import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real Worker OAuth metadata and challenge are resource scoped; manual token cannot bypass OAuth',async()=> {
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'oauth-test',modules:true,
    scriptPath:resolve('dist/worker.mjs'),compatibilityDate:'2026-10-01',bindings:{
      PUBLIC_URL:'https://beacon.synthetic.invalid',MCP_OAUTH_ISSUER:'https://issuer.synthetic.invalid',
      MCP_OAUTH_JWKS_URL:'https://issuer.synthetic.invalid/jwks',MCP_TOKEN:'synthetic-manual-token-disabled-00000000'}}]}));
  try {
    const metadata=await mf.dispatchFetch('https://beacon.synthetic.invalid/.well-known/oauth-protected-resource/mcp',
      {headers:{Origin:'https://synthetic-oauth-client.invalid'}});
    assert.equal(metadata.status,200); assert.equal(metadata.headers.get('Access-Control-Allow-Origin'),'*');
    assert.deepEqual(await metadata.json(),{resource:'https://beacon.synthetic.invalid/mcp',
      authorization_servers:['https://issuer.synthetic.invalid'],scopes_supported:['beacon:read'],bearer_methods_supported:['header']});
    const response=await mf.dispatchFetch('https://beacon.synthetic.invalid/mcp',{method:'POST',
      headers:{Authorization:'Bearer synthetic-manual-token-disabled-00000000','Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,401);
    assert.equal(response.headers.get('WWW-Authenticate'),
      'Bearer resource_metadata="https://beacon.synthetic.invalid/.well-known/oauth-protected-resource/mcp", scope="beacon:read"');
  } finally {await mf.dispose();}
});
test('incomplete OAuth configuration fails closed in the real Worker',async()=> {
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'oauth-incomplete',modules:true,
    scriptPath:resolve('dist/worker.mjs'),compatibilityDate:'2026-10-01',bindings:{
      MCP_OAUTH_ISSUER:'',MCP_TOKEN:'synthetic-manual-token-disabled-00000000'}}]}));
  try {
    assert.equal((await mf.dispatchFetch('http://localhost/.well-known/oauth-protected-resource')).status,503);
    assert.equal((await mf.dispatchFetch('http://localhost/mcp',{headers:{Authorization:'Bearer synthetic-manual-token-disabled-00000000'}})).status,401);
  } finally {await mf.dispose();}
});
