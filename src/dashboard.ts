export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitSync for Tangled</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fafafa; --muted:#666; --line:#ddd; --ok:#1a7f37; --bad:#cf222e; --run:#9a6700; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#111; --muted:#999; --line:#333; --ok:#3fb950; --bad:#f85149; --run:#d29922; } }
  body { font: 15px/1.5 system-ui, sans-serif; margin:0; background:var(--bg); color:var(--fg); }
  main { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:12px; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .muted { color: var(--muted); font-size: 13px; }
  .status-ok { color: var(--ok); }
  .status-error, .err { color: var(--bad); }
  .status-running, .status-queued { color: var(--run); }
  .status-paused { color: var(--muted); }
  button, select, input { font: inherit; padding:6px 10px; border-radius:6px; border:1px solid var(--line); background:transparent; color:inherit; }
  button:disabled { opacity:.5; cursor:default; }
  pre { background: rgba(127,127,127,.12); padding:10px; border-radius:6px; overflow:auto; font-size:12px; white-space:pre-wrap; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
  td, th { text-align:left; padding:6px; border-top:1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>GitSync for Tangled</h1>
  <div id="app"></div>
</main>
<script>
(function () {
  var app = document.getElementById("app");
  var pollTimer = null;

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "onclick") n.onclick = attrs[k];
      else if (k === "onchange") n.onchange = attrs[k];
      else if (k === "disabled") n.disabled = !!attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    opts.headers = Object.assign({ "content-type": "application/json" }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { status: r.status, body: body };
      });
    });
  }

  function ago(ms) {
    if (!ms) return "never";
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function statusEl(s) {
    return el("span", { class: "status-" + s }, [s]);
  }

  function opt(value, label, current) {
    var o = el("option", { value: value }, [label]);
    if (String(current == null ? "" : current) === value) o.selected = true;
    return o;
  }

  function signIn() {
    var input = el("input", { placeholder: "you.bsky.social", size: 28 });
    var go = el("button", { onclick: function () {
      var h = input.value.trim();
      if (h) window.location.href = "/login?handle=" + encodeURIComponent(h);
    } }, ["Sign in with Bluesky"]);
    app.replaceChildren(el("div", { class: "card" }, [
      el("p", null, ["Sign in with your Bluesky handle to manage your repos."]),
      el("div", { class: "row" }, [input, go])
    ]));
  }

  function showOutput(jobId, box) {
    var detail = box.querySelector(".detail");
    if (!detail) return;
    detail.replaceChildren(el("div", { class: "muted" }, ["Loading output…"]));
    api("/api/jobs/" + jobId).then(function (res) {
      var j = res.body && res.body.job;
      if (!j) {
        detail.replaceChildren(el("div", { class: "err" }, [(res.body && res.body.error) || "Not found"]));
        return;
      }
      detail.replaceChildren(el("pre", null, [j.output || j.error || "(no output)"]));
    });
  }

  function toggleLogs(repoId, box) {
    if (box.childNodes.length) { box.replaceChildren(); return; }
    box.appendChild(el("div", { class: "muted" }, ["Loading…"]));
    api("/api/repos/" + repoId + "/jobs").then(function (res) {
      var jobs = (res.body && res.body.jobs) || [];
      if (!jobs.length) {
        box.replaceChildren(el("div", { class: "muted" }, ["No runs yet."]));
        return;
      }
      var rows = jobs.map(function (j) {
        return el("tr", { style: "cursor:pointer", onclick: function () { showOutput(j.id, box); } }, [
          el("td", null, [new Date(j.created_at).toLocaleString()]),
          el("td", null, [j.source]),
          el("td", null, [statusEl(j.status)]),
          el("td", { class: "err" }, [j.error ? j.error.split("\n")[0].slice(0, 120) : ""])
        ]);
      });
      var table = el("table", null, [
        el("tr", null, [el("th", null, ["When"]), el("th", null, ["Source"]), el("th", null, ["Status"]), el("th", null, ["Error"])])
      ].concat(rows));
      box.replaceChildren(table, el("div", { class: "detail" }));
    });
  }

  function repoCard(r) {
    var syncBtn = el("button", {
      disabled: !r.enabled || r.status === "queued" || r.status === "running",
      onclick: function () {
        api("/api/repos/" + r.id + "/sync", { method: "POST" }).then(function (res) {
          if (res.status >= 400) alert(res.body.error || "Sync could not be queued");
          load();
        });
      }
    }, ["Sync now"]);

    var pauseBtn = el("button", { onclick: function () {
      api("/api/repos/" + r.id, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) }).then(load);
    } }, [r.enabled ? "Pause" : "Resume"]);

    var sched = el("select", { onchange: function () {
      var v = this.value === "" ? null : Number(this.value);
      api("/api/repos/" + r.id + "/schedule", { method: "PATCH", body: JSON.stringify({ minutes: v }) }).then(function (res) {
        if (res.status >= 400) alert(res.body.error || "Could not save schedule");
        load();
      });
    } }, [
      opt("", "Manual only", r.schedule_minutes),
      opt("60", "Hourly", r.schedule_minutes),
      opt("360", "Every 6 hours", r.schedule_minutes),
      opt("1440", "Daily", r.schedule_minutes),
      opt("10080", "Weekly", r.schedule_minutes)
    ]);

    var logsBox = el("div", { class: "logs" });
    var logsBtn = el("button", { onclick: function () { toggleLogs(r.id, logsBox); } }, ["Logs"]);

    return el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("strong", null, [r.github_full_name]),
        el("span", { class: "muted" }, ["→ " + r.tangled_full_name]),
        statusEl(r.enabled ? r.status : "paused")
      ]),
      el("div", { class: "muted" }, ["Last synced " + ago(r.last_synced_at)]),
      r.last_error ? el("div", { class: "err" }, [r.last_error]) : el("span"),
      el("div", { class: "row", style: "margin-top:8px" }, [syncBtn, pauseBtn, sched, logsBtn]),
      logsBox
    ]);
  }

  function load() {
    api("/api/repos").then(function (res) {
      if (res.status === 401) { signIn(); return; }
      var repos = (res.body && res.body.repos) || [];
      var busy = repos.some(function (r) { return r.status === "queued" || r.status === "running"; });
      var header = el("div", { class: "muted" }, [repos.length + " repo" + (repos.length === 1 ? "" : "s")]);
      var list = repos.length
        ? repos.map(repoCard)
        : [el("div", { class: "card muted" }, ["No repos yet. Adding repos is the next step."])];
      app.replaceChildren.apply(app, [header].concat(list));
      clearTimeout(pollTimer);
      if (busy) pollTimer = setTimeout(load, 15000);
    });
  }

  load();
})();
</script>
</body>
</html>`;