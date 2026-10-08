-- Indexes for the processing and flag rows a backup's final snapshot re-reads because
-- they may have changed after their round (DATA-OPERATIONS.md). Needs 0004 and 0007.
-- Only adds indexes.
CREATE INDEX processing_jobs_updated ON processing_jobs(updated_at);
CREATE INDEX processing_calls_finished ON processing_calls(finished_at);
CREATE INDEX context_flags_resolved ON context_flags(resolved_at);
