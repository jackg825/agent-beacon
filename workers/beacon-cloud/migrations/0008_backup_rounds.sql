-- Backup follow-ups to 0006. Like 0006 it acts on nothing by itself, and ingest never
-- reads or writes these columns or this table. Only adds columns, a table and indexes.

-- Rows the final snapshot re-reads (DATA-OPERATIONS.md) are counted apart from the rows
-- a chunk adds, so a manifest's table counts stay exact.
ALTER TABLE backup_chunks ADD COLUMN revisions TEXT;

-- A raw copy is content-addressed and shared by every checkpoint: the integrity pass
-- verifies it once (verified_at, reset whenever the copy is written again).
ALTER TABLE backup_raw_objects ADD COLUMN verified_at TEXT;
-- A source that was missing at copy time is looked for again, oldest check first.
ALTER TABLE backup_raw_objects ADD COLUMN checked_at TEXT;
CREATE INDEX backup_raw_unverified ON backup_raw_objects(batch_received_at,batch_id) WHERE status='copied' AND verified_at IS NULL;
CREATE INDEX backup_raw_missing_checked ON backup_raw_objects(checked_at,batch_id) WHERE status='source_missing';

-- When a forwarder replay brings a retention-deleted batch back and it is copied again,
-- the earlier copy's listing attributes are kept here, so a checkpoint that listed the
-- earlier copy keeps its membership (object route, raw_pruned_at marking).
CREATE TABLE backup_raw_generations (
  batch_id TEXT NOT NULL CHECK(length(batch_id)=64),
  copied_at TEXT NOT NULL,
  batch_received_at TEXT NOT NULL,
  superseded_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,copied_at)
);

-- Rows the final snapshot re-reads because they may have changed after their round.
CREATE INDEX context_entries_reviewed ON context_entries(reviewed_at);
CREATE INDEX retention_run_objects_raw_deleted ON retention_run_objects(raw_deleted_at);
CREATE INDEX retention_run_objects_backup_deleted ON retention_run_objects(backup_deleted_at);
