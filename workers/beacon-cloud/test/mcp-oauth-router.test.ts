import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

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
      'Bearer error="invalid_token", resource_metadata="https://beacon.synthetic.invalid/.well-known/oauth-protected-resource/mcp", scope="beacon:read"');
  } finally {await mf.dispose();}
});

test('real Worker validates external JWKS before distinguishing invalid JWTs from insufficient scope',async()=> {
  const issuer='https://issuer.synthetic.invalid',resource='https://beacon.synthetic.invalid/mcp';
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),kid:'synthetic-workerd-issuer',alg:'RS256'};
  const now=Math.floor(Date.now()/1000);
  const signed=(claims:Record<string,unknown>={})=>new SignJWT({iss:issuer,aud:resource,
    sub:'synthetic-reviewer',iat:now-1,exp:now+300,scope:'beacon:read',...claims})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(privateKey);
  // All outbound fetches are sent to an isolated workerd service. The verifier
  // still downloads its configured HTTPS JWKS through its real production path.
  // No factory injection, internet request, or genuine identity provider is used.
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'oauth-jwt-test',modules:true,scriptPath:resolve('dist/worker.mjs'),
    compatibilityDate:'2026-10-01',outboundService:'synthetic-jwks',bindings:{
      PUBLIC_URL:'https://beacon.synthetic.invalid',MCP_OAUTH_ISSUER:issuer,
      MCP_OAUTH_JWKS_URL:issuer+'/jwks',MCP_TOKEN:'synthetic-manual-token-disabled-00000000'},
  },{
    name:'synthetic-jwks',modules:true,compatibilityDate:'2026-10-01',
    bindings:{JWKS:{keys:[jwk]}},script:`export default {fetch(request,env) {
      if(request.url !== 'https://issuer.synthetic.invalid/jwks') return new Response('Unexpected outbound URL',{status:404});
      return Response.json(env.JWKS);
    }};`,
  }]}));
  const request=(token:string)=>mf.dispatchFetch(resource,{method:'POST',headers:{
    Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{
      'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientCapabilities':{},
    }}})});
  try {
    const permitted=await request(await signed());
    assert.equal(permitted.status,200);
    assert.equal((await permitted.json() as {result:{tools:unknown[]}}).result.tools.length,14);
    const denied=await request(await signed({scope:'beacon:write'}));
    assert.equal(denied.status,403);
    assert.equal(denied.headers.get('WWW-Authenticate'),
      'Bearer error="insufficient_scope", resource_metadata="https://beacon.synthetic.invalid/.well-known/oauth-protected-resource/mcp", scope="beacon:read"');
    for(const claims of [
      {scope:'beacon:write',exp:now-1},{scope:'beacon:write',iss:'https://wrong.synthetic.invalid'},
      {scope:'beacon:write',aud:'https://wrong.synthetic.invalid/mcp'},
      {scope:'beacon:write',iat:now+60},{scope:'beacon:write',sub:''},
    ]) {
      const rejected=await request(await signed(claims));
      assert.equal(rejected.status,401);
      assert.match(rejected.headers.get('WWW-Authenticate')!,/error="invalid_token"/);
    }
    const jwt=await signed({scope:'beacon:write'});
    assert.equal((await request(jwt.slice(0,-8)+'invalidX')).status,401);
    assert.equal((await request('synthetic-manual-token-disabled-00000000')).status,401);
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
