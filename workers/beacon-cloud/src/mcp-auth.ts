import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './types';

const requiredScope = 'beacon:read';
export type McpAuthorizationResult = 'authorized' | 'invalid_token' | 'insufficient_scope';
interface OAuthConfig { issuer: string; jwksUrl: string; resource: string; metadataUrl: string }
let remoteKeys: { url: string; resolver: JWTVerifyGetKey } | undefined;

/** Any configured OAuth field selects OAuth mode, including incomplete configuration. */
export function mcpOAuthEnabled(env: Env): boolean {
  return env.MCP_OAUTH_ISSUER !== undefined || env.MCP_OAUTH_JWKS_URL !== undefined;
}

function trustedUrl(value: string | undefined): URL {
  if (!value || value.trim() !== value) throw new Error('Invalid OAuth configuration');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid OAuth configuration');
  }
  return url;
}

function config(env: Env): OAuthConfig | undefined {
  try {
    const issuer = trustedUrl(env.MCP_OAUTH_ISSUER);
    const jwks = trustedUrl(env.MCP_OAUTH_JWKS_URL);
    const publicUrl = trustedUrl(env.PUBLIC_URL);
    if (publicUrl.pathname !== '/') return undefined;
    return {
      // Issuer comparison uses the exact configured string, as OAuth discovery requires.
      issuer: env.MCP_OAUTH_ISSUER!, jwksUrl: jwks.href,
      resource: publicUrl.origin + '/mcp',
      metadataUrl: publicUrl.origin + '/.well-known/oauth-protected-resource/mcp',
    };
  } catch { return undefined; }
}

function resolverFor(url: string): JWTVerifyGetKey {
  if (remoteKeys?.url !== url) {
    remoteKeys = { url, resolver: createRemoteJWKSet(new URL(url), {
      timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
    }) };
  }
  return remoteKeys.resolver;
}

/** Injection supplies signing keys, never a bypass of signature or claim validation. */
export function createMcpAuthorizationResult(keyResolver?: JWTVerifyGetKey) {
  return async (request: Request, env: Env): Promise<McpAuthorizationResult> => {
    const settings = config(env);
    if (!settings) return 'invalid_token';
    const header = request.headers.get('Authorization');
    if (!header || header.length > 16 * 1024) return 'invalid_token';
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(header);
    if (!match) return 'invalid_token';
    try {
      const { payload } = await jwtVerify(match[1], keyResolver || resolverFor(settings.jwksUrl), {
        algorithms: ['RS256', 'ES256'], issuer: settings.issuer, audience: settings.resource,
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 512) return 'invalid_token';
      if (typeof payload.iat !== 'number' || !Number.isInteger(payload.iat) || payload.iat < 0 || payload.iat > now) return 'invalid_token';
      if (typeof payload.exp !== 'number' || !Number.isInteger(payload.exp) || payload.exp <= payload.iat) return 'invalid_token';
      // This resource never accepts tokens also issued for a different audience.
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (audiences.length !== 1 || audiences[0] !== settings.resource) return 'invalid_token';
      // Only a fully valid resource token can produce a scope challenge. Invalid
      // signatures, audiences and claims remain authentication failures (401).
      if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(requiredScope)) return 'insufficient_scope';
      return 'authorized';
    } catch {
      // Invalid signatures, expired tokens, misconfiguration, and unavailable JWKS fail closed.
      return 'invalid_token';
    }
  };
}

export function createMcpAuthorization(keyResolver?: JWTVerifyGetKey) {
  const authorize = createMcpAuthorizationResult(keyResolver);
  return async (request: Request, env: Env): Promise<boolean> => (await authorize(request, env)) === 'authorized';
}

export const mcpAuthorizationResult = createMcpAuthorizationResult();
export const mcpAuthorized = createMcpAuthorization();

/** Metadata only advertises an explicitly configured, valid external authorization server. */
export function mcpMetadata(env: Env): Response {
  const settings = config(env);
  if (!settings) return Response.json({ error: 'MCP OAuth is not configured' }, { status: 503 });
  return Response.json({
    resource: settings.resource, authorization_servers: [settings.issuer],
    scopes_supported: [requiredScope], bearer_methods_supported: ['header'],
  }, { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}

export function mcpChallenge(env: Env, error?: 'invalid_token' | 'insufficient_scope'): string {
  const settings = config(env);
  const errorParameter = error ? 'error="' + error + '", ' : '';
  return settings
    ? 'Bearer ' + errorParameter + 'resource_metadata="' + settings.metadataUrl + '", scope="' + requiredScope + '"'
    : 'Bearer ' + errorParameter + 'realm="beacon-mcp"';
}
