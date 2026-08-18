export const DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'folder')),
  identity_fingerprint TEXT NOT NULL,
  common_dir_path TEXT,
  root_path TEXT,
  display_name TEXT NOT NULL,
  last_seen_path TEXT NOT NULL,
  remote_label TEXT,
  recall_generation INTEGER NOT NULL DEFAULT 0,
  remote_warning INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, identity_fingerprint)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  native_session_ref TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  transcript_path TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(client, native_session_ref)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  native_turn_ref TEXT NOT NULL,
  source_digest TEXT,
  projection_version TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, native_turn_ref)
);

CREATE TABLE IF NOT EXISTS refine_jobs (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  refine_job_id TEXT NOT NULL UNIQUE REFERENCES refine_jobs(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  action TEXT NOT NULL,
  target_id TEXT,
  applied_memory_id TEXT,
  base_version INTEGER,
  revision INTEGER NOT NULL,
  content TEXT,
  state TEXT NOT NULL CHECK (state IN ('applied', 'skipped', 'failed', 'stale')),
  review_state TEXT NOT NULL CHECK (review_state IN ('none', 'unverified', 'confirmed', 'rolled_back')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  active_version_id TEXT,
  topic_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'archived', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS memories_active_topic
ON memories(repo_id, topic_key) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  source_session_id TEXT REFERENCES sessions(id),
  source_turn_ref TEXT,
  restores_version_id TEXT REFERENCES memory_versions(id),
  created_at TEXT NOT NULL,
  UNIQUE(memory_id, version_no)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  repo_id UNINDEXED,
  searchable_text,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS deletion_tombstones (
  memory_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
