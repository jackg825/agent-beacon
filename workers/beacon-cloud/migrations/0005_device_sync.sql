-- A reviewer explicitly chooses which device may read which project's approved
-- notes. Devices cannot subscribe themselves, write context, or widen the kinds.
-- Subscriptions are immutable except for one revocation; changing kinds means
-- revoking and creating a new subscription, so every grant has its own audit.
CREATE TABLE device_sync_subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  kinds TEXT NOT NULL CHECK(kinds IN ('["memory"]','["summary"]','["memory","summary"]')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 128),
  revoked_at TEXT,
  revoked_by TEXT CHECK(revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 128),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE TABLE device_sync_audit (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES device_sync_subscriptions(id),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('create','revoke')),
  created_at TEXT NOT NULL
);
-- One active grant per device and project; also serves the per-device active count.
CREATE UNIQUE INDEX device_sync_active ON device_sync_subscriptions(device_id,project_id) WHERE revoked_at IS NULL;
CREATE INDEX device_sync_recent ON device_sync_subscriptions(created_at DESC,id DESC);
CREATE INDEX device_sync_device_recent ON device_sync_subscriptions(device_id,created_at DESC,id DESC);
CREATE INDEX device_sync_audit_subscription ON device_sync_audit(subscription_id,created_at,id);
-- Snapshot reads select one project's approved entries by kind in (kind, created_at, id) order.
CREATE INDEX context_project_snapshot ON context_entries(project_id,status,kind,created_at,id);

CREATE TRIGGER device_sync_initial_state BEFORE INSERT ON device_sync_subscriptions
WHEN NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'sync_subscription_invalid_state');
END;

CREATE TRIGGER device_sync_revoke_only BEFORE UPDATE ON device_sync_subscriptions
WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.device_id IS OLD.device_id AND NEW.project_id IS OLD.project_id
  AND NEW.kinds IS OLD.kinds AND NEW.created_at IS OLD.created_at AND NEW.created_by IS OLD.created_by)
BEGIN
  SELECT RAISE(ABORT,'sync_subscription_immutable');
END;

CREATE TRIGGER device_sync_no_delete BEFORE DELETE ON device_sync_subscriptions
BEGIN
  SELECT RAISE(ABORT,'sync_subscription_immutable');
END;

-- The audit rows are written by the database, so no grant or revocation can skip them.
CREATE TRIGGER device_sync_after_create AFTER INSERT ON device_sync_subscriptions
BEGIN
  INSERT INTO device_sync_audit(id,subscription_id,actor,action,created_at)
    VALUES(NEW.id||':create',NEW.id,NEW.created_by,'create',NEW.created_at);
END;

CREATE TRIGGER device_sync_after_revoke AFTER UPDATE OF revoked_at ON device_sync_subscriptions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO device_sync_audit(id,subscription_id,actor,action,created_at)
    VALUES(NEW.id||':revoke',NEW.id,NEW.revoked_by,'revoke',NEW.revoked_at);
END;

CREATE TRIGGER device_sync_audit_immutable_update BEFORE UPDATE ON device_sync_audit
BEGIN
  SELECT RAISE(ABORT,'sync_audit_immutable');
END;
CREATE TRIGGER device_sync_audit_immutable_delete BEFORE DELETE ON device_sync_audit
BEGIN
  SELECT RAISE(ABORT,'sync_audit_immutable');
END;
