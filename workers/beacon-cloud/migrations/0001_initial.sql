CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  created_at TEXT NOT NULL, last_seen TEXT
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL UNIQUE,
  identity_kind TEXT NOT NULL CHECK(identity_kind IN ('remote','device_path','unknown'))
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
  source_session_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
  harness TEXT NOT NULL, started_at TEXT NOT NULL, last_event_at TEXT NOT NULL
);
CREATE TABLE batches (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
  stream TEXT NOT NULL CHECK(stream IN ('runtime','inventory')),
  r2_key TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL, event_count INTEGER NOT NULL
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
  stream TEXT NOT NULL, event_id TEXT NOT NULL, session_id TEXT REFERENCES sessions(id),
  project_id TEXT NOT NULL REFERENCES projects(id), timestamp TEXT NOT NULL,
  action TEXT NOT NULL, harness TEXT NOT NULL, batch_id TEXT NOT NULL REFERENCES batches(id),
  line_number INTEGER NOT NULL, payload_hash TEXT NOT NULL,
  UNIQUE(device_id, stream, event_id)
);
-- A hook and an OTLP capture can legitimately share event.id but carry different fields.
-- Preserve both raw versions without counting the logical action twice.
CREATE TABLE event_versions (
  event_id TEXT NOT NULL REFERENCES events(id), payload_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id), line_number INTEGER NOT NULL,
  PRIMARY KEY(event_id,payload_hash)
);
CREATE INDEX sessions_recent ON sessions(last_event_at DESC,id DESC);
CREATE INDEX sessions_device_recent ON sessions(device_id,last_event_at DESC,id DESC);
CREATE INDEX sessions_project_recent ON sessions(project_id,last_event_at DESC,id DESC);
CREATE INDEX events_timeline ON events(session_id,timestamp,id);
CREATE INDEX events_project ON events(project_id,timestamp);
CREATE INDEX events_batch ON events(batch_id);
-- Repeat the preflight identity check inside D1's transaction to close concurrent
-- first-upload races. The statement abort rolls back the complete index batch.
CREATE TRIGGER sessions_no_remote_change BEFORE UPDATE OF project_id ON sessions
WHEN OLD.project_id != NEW.project_id
  AND (SELECT identity_kind FROM projects WHERE id=OLD.project_id)='remote'
  AND (SELECT identity_kind FROM projects WHERE id=NEW.project_id)='remote'
BEGIN
  SELECT RAISE(ABORT,'session_project_conflict');
END;
