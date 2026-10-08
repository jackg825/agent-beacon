-- Revision lookups (validity windows, revision history, the supersede triggers) find an
-- entry's children by supersedes_id. 0007 indexed every row, and most rows have no parent:
-- once statistics exist (any ANALYZE), that index looks useless and the planner scans the
-- table for every evaluated row. Counting only revisions keeps the index selective, and
-- carrying status and reviewed_at answers a validity window from the index alone.
-- `child.supersedes_id=<id>` implies supersedes_id IS NOT NULL, so every lookup can use it.
-- Only replaces an index.
DROP INDEX IF EXISTS context_entries_supersedes;
CREATE INDEX context_entries_supersedes ON context_entries(supersedes_id,status,reviewed_at) WHERE supersedes_id IS NOT NULL;
