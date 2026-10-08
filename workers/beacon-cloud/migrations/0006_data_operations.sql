-- Phase 3 data operations: explicit retention, scheduled backups and data health.
-- Nothing here acts on its own. Backup and health run only when an operator names
-- them in MAINTENANCE_TASKS, and only a reviewer can apply a retention plan.
-- Ingest never reads or writes these tables.
CREATE INDEX batches_received ON batches(received_at,id);
CREATE INDEX event_versions_batch ON event_versions(batch_id);

-- keep_days NULL (or no row) keeps a class forever. Only `raw` is enforceable;
-- summary/candidate/audit rows are immutable under 0003, so their periods are recorded only.
CREATE TABLE retention_policies (
  data_class TEXT PRIMARY KEY CHECK(data_class IN ('raw','summary','candidate','audit')),
  keep_days INTEGER CHECK(keep_days IS NULL OR keep_days BETWEEN 1 AND 36500),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 128)
);
CREATE TABLE retention_policy_audit (
  id TEXT PRIMARY KEY,
  data_class TEXT NOT NULL CHECK(data_class IN ('raw','summary','candidate','audit')),
  keep_days INTEGER,
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
);
-- One reviewer-applied deletion of whole raw batches. checkpoint_id names the verified
-- backup the run relied on; it has no foreign key because backup bookkeeping is not
-- part of a checkpoint's own snapshot.
CREATE TABLE retention_runs (
  id TEXT PRIMARY KEY,
  data_class TEXT NOT NULL CHECK(data_class='raw'),
  plan_sha256 TEXT NOT NULL UNIQUE CHECK(length(plan_sha256)=64),
  generated_at TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  batch_count INTEGER NOT NULL CHECK(batch_count BETWEEN 1 AND 50),
  event_count INTEGER NOT NULL,
  version_count INTEGER NOT NULL,
  raw_bytes INTEGER NOT NULL,
  keys_sha256 TEXT NOT NULL CHECK(length(keys_sha256)=64),
  checkpoint_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
);
-- Keys contain only device and batch identifiers. The backup task retries failed RAW
-- deletes and removes the BACKUP copy once backup_delete_after has passed.
CREATE TABLE retention_run_objects (
  run_id TEXT NOT NULL REFERENCES retention_runs(id),
  batch_id TEXT NOT NULL CHECK(length(batch_id)=64),
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  raw_deleted_at TEXT,
  backup_delete_after TEXT NOT NULL,
  backup_deleted_at TEXT,
  PRIMARY KEY(run_id,batch_id)
);
CREATE INDEX retention_runs_checkpoint ON retention_runs(checkpoint_id,created_at);
CREATE INDEX retention_run_objects_batch ON retention_run_objects(batch_id,created_at);
CREATE INDEX retention_run_objects_raw_pending ON retention_run_objects(created_at) WHERE raw_deleted_at IS NULL;
CREATE INDEX retention_run_objects_backup_due ON retention_run_objects(backup_delete_after) WHERE backup_deleted_at IS NULL;

-- A checkpoint exports batches/events/event_versions in chunks across ticks, then every
-- other table plus the chunk tail in one D1 transaction, then lists the raw copies.
CREATE TABLE backup_checkpoints (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','verified','expired')),
  phase TEXT NOT NULL CHECK(phase IN ('chunks','raw','manifest','done')),
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK(length(started_by) BETWEEN 1 AND 128),
  cursor TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  final_snapshot_at TEXT,
  batches_through TEXT,
  raw_listed_at TEXT,
  raw_object_count INTEGER NOT NULL DEFAULT 0,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  manifest_key TEXT,
  manifest_sha256 TEXT,
  table_counts TEXT,
  integrity_cursor TEXT,
  integrity_verified_at TEXT,
  integrity_error TEXT,
  verified_at TEXT,
  verified_by TEXT,
  verification_result TEXT CHECK(verification_result IS NULL OR verification_result IN ('passed','failed')),
  verification_sha256 TEXT,
  raw_pruned_at TEXT,
  expired_at TEXT,
  expired_by TEXT,
  expire_cursor INTEGER,
  objects_deleted_at TEXT,
  error_code TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX backup_one_running ON backup_checkpoints(status) WHERE status='running';
CREATE INDEX backup_checkpoints_recent ON backup_checkpoints(started_at DESC,id DESC);
CREATE TABLE backup_chunks (
  checkpoint_id TEXT NOT NULL REFERENCES backup_checkpoints(id),
  seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 999999),
  kind TEXT NOT NULL CHECK(kind IN ('rows','final','raw_list')),
  key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  bytes INTEGER NOT NULL,
  rows TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(checkpoint_id,seq)
);
-- Raw copies are tracked once and shared by every checkpoint; no foreign key to
-- batches because retention removes batch rows while the copy waits out its grace period.
CREATE TABLE backup_raw_objects (
  batch_id TEXT PRIMARY KEY CHECK(length(batch_id)=64),
  r2_key TEXT NOT NULL UNIQUE,
  batch_received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('copied','source_missing','deleted')),
  size INTEGER,
  sha256 TEXT,
  copied_at TEXT NOT NULL,
  first_checkpoint_id TEXT,
  deleted_at TEXT,
  CHECK(status!='copied' OR (size IS NOT NULL AND length(sha256)=64))
);
CREATE INDEX backup_raw_received ON backup_raw_objects(batch_received_at,batch_id);
CREATE INDEX backup_raw_source_missing ON backup_raw_objects(batch_received_at) WHERE status='source_missing';
CREATE TABLE backup_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  raw_cursor TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO backup_state(id,revision) VALUES(1,0);
CREATE TABLE backup_audit (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES backup_checkpoints(id),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('run','verify','expire')),
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX backup_audit_checkpoint ON backup_audit(checkpoint_id,created_at,id);

-- Rolling R2/D1 list-diff state: identifiers and counts only.
CREATE TABLE health_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0,
  scan TEXT,
  last_pass TEXT,
  updated_at TEXT
);
INSERT INTO health_state(id,revision) VALUES(1,0);

CREATE TRIGGER retention_policy_audit_no_update BEFORE UPDATE ON retention_policy_audit
BEGIN
  SELECT RAISE(ABORT,'retention_immutable');
END;
CREATE TRIGGER retention_policy_audit_no_delete BEFORE DELETE ON retention_policy_audit
BEGIN
  SELECT RAISE(ABORT,'retention_immutable');
END;
CREATE TRIGGER retention_runs_no_update BEFORE UPDATE ON retention_runs
BEGIN
  SELECT RAISE(ABORT,'retention_immutable');
END;
CREATE TRIGGER retention_runs_no_delete BEFORE DELETE ON retention_runs
BEGIN
  SELECT RAISE(ABORT,'retention_immutable');
END;
-- Deletion progress may be recorded once; identities and the grace deadline never change.
CREATE TRIGGER retention_run_objects_progress BEFORE UPDATE ON retention_run_objects
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.r2_key IS NOT OLD.r2_key
  OR NEW.size IS NOT OLD.size OR NEW.created_at IS NOT OLD.created_at OR NEW.backup_delete_after IS NOT OLD.backup_delete_after
  OR (OLD.raw_deleted_at IS NOT NULL AND NEW.raw_deleted_at IS NOT OLD.raw_deleted_at)
  OR (OLD.backup_deleted_at IS NOT NULL AND NEW.backup_deleted_at IS NOT OLD.backup_deleted_at)
BEGIN
  SELECT RAISE(ABORT,'retention_immutable');
END;
CREATE TRIGGER retention_run_objects_no_delete BEFORE DELETE ON retention_run_objects
BEGIN
  SELECT RAISE(ABORT,'retention_immutable');
END;
CREATE TRIGGER backup_chunks_no_update BEFORE UPDATE ON backup_chunks
BEGIN
  SELECT RAISE(ABORT,'backup_immutable');
END;
CREATE TRIGGER backup_chunks_no_delete BEFORE DELETE ON backup_chunks
BEGIN
  SELECT RAISE(ABORT,'backup_immutable');
END;
CREATE TRIGGER backup_audit_no_update BEFORE UPDATE ON backup_audit
BEGIN
  SELECT RAISE(ABORT,'backup_immutable');
END;
CREATE TRIGGER backup_audit_no_delete BEFORE DELETE ON backup_audit
BEGIN
  SELECT RAISE(ABORT,'backup_immutable');
END;
CREATE TRIGGER backup_checkpoints_no_delete BEFORE DELETE ON backup_checkpoints
BEGIN
  SELECT RAISE(ABORT,'backup_immutable');
END;
-- An expired checkpoint never becomes usable again.
CREATE TRIGGER backup_checkpoints_expired_final BEFORE UPDATE OF status ON backup_checkpoints
WHEN OLD.status='expired' AND NEW.status!='expired'
BEGIN
  SELECT RAISE(ABORT,'backup_immutable');
END;
