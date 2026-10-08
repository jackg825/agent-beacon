export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  READ_TOKEN?: string;
  MCP_TOKEN?: string;
  REVIEW_TOKEN?: string;
  MCP_OAUTH_ISSUER?: string;
  MCP_OAUTH_JWKS_URL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  PUBLIC_URL?: string;
  /** Optional separate private bucket for scheduled backups; absent means backups stay disabled. */
  BACKUP?: R2Bucket;
  /** Comma-separated maintenance task names the operator opted into; empty means none run. */
  MAINTENANCE_TASKS?: string;
  /** Shared wall-clock budget for one scheduled invocation, 1000–600000 ms (default 25000). */
  MAINTENANCE_BUDGET_MS?: string;
  BACKUP_INTERVAL_HOURS?: string;
  /** Raw retention needs a verified, integrity-checked checkpoint at most this many days old (1–90, default 7). */
  BACKUP_MAX_AGE_DAYS?: string;
  /** Days a retention-deleted batch's BACKUP copy is kept before the backup task removes it (0–365, default 30). */
  BACKUP_RETENTION_GRACE_DAYS?: string;
  /**
   * Deploy-time gate for any outbound model call: comma-separated central project IDs or `*`.
   * Absent means no external call happens, whatever the stored processing policy says.
   */
  EXTERNAL_PROCESSING_PROJECTS?: string;
  /** Optional TypeSafe Jev System One evaluator; used only when the gate, policy and budget allow. */
  JEV_API_KEY?: string;
  JEV_ENDPOINT?: string;
  JEV_MODEL?: string;
}

export type RecordData = Record<string, unknown>;
export interface Device { id: string; name: string; token_hash: string; revoked: number }
export class HttpError extends Error {
  constructor(public status: number, message: string,
    public authError?: 'invalid_token' | 'insufficient_scope') { super(message); }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
