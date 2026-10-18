-- Context is an explicitly reviewed derivative of immutable event versions.
-- No model calls, raw-data deletion, file publication, or automatic approval.
CREATE TABLE context_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('summary','memory')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','superseded')),
  supersedes_id TEXT REFERENCES context_entries(id),
  created_at TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1)),
  review_id TEXT UNIQUE,
  reviewed_at TEXT,
  reviewed_by TEXT,
  review_reason TEXT,
  CHECK((status='pending' AND review_id IS NULL AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status!='pending' AND review_id IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE TABLE context_sources (
  context_id TEXT NOT NULL REFERENCES context_entries(id),
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19),
  PRIMARY KEY(context_id,event_id,payload_hash),
  UNIQUE(context_id,ordinal),
  FOREIGN KEY(event_id,payload_hash) REFERENCES event_versions(event_id,payload_hash)
);
CREATE TABLE context_audit (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES context_entries(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','approve','reject','supersede')),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX context_recent ON context_entries(status,created_at DESC,id DESC);
CREATE INDEX context_project_recent ON context_entries(project_id,status,created_at DESC,id DESC);
CREATE INDEX context_task_recent ON context_entries(task_id,status,created_at DESC,id DESC);
CREATE INDEX context_audit_entry ON context_audit(context_id,created_at,id);
CREATE INDEX context_sources_event ON context_sources(event_id,payload_hash);

CREATE TRIGGER context_initial_state BEFORE INSERT ON context_entries
WHEN NEW.status!='pending' OR NEW.sealed!=0 OR NEW.review_id IS NOT NULL
  OR NEW.reviewed_at IS NOT NULL OR NEW.reviewed_by IS NOT NULL OR NEW.review_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'context_invalid_state');
END;

CREATE TRIGGER context_revision_scope BEFORE INSERT ON context_entries
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_entries parent WHERE parent.id=NEW.supersedes_id
    AND parent.status='approved' AND parent.kind=NEW.kind AND parent.project_id=NEW.project_id
    AND parent.task_id IS NEW.task_id
)
BEGIN
  SELECT RAISE(ABORT,'context_stale_revision');
END;

CREATE TRIGGER context_content_immutable BEFORE UPDATE OF id,kind,project_id,task_id,title,content,supersedes_id,created_at ON context_entries
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.project_id IS NOT OLD.project_id
  OR NEW.task_id IS NOT OLD.task_id OR NEW.title IS NOT OLD.title OR NEW.content IS NOT OLD.content
  OR NEW.supersedes_id IS NOT OLD.supersedes_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;

CREATE TRIGGER context_source_check BEFORE INSERT ON context_sources
WHEN NOT EXISTS (
  SELECT 1 FROM context_entries c JOIN events e ON e.id=NEW.event_id
    JOIN event_versions v ON v.event_id=e.id AND v.payload_hash=NEW.payload_hash
  WHERE c.id=NEW.context_id AND c.sealed=0 AND c.status='pending' AND e.project_id=c.project_id
    AND (c.task_id IS NULL OR EXISTS (
      SELECT 1 FROM task_sessions ts WHERE ts.task_id=c.task_id AND ts.session_id=e.session_id
    ))
) OR (SELECT COUNT(*) FROM context_sources WHERE context_id=NEW.context_id)>=20
BEGIN
  SELECT RAISE(ABORT,'context_invalid_source');
END;

CREATE TRIGGER context_sources_immutable_update BEFORE UPDATE ON context_sources
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;
CREATE TRIGGER context_sources_immutable_delete BEFORE DELETE ON context_sources
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;

CREATE TRIGGER context_seal_guard BEFORE UPDATE OF sealed ON context_entries
WHEN NOT (OLD.sealed=0 AND NEW.sealed=1 AND OLD.status='pending'
  AND (SELECT COUNT(*) FROM context_sources WHERE context_id=OLD.id) BETWEEN 1 AND 20)
BEGIN
  SELECT RAISE(ABORT,'context_invalid_state');
END;

CREATE TRIGGER context_review_guard BEFORE UPDATE OF status ON context_entries
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status='pending' AND NEW.status IN ('approved','rejected') AND OLD.sealed=1
    AND NEW.review_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL AND NEW.reviewed_by IS NOT NULL)
  OR (OLD.status='approved' AND NEW.status='superseded' AND EXISTS (
    SELECT 1 FROM context_entries child WHERE child.supersedes_id=OLD.id AND child.status='approved'
  ))
)
BEGIN
  SELECT RAISE(ABORT,'context_review_conflict');
END;

-- Repeat provenance and current-parent checks inside the review transaction:
-- a concurrent reviewer or repository-identity upgrade cannot bypass preflight.
CREATE TRIGGER context_approval_guard BEFORE UPDATE OF status ON context_entries
WHEN NEW.status='approved' AND OLD.status='pending' AND (
  (NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_entries parent WHERE parent.id=NEW.supersedes_id AND parent.status='approved'
  )) OR EXISTS (
    SELECT 1 FROM context_sources s JOIN events e ON e.id=s.event_id
    WHERE s.context_id=NEW.id AND (e.project_id!=NEW.project_id
      OR (NEW.task_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM task_sessions ts WHERE ts.task_id=NEW.task_id AND ts.session_id=e.session_id
      )))
  )
)
BEGIN
  SELECT RAISE(ABORT,'context_review_conflict');
END;

CREATE TRIGGER context_review_metadata_immutable BEFORE UPDATE OF review_id,reviewed_at,reviewed_by,review_reason ON context_entries
WHEN OLD.status!='pending'
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;

CREATE TRIGGER context_after_review AFTER UPDATE OF status ON context_entries
WHEN OLD.status='pending' AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO context_audit(id,context_id,actor,action,reason,created_at)
    VALUES(NEW.review_id,NEW.id,NEW.reviewed_by,
      CASE WHEN NEW.status='approved' THEN 'approve' ELSE 'reject' END,NEW.review_reason,NEW.reviewed_at);
  UPDATE context_entries SET status='superseded'
    WHERE id=NEW.supersedes_id AND status='approved' AND NEW.status='approved';
  INSERT INTO context_audit(id,context_id,actor,action,reason,created_at)
    SELECT NEW.review_id||':supersede',NEW.supersedes_id,NEW.reviewed_by,'supersede',NEW.review_reason,NEW.reviewed_at
    WHERE NEW.supersedes_id IS NOT NULL AND NEW.status='approved';
END;

CREATE TRIGGER context_entries_no_delete BEFORE DELETE ON context_entries
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;
CREATE TRIGGER context_audit_immutable_update BEFORE UPDATE ON context_audit
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;
CREATE TRIGGER context_audit_immutable_delete BEFORE DELETE ON context_audit
BEGIN
  SELECT RAISE(ABORT,'context_immutable');
END;
