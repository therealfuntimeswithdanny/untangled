export interface Env {
  DB: D1Database;
  GITHUB_WEBHOOK_SECRET: string;
  WORKER_TOKEN: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

async function verifyGitHub(sig: string | null, secret: string, body: string) {
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected =
    "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === expected;
}

function workerAuthed(req: Request, env: Env) {
  return req.headers.get("authorization") === `Bearer ${env.WORKER_TOKEN}`;
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifyGitHub(req.headers.get("x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET, body))) {
    return json({ error: "bad signature" }, 401);
  }
  if (req.headers.get("x-github-event") !== "push") {
    return json({ ignored: "not a push" }, 202);
  }

  const payload = JSON.parse(body);
  if (payload.repository?.private) return json({ ignored: "private repo" }, 202);

  const repo = await env.DB.prepare(
    "SELECT id FROM repos WHERE github_full_name = ?",
  ).bind(payload.repository.full_name).first<{ id: number }>();
  if (!repo) return json({ ignored: "unknown repo" }, 202);

  // Coalesce: if a job is already waiting, don't queue another
  const pending = await env.DB.prepare(
    "SELECT id FROM jobs WHERE repo_id = ? AND finished_at IS NULL AND claimed_at IS NULL",
  ).bind(repo.id).first();
  if (!pending) {
    const msg = String(payload.head_commit?.message ?? "").slice(0, 500);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs (repo_id, commit_message, created_at) VALUES (?, ?, ?)",
      ).bind(repo.id, msg, Date.now()),
      env.DB.prepare("UPDATE repos SET status = 'queued' WHERE id = ?").bind(repo.id),
    ]);
  }
  return json({ queued: true }, 202);
}

async function claimJob(env: Env): Promise<Response> {
  const now = Date.now();
  const job = await env.DB.prepare(`
    UPDATE jobs SET claimed_at = ?, attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE finished_at IS NULL AND claimed_at IS NULL
      ORDER BY created_at LIMIT 1
    )
    RETURNING id, repo_id, commit_message
  `).bind(now).first<{ id: number; repo_id: number; commit_message: string }>();

  if (!job) return json({ job: null });

  const repo = await env.DB.prepare(
    "SELECT github_full_name, tangled_full_name FROM repos WHERE id = ?",
  ).bind(job.repo_id).first<{ github_full_name: string; tangled_full_name: string }>();

  await env.DB.prepare("UPDATE repos SET status = 'running' WHERE id = ?")
    .bind(job.repo_id).run();

  return json({
    job: {
      id: job.id,
      github_full_name: repo!.github_full_name,
      tangled_full_name: repo!.tangled_full_name,
      commit_message: job.commit_message,
    },
  });
}

async function finishJob(env: Env, jobId: number, outcome: "done" | "fail", req: Request) {
  const now = Date.now();
  const job = await env.DB.prepare("SELECT repo_id FROM jobs WHERE id = ?")
    .bind(jobId).first<{ repo_id: number }>();
  if (!job) return json({ error: "no such job" }, 404);

  if (outcome === "done") {
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").bind(now, jobId),
      env.DB.prepare(
        "UPDATE repos SET status = 'idle', last_synced_at = ?, last_error = NULL WHERE id = ?",
      ).bind(now, job.repo_id),
    ]);
  } else {
    const { error } = await req.json<{ error?: string }>().catch(() => ({ error: "" }));
    const safe = String(error ?? "").slice(0, 500);
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").bind(now, jobId),
      env.DB.prepare(
        "UPDATE repos SET status = 'error', last_error = ? WHERE id = ?",
      ).bind(safe, job.repo_id),
    ]);
  }
  return json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook/github") {
      return handleWebhook(req, env);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!workerAuthed(req, env)) return json({ error: "unauthorized" }, 401);

      if (req.method === "POST" && url.pathname === "/api/jobs/claim") {
        return claimJob(env);
      }
      const m = url.pathname.match(/^\/api\/jobs\/(\d+)\/(done|fail)$/);
      if (req.method === "POST" && m) {
        return finishJob(env, Number(m[1]), m[2] as "done" | "fail", req);
      }
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    const staleBefore = now - LEASE_MS;

    // Give up on jobs that keep dying
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE repos SET status = 'error', last_error = 'gave up after ${MAX_ATTEMPTS} attempts'
        WHERE id IN (
          SELECT repo_id FROM jobs
          WHERE finished_at IS NULL AND claimed_at < ? AND attempts >= ?
        )`).bind(staleBefore, MAX_ATTEMPTS),
      env.DB.prepare(`
        UPDATE jobs SET finished_at = ?
        WHERE finished_at IS NULL AND claimed_at < ? AND attempts >= ?
      `).bind(now, staleBefore, MAX_ATTEMPTS),
      // Requeue the rest
      env.DB.prepare(`
        UPDATE jobs SET claimed_at = NULL
        WHERE finished_at IS NULL AND claimed_at < ? AND attempts < ?
      `).bind(staleBefore, MAX_ATTEMPTS),
      // Retention
      env.DB.prepare("DELETE FROM jobs WHERE finished_at < ?")
        .bind(now - 30 * 86_400_000),
    ]);
  },
} satisfies ExportedHandler<Env>;