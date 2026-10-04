export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  READ_TOKEN?: string;
  MCP_TOKEN?: string;
  MCP_OAUTH_ISSUER?: string;
  MCP_OAUTH_JWKS_URL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  PUBLIC_URL?: string;
}

export type RecordData = Record<string, unknown>;
export interface Device { id: string; name: string; token_hash: string; revoked: number }
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
