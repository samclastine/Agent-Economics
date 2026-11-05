-- Agent Treasury schema (SQLite). A423 workflow state lives in the SDK
-- operations database at A423_STORAGE_FILE.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  model_config TEXT NOT NULL DEFAULT '{}',
  system_prompt_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_wallets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  wallet_type TEXT NOT NULL DEFAULT 'evm_eoa',
  key_reference TEXT,
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  job_id TEXT,
  thread_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES agent_runs(id),
  agent_id TEXT REFERENCES agents(id),
  job_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_events_cursor_idx ON agent_events(id);
