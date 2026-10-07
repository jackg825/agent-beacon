import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { contextRead, contextWrite, getContext, listContext } from '../src/context';
import { ingest } from '../src/ingest';
import { Env, HttpError } from '../src/types';
import { applyMigrations } from './migrations';

const now='2026-10-07T00:00:00.000Z';
const actor='synthetic-reviewer';
function event(id:string,session='session-a',repo='context-demo',message='synthetic source') {
  return {vendor:'beacon',product:'endpoint-agent',schema_version:'1.0',timestamp:now,
    event:{id,action:'command.executed',kind:'agent_runtime',fidelity:'observed'},
    harness:{name:'codex_cli',collection_method:'hook'},session:{id:session,working_directory:'/synthetic/context'},
    repository:`https://github.com/example/${repo}.git`,message};
}
function request(path:string,body:unknown) {
  return new Request('http://localhost'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
test('manual context lifecycle preserves source versions, authority boundaries and atomic review',async(t)=> {
  const directory=await mkdtemp(join(tmpdir(),'beacon-context-'));
  const options=convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
    name:'context',modules:true as const,script:'export default {fetch(){return new Response("synthetic");}}',
    compatibilityDate:'2026-10-01',d1Databases:{DB:'context-index'},r2Buckets:{RAW:'context-raw'}
  }]});
  let mf=new Miniflare(options);
  let env={DB:await mf.getD1Database('DB'),RAW:await mf.getR2Bucket('RAW')} as unknown as Env;
  const write=(path:string,body:unknown)=>contextWrite(request(path,body),env,actor);
  const create=async(body:unknown)=> {
    const response=await write('/api/context',body);
    assert.equal(response!.status,201);
    return (await response!.json() as any).context;
  };
  const review=async(id:string,decision='approve',reason?:string)=> {
    const response=await write(`/api/context/${id}/review`,{decision,...(reason===undefined?{}:{reason})});
    assert.equal(response!.status,200);
    return (await response!.json() as any).context;
  };
  const rejects=async(operation:Promise<unknown>,status:number)=>assert.rejects(operation,
    (error:unknown)=>error instanceof HttpError && error.status===status);
  try {
    await applyMigrations(env.DB);
    await env.DB.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)')
      .bind('mbp','Synthetic MBP','a'.repeat(64),now).run();
    const upload=async(record:unknown)=>ingest(new Request('http://localhost/v1/ingest/runtime',{
      method:'POST',headers:{'Content-Type':'application/x-ndjson'},body:JSON.stringify(record)+'\n'
    }),env,{id:'mbp',name:'Synthetic MBP',token_hash:'a'.repeat(64),revoked:0},'runtime');
    await upload(event('event-a'));
    await upload(event('event-a','session-a','context-demo','synthetic alternate captured version'));
    await upload(event('event-b','session-b'));
    await upload(event('event-other','session-other','other-project'));
    const first=await env.DB.prepare('SELECT * FROM events WHERE event_id=?').bind('event-a').first<any>();
    const second=await env.DB.prepare('SELECT * FROM events WHERE event_id=?').bind('event-b').first<any>();
    const other=await env.DB.prepare('SELECT * FROM events WHERE event_id=?').bind('event-other').first<any>();
    const sources=[{event_id:first.id,payload_hash:first.payload_hash}];
    const input={kind:'summary',project_id:first.project_id,title:'Synthetic handoff',content:'Synthetic progress and remaining verification.',sources};
    let parent:any;
    await t.test('pending content remains untrusted, exact provenance is immutable, and review is audited',async()=> {
      parent=await create(input);
      assert.equal(parent.status,'pending');assert.equal(parent.authoritative,false);assert.equal(parent.sources_valid,true);
      assert.equal(parent.source_count,1);assert.equal(parent.sources[0].event_id,first.id);
      assert.equal(parent.sources[0].payload_hash,first.payload_hash);
      assert.equal(parent.sources[0].session_id,first.session_id);
      assert.deepEqual(parent.audit.map((row:any)=>row.action),['create']);
      assert.equal(parent.audit[0].actor,actor);
      assert.equal((await listContext(env,new URLSearchParams())).context.length,0);
      const pending=await listContext(env,new URLSearchParams('status=pending'));
      assert.equal(pending.context.length,1);assert.equal(pending.context[0].authoritative,false);
      await assert.rejects(env.DB.prepare('UPDATE context_entries SET content=? WHERE id=?').bind('silently changed',parent.id).run(),/context_immutable/);
      await assert.rejects(env.DB.prepare('UPDATE context_sources SET payload_hash=? WHERE context_id=?').bind('b'.repeat(64),parent.id).run(),/context_immutable/);
      await assert.rejects(env.DB.prepare('DELETE FROM context_sources WHERE context_id=?').bind(parent.id).run(),/context_immutable/);
      await assert.rejects(env.DB.prepare('INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal) VALUES(?,?,?,?)')
        .bind(parent.id,second.id,second.payload_hash,1).run(),/context_invalid_source/);
      parent=await review(parent.id,'approve','Synthetic reviewer verified the source.');
      assert.equal(parent.status,'approved');assert.equal(parent.authoritative,true);
      assert.deepEqual(parent.audit.map((row:any)=>row.action),['create','approve']);
      assert.equal(parent.audit.at(-1).reason,'Synthetic reviewer verified the source.');
      assert.equal((await listContext(env,new URLSearchParams())).context[0].id,parent.id);
      await rejects(write(`/api/context/${parent.id}/review`,{decision:'approve'}),409);
      await rejects(write(`/api/context/${parent.id}/review`,{decision:'reject'}),409);
      assert.equal((await getContext(env,parent.id)).context.audit.length,2);
    });
    await t.test('strict fields, size boundaries and false or cross-project source claims are rejected atomically',async()=> {
      const count=async()=> (await env.DB.prepare('SELECT COUNT(*) AS count FROM context_entries').first<{count:number}>())!.count;
      const before=await count();
      for (const invalid of [
        {...input,actor:'forged-user'}, {...input,status:'approved'}, {...input,kind:'unknown'},
        {...input,title:''}, {...input,title:'x'.repeat(161)}, {...input,content:' '}, {...input,content:'x'.repeat(12001)},
        {...input,sources:[]}, {...input,sources:[...sources,...sources]},
        {...input,sources:[{...sources[0],payload_hash:'b'.repeat(64)}]},
        {...input,sources:[{event_id:'c'.repeat(64),payload_hash:first.payload_hash}]},
        {...input,sources:[{event_id:other.id,payload_hash:other.payload_hash}]},
        {...input,sources:[{...sources[0],session_id:first.session_id}]}, {...input,task_id:'not-a-task'},
        {...input,sources:Array.from({length:21},(_,index)=>({event_id:index.toString(16).padStart(64,'0'),payload_hash:first.payload_hash}))}
      ]) await rejects(write('/api/context',invalid),400);
      assert.equal(await count(),before);
      await rejects(contextWrite(new Request('http://localhost/api/context',{method:'POST',body:'{}'}),env,actor),415);
      await rejects(contextWrite(new Request('http://localhost/api/context',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(65537)}),env,actor),413);
      await rejects(contextWrite(new Request('http://localhost/api/context',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'}),env,actor),400);
      const alternate=await env.DB.prepare('SELECT payload_hash FROM event_versions WHERE event_id=? AND payload_hash!=?')
        .bind(first.id,first.payload_hash).first<{payload_hash:string}>();
      const variant=await create({...input,kind:'memory',sources:[{event_id:first.id,payload_hash:alternate!.payload_hash}]});
      assert.equal(variant.sources[0].payload_hash,alternate!.payload_hash);
      assert.ok((await env.RAW.list()).objects.length>0);
    });
    await t.test('alternate captures cannot reuse an event identity to forge project, session or harness provenance',async()=> {
      await upload(event('event-scope'));
      const indexed=await env.DB.prepare('SELECT * FROM events WHERE event_id=?').bind('event-scope').first<any>();
      const captures=[
        event('event-scope','different-session'),
        event('event-scope','different-repo-session','different-repo'),
        {...event('event-scope'),harness:{name:'claude_code',collection_method:'hook'}}
      ];
      for (const capture of captures) {
        await upload(capture);
        const versions=await env.DB.prepare(`SELECT v.payload_hash FROM event_versions v
          WHERE v.event_id=? AND v.payload_hash!=? AND NOT EXISTS(
            SELECT 1 FROM context_sources s WHERE s.event_id=v.event_id AND s.payload_hash=v.payload_hash
          ) ORDER BY v.payload_hash`).bind(indexed.id,indexed.payload_hash).all<{payload_hash:string}>();
        assert.equal(versions.results.length,1);
        // Previous variants already have rejected legacy references; test the new capture.
        for (const version of versions.results) {
          const falseSource={event_id:indexed.id,payload_hash:version.payload_hash};
          await rejects(write('/api/context',{...input,sources:[falseSource]}),400);
          // Simulate an older pending candidate from before exact-raw verification.
          const candidateId=crypto.randomUUID();
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO context_entries(id,kind,project_id,title,content,created_at)
              VALUES(?,'summary',?,?,?,?)`).bind(candidateId,indexed.project_id,'Legacy synthetic candidate','Synthetic forged capture.',now),
            env.DB.prepare('INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal) VALUES(?,?,?,0)')
              .bind(candidateId,falseSource.event_id,falseSource.payload_hash),
            env.DB.prepare('UPDATE context_entries SET sealed=1 WHERE id=?').bind(candidateId),
            env.DB.prepare(`INSERT INTO context_audit(id,context_id,actor,action,created_at) VALUES(?,?,?,'create',?)`)
              .bind(crypto.randomUUID(),candidateId,actor,now)
          ]);
          await rejects(write(`/api/context/${candidateId}/review`,{decision:'approve'}),409);
          const detail=(await getContext(env,candidateId)).context;
          assert.equal(detail.status,'pending');assert.equal(detail.authoritative,false);assert.equal(detail.audit.length,1);
          // Rejecting an unusable candidate remains possible without approving it.
          await review(candidateId,'reject','Synthetic raw scope differs from logical index.');
        }
      }
      const logical=await env.DB.prepare('SELECT project_id,session_id,harness FROM events WHERE id=?').bind(indexed.id).first<any>();
      assert.equal(logical.project_id,indexed.project_id);assert.equal(logical.session_id,indexed.session_id);assert.equal(logical.harness,indexed.harness);
    });
    await t.test('missing or corrupt raw evidence cannot create or approve context and remains a service failure',async()=> {
      const candidate=await create({...input,title:'Synthetic unavailable evidence'});
      const version=await env.DB.prepare(`SELECT b.r2_key FROM event_versions v JOIN batches b ON b.id=v.batch_id
        WHERE v.event_id=? AND v.payload_hash=?`).bind(first.id,first.payload_hash).first<{r2_key:string}>();
      const raw=(await (await env.RAW.get(version!.r2_key))!.text());
      try {
        await env.RAW.delete(version!.r2_key);
        await rejects(write('/api/context',input),503);
        await rejects(write(`/api/context/${candidate.id}/review`,{decision:'approve'}),503);
        await env.RAW.put(version!.r2_key,JSON.stringify({...event('event-a'),message:'synthetic corrupted replacement'})+'\n');
        await rejects(write('/api/context',input),503);
        await rejects(write(`/api/context/${candidate.id}/review`,{decision:'approve'}),503);
        const detail=(await getContext(env,candidate.id)).context;
        assert.equal(detail.status,'pending');assert.equal(detail.authoritative,false);assert.equal(detail.audit.length,1);
      } finally {await env.RAW.put(version!.r2_key,raw);}
      assert.equal((await review(candidate.id)).authoritative,true);
    });
    await t.test('task-scoped candidates require all event sessions linked to that task',async()=> {
      const taskId=crypto.randomUUID();
      await env.DB.prepare('INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,?,?,?)').bind(taskId,'Synthetic cross-session task',now,now).run();
      await env.DB.prepare('INSERT INTO task_sessions(task_id,session_id,linked_at) VALUES(?,?,?)').bind(taskId,first.session_id,now).run();
      const scoped=await create({...input,task_id:taskId});
      assert.equal(scoped.task_id,taskId);
      await rejects(write('/api/context',{...input,task_id:taskId,sources:[{event_id:second.id,payload_hash:second.payload_hash}]}),400);
      await rejects(write('/api/context',{...input,task_id:taskId,sources:[...sources,{event_id:second.id,payload_hash:second.payload_hash}]}),400);
      await rejects(write('/api/context',{...input,task_id:crypto.randomUUID()}),404);
      await env.DB.prepare('DELETE FROM task_sessions WHERE task_id=? AND session_id=?').bind(taskId,first.session_id).run();
      await rejects(write(`/api/context/${scoped.id}/review`,{decision:'approve'}),409);
      assert.equal((await getContext(env,scoped.id)).context.audit.length,1);
      await env.DB.prepare('INSERT INTO task_sessions(task_id,session_id,linked_at) VALUES(?,?,?)').bind(taskId,first.session_id,now).run();
      await review(scoped.id,'reject','Synthetic candidate lacks sufficient explanation.');
      const rejected=(await getContext(env,scoped.id)).context;
      assert.equal(rejected.authoritative,false);assert.equal(rejected.status,'rejected');
      await rejects(write(`/api/context/${scoped.id}/review`,{decision:'approve'}),409);
    });
    await t.test('pending and rejected revisions preserve the approved parent; concurrent revisions cannot both approve',async()=> {
      const rejected=await create({...input,title:'Rejected revision',supersedes_id:parent.id});
      assert.equal((await getContext(env,parent.id)).context.status,'approved');
      await review(rejected.id,'reject','Synthetic reviewer declined revision.');
      assert.equal((await getContext(env,parent.id)).context.status,'approved');
      const revisionA=await create({...input,title:'Revision A',supersedes_id:parent.id});
      const revisionB=await create({...input,title:'Revision B',supersedes_id:parent.id});
      const results=await Promise.allSettled([
        write(`/api/context/${revisionA.id}/review`,{decision:'approve',reason:'synthetic concurrent A'}),
        write(`/api/context/${revisionB.id}/review`,{decision:'approve',reason:'synthetic concurrent B'})
      ]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
      assert.ok(failure.reason instanceof HttpError);assert.equal(failure.reason.status,409);
      const a=(await getContext(env,revisionA.id)).context,b=(await getContext(env,revisionB.id)).context;
      const winner=a.status==='approved'?a:b,loser=a.status==='pending'?a:b;
      assert.equal(winner.authoritative,true);assert.equal(loser.authoritative,false);
      const old=(await getContext(env,parent.id)).context;
      assert.equal(old.status,'superseded');assert.equal(old.authoritative,false);
      assert.deepEqual(old.audit.map((row:any)=>row.action),['create','approve','supersede']);
      assert.equal(old.audit.at(-1)!.actor,actor);
      assert.equal(loser.audit.length,1); // Aborted approval cannot append a misleading audit.
      await rejects(write(`/api/context/${loser.id}/review`,{decision:'approve'}),409);
      await rejects(write('/api/context',{...input,supersedes_id:parent.id}),409);
      await rejects(write('/api/context',{...input,kind:'memory',supersedes_id:winner.id}),409);
      await rejects(write('/api/context',{...input,project_id:other.project_id,sources:[{event_id:other.id,payload_hash:other.payload_hash}],supersedes_id:winner.id}),409);
    });
    await t.test('simultaneous approval and rejection of one candidate produces one terminal decision and audit',async()=> {
      const candidate=await create({...input,title:'One candidate race'});
      let readers=0,release!:()=>void;
      const barrier=new Promise<void>(resolve=>{release=resolve;});
      // Force both callers to observe pending before either CAS can run.
      const racingEnv={...env,DB:{prepare(sql:string) {
        const statement=env.DB.prepare(sql);
        if (!sql.startsWith('SELECT status FROM context_entries')) return statement;
        return {bind(...values:unknown[]) {
          const bound=statement.bind(...values);
          return {async first() {const result=await bound.first();if(++readers===2) release();await barrier;return result;}};
        }};
      }}} as unknown as Env;
      const results=await Promise.allSettled([
        contextWrite(request(`/api/context/${candidate.id}/review`,{decision:'approve'}),racingEnv,actor),
        contextWrite(request(`/api/context/${candidate.id}/review`,{decision:'reject'}),racingEnv,actor)
      ]);
      assert.equal(readers,2);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
      assert.equal(failure.reason.status,409);
      const detail=(await getContext(env,candidate.id)).context;
      assert.ok(['approved','rejected'].includes(detail.status));assert.equal(detail.audit.length,2);
    });
    await t.test('source scope is rechecked at approval, and old derivatives lose authority after evidence changes',async()=> {
      const candidate=await create({...input,title:'Changed provenance before approval'});
      // Simulate a local-path session upgrading to Git identity after distillation.
      await env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(other.project_id,first.id).run();
      await rejects(write(`/api/context/${candidate.id}/review`,{decision:'approve'}),409);
      const detail=(await getContext(env,candidate.id)).context;
      assert.equal(detail.sources_valid,false);assert.equal(detail.authoritative,false);assert.equal(detail.status,'pending');
      assert.equal(detail.audit.length,1);
      await env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(input.project_id,first.id).run();
      const approved=await review(candidate.id);
      assert.equal(approved.authoritative,true);
      await env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(other.project_id,first.id).run();
      assert.equal((await getContext(env,candidate.id)).context.authoritative,false);
      assert.ok(!(await listContext(env,new URLSearchParams())).context.some(row=>row.id===candidate.id));
      const auditList=await listContext(env,new URLSearchParams('status=approved'));
      assert.equal(auditList.context.find(row=>row.id===candidate.id)!.authoritative,false);
      assert.equal(auditList.context.find(row=>row.id===candidate.id)!.sources_valid,false);
      await env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(input.project_id,first.id).run();
    });
    await t.test('keyset pages, filters and persistence retain exact provenance and audit history',async()=> {
      for (let index=0;index<3;index++) await create({...input,title:`Synthetic pagination ${index}`});
      const page=await listContext(env,new URLSearchParams('status=pending&limit=1'));
      assert.equal(page.context.length,1);assert.ok(page.next_cursor);
      const next=await listContext(env,new URLSearchParams(`status=pending&limit=1&before=${encodeURIComponent(page.next_cursor!)}`));
      assert.notEqual(next.context[0].id,page.context[0].id);
      const filtered=await listContext(env,new URLSearchParams(`status=pending&project_id=${first.project_id}&kind=summary`));
      assert.ok(filtered.context.every(row=>row.project_id===first.project_id && row.kind==='summary' && row.status==='pending'));
      for (const filter of ['limit=41','before=invalid','status=all','unknown=yes','kind=summary&kind=memory','project_id=wrong'])
        await rejects(listContext(env,new URLSearchParams(filter)),400);
      assert.equal(await contextRead(new Request('http://localhost/unrelated'),env),null);
      assert.equal(await contextWrite(request('/unrelated',{}),env,actor),null);
      await rejects(contextRead(new Request(`http://localhost/api/context/${parent.id}?status=approved`),env),400);
      await rejects(contextRead(new Request('http://localhost/api/context/not-a-uuid'),env),400);
      await rejects(getContext(env,crypto.randomUUID()),404);
      await assert.rejects(env.DB.prepare('DELETE FROM context_audit WHERE context_id=?').bind(parent.id).run(),/context_immutable/);
      await assert.rejects(env.DB.prepare('DELETE FROM context_entries WHERE id=?').bind(parent.id).run(),/context_immutable/);
      const before=await getContext(env,parent.id);
      await mf.dispose();mf=new Miniflare(options);
      env={DB:await mf.getD1Database('DB'),RAW:await mf.getR2Bucket('RAW')} as unknown as Env;
      assert.deepEqual(await getContext(env,parent.id),before);
      const version=await env.DB.prepare(`SELECT b.r2_key FROM event_versions v JOIN batches b ON b.id=v.batch_id
        WHERE v.event_id=? AND v.payload_hash=?`).bind(first.id,first.payload_hash).first<{r2_key:string}>();
      assert.ok((await (await env.RAW.get(version!.r2_key))!.text()).includes('synthetic source'));
    });
  } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
