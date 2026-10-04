import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Device, Env, HttpError } from './types';
import { mcpAuthorized, mcpOAuthEnabled } from './mcp-auth';

export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(v => v.toString(16).padStart(2, '0')).join('');
}
export function bearer(request: Request): string | null {
  return /^Bearer ([^\s]{20,512})$/i.exec(request.headers.get('Authorization') || '')?.[1] ?? null;
}
async function equalSecret(actual: string | null, expected?: string): Promise<boolean> {
  if (!actual || !expected || expected.length < 32) return false;
  const a = await digest(actual), b = await digest(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function deviceAuth(request: Request, env: Env): Promise<Device> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Device credential required');
  const device = await env.DB.prepare('SELECT id,name,token_hash,revoked FROM devices WHERE token_hash=?')
    .bind(await digest(token)).first<Device>();
  if (!device || device.revoked) throw new HttpError(401, 'Invalid device credential');
  return device;
}
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyAccess(token: string, team: string, audience: string,
  keys?: Parameters<typeof jwtVerify>[1]): Promise<boolean> {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !audience) return false;
  try {
    const issuer = `https://${team}`;
    if (!keys) {
      if (!keysets.has(team)) keysets.set(team, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
      keys = keysets.get(team)!;
    }
    await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'] });
    return true;
  } catch { return false; }
}
export async function readAuth(request: Request, env: Env, mcp = false): Promise<void> {
  if (mcp) {
    if (mcpOAuthEnabled(env)) {
      if (await mcpAuthorized(request,env)) return;
    } else if (await equalSecret(bearer(request), env.MCP_TOKEN)) return;
  } else {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (assertion && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD &&
      await verifyAccess(assertion, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD)) return;
    let token = bearer(request);
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(request.headers.get('Authorization') || '');
    if (basic) {
      try {
        const decoded = atob(basic[1]);
        if (decoded.startsWith('beacon:')) token = decoded.slice(7);
      } catch { /* Invalid Basic encoding is unauthorized. */ }
    }
    if (await equalSecret(token, env.READ_TOKEN)) return;
  }
  throw new HttpError(401, 'Read credential required');
}

export function checkOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('Origin');
  const expected = new URL(env.PUBLIC_URL || request.url).origin;
  if (origin && origin !== expected) throw new HttpError(403, 'Origin rejected');
}
