-- Phase 3 revisions: validity windows, review flags and cross-project shares.
-- Validity is derived (valid_from = approval time, valid_until = the approval time of
-- the revision that superseded it), so no context column changes. A flag or a share
-- never edits, approves, publishes or deletes a note: resolving a flag records a
-- reason, and a correction is a new revision through the existing supersede flow.
-- Ingest never reads or writes these tables.

-- Revision chains and validity windows look up children by supersedes_id.
CREATE INDEX context_entries_supersedes ON context_entries(supersedes_id);

-- A flag asks a reviewer to look at one approved entry again. Origin `jev` comes only
-- from that entry's own per-entry evaluator answer (contradiction:<id> >= 0.5) in a job
-- of the entry's project; origin `reviewer` comes from REVIEW_TOKEN. No FK to events or
-- processing tables: evidence is checked to exist at creation, and retention refuses to
-- delete a batch that an open flag cites.
CREATE TABLE context_flags (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES context_entries(id),
  kind TEXT NOT NULL CHECK(kind IN ('contradiction','needs_review')),
  origin TEXT NOT NULL CHECK(origin IN ('jev','reviewer')),
  job_id TEXT CHECK(job_id IS NULL OR length(job_id)=64),
  -- 0–20 exact {event_id,payload_hash} pairs (at least one for origin jev).
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence)='array' AND json_array_length(evidence)<=20),
  note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 128),
  resolved_at TEXT,
  resolved_by TEXT CHECK(resolved_by IS NULL OR length(resolved_by) BETWEEN 1 AND 128),
  resolution_reason TEXT CHECK(resolution_reason IS NULL OR length(resolution_reason) BETWEEN 1 AND 2000),
  CHECK((status='open' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL)
    OR (status!='open' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_reason IS NOT NULL)),
  CHECK((origin='jev' AND kind='contradiction' AND job_id IS NOT NULL AND created_by LIKE 'pipeline:%')
    OR (origin='reviewer' AND job_id IS NULL AND created_by NOT LIKE 'pipeline:%'))
);
-- One flag per job and entry: a replayed or retried job never adds a second.
CREATE UNIQUE INDEX context_flags_job_entry ON context_flags(job_id,context_id) WHERE job_id IS NOT NULL;
CREATE INDEX context_flags_entry ON context_flags(context_id,status,created_at,id);
-- Open flags for health and for retention's evidence check.
CREATE INDEX context_flags_status ON context_flags(status,created_at,id);

CREATE TRIGGER context_flags_initial_state BEFORE INSERT ON context_flags
WHEN NEW.status!='open' OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by IS NOT NULL OR NEW.resolution_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'context_flag_invalid_state');
END;

-- Only a current approved entry can be flagged; an evaluator flag needs its job's own
-- per-entry answer at or above 0.5 for an entry of the job's project.
CREATE TRIGGER context_flags_target BEFORE INSERT ON context_flags
WHEN NOT EXISTS(SELECT 1 FROM context_entries c WHERE c.id=NEW.context_id AND c.sealed=1 AND c.status='approved')
  OR (NEW.origin='jev' AND NOT EXISTS(SELECT 1 FROM processing_jobs j
    JOIN context_entries c ON c.id=NEW.context_id AND c.project_id=j.project_id
    JOIN processing_signals s ON s.job_id=j.id AND s.question_id='contradiction:'||NEW.context_id AND s.probability>=0.5
    WHERE j.id=NEW.job_id))
BEGIN
  SELECT RAISE(ABORT,'context_flag_target');
END;

-- Evidence is a set of exact event versions that exist when the flag is created.
CREATE TRIGGER context_flags_evidence BEFORE INSERT ON context_flags
WHEN (NEW.origin='jev' AND json_array_length(NEW.evidence)=0)
  OR (SELECT COUNT(DISTINCT json_extract(value,'$.event_id')||':'||json_extract(value,'$.payload_hash')) FROM json_each(NEW.evidence))
    !=json_array_length(NEW.evidence)
  OR EXISTS(SELECT 1 FROM json_each(NEW.evidence) j WHERE j.type!='object' OR (SELECT COUNT(*) FROM json_each(j.value))!=2
    OR NOT EXISTS(SELECT 1 FROM event_versions v WHERE v.event_id=json_extract(j.value,'$.event_id')
      AND v.payload_hash=json_extract(j.value,'$.payload_hash')))
BEGIN
  SELECT RAISE(ABORT,'context_flag_evidence');
END;

-- The only change: open -> resolved|dismissed, once, with a reason. Everything else is immutable.
CREATE TRIGGER context_flags_resolve_only BEFORE UPDATE ON context_flags
WHEN NOT (OLD.status='open' AND NEW.status IN ('resolved','dismissed') AND NEW.resolved_at IS NOT NULL
  AND NEW.resolved_by IS NOT NULL AND NEW.resolution_reason IS NOT NULL AND length(trim(NEW.resolution_reason))>0
  AND NEW.id IS OLD.id AND NEW.context_id IS OLD.context_id AND NEW.kind IS OLD.kind AND NEW.origin IS OLD.origin
  AND NEW.job_id IS OLD.job_id AND NEW.evidence IS OLD.evidence AND NEW.note IS OLD.note
  AND NEW.created_at IS OLD.created_at AND NEW.created_by IS OLD.created_by)
BEGIN
  SELECT RAISE(ABORT,'context_flag_immutable');
END;

-- Background processors raise flags but never hold the authority to close one.
CREATE TRIGGER context_flags_pipeline_cannot_resolve BEFORE UPDATE OF status ON context_flags
WHEN NEW.resolved_by LIKE 'pipeline:%'
BEGIN
  SELECT RAISE(ABORT,'context_flag_resolution_forbidden');
END;

CREATE TRIGGER context_flags_no_delete BEFORE DELETE ON context_flags
BEGIN
  SELECT RAISE(ABORT,'context_flag_immutable');
END;

CREATE TABLE context_flag_audit (
  id TEXT PRIMARY KEY,
  flag_id TEXT NOT NULL REFERENCES context_flags(id),
  context_id TEXT NOT NULL REFERENCES context_entries(id),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('create','resolve','dismiss')),
  reason TEXT CHECK(reason IS NULL OR length(reason)<=2000),
  created_at TEXT NOT NULL
);
CREATE INDEX context_flag_audit_flag ON context_flag_audit(flag_id,created_at,id);

-- The database writes the audit rows, so no flag or resolution can skip them.
CREATE TRIGGER context_flags_after_create AFTER INSERT ON context_flags
BEGIN
  INSERT INTO context_flag_audit(id,flag_id,context_id,actor,action,reason,created_at)
    VALUES(NEW.id||':create',NEW.id,NEW.context_id,NEW.created_by,'create',NULL,NEW.created_at);
END;

CREATE TRIGGER context_flags_after_resolve AFTER UPDATE OF status ON context_flags
WHEN OLD.status='open' AND NEW.status IN ('resolved','dismissed')
BEGIN
  INSERT INTO context_flag_audit(id,flag_id,context_id,actor,action,reason,created_at)
    VALUES(NEW.id||':'||CASE NEW.status WHEN 'resolved' THEN 'resolve' ELSE 'dismiss' END,NEW.id,NEW.context_id,NEW.resolved_by,
      CASE NEW.status WHEN 'resolved' THEN 'resolve' ELSE 'dismiss' END,NEW.resolution_reason,NEW.resolved_at);
END;

CREATE TRIGGER context_flag_audit_immutable_update BEFORE UPDATE ON context_flag_audit
BEGIN
  SELECT RAISE(ABORT,'context_flag_audit_immutable');
END;
CREATE TRIGGER context_flag_audit_immutable_delete BEFORE DELETE ON context_flag_audit
BEGIN
  SELECT RAISE(ABORT,'context_flag_audit_immutable');
END;

-- A reviewer shares one approved, authoritative memory with another project. Reads
-- re-check authority every time: a superseded entry, or one whose sources left its
-- scope, is no longer served anywhere even while the share row stays active.
-- Project targets only; immutable except for one revocation.
CREATE TABLE context_shares (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES context_entries(id),
  target_type TEXT NOT NULL CHECK(target_type IN ('project')),
  target_id TEXT NOT NULL REFERENCES projects(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 128 AND created_by NOT LIKE 'pipeline:%'),
  revoked_at TEXT,
  revoked_by TEXT CHECK(revoked_by IS NULL OR (length(revoked_by) BETWEEN 1 AND 128 AND revoked_by NOT LIKE 'pipeline:%')),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
-- One active share per entry and target; also serves the per-entry lookup.
CREATE UNIQUE INDEX context_shares_active ON context_shares(context_id,target_type,target_id) WHERE revoked_at IS NULL;
CREATE INDEX context_shares_target ON context_shares(target_type,target_id,revoked_at);
CREATE INDEX context_shares_entry ON context_shares(context_id,created_at,id);

CREATE TRIGGER context_shares_target_check BEFORE INSERT ON context_shares
WHEN NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NOT EXISTS(SELECT 1 FROM context_entries c
  WHERE c.id=NEW.context_id AND c.sealed=1 AND c.status='approved' AND c.kind='memory' AND c.project_id!=NEW.target_id
    AND NOT EXISTS(SELECT 1 FROM context_sources s JOIN events e ON e.id=s.event_id
      WHERE s.context_id=c.id AND (e.project_id!=c.project_id OR (c.task_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM task_sessions ts WHERE ts.task_id=c.task_id AND ts.session_id=e.session_id)))))
BEGIN
  SELECT RAISE(ABORT,'context_share_invalid');
END;

CREATE TRIGGER context_shares_revoke_only BEFORE UPDATE ON context_shares
WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.context_id IS OLD.context_id AND NEW.target_type IS OLD.target_type
  AND NEW.target_id IS OLD.target_id AND NEW.created_at IS OLD.created_at AND NEW.created_by IS OLD.created_by)
BEGIN
  SELECT RAISE(ABORT,'context_share_immutable');
END;

CREATE TRIGGER context_shares_no_delete BEFORE DELETE ON context_shares
BEGIN
  SELECT RAISE(ABORT,'context_share_immutable');
END;

CREATE TABLE context_share_audit (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES context_shares(id),
  context_id TEXT NOT NULL REFERENCES context_entries(id),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('create','revoke')),
  created_at TEXT NOT NULL
);
CREATE INDEX context_share_audit_share ON context_share_audit(share_id,created_at,id);

CREATE TRIGGER context_shares_after_create AFTER INSERT ON context_shares
BEGIN
  INSERT INTO context_share_audit(id,share_id,context_id,actor,action,created_at)
    VALUES(NEW.id||':create',NEW.id,NEW.context_id,NEW.created_by,'create',NEW.created_at);
END;

CREATE TRIGGER context_shares_after_revoke AFTER UPDATE OF revoked_at ON context_shares
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO context_share_audit(id,share_id,context_id,actor,action,created_at)
    VALUES(NEW.id||':revoke',NEW.id,NEW.context_id,NEW.revoked_by,'revoke',NEW.revoked_at);
END;

CREATE TRIGGER context_share_audit_immutable_update BEFORE UPDATE ON context_share_audit
BEGIN
  SELECT RAISE(ABORT,'context_share_audit_immutable');
END;
CREATE TRIGGER context_share_audit_immutable_delete BEFORE DELETE ON context_share_audit
BEGIN
  SELECT RAISE(ABORT,'context_share_audit_immutable');
END;

-- A device subscription may also carry entries other projects shared with its project.
-- Like the kinds, it is fixed for the life of the grant: change it by revoking and
-- creating a new subscription, so every grant keeps its own audit. This trigger adds
-- include_shared to device_sync_revoke_only's immutable set without recreating it.
ALTER TABLE device_sync_subscriptions ADD COLUMN include_shared INTEGER NOT NULL DEFAULT 0 CHECK(include_shared IN (0,1));
CREATE TRIGGER device_sync_include_shared_immutable BEFORE UPDATE ON device_sync_subscriptions
WHEN NEW.include_shared IS NOT OLD.include_shared
BEGIN
  SELECT RAISE(ABORT,'sync_subscription_immutable');
END;
