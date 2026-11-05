ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'webhook';  -- webhook | manual | schedule
ALTER TABLE jobs ADD COLUMN outcome TEXT;                            -- ok | failed | gave_up
ALTER TABLE jobs ADD COLUMN error TEXT;
ALTER TABLE jobs ADD COLUMN output TEXT;                             -- last 8 KB of sync output
ALTER TABLE repos ADD COLUMN schedule_minutes INTEGER;               -- NULL = manual only
ALTER TABLE repos ADD COLUMN next_run_at INTEGER;