import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createMcpAuthorization, mcpChallenge, mcpMetadata, mcpOAuthEnabled } from '../src/mcp-auth';
import type { Env } from '../src/types';

const issuer = 'https://auth.synthetic.invalid';
const resource = 'https://beacon.synthetic.invalid/mcp';
const env = { MCP_OAUTH_ISSUER: issuer, MCP_OAUTH_JWKS_URL: issuer + '/jwks', PUBLIC_URL: 'https://beacon.synthetic.invalid' } as Env;
const now = Math.floor(Date.now() / 1000);
const rsa = await generateKeyPair('RS256');
const ec = await generateKeyPair('ES256');
const rsaJwk = { ...await exportJWK(rsa.publicKey), kid: 'synthetic-rsa', alg: 'RS256' };
const ecJwk = { ...await exportJWK(ec.publicKey), kid: 'synthetic-ec', alg: 'ES256' };
const authorized = createMcpAuthorization(createLocalJWKSet({ keys: [rsaJwk, ecJwk] }));

async function token(overrides: Record<string, unknown> = {}, algorithm = 'RS256') {
  const payload = { iss: issuer, aud: resource, sub: 'synthetic-reviewer', iat: now - 1, exp: now + 300, scope: 'beacon:read', ...overrides };
  const key = algorithm === 'ES256' ? ec.privateKey : rsa.privateKey;
  return new SignJWT(payload).setProtectedHeader({ alg: algorithm, kid: algorithm === 'ES256' ? 'synthetic-ec' : 'synthetic-rsa' }).sign(key);
}
function request(value: string) { return new Request(resource, { headers: { Authorization: 'Bearer ' + value } }); }

test('configured OAuth resource-server accepts signed scoped JWTs from its issuer', async () => {
  assert.equal(await authorized(request(await token()), env), true);
  assert.equal(await authorized(request(await token({}, 'ES256')), env), true);
  assert.equal(await authorized(request(await token({ scope: 'other:scope beacon:read' })), env), true);
});

test('OAuth resource-server rejects forged issuer/audience/scope and expired or incomplete claims', async () => {
  const variants = [
    { iss: 'https://other.synthetic.invalid' }, { aud: 'https://other.synthetic.invalid/mcp' },
    { aud: [resource, 'https://other.synthetic.invalid/mcp'] }, { scope: 'beacon:write' },
    { exp: now - 1 }, { exp: undefined }, { iat: undefined }, { iat: now + 60 },
    { sub: undefined }, { sub: '' }, { exp: now + 300.5 }, { iat: -1 },
  ];
  for (const variant of variants) assert.equal(await authorized(request(await token(variant)), env), false);
  const signed = await token();
  assert.equal(await authorized(request(signed.slice(0, -8) + 'invalidX'), env), false);
  assert.equal(await authorized(new Request(resource), env), false);
  assert.equal(await authorized(new Request(resource, { headers: { Authorization: 'Basic synthetic' } }), env), false);
});

test('OAuth mode fails closed for incomplete and untrusted configured URLs', async () => {
  assert.equal(mcpOAuthEnabled({} as Env), false);
  for (const broken of [
    { MCP_OAUTH_ISSUER: issuer }, { MCP_OAUTH_JWKS_URL: issuer + '/jwks' },
    { ...env, MCP_OAUTH_ISSUER: '' }, { ...env, MCP_OAUTH_ISSUER: 'http://auth.synthetic.invalid' },
    { ...env, MCP_OAUTH_JWKS_URL: 'http://auth.synthetic.invalid/jwks' },
    { ...env, PUBLIC_URL: 'http://beacon.synthetic.invalid' },
    { ...env, PUBLIC_URL: 'https://beacon.synthetic.invalid/private' },
    { ...env, MCP_OAUTH_ISSUER: 'https://user:password@auth.synthetic.invalid' },
  ]) {
    assert.equal(mcpOAuthEnabled(broken as Env), true);
    assert.equal(await authorized(request(await token()), broken as Env), false);
    assert.equal(mcpMetadata(broken as Env).status, 503);
    assert.equal(mcpChallenge(broken as Env), 'Bearer realm="beacon-mcp"');
  }
});

test('PRM metadata and 401 challenge identify the exact resource and external authorization server', async () => {
  const response = mcpMetadata(env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { resource, authorization_servers: [issuer], scopes_supported: ['beacon:read'], bearer_methods_supported: ['header'] });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(mcpChallenge(env), 'Bearer resource_metadata="https://beacon.synthetic.invalid/.well-known/oauth-protected-resource/mcp", scope="beacon:read"');
});
