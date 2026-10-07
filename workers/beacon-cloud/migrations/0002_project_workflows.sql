-- Explicit grouping and task links never replace project or session identities.
CREATE TABLE project_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_group_members (
  group_id TEXT NOT NULL REFERENCES project_groups(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY(group_id,project_id)
);
CREATE TABLE project_relations (
  id TEXT PRIMARY KEY,
  from_project_id TEXT NOT NULL REFERENCES projects(id),
  to_project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK(type IN ('depends_on','shares_service','fork_of')),
  created_at TEXT NOT NULL,
  CHECK(from_project_id != to_project_id),
  UNIQUE(from_project_id,to_project_id,type)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_sessions (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY(task_id,session_id)
);
-- Actor identifiers are supplied by reviewer authentication, never a request body.
CREATE TABLE project_workflow_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX project_groups_recent ON project_groups(created_at DESC,id DESC);
CREATE INDEX group_members_recent ON project_group_members(group_id,linked_at DESC,project_id DESC);
CREATE INDEX group_members_project ON project_group_members(project_id,group_id);
CREATE INDEX project_relations_recent ON project_relations(created_at DESC,id DESC);
CREATE INDEX project_relations_from ON project_relations(from_project_id,created_at DESC,id DESC);
CREATE INDEX project_relations_to ON project_relations(to_project_id,created_at DESC,id DESC);
CREATE INDEX tasks_recent ON tasks(created_at DESC,id DESC);
CREATE INDEX tasks_status_recent ON tasks(status,created_at DESC,id DESC);
CREATE INDEX task_sessions_recent ON task_sessions(task_id,linked_at DESC,session_id DESC);
CREATE INDEX task_sessions_session ON task_sessions(session_id,task_id);
CREATE INDEX project_workflow_audit_recent ON project_workflow_audit(created_at DESC,id DESC);
