-- Phase 2 background processing: privacy policies, durable summarize jobs, coverage,
-- generated candidates, optional evaluator signals and the call budget ledger.
-- Everything here is inert until an operator names `processing` in MAINTENANCE_TASKS
-- AND a reviewer enables the workspace policy. Ingest never reads or writes these tables,
-- and no table here declares a foreign key to events, so retention stays possible.

-- Workspace row ('*') is a ceiling: effective booleans are workspace AND project,
-- effective field sets are the intersection. A missing workspace row means all off.
CREATE TABLE processing_policies (
  scope_type TEXT NOT NULL CHECK(scope_type IN ('workspace','project')),
  scope_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  external_allowed INTEGER NOT NULL CHECK(external_allowed IN (0,1)),
  jev_enabled INTEGER NOT NULL CHECK(jev_enabled IN (0,1)),
  summary_fields TEXT NOT NULL CHECK(json_valid(summary_fields) AND json_type(summary_fields)='array'),
  external_fields TEXT NOT NULL CHECK(json_valid(external_fields) AND json_type(external_fields)='array'),
  min_new_events INTEGER NOT NULL CHECK(min_new_events BETWEEN 1 AND 1000),
  quiet_minutes INTEGER NOT NULL CHECK(quiet_minutes BETWEEN 0 AND 1440),
  max_events_per_job INTEGER NOT NULL CHECK(max_events_per_job BETWEEN 1 AND 200),
  jev_skip_threshold REAL CHECK(jev_skip_threshold IS NULL OR jev_skip_threshold BETWEEN 0 AND 1),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY(scope_type,scope_id),
  CHECK((scope_type='workspace' AND scope_id='*') OR (scope_type='project' AND length(scope_id)=64))
);
CREATE TRIGGER processing_policy_project_exists BEFORE INSERT ON processing_policies
WHEN NEW.scope_type='project' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.scope_id)
BEGIN
  SELECT RAISE(ABORT,'processing_policy_project');
END;
CREATE TRIGGER processing_policies_no_delete BEFORE DELETE ON processing_policies
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TABLE processing_policy_audit (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  policy TEXT NOT NULL CHECK(json_valid(policy)),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  UNIQUE(scope_type,scope_id,version)
);
CREATE INDEX processing_policy_audit_recent ON processing_policy_audit(scope_type,scope_id,created_at DESC,id DESC);
CREATE TRIGGER processing_policy_audit_no_update BEFORE UPDATE ON processing_policy_audit
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_policy_audit_no_delete BEFORE DELETE ON processing_policy_audit
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- One deterministic job per (scope, exact source set, effective policy hash, processor).
-- id = sha256(stableJSON(['summarize',scope_key,source_set_hash,policy_hash,processor_version])).
CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY CHECK(length(id)=64),
  kind TEXT NOT NULL CHECK(kind IN ('summarize')),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('task','project')),
  scope_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  scope_key TEXT NOT NULL CHECK(length(scope_key)=64),
  source_set_hash TEXT NOT NULL CHECK(length(source_set_hash)=64),
  policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64),
  processor_version TEXT NOT NULL CHECK(length(processor_version) BETWEEN 1 AND 64),
  -- sha256 of the run-time projection plus policy hash; audit only, never part of the identity.
  input_hash TEXT CHECK(input_hash IS NULL OR length(input_hash)=64),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','skipped','failed','dismissed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  max_attempts INTEGER NOT NULL DEFAULT 4 CHECK(max_attempts BETWEEN 1 AND 10),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  result_context_id TEXT REFERENCES context_entries(id),
  -- Short codes only: never event content, provider bodies or credential values.
  skip_reason TEXT CHECK(skip_reason IS NULL OR (length(skip_reason) BETWEEN 1 AND 64 AND skip_reason NOT GLOB '*[^a-z0-9_.:-]*')),
  last_error TEXT CHECK(last_error IS NULL OR (length(last_error) BETWEEN 1 AND 64 AND last_error NOT GLOB '*[^a-z0-9_.:-]*')),
  note TEXT CHECK(note IS NULL OR (length(note) BETWEEN 1 AND 64 AND note NOT GLOB '*[^a-z0-9_.:-]*')),
  source_count INTEGER NOT NULL CHECK(source_count BETWEEN 1 AND 200),
  event_count INTEGER CHECK(event_count IS NULL OR event_count BETWEEN 0 AND 200),
  excluded_count INTEGER CHECK(excluded_count IS NULL OR excluded_count BETWEEN 0 AND 200),
  first_event_at TEXT,
  last_event_at TEXT,
  planned_by TEXT NOT NULL CHECK(length(planned_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((scope_type='task' AND task_id IS NOT NULL AND task_id=scope_id)
    OR (scope_type='project' AND task_id IS NULL AND scope_id=project_id)),
  CHECK(status!='succeeded' OR result_context_id IS NOT NULL),
  CHECK(status!='skipped' OR skip_reason IS NOT NULL)
);
-- At most one live (or failed, awaiting a reviewer) job per scope.
CREATE UNIQUE INDEX processing_jobs_live ON processing_jobs(scope_key) WHERE status IN ('queued','running','failed');
CREATE INDEX processing_jobs_scope ON processing_jobs(scope_key,created_at DESC,id DESC);
CREATE INDEX processing_jobs_due ON processing_jobs(status,next_attempt_at,id);
CREATE INDEX processing_jobs_lease ON processing_jobs(status,lease_until,id);
CREATE INDEX processing_jobs_recent ON processing_jobs(created_at DESC,id DESC);
CREATE INDEX processing_jobs_status_recent ON processing_jobs(status,created_at DESC,id DESC);
CREATE INDEX processing_jobs_project_recent ON processing_jobs(project_id,created_at DESC,id DESC);
CREATE INDEX processing_jobs_task_recent ON processing_jobs(task_id,created_at DESC,id DESC);
CREATE TRIGGER processing_jobs_identity_immutable BEFORE UPDATE OF id,kind,scope_type,scope_id,project_id,task_id,scope_key,source_set_hash,policy_hash,processor_version,source_count,created_at ON processing_jobs
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.scope_type IS NOT OLD.scope_type
  OR NEW.scope_id IS NOT OLD.scope_id OR NEW.project_id IS NOT OLD.project_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.scope_key IS NOT OLD.scope_key OR NEW.source_set_hash IS NOT OLD.source_set_hash
  OR NEW.policy_hash IS NOT OLD.policy_hash OR NEW.processor_version IS NOT OLD.processor_version
  OR NEW.source_count IS NOT OLD.source_count OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
-- Identical inputs are never re-processed: a finished job only returns to the queue
-- when it ended before doing any work because policy or scope changed under it.
CREATE TRIGGER processing_jobs_transition BEFORE UPDATE OF status ON processing_jobs
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status='queued' AND NEW.status IN ('running','dismissed'))
  OR (OLD.status='running' AND NEW.status IN ('queued','succeeded','skipped','failed'))
  OR (OLD.status='failed' AND NEW.status IN ('queued','dismissed'))
  OR (OLD.status='skipped' AND NEW.status='queued' AND OLD.skip_reason IN ('policy_changed','scope_changed'))
)
BEGIN
  SELECT RAISE(ABORT,'processing_job_transition');
END;
CREATE TRIGGER processing_jobs_no_delete BEFORE DELETE ON processing_jobs
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- Every completion batch starts with an insert here. It aborts the whole D1 batch
-- unless the caller still holds the job lease, and the row never persists.
CREATE TABLE processing_job_fence (
  job_id TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE TRIGGER processing_job_fence_check BEFORE INSERT ON processing_job_fence
WHEN NOT EXISTS(SELECT 1 FROM processing_jobs WHERE id=NEW.job_id AND status='running'
  AND lease_owner=NEW.lease_owner AND attempts=NEW.attempts)
BEGIN
  SELECT RAISE(ABORT,'processing_lease_lost');
END;
CREATE TRIGGER processing_job_fence_clear AFTER INSERT ON processing_job_fence
BEGIN
  DELETE FROM processing_job_fence WHERE rowid=NEW.rowid;
END;

-- The exact events selected at plan time (indexed payload hash), bounded to 200.
CREATE TABLE processing_job_sources (
  job_id TEXT NOT NULL REFERENCES processing_jobs(id),
  event_id TEXT NOT NULL CHECK(length(event_id)=64),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 199),
  PRIMARY KEY(job_id,event_id),
  UNIQUE(job_id,ordinal)
);
CREATE INDEX processing_job_sources_event ON processing_job_sources(event_id,payload_hash);
CREATE TRIGGER processing_job_sources_no_update BEFORE UPDATE ON processing_job_sources
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_job_sources_no_delete BEFORE DELETE ON processing_job_sources
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- Coverage replaces a timestamp watermark: an event is pending for a scope until a
-- succeeded or skipped job of that scope covers it, whatever its timestamp or arrival.
CREATE TABLE processing_coverage (
  scope_key TEXT NOT NULL CHECK(length(scope_key)=64),
  event_id TEXT NOT NULL CHECK(length(event_id)=64),
  job_id TEXT NOT NULL REFERENCES processing_jobs(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope_key,event_id)
);
CREATE INDEX processing_coverage_job ON processing_coverage(job_id);
CREATE TRIGGER processing_coverage_no_update BEFORE UPDATE ON processing_coverage
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_coverage_no_delete BEFORE DELETE ON processing_coverage
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- Rotating planner cursor over scope keys ('p:<project>' / 't:<task>:<project>'),
-- advanced by compare-and-swap so overlapping invocations never fight over it.
CREATE TABLE processing_scan_cursor (
  id INTEGER PRIMARY KEY CHECK(id=1),
  scan_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO processing_scan_cursor(id,scan_key,updated_at) VALUES(1,'','1970-01-01T00:00:00.000Z');

CREATE TABLE processing_job_audit (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('run','retry','dismiss')),
  reason TEXT CHECK(reason IS NULL OR length(reason)<=2000),
  created_at TEXT NOT NULL
);
CREATE INDEX processing_job_audit_job ON processing_job_audit(job_id,created_at,id);
CREATE TRIGGER processing_job_audit_no_update BEFORE UPDATE ON processing_job_audit
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_job_audit_no_delete BEFORE DELETE ON processing_job_audit
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- A generated candidate is inserted in the same D1 batch as this row; the UNIQUE job_id
-- rolls back a second candidate for the same job. previous_context_id chains successive
-- summaries of one scope without using supersedes_id (delta summaries do not replace).
CREATE TABLE context_generation (
  context_id TEXT PRIMARY KEY REFERENCES context_entries(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES processing_jobs(id),
  processor TEXT NOT NULL CHECK(length(processor) BETWEEN 1 AND 64),
  scope_key TEXT NOT NULL CHECK(length(scope_key)=64),
  previous_context_id TEXT REFERENCES context_entries(id),
  created_at TEXT NOT NULL
);
CREATE INDEX context_generation_scope ON context_generation(scope_key,created_at DESC,context_id DESC);
CREATE TRIGGER context_generation_shape BEFORE INSERT ON context_generation
WHEN NOT EXISTS(SELECT 1 FROM context_entries c WHERE c.id=NEW.context_id AND c.kind='summary'
    AND c.supersedes_id IS NULL AND c.status='pending' AND c.sealed=1)
  OR NOT EXISTS(SELECT 1 FROM context_audit a WHERE a.context_id=NEW.context_id AND a.action='create'
    AND a.actor LIKE 'pipeline:%')
BEGIN
  SELECT RAISE(ABORT,'context_generation_invalid');
END;
CREATE TRIGGER context_generation_no_update BEFORE UPDATE ON context_generation
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;
CREATE TRIGGER context_generation_no_delete BEFORE DELETE ON context_generation
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;
-- Background processors never hold review authority, at the database level too.
CREATE TRIGGER context_pipeline_cannot_review BEFORE UPDATE OF status ON context_entries
WHEN NEW.status IN ('approved','rejected') AND NEW.reviewed_by LIKE 'pipeline:%'
BEGIN
  SELECT RAISE(ABORT,'context_review_forbidden');
END;

-- Optional evaluator answers. Probabilities are stored uncalibrated (calibrated=0)
-- and never approve, edit or delete anything.
CREATE TABLE processing_signals (
  job_id TEXT NOT NULL REFERENCES processing_jobs(id),
  question_id TEXT NOT NULL CHECK(question_id IN ('new_information','task_related')
    OR (question_id GLOB 'contradiction:*' AND length(question_id)=50)),
  probability REAL NOT NULL CHECK(probability BETWEEN 0 AND 1),
  confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
  evaluator TEXT NOT NULL CHECK(length(evaluator) BETWEEN 1 AND 64),
  model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 128),
  calibrated INTEGER NOT NULL DEFAULT 0 CHECK(calibrated IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id,question_id)
);
CREATE TRIGGER processing_signals_no_update BEFORE UPDATE ON processing_signals
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_signals_no_delete BEFORE DELETE ON processing_signals
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- Budget ledger for external calls. A reservation counts toward the daily budget
-- whatever its outcome; an uncertain outcome stays outcome_unknown, never success.
CREATE TABLE processing_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES processing_jobs(id),
  provider TEXT NOT NULL CHECK(provider IN ('jev','generator')),
  model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 128),
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  status TEXT NOT NULL CHECK(status IN ('reserved','succeeded','failed','outcome_unknown')),
  day TEXT NOT NULL CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  input_chars INTEGER NOT NULL CHECK(input_chars>=0),
  estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens>=0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  -- Provider-reported cost only; never derived from local price tables.
  reported_cost_usd REAL CHECK(reported_cost_usd IS NULL OR reported_cost_usd>=0),
  error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^a-z0-9_.:-]*')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(job_id,provider,attempt)
);
CREATE INDEX processing_calls_day ON processing_calls(day,provider);
CREATE INDEX processing_calls_reserved ON processing_calls(status,started_at);
CREATE INDEX processing_calls_job ON processing_calls(job_id,started_at,id);
CREATE TRIGGER processing_calls_identity_immutable BEFORE UPDATE OF id,job_id,provider,model,attempt,day,input_chars,estimated_tokens,started_at ON processing_calls
WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.provider IS NOT OLD.provider
  OR NEW.model IS NOT OLD.model OR NEW.attempt IS NOT OLD.attempt OR NEW.day IS NOT OLD.day
  OR NEW.input_chars IS NOT OLD.input_chars OR NEW.estimated_tokens IS NOT OLD.estimated_tokens
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_calls_transition BEFORE UPDATE OF status ON processing_calls
WHEN NEW.status IS NOT OLD.status AND NOT (OLD.status='reserved' AND NEW.status IN ('succeeded','failed','outcome_unknown'))
BEGIN
  SELECT RAISE(ABORT,'processing_call_transition');
END;
CREATE TRIGGER processing_calls_no_delete BEFORE DELETE ON processing_calls
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- Single-row budget; an absent row means every limit is zero (external calls disabled).
CREATE TABLE processing_budget (
  id INTEGER PRIMARY KEY CHECK(id=1),
  daily_call_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_call_limit BETWEEN 0 AND 10000),
  daily_token_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_token_limit BETWEEN 0 AND 100000000),
  daily_usd_ceiling REAL CHECK(daily_usd_ceiling IS NULL OR daily_usd_ceiling>=0),
  max_input_chars INTEGER NOT NULL DEFAULT 20000 CHECK(max_input_chars BETWEEN 1000 AND 200000),
  max_output_tokens INTEGER NOT NULL DEFAULT 512 CHECK(max_output_tokens BETWEEN 1 AND 8192),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK(timeout_ms BETWEEN 1000 AND 30000),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 128)
);
CREATE TRIGGER processing_budget_no_delete BEFORE DELETE ON processing_budget
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TABLE processing_budget_audit (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  budget TEXT NOT NULL CHECK(json_valid(budget)),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
);
CREATE TRIGGER processing_budget_audit_no_update BEFORE UPDATE ON processing_budget_audit
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;
CREATE TRIGGER processing_budget_audit_no_delete BEFORE DELETE ON processing_budget_audit
BEGIN
  SELECT RAISE(ABORT,'processing_immutable');
END;

-- Planner selection orders a project's runtime events oldest-first by (timestamp,id).
CREATE INDEX events_project_order ON events(project_id,timestamp,id);
