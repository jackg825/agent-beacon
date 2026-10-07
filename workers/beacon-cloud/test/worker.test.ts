import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { verifyMcp } from './mcp-client';
import { ingest } from '../src/ingest';
import { Env } from '../src/types';
import { applyMigrations } from './migrations';

// Deliberately synthetic credentials and records; no installed Beacon paths are read.
const tokens={mbp:'synthetic-device-mbp-credential-00000000000',mini:'synthetic-device-mini-credential-0000000000',
  read:'synthetic-dashboard-read-credential-000000',mcp:'synthetic-remote-mcp-credential-00000000000'};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function event(id:string, remote='git@github.com:Example/Beacon-Demo.git', cwd='/synthetic/mbp/demo') {
  return {vendor:'beacon',product:'endpoint-agent',schema_version:'1.0',timestamp:'2026-10-04T00:00:00Z',
    event:{id,action:'command.executed',kind:'agent_runtime',fidelity:'observed'},
    harness:{name:'codex_cli',collection_method:'hook'},session:{id:'same-native-session',working_directory:cwd},
    repository:remote,message:'synthetic only',command:{command:'echo synthetic',exit_code:0}};
}

test('workerd D1/R2 pipeline, isolation, persistence and official MCP clients',async(t)=> {
  const directory=await mkdtemp(join(tmpdir(),'beacon-worker-'));
  const options=convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
    name:'beacon',modules:true as const,scriptPath:resolve('dist/worker.mjs'),compatibilityDate:'2026-10-01',
    d1Databases:{DB:'beacon-test-index'},r2Buckets:{RAW:'beacon-test-raw'},
    bindings:{READ_TOKEN:tokens.read,MCP_TOKEN:tokens.mcp}}]});
  let mf=new Miniflare(options);
  const request=(path:string,options:Parameters<typeof mf.dispatchFetch>[1]={})=>mf.dispatchFetch('http://localhost'+path,options);
  const read=(path:string)=>request(path,{headers:{Authorization:`Bearer ${tokens.read}`}});
  const upload=(records:unknown[],token=tokens.mbp,stream='runtime',extra:Record<string,string>={})=>
    request('/v1/ingest/'+stream,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-ndjson',...extra},
      body:records.map(r=>JSON.stringify(r)).join('\n')+'\n'});
  try {
    let db=await mf.getD1Database('DB');
    await applyMigrations(db);
    for (const [id,name,token] of [['mbp','Synthetic MBP',tokens.mbp],['mini','Synthetic Mac mini',tokens.mini]])
      await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind(id,name,hash(token),'2026-10-04T00:00:00Z').run();
    await t.test('denies anonymous, forged device and cross-role credentials',async()=> {
      for (const path of ['/dashboard','/dashboard.js','/api/sessions','/mcp','/v1/ingest/health']) assert.equal((await request(path)).status,401);
      assert.equal((await read('/v1/ingest/health')).status,401);
      assert.equal((await upload([event('unauthorized')],tokens.read)).status,401);
      assert.equal((await request('/api/devices',{headers:{Authorization:`Bearer ${tokens.mbp}`}})).status,401);
      assert.equal((await request('/mcp',{headers:{Authorization:`Bearer ${tokens.read}`}})).status,401);
      assert.equal((await upload([{...event('forged'),device_id:'mini'}])).status,403);
      assert.equal((await upload([{...event('forged-nested'),device_id:'mbp',device:{id:'mini'}}])).status,403);
      assert.equal((await request('/api/sessions',{headers:{'Cf-Access-Jwt-Assertion':'forged'}})).status,401);
      assert.equal((await request('/dashboard',{headers:{Authorization:`Bearer ${tokens.read}`,Origin:'https://hostile.invalid'}})).status,403);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events').first<{count:number}>())!.count,0);
    });
    await t.test('stores raw bytes, deduplicates regrouped concurrent retries and namespaces sessions',async()=> {
      const original=event('event-1');
      const responses=await Promise.all([upload([original]),upload([original]),upload([original,event('event-2')])]);
      for (const response of responses) assert.equal(response.status,200,await response.text());
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events').first<{count:number}>())!.count,2);
      assert.equal((await upload([event('event-1','https://github.com/example/beacon-demo','/synthetic/mini/other')],tokens.mini)).status,200);
      const data=await (await read('/api/sessions')).json() as any;
      assert.equal(data.sessions.length,2);
      assert.notEqual(data.sessions[0].id,data.sessions[1].id);
      assert.equal(data.sessions[0].project_id,data.sessions[1].project_id);
      const mbp=data.sessions.find((s:any)=>s.device_id==='mbp');
      assert.equal(mbp.event_count,2);
      const timeline=await (await read(`/api/sessions/${mbp.id}/events`)).json() as any;
      assert.equal(timeline.events.length,2); assert.deepEqual(timeline.events.find((e:any)=>e.event_id==='event-1').payload,original);
      const batch=await db.prepare('SELECT r2_key FROM batches WHERE event_count=1 AND device_id=?').bind('mbp').first<{r2_key:string}>();
      assert.equal(await (await (await mf.getR2Bucket('RAW')).get(batch!.r2_key))!.text(),JSON.stringify(original)+'\n');
      const devices=await (await read('/api/devices')).json();
      assert.ok(!JSON.stringify(devices).includes('token_hash')); assert.ok(!JSON.stringify(devices).includes(tokens.mbp));
      const page=await (await read('/api/sessions?limit=1')).json() as any;
      assert.ok(page.next_cursor);
      const next=await (await read('/api/sessions?limit=1&before='+encodeURIComponent(page.next_cursor))).json() as any;
      assert.notEqual(page.sessions[0].id,next.sessions[0].id);
      const filtered=await (await read('/api/sessions?device_id=mini&harness=codex_cli&project_id='+mbp.project_id)).json() as any;
      assert.equal(filtered.sessions.length,1);
      assert.equal((await read('/api/sessions?before=invalid')).status,400);
      assert.equal((await read('/api/sessions?limit=10000')).status,400);
    });
    await t.test('validates whole batch and accepts bounded gzip/inventory and variants',async()=> {
      assert.equal((await upload([event('invalid-batch'),{...event('bad-schema'),schema_version:'9'}])).status,400);
      assert.equal((await db.prepare('SELECT id FROM events WHERE event_id=?').bind('invalid-batch').first()),null);
      const body=JSON.stringify(event('gzip-event'))+'\n';
      assert.equal((await request('/v1/ingest/runtime',{method:'POST',headers:{Authorization:`Bearer ${tokens.mbp}`,
        'Content-Type':'application/x-ndjson','Content-Encoding':'gzip'},body:gzipSync(body)})).status,200);
      assert.equal((await upload([event('event-1')],tokens.mbp,'inventory')).status,200);
      assert.equal((await upload([{...event('event-1'),message:'synthetic second capture'}])).status,200);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE device_id=? AND event_id=? AND stream=?').bind('mbp','event-1','runtime').first<{count:number}>())!.count,1);
      assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM event_versions v JOIN events e ON e.id=v.event_id WHERE e.device_id=? AND e.event_id=? AND e.stream=?`)
        .bind('mbp','event-1','runtime').first<{count:number}>())!.count,2);
      assert.equal((await upload(Array.from({length:101},(_,i)=>event('oversize-'+i)))).status,400);
      assert.equal((await upload([{...event('oversize'),message:'x'.repeat(1024*1024)}])).status,413);
      assert.equal((await request('/v1/ingest/runtime',{method:'POST',headers:{Authorization:`Bearer ${tokens.mbp}`,
        'Content-Type':'application/x-ndjson','Content-Encoding':'gzip'},body:gzipSync('x'.repeat(1024*1024+1))})).status,413);
    });
    await t.test('serves guarded dashboard and current plus legacy MCP clients',async()=> {
      const dashboard=await read('/dashboard'); assert.equal(dashboard.status,200);
      assert.ok(dashboard.headers.get('Content-Security-Policy')?.includes("script-src 'self'"));
      assert.ok((await dashboard.text()).includes('事件時間線'));
      const basic=await request('/dashboard',{headers:{Authorization:'Basic '+Buffer.from('beacon:'+tokens.read).toString('base64')}});
      assert.equal(basic.status,200);
      const sessions=await (await read('/api/sessions?device_id=mbp')).json() as any;
      await verifyMcp('http://localhost/mcp',tokens.mcp,sessions.sessions[0].id,mf.dispatchFetch.bind(mf) as unknown as typeof fetch);
      assert.equal((await request('/api/devices',{method:'POST',headers:{Authorization:`Bearer ${tokens.read}`}})).status,405);
      if(process.env.BEACON_PLAYWRIGHT_MODULE) {
        const {verifyWorkerDashboard}=await import('./dashboard-worker-browser');
        await verifyWorkerDashboard(mf.dispatchFetch.bind(mf) as unknown as typeof fetch,tokens.read);
      }
    });
    await t.test('local JSONL producer to forwarder to real workerd and durable restart',async()=> {
      // JS adapter is intentionally independent of the shipping collector.
      // @ts-expect-error Standalone customer-managed Node adapter has no TypeScript declarations.
      const {runOnce}=await import('../forwarder/forwarder.mjs');
      const logs=join(directory,'producer'); await mkdir(logs,{mode:0o700});
      const tokenFile=join(logs,'device-token'), path=join(logs,'runtime.jsonl');
      await writeFile(tokenFile,tokens.mbp,{mode:0o600});
      await writeFile(path,JSON.stringify({...event('forwarder-event'),session:{id:'forwarder-native-session',working_directory:'/synthetic/producer'}})+'\n');
      await runOnce({endpoint:'http://localhost',tokenFile,stateDir:join(logs,'state'),allowLocalHttp:true,
        streams:{runtime:{path,readFrom:'beginning'}}},{fetchImpl:mf.dispatchFetch.bind(mf)});
      assert.ok(await db.prepare('SELECT id FROM events WHERE event_id=?').bind('forwarder-event').first());
      await mf.dispose(); mf=new Miniflare(options); db=await mf.getD1Database('DB');
      const persisted=await read('/api/sessions');
      assert.equal(persisted.status,200,await persisted.clone().text());
      const sessions=await persisted.json() as any;
      assert.equal(sessions.sessions.length,3);
      const produced=sessions.sessions.find((s:any)=>s.source_session_id==='forwarder-native-session');
      const timeline=await (await read(`/api/sessions/${produced.id}/events`)).json() as any;
      assert.equal(timeline.events[0].payload.event.id,'forwarder-event');
      await runOnce({endpoint:'http://localhost',tokenFile,stateDir:join(logs,'state'),allowLocalHttp:true,
        streams:{runtime:{path,readFrom:'beginning'}}},{fetchImpl:mf.dispatchFetch.bind(mf)});
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events WHERE event_id=?').bind('forwarder-event').first<{count:number}>())!.count,1);
      await db.prepare('UPDATE devices SET revoked=1 WHERE id=?').bind('mini').run();
      assert.equal((await upload([event('revoked')],tokens.mini)).status,401);
      await db.prepare('UPDATE devices SET token_hash=? WHERE id=?').bind(hash('synthetic-rotated-device-key-00000000000'),'mbp').run();
      assert.equal((await upload([event('old-key')])).status,401);
      assert.equal((await upload([event('new-key')],'synthetic-rotated-device-key-00000000000')).status,200);
    });
    await t.test('stale concurrent preflight cannot downgrade or replace a remote project',async()=> {
      const raw=await mf.getR2Bucket('RAW');
      async function race(firstRemote:string,secondRemote:string,sourceSession:string) {
        let readers=0,releaseRead!:()=>void,releaseFirst!:()=>void;
        const readBarrier=new Promise<void>(resolve=>{releaseRead=resolve;});
        const firstCommitted=new Promise<void>(resolve=>{releaseFirst=resolve;});
        const wrapper=(second:boolean)=>({RAW:raw,DB:{
          prepare(sql:string) {
            const statement=db.prepare(sql);
            if (!sql.includes('FROM sessions s JOIN projects')) return statement;
            return {bind(...values:any[]) {const bound=statement.bind(...values); return {
              async all() { const result=await bound.all(); readers++; if(readers===2) releaseRead(); await readBarrier; return result; }
            };}};
          },
          async batch(statements:any[]) {if(second) await firstCommitted;
            try {return await db.batch(statements);} finally {if(!second) releaseFirst();}}
        }}) as unknown as Env;
        const makeRequest=(id:string,remote:string)=>new Request('http://localhost/v1/ingest/runtime',{method:'POST',
          headers:{'Content-Type':'application/x-ndjson'},body:JSON.stringify({...event(id,remote),session:{id:sourceSession,working_directory:'/synthetic/race'}})+'\n'});
        return Promise.allSettled([ingest(makeRequest(sourceSession+'-a',firstRemote),wrapper(false),{id:'mbp',name:'MBP',token_hash:'synthetic',revoked:0},'runtime'),
          ingest(makeRequest(sourceSession+'-b',secondRemote),wrapper(true),{id:'mbp',name:'MBP',token_hash:'synthetic',revoked:0},'runtime')]);
      }
      const downgrade=await race('https://github.com/example/race-repo.git','','race-downgrade');
      assert.ok(downgrade.every(r=>r.status==='fulfilled'));
      const session=await db.prepare(`SELECT s.id,p.identity_kind,p.identity FROM sessions s JOIN projects p ON p.id=s.project_id WHERE source_session_id=?`)
        .bind('race-downgrade').first<{id:string;identity_kind:string;identity:string}>();
      assert.equal(session!.identity_kind,'remote'); assert.equal(session!.identity,'repo:github.com/example/race-repo');
      assert.equal((await db.prepare('SELECT COUNT(DISTINCT project_id) AS count FROM events WHERE session_id=?').bind(session!.id).first<{count:number}>())!.count,1);
      const conflict=await race('https://github.com/example/race-one.git','https://github.com/example/race-two.git','race-conflict');
      assert.equal(conflict[0].status,'fulfilled'); assert.equal(conflict[1].status,'rejected');
      if(conflict[1].status==='rejected') assert.equal(conflict[1].reason.status,409);
      assert.equal(await db.prepare('SELECT id FROM events WHERE event_id=?').bind('race-conflict-b').first(),null);
      const orphan=(await raw.list()).objects.length-(await db.prepare('SELECT COUNT(*) AS count FROM batches').first<{count:number}>())!.count;
      assert.equal(orphan,1); // R2-first failure leaves recoverable raw data, never a partial index.
    });
    await t.test('unscoped repositories stay separate and session evidence upgrades from unknown',async()=> {
      const token='synthetic-rotated-device-key-00000000000';
      for (const repo of ['unscoped-alpha','unscoped-beta']) {
        const record={...event(repo,`https://github.com/example/${repo}.git`)} as any;
        delete record.session;
        assert.equal((await upload([record],token)).status,200);
      }
      const unscoped=await db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE source_session_id LIKE 'unscoped-event:%'").first<{count:number}>();
      assert.equal(unscoped!.count,2);
      const unknown={...event('unknown-project',''),session:{id:'upgradable'}};
      assert.equal((await upload([unknown],token)).status,200);
      const path={...event('path-project',''),session:{id:'upgradable',working_directory:'/synthetic/path-only'}};
      assert.equal((await upload([path],token)).status,200);
      const lookup=()=>db.prepare(`SELECT p.identity_kind AS kind FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.source_session_id=?`).bind('upgradable').first<{kind:string}>();
      assert.equal((await lookup())!.kind,'device_path');
      assert.equal((await upload([{...event('remote-project'),session:{id:'upgradable'}}],token)).status,200);
      assert.equal((await lookup())!.kind,'remote');
      assert.equal((await upload([{...unknown,event:{...unknown.event,id:'late-unknown'}}],token)).status,200);
      assert.equal((await lookup())!.kind,'remote');
    });
    await t.test('R2-first index failure retries cleanly and missing raw history fails explicitly',async()=> {
      const raw=await mf.getR2Bucket('RAW');
      const record={...event('recoverable-index'),session:{id:'recoverable-session'}};
      const request=new Request('http://localhost/v1/ingest/runtime',{method:'POST',headers:{'Content-Type':'application/x-ndjson'},body:JSON.stringify(record)+'\n'});
      const failed={RAW:raw,DB:{prepare:db.prepare.bind(db),batch:async()=>{throw new Error('synthetic-db-outage');}}} as unknown as Env;
      await assert.rejects(ingest(request,failed,{id:'mbp',name:'MBP',token_hash:'synthetic',revoked:0},'runtime'));
      assert.equal(await db.prepare('SELECT id FROM events WHERE event_id=?').bind('recoverable-index').first(),null);
      assert.equal((await upload([record],'synthetic-rotated-device-key-00000000000')).status,200);
      const ref=await db.prepare(`SELECT b.r2_key,e.session_id FROM events e JOIN batches b ON b.id=e.batch_id WHERE e.event_id=?`)
        .bind('recoverable-index').first<{r2_key:string;session_id:string}>();
      const body=await (await raw.get(ref!.r2_key))!.text();
      await raw.delete(ref!.r2_key);
      assert.equal((await read(`/api/sessions/${ref!.session_id}/events`)).status,503);
      await raw.put(ref!.r2_key,body);
      assert.equal((await read(`/api/sessions/${ref!.session_id}/events`)).status,200);
    });
    await t.test('large transcript pages remain bounded and continue without missing events',async()=> {
      const token='synthetic-rotated-device-key-00000000000';
      for (let n=0;n<4;n++) assert.equal((await upload([{...event('large-'+n),
        session:{id:'bounded-timeline'},message:'synthetic-'.repeat(60000)}],token)).status,200);
      const session=await db.prepare('SELECT id FROM sessions WHERE source_session_id=?').bind('bounded-timeline').first<{id:string}>();
      const first=await (await read(`/api/sessions/${session!.id}/events?limit=40`)).json() as any;
      assert.equal(first.events.length,3); assert.ok(first.next_cursor);
      const next=await (await read(`/api/sessions/${session!.id}/events?after=`+encodeURIComponent(first.next_cursor))).json() as any;
      assert.equal(next.events.length,1); assert.equal(next.next_cursor,null);
      assert.equal(new Set([...first.events,...next.events].map((e:any)=>e.id)).size,4);
      let nested: any={}; for(let n=0;n<70;n++) nested={child:nested};
      assert.equal((await upload([{...event('deep-event'),raw:nested}],token)).status,400);
    });
  } finally {await mf.dispose(); await rm(directory,{recursive:true,force:true});}
});
