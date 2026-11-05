CREATE TABLE IF NOT EXISTS users (
  did TEXT PRIMARY KEY,
  github_login TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  user_did TEXT REFERENCES users(did),
  github_full_name TEXT NOT NULL UNIQUE,
  tangled_full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  last_synced_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  commit_message TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  finished_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(finished_at, claimed_at, created_at);