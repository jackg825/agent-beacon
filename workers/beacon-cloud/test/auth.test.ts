import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { verifyAccess } from '../src/auth';
import { canonicalRemote } from '../src/identity';

test('Access JWT verifies signature, issuer, audience and expiration',async()=> {
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey); jwk.kid='synthetic-key';
  const keys=createLocalJWKSet({keys:[jwk]});
  const token=await new SignJWT({sub:'synthetic-user'}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
    .setIssuer('https://synthetic-team.cloudflareaccess.com').setAudience('synthetic-audience')
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);
  assert.equal(await verifyAccess(token,'synthetic-team.cloudflareaccess.com','synthetic-audience',keys),true);
  assert.equal(await verifyAccess(token,'synthetic-team.cloudflareaccess.com','wrong-audience',keys),false);
  assert.equal(await verifyAccess(token,'wrong-team.cloudflareaccess.com','synthetic-audience',keys),false);
  assert.equal(await verifyAccess(token.slice(0,-4)+'aaaa','synthetic-team.cloudflareaccess.com','synthetic-audience',keys),false);
  const expired=await new SignJWT({sub:'synthetic-user'}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
    .setIssuer('https://synthetic-team.cloudflareaccess.com').setAudience('synthetic-audience').setIssuedAt().setExpirationTime(1).sign(privateKey);
  assert.equal(await verifyAccess(expired,'synthetic-team.cloudflareaccess.com','synthetic-audience',keys),false);
  assert.equal(await verifyAccess(token,'https://hostile.invalid','synthetic-audience',keys),false);
});
test('SSH/HTTPS project remotes normalize credentials, suffix and GitHub case',()=> {
  const expected='github.com/example/beacon-demo';
  for (const url of ['git@github.com:Example/Beacon-Demo.git','https://github.com/example/beacon-demo/',
    'ssh://git@github.com:22/Example/Beacon-Demo.git','https://user:synthetic@github.com/Example/Beacon-Demo.git?token=synthetic#main'])
    assert.equal(canonicalRemote(url),expected);
  assert.equal(canonicalRemote('file:///synthetic/project'),null);
  assert.equal(canonicalRemote('/synthetic/project'),null);
  assert.equal(canonicalRemote('ssh://git@git.example/team/CaseSensitive.git'),'git.example/team/CaseSensitive');
  assert.equal(canonicalRemote('ssh://git@git.example:443/team/repo.git'),'git.example:443/team/repo');
  assert.equal(canonicalRemote('https://git.example:22/team/repo.git'),'git.example:22/team/repo');
});
