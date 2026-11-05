import * as oauth from "@atproto/oauth-client";
import { DASHBOARD_HTML } from "./dashboard";

export interface Env {
  DB: D1Database;
  GITHUB_WEBHOOK_SECRET: string;
  WORKER_TOKEN: string;
  ATPROTO_CLIENT_JWK?: string;
}

const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const MANUAL_COOLDOWN_MS = 5 * 60_000;
const QUEUE_CAP = 100;
const ALLOWED_SCHEDULES = [60, 360, 1440, 10080]; // hourly, 6h, daily, weekly
const MAX_OUTPUT = 8000;
const RETENTION_MS = 30 * 86_400_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------- auth ----------

async function verifyGitHub(sig: string | null, secret: string, body: string): Promise<boolean> {
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

function workerAuthed(req: Request, env: Env): boolean {
  return req.headers.get("authorization") === `Bearer ${env.WORKER_TOKEN}`;
}

// Replaced when login is built: return the DID of the signed-in user, or null.
async function currentDid(_req: Request, _env: Env): Promise<string | null> {
  return null;
}

// ---------- AT Proto client identity ----------

function clientMetadata(origin: string) {
  return {
    client_id: `${origin}/client-metadata.json`,
    client_name: "GitSync for Tangled",
    client_uri: origin,
    redirect_uris: [`${origin}/oauth/bsky/callback`],
    scope: "atproto",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${origin}/jwks.json`,
  };
}

function publicJwks(env: Env): Response {
  if (!env.ATPROTO_CLIENT_JWK) return json({ error: "client key not configured" }, 500);
  const jwk = JSON.parse(env.ATPROTO_CLIENT_JWK) as Record<string, unknown>;
  const { d: _private, ...pub } = jwk;
  return json({ keys: [pub] });
}

// ---------- webhook ----------

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await verifyGitHub(req.headers.get("x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET, body))) {
    return json({ error: "bad signature" }, 401);
  }
  if (req.headers.get("x-github-event") !== "push") {
    return json({ ignored: "not a push" }, 202);
  }

  const payload = JSON.parse(body) as {
    repository?: { full_name?: string; private?: boolean };
    head_commit?: { message?: string };
  };
  if (payload.repository?.private) return json({ ignored: "private repo" }, 202);

  const fullName = payload.repository?.full_name ?? null;
  if (!fullName) return json({ error: "no repository.full_name in payload" }, 400);

  const repo = await env.DB.prepare(
    "SELECT id FROM repos WHERE github_full_name = ? AND enabled = 1",
  ).bind(fullName).first<{ id: number }>();
  if (!repo) return json({ ignored: "unknown or paused repo" }, 202);

  const pending = await env.DB.prepare(
    "SELECT id FROM jobs WHERE repo_id = ? AND finished_at IS NULL AND claimed_at IS NULL",
  ).bind(repo.id).first();
  if (pending) return json({ queued: true, coalesced: true }, 202);

  const msg = String(payload.head_commit?.message ?? "").slice(0, 500);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs (repo_id, commit_message, created_at, source) VALUES (?, ?, ?, 'webhook')",
    ).bind(repo.id, msg, Date.now()),
    env.DB.prepare("UPDATE repos SET status = 'queued' WHERE id = ?").bind(repo.id),
  ]);
  return json({ queued: true }, 202);
}

// ---------- poller API (WORKER_TOKEN) ----------

async function claimJob(env: Env): Promise<Response> {
  const now = Date.now();
  const job = await env.DB.prepare(`
    UPDATE jobs SET claimed_at = ?, attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM jobs j JOIN repos r ON r.id = j.repo_id
      WHERE j.finished_at IS NULL AND j.claimed_at IS NULL AND r.enabled = 1
      ORDER BY j.created_at LIMIT 1
    )
    RETURNING id, repo_id, commit_message
  `).bind(now).first<{ id: number; repo_id: number; commit_message: string }>();
  if (!job) return json({ job: null });

  const repo = await env.DB.prepare(
    "SELECT github_full_name, tangled_full_name FROM repos WHERE id = ?",
  ).bind(job.repo_id).first<{ github_full_name: string; tangled_full_name: string }>();

  await env.DB.prepare("UPDATE repos SET status = 'running' WHERE id = ?").bind(job.repo_id).run();

  return json({
    job: {
      id: job.id,
      github_full_name: repo!.github_full_name,
      tangled_full_name: repo!.tangled_full_name,
      commit_message: job.commit_message,
    },
  });
}

async function finishJob(env: Env, jobId: number, outcome: "ok" | "failed", req: Request): Promise<Response> {
  const now = Date.now();
  const body = (await req.json().catch(() => ({}))) as { output?: string };
  const output = String(body.output ?? "").slice(-MAX_OUTPUT);
  const error = outcome === "failed" ? output.slice(-400) : null;

  const job = await env.DB.prepare(
    "SELECT repo_id, finished_at FROM jobs WHERE id = ?",
  ).bind(jobId).first<{ repo_id: number; finished_at: number | null }>();
  if (!job) return json({ error: "no such job" }, 404);
  if (job.finished_at) return json({ error: "already finished" }, 409);

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE jobs SET finished_at = ?, outcome = ?, error = ?, output = ? WHERE id = ?",
    ).bind(now, outcome, error, output, jobId),
    outcome === "ok"
      ? env.DB.prepare(
          "UPDATE repos SET status = 'idle', last_synced_at = ?, last_error = NULL WHERE id = ?",
        ).bind(now, job.repo_id)
      : env.DB.prepare(
          "UPDATE repos SET status = 'error', last_error = ? WHERE id = ?",
        ).bind(error, job.repo_id),
  ]);
  return json({ ok: true });
}

// ---------- user actions (signed-in DID) ----------

async function listRepos(env: Env, did: string): Promise<Response> {
  const rows = await env.DB.prepare(`
    SELECT id, github_full_name, tangled_full_name, status, enabled, schedule_minutes,
      last_synced_at, last_error
    FROM repos WHERE user_did = ? ORDER BY github_full_name
  `).bind(did).all();
  return json({ repos: rows.results });
}

async function setRepoEnabled(env: Env, did: string, repoId: number, req: Request): Promise<Response> {
  const body = await req.json<{ enabled?: boolean }>().catch(() => null);
  if (typeof body?.enabled !== "boolean") return json({ error: "send {enabled: true|false}" }, 400);
  const enabled = body.enabled;

  const owned = await env.DB.prepare(
    "SELECT id FROM repos WHERE id = ? AND user_did = ?",
  ).bind(repoId, did).first();
  if (!owned) return json({ error: "not found" }, 404);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE repos SET enabled = ?, status = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, enabled ? "idle" : "paused", repoId),
  ];
  if (!enabled) {
    stmts.push(
      env.DB.prepare(
        `UPDATE jobs SET finished_at = ?, outcome = 'canceled', error = 'paused by user'
         WHERE repo_id = ? AND claimed_at IS NULL AND finished_at IS NULL`,
      ).bind(Date.now(), repoId),
    );
  }
  await env.DB.batch(stmts);
  return json({ ok: true, enabled });
}

async function syncNow(env: Env, did: string, repoId: number): Promise<Response> {
  const repo = await env.DB.prepare(
    "SELECT id, enabled, last_synced_at FROM repos WHERE id = ? AND user_did = ?",
  ).bind(repoId, did).first<{ id: number; enabled: number; last_synced_at: number | null }>();
  if (!repo) return json({ error: "not found" }, 404);
  if (!repo.enabled) return json({ error: "repo is paused" }, 409);

  const now = Date.now();
  if (repo.last_synced_at && now - repo.last_synced_at < MANUAL_COOLDOWN_MS) {
    return json({ error: "synced recently, try again shortly" }, 429);
  }

  const pending = await env.DB.prepare(
    "SELECT id FROM jobs WHERE repo_id = ? AND finished_at IS NULL AND claimed_at IS NULL",
  ).bind(repo.id).first();
  if (pending) return json({ queued: true, already: true }, 202);

  const queued = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE finished_at IS NULL AND claimed_at IS NULL",
  ).first<{ n: number }>();
  if ((queued?.n ?? 0) >= QUEUE_CAP) return json({ error: "queue is full, try later" }, 503);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs (repo_id, commit_message, created_at, source) VALUES (?, 'manual sync', ?, 'manual')",
    ).bind(repo.id, now),
    env.DB.prepare("UPDATE repos SET status = 'queued' WHERE id = ?").bind(repo.id),
  ]);
  return json({ queued: true }, 202);
}

async function setSchedule(env: Env, did: string, repoId: number, req: Request): Promise<Response> {
  const body = await req.json<{ minutes?: number | null }>().catch(() => null);
  const minutes = body?.minutes;
  if (minutes === undefined || (minutes !== null && !ALLOWED_SCHEDULES.includes(minutes))) {
    return json({ error: "minutes must be 60, 360, 1440, 10080, or null" }, 400);
  }

  const owned = await env.DB.prepare(
    "SELECT id FROM repos WHERE id = ? AND user_did = ?",
  ).bind(repoId, did).first();
  if (!owned) return json({ error: "not found" }, 404);

  await env.DB.prepare(
    "UPDATE repos SET schedule_minutes = ?, next_run_at = ? WHERE id = ?",
  ).bind(minutes, minutes === null ? null : Date.now(), repoId).run();
  return json({ ok: true, minutes });
}

async function listJobs(env: Env, did: string, repoId: number): Promise<Response> {
  const owned = await env.DB.prepare(
    "SELECT id FROM repos WHERE id = ? AND user_did = ?",
  ).bind(repoId, did).first();
  if (!owned) return json({ error: "not found" }, 404);

  const rows = await env.DB.prepare(`
    SELECT id, source, created_at, claimed_at, finished_at, attempts, outcome, error,
      CASE
        WHEN finished_at IS NOT NULL THEN COALESCE(outcome, 'ok')
        WHEN claimed_at IS NOT NULL THEN 'running'
        ELSE 'queued'
      END AS status
    FROM jobs WHERE repo_id = ? ORDER BY id DESC LIMIT 50
  `).bind(repoId).all();
  return json({ jobs: rows.results });
}

async function getJob(env: Env, did: string, jobId: number): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT j.id, j.repo_id, j.source, j.outcome, j.error, j.output, j.attempts,
      j.created_at, j.claimed_at, j.finished_at
    FROM jobs j JOIN repos r ON r.id = j.repo_id
    WHERE j.id = ? AND r.user_did = ?
  `).bind(jobId, did).first();
  if (!row) return json({ error: "not found" }, 404);
  return json({ job: row });
}

// ---------- cron ----------

async function runScheduled(env: Env): Promise<void> {
  const now = Date.now();
  const staleBefore = now - LEASE_MS;
  const gaveUp = `gave up after ${MAX_ATTEMPTS} attempts`;

  // Order matters: repos are updated before jobs are marked finished,
  // since the repos subquery looks for unfinished jobs.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE repos SET status = 'error', last_error = ?
       WHERE id IN (
         SELECT repo_id FROM jobs
         WHERE finished_at IS NULL AND claimed_at < ? AND attempts >= ?
       )`,
    ).bind(gaveUp, staleBefore, MAX_ATTEMPTS),
    env.DB.prepare(
      `UPDATE jobs SET finished_at = ?, outcome = 'gave_up', error = ?
       WHERE finished_at IS NULL AND claimed_at < ? AND attempts >= ?`,
    ).bind(now, gaveUp, staleBefore, MAX_ATTEMPTS),
    env.DB.prepare(
      "UPDATE jobs SET claimed_at = NULL WHERE finished_at IS NULL AND claimed_at < ? AND attempts < ?",
    ).bind(staleBefore, MAX_ATTEMPTS),
    // Enqueue due scheduled syncs, skipping repos that already have unfinished work
    env.DB.prepare(
      `INSERT INTO jobs (repo_id, commit_message, created_at, source)
       SELECT r.id, 'scheduled sync', ?, 'schedule' FROM repos r
       WHERE r.enabled = 1 AND r.schedule_minutes IS NOT NULL AND r.next_run_at <= ?
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.repo_id = r.id AND j.finished_at IS NULL)`,
    ).bind(now, now),
    env.DB.prepare(
      `UPDATE repos SET next_run_at = ? + schedule_minutes * 60000
       WHERE enabled = 1 AND schedule_minutes IS NOT NULL AND next_run_at <= ?`,
    ).bind(now, now),
    env.DB.prepare("DELETE FROM jobs WHERE finished_at < ?").bind(now - RETENTION_MS),
  ]);
}

// ---------- routing ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // Dashboard
    if (req.method === "GET" && p === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // AT Proto client identity (fetched by the authorization server)
    if (req.method === "GET" && p === "/client-metadata.json") {
      return json(clientMetadata(url.origin));
    }
    if (req.method === "GET" && p === "/jwks.json") {
      return publicJwks(env);
    }

    // TEMPORARY: confirms the AT Proto client library loads in the Worker runtime.
    // Remove this route and the import at the top once the login route works.
    if (req.method === "GET" && p === "/smoke-atproto") {
      return json({ exports: Object.keys(oauth) });
    }

    if (req.method === "POST" && p === "/webhook/github") {
      return handleWebhook(req, env);
    }

    // Poller API
    if (p.startsWith("/api/jobs/") && req.method === "POST") {
      if (!workerAuthed(req, env)) return json({ error: "unauthorized" }, 401);
      if (p === "/api/jobs/claim") return claimJob(env);
      const m = p.match(/^\/api\/jobs\/(\d+)\/(done|fail)$/);
      if (m) return finishJob(env, Number(m[1]), m[2] === "done" ? "ok" : "failed", req);
      return json({ error: "not found" }, 404);
    }

    // Signed-in user API
    if (p === "/api/repos" || p.startsWith("/api/repos/") || (p.startsWith("/api/jobs/") && req.method === "GET")) {
      const did = await currentDid(req, env);
      if (!did) return json({ error: "sign in required" }, 401);

      if (p === "/api/repos" && req.method === "GET") return listRepos(env, did);

      const repoOnly = p.match(/^\/api\/repos\/(\d+)$/);
      if (repoOnly && req.method === "PATCH") return setRepoEnabled(env, did, Number(repoOnly[1]), req);

      const repoAction = p.match(/^\/api\/repos\/(\d+)\/(sync|schedule|jobs)$/);
      if (repoAction) {
        const id = Number(repoAction[1]);
        const action = repoAction[2];
        if (action === "sync" && req.method === "POST") return syncNow(env, did, id);
        if (action === "schedule" && req.method === "PATCH") return setSchedule(env, did, id, req);
        if (action === "jobs" && req.method === "GET") return listJobs(env, did, id);
      }

      const jobOnly = p.match(/^\/api\/jobs\/(\d+)$/);
      if (jobOnly && req.method === "GET") return getJob(env, did, Number(jobOnly[1]));

      return json({ error: "not found" }, 404);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await runScheduled(env);
  },
} satisfies ExportedHandler<Env>;