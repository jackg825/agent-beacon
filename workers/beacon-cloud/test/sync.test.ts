import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createEnvFixture, fixtureDevices, syntheticEvent } from './env-fixture';
import { applyMigrations } from './migrations';
import { MAX_ACTIVE_SUBSCRIPTIONS, SNAPSHOT_SCHEMA, approvedSnapshot, syncDeviceRead, syncRead, syncWrite } from '../src/sync';
import { listContext } from '../src/context';
import { stableJSON } from '../src/identity';
import { Env, HttpError } from '../src/types';

// Synthetic notes, devices and credentials only; nothing reads installed Beacon data or the network.
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const actor='reviewer:0123456789abcdef';
const get=(path:string)=>new Request('http://localhost'+path);
const post=(path:string,body:unknown)=>new Request('http://localhost'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const rejects=(operation:Promise<unknown>,status:number,message?:RegExp)=>assert.rejects(operation,
  (error:unknown)=>error instanceof HttpError && error.status===status && (!message || message.test(error.message)));
type Source={id:string;payload_hash:string;project_id:string;session_id:string};
type Kind='memory'|'summary';

/** Insert a sealed candidate through the real triggers; approve it unless `reviewed` is null. */
async function entry(env:Env,source:Source,options:{kind:Kind;title:string;content:string;created:string;reviewed?:string|null;
  taskId?:string;supersedes?:string}) {
  const id=crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO context_entries(id,kind,project_id,task_id,title,content,supersedes_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id,options.kind,source.project_id,options.taskId??null,options.title,options.content,options.supersedes??null,options.created),
    env.DB.prepare('INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal) VALUES(?,?,?,0)').bind(id,source.id,source.payload_hash),
    env.DB.prepare('UPDATE context_entries SET sealed=1 WHERE id=?').bind(id),
    env.DB.prepare(`INSERT INTO context_audit(id,context_id,actor,action,created_at) VALUES(?,?,?,'create',?)`)
      .bind(crypto.randomUUID(),id,actor,options.created),
  ]);
  if (options.reviewed!==null) await review(env,id,'approved',options.reviewed??options.created);
  return id;
}
function review(env:Env,id:string,status:'approved'|'rejected',at:string) {
  return env.DB.prepare('UPDATE context_entries SET status=?,review_id=?,reviewed_at=?,reviewed_by=? WHERE id=?')
    .bind(status,crypto.randomUUID(),at,actor,id).run();
}
/** Many approved entries for bound tests: sealed in chunks, then approved by one statement. */
async function bulk(env:Env,source:Source,count:number,kind:Kind,content:string,prefix:string) {
  for (let start=0;start<count;start+=50) {
    const statements=[];
    for (let index=start;index<Math.min(count,start+50);index++) {
      const id=crypto.randomUUID(),created=new Date(Date.UTC(2026,9,1)+index).toISOString();
      statements.push(env.DB.prepare('INSERT INTO context_entries(id,kind,project_id,title,content,created_at) VALUES(?,?,?,?,?,?)')
        .bind(id,kind,source.project_id,`${prefix}-${String(index).padStart(3,'0')}`,content,created),
      env.DB.prepare('INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal) VALUES(?,?,?,0)').bind(id,source.id,source.payload_hash),
      env.DB.prepare('UPDATE context_entries SET sealed=1 WHERE id=?').bind(id));
    }
    await env.DB.batch(statements);
  }
  await env.DB.prepare(`UPDATE context_entries SET status='approved',review_id=id||':review',reviewed_at=?,reviewed_by=?
    WHERE project_id=? AND status='pending'`).bind('2026-10-07T00:00:00.000Z',actor,source.project_id).run();
}
async function json(response:Response|null):Promise<any> { assert.ok(response); return response.json(); }

test('the approved snapshot is exactly authoritative recall, in a stable order with a reproducible hash',async()=>{
  const f=await createEnvFixture();
  try {
    await f.ingest([syntheticEvent('alpha-1'),syntheticEvent('alpha-2',{session:'session-b'}),syntheticEvent('alpha-3',{session:'session-c'})]);
    await f.ingest(syntheticEvent('beta-1',{repo:'beta',session:'beta-session'}));
    const [a1,a2,a3,b1]=await Promise.all(['alpha-1','alpha-2','alpha-3','beta-1'].map(id=>f.event(id))) as Source[];
    const env=f.env,project=a1.project_id;
    const at=(day:number)=>`2026-10-0${day}T00:00:00.000Z`;
    const late=await entry(env,a1,{kind:'memory',title:'合成後建立的記憶',content:'synthetic late memory',created:at(3)});
    const early=await entry(env,a1,{kind:'memory',title:'合成先建立的記憶',content:'synthetic early memory',created:at(2)});
    const ties=[await entry(env,a1,{kind:'memory',title:'tie a',content:'synthetic tie',created:at(4)}),
      await entry(env,a1,{kind:'memory',title:'tie b',content:'synthetic tie',created:at(4)})].sort();
    const summary=await entry(env,a2,{kind:'summary',title:'合成交接',content:'synthetic summary',created:at(1)});
    await entry(env,a1,{kind:'memory',title:'pending',content:'synthetic pending',created:at(1),reviewed:null});
    const rejected=await entry(env,a1,{kind:'summary',title:'rejected',content:'synthetic rejected',created:at(1),reviewed:null});
    await review(env,rejected,'rejected',at(2));
    const parent=await entry(env,a1,{kind:'memory',title:'superseded',content:'synthetic old rule',created:at(1)});
    const revision=await entry(env,a1,{kind:'memory',title:'revision',content:'synthetic new rule',created:at(5),reviewed:null,supersedes:parent});
    await review(env,revision,'approved',at(6));
    // An approved entry whose source event later left the project is not authoritative.
    const stale=await entry(env,a3,{kind:'memory',title:'stale',content:'synthetic stale',created:at(1)});
    await env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(b1.project_id,a3.id).run();
    const taskId=crypto.randomUUID(),unlinkedTask=crypto.randomUUID();
    for (const id of [taskId,unlinkedTask]) {
      await env.DB.prepare(`INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,?,?,?)`).bind(id,'synthetic task',at(1),at(1)).run();
      await env.DB.prepare('INSERT INTO task_sessions(task_id,session_id,linked_at) VALUES(?,?,?)').bind(id,a2.session_id,at(1)).run();
    }
    const scoped=await entry(env,a2,{kind:'summary',title:'task scoped',content:'synthetic task note',created:at(2),taskId});
    await entry(env,a2,{kind:'summary',title:'unlinked task',content:'synthetic unlinked',created:at(2),taskId:unlinkedTask});
    await env.DB.prepare('DELETE FROM task_sessions WHERE task_id=?').bind(unlinkedTask).run();
    await entry(env,b1,{kind:'memory',title:'other project',content:'synthetic other',created:at(1)});

    const snapshot=await approvedSnapshot(env,project,{kinds:['memory','summary']});
    assert.deepEqual(snapshot.entries.map(item=>item.id),[early,late,...ties,revision,summary,scoped]);
    const recall=new Set<string>();
    for (let cursor:string|null=null,first=true;first || cursor;first=false) {
      const page:any=await listContext(env,new URLSearchParams({project_id:project,limit:'40',...(cursor?{before:cursor}:{})}));
      page.context.forEach((item:any)=>recall.add(item.id));cursor=page.next_cursor;
    }
    assert.deepEqual(new Set(snapshot.entries.map(item=>item.id)),recall,'the snapshot and default recall agree on authority');
    assert.ok(!snapshot.entries.some(item=>[parent,stale,rejected].includes(item.id)));
    assert.deepEqual(Object.keys(snapshot.entries[0]).sort(),['content','content_sha256','id','kind','reviewed_at','supersedes_id','task_id','title','valid_from']);
    for (const item of snapshot.entries) {assert.equal(item.content_sha256,sha(item.content));assert.equal(item.valid_from,item.reviewed_at);}
    assert.equal(snapshot.entries.find(item=>item.id===revision)!.supersedes_id,parent);
    assert.equal(snapshot.entries.find(item=>item.id===scoped)!.task_id,taskId);
    assert.deepEqual({schema:snapshot.schema,project_id:snapshot.project_id,kinds:snapshot.kinds,entry_count:snapshot.entry_count,reviewed_through:snapshot.reviewed_through},
      {schema:SNAPSHOT_SCHEMA,project_id:project,kinds:['memory','summary'],entry_count:7,reviewed_through:at(6)});
    assert.equal(snapshot.content_bytes,snapshot.entries.reduce((total,item)=>total+Buffer.byteLength(item.title)+Buffer.byteLength(item.content),0));
    assert.equal(snapshot.snapshot_sha256,sha(stableJSON({schema:SNAPSHOT_SCHEMA,project_id:project,kinds:['memory','summary'],entries:snapshot.entries})));
    assert.deepEqual(await approvedSnapshot(env,project,{kinds:['summary','memory']}),snapshot,'the same state hashes identically');
    const later=await entry(env,a1,{kind:'memory',title:'later',content:'synthetic later',created:at(7),reviewed:null});
    assert.equal((await approvedSnapshot(env,project,{kinds:['memory','summary']})).snapshot_sha256,snapshot.snapshot_sha256,'pending entries never change it');
    await review(env,later,'approved','2026-10-09T00:00:00.000Z');
    const changed=await approvedSnapshot(env,project,{kinds:['memory','summary']});
    assert.notEqual(changed.snapshot_sha256,snapshot.snapshot_sha256);
    assert.equal(changed.reviewed_through,'2026-10-09T00:00:00.000Z');
    await env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(project,a3.id).run();
    assert.ok((await approvedSnapshot(env,project,{kinds:['memory']})).entries.some(item=>item.id===stale),'authority is checked at read time');
    const memories=await approvedSnapshot(env,project,{kinds:['memory']});
    assert.ok(memories.entries.every(item=>item.kind==='memory'));assert.deepEqual(memories.kinds,['memory']);
    for (const kinds of [[],['bogus'],['memory','memory'],['memory','summary','memory']]) await rejects(approvedSnapshot(env,project,{kinds}),400);

    const routed=(await json(await syncRead(get(`/api/context/snapshot?project_id=${project}&kind=summary`),env))).snapshot;
    assert.deepEqual(routed.kinds,['summary']);assert.deepEqual(routed.entries.map((item:any)=>item.id),[summary,scoped]);
    for (const query of ['', '?project_id=x', `?project_id=${project}&kind=bogus`, `?project_id=${project}&kind=memory&kind=summary`,
      `?project_id=${project}&status=pending`, `?project_id=${project}&project_id=${project}`]) await rejects(syncRead(get('/api/context/snapshot'+query),env),400);
    await rejects(syncRead(get(`/api/context/snapshot?project_id=${'f'.repeat(64)}`),env),404);
    for (const path of ['/api/context',`/api/context/${revision}`,'/api/context/snapshot/','/api/contexts/snapshot','/api/sync',
      '/api/sync/subscriptions/x/revoke','/api/sync/subscriptions/x/y']) assert.equal(await syncRead(get(path),env),null,path);
    assert.equal(await syncRead(post('/api/context/snapshot',{}),env),null);
    assert.equal(await syncWrite(post('/api/context/snapshot',{}),env,actor),null);
    assert.equal(await syncWrite(get('/api/sync/subscriptions'),env,actor),null);
  } finally {await f.close();}
});

test('oversized snapshots fail with 413 before any note content is read',async()=>{
  const f=await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('bulk-1',{repo:'bulk',session:'bulk'}));
    await f.ingest(syntheticEvent('large-1',{repo:'large',session:'large'}));
    const many=await f.event('bulk-1') as Source,large=await f.event('large-1') as Source;
    await bulk(f.env,many,500,'memory','synthetic short note','bulk');
    assert.equal((await approvedSnapshot(f.env,many.project_id,{kinds:['memory']})).entry_count,500);
    await bulk(f.env,many,1,'memory','synthetic note 501','extra');
    const statements:string[]=[];
    const recording={...f.env,DB:new Proxy(f.env.DB,{get(target,property) {
      if (property==='prepare') return (sql:string)=>{statements.push(sql);return target.prepare(sql);};
      const value=Reflect.get(target,property);
      return typeof value==='function'?value.bind(target):value;
    }})} as Env;
    await rejects(approvedSnapshot(recording,many.project_id,{kinds:['memory']}),413,/500 entries or 2 MiB/);
    assert.equal(statements.length,1);assert.match(statements[0],/COUNT\(\*\)/);
    assert.equal((await approvedSnapshot(f.env,many.project_id,{kinds:['summary']})).entry_count,0,'narrowing the kinds stays within bounds');
    // Bytes, not characters: 58 entries of 12,000 three-byte characters fit, the 59th does not.
    await bulk(f.env,large,58,'summary','字'.repeat(12000),'large');
    const fits=await approvedSnapshot(f.env,large.project_id,{kinds:['summary']});
    assert.equal(fits.entry_count,58);assert.ok(fits.content_bytes<=2*1024*1024 && fits.content_bytes>2_000_000);
    await bulk(f.env,large,1,'summary','字'.repeat(12000),'large-extra');
    statements.length=0;
    await rejects(approvedSnapshot(recording,large.project_id,{kinds:['summary']}),413);
    assert.equal(statements.length,1);
    const created=await syncWrite(post('/api/sync/subscriptions',{device_id:'mbp',project_id:large.project_id,kinds:['summary']}),f.env,actor);
    assert.equal(created!.status,201);
    await rejects(syncDeviceRead(get(`/v1/sync/snapshot?project_id=${large.project_id}`),f.env,fixtureDevices.mbp),413);
  } finally {await f.close();}
});

test('reviewer subscriptions are validated, idempotent, bounded, revocable and immutably audited',async()=>{
  const f=await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('alpha-1'));
    const project=(await f.event('alpha-1'))!.project_id as string;
    const write=(path:string,body:unknown)=>syncWrite(post(path,body),f.env,actor);
    const created=await write('/api/sync/subscriptions',{device_id:'mbp',project_id:project,kinds:['summary','memory']});
    assert.equal(created!.status,201);
    const first=await json(created);
    const subscription=first.subscription;
    assert.equal(first.created,true);
    assert.deepEqual({kinds:subscription.kinds,status:subscription.status,device_name:subscription.device_name,created_by:subscription.created_by,revoked_at:subscription.revoked_at},
      {kinds:['memory','summary'],status:'active',device_name:'Synthetic MBP',created_by:actor,revoked_at:null});
    assert.deepEqual(subscription.audit.map((row:any)=>[row.id,row.action,row.actor]),[[subscription.id+':create','create',actor]]);
    const again=await write('/api/sync/subscriptions',{device_id:'mbp',project_id:project,kinds:['memory','summary']});
    assert.equal(again!.status,200);
    const repeated=await json(again);
    assert.equal(repeated.created,false);assert.equal(repeated.subscription.id,subscription.id);
    await rejects(write('/api/sync/subscriptions',{device_id:'mbp',project_id:project,kinds:['memory']}),409,/revoke it first/);
    const valid={device_id:'mbp',project_id:project,kinds:['memory']};
    for (const invalid of [{...valid,kinds:[]},{...valid,kinds:['memory','memory']},{...valid,kinds:['bogus']},{...valid,kinds:'memory'},
      {...valid,kinds:['memory','summary','memory']},{device_id:'mbp',project_id:project},{...valid,actor:'forged'},{...valid,device_id:'../mbp'},
      {...valid,device_id:''},{...valid,device_id:42},{...valid,project_id:'x'},[valid],null]) await rejects(write('/api/sync/subscriptions',invalid),400);
    await rejects(syncWrite(new Request('http://localhost/api/sync/subscriptions',{method:'POST',body:JSON.stringify(valid)}),f.env,actor),415);
    await rejects(syncWrite(post('/api/sync/subscriptions?device_id=mbp',valid),f.env,actor),400);
    await rejects(write('/api/sync/subscriptions',{...valid,device_id:'unknown-device'}),404,/Device not found/);
    await rejects(write('/api/sync/subscriptions',{...valid,project_id:'f'.repeat(64)}),404,/Project not found/);
    await f.env.DB.prepare('INSERT INTO devices(id,name,token_hash,revoked,created_at) VALUES(?,?,?,1,?)').bind('retired','Synthetic retired','c'.repeat(64),'2026-10-08T00:00:00Z').run();
    await rejects(write('/api/sync/subscriptions',{...valid,device_id:'retired'}),409,/revoked/);
    await rejects(syncWrite(post('/api/sync/subscriptions',valid),f.env,'bad\nactor'),500);

    const revokePath=`/api/sync/subscriptions/${subscription.id}/revoke`;
    for (const body of [{reason:'synthetic'},[],'x']) await rejects(write(revokePath,body),400);
    const revoked=(await json(await write(revokePath,{}))).subscription;
    assert.equal(revoked.status,'revoked');assert.equal(revoked.revoked_by,actor);
    assert.deepEqual(revoked.audit.map((row:any)=>row.action),['create','revoke']);
    assert.equal(revoked.audit[1].id,subscription.id+':revoke');
    await rejects(write(revokePath,{}),409,/already revoked/);
    await rejects(write(`/api/sync/subscriptions/${crypto.randomUUID()}/revoke`,{}),404);
    await rejects(write('/api/sync/subscriptions/not-a-uuid/revoke',{}),400);
    const replacement=(await json(await write('/api/sync/subscriptions',valid))).subscription;
    assert.notEqual(replacement.id,subscription.id);assert.deepEqual(replacement.kinds,['memory']);

    const list=async(query:string)=>(await json(await syncRead(get('/api/sync/subscriptions'+query),f.env)));
    assert.deepEqual((await list('?device_id=mbp')).subscriptions.map((row:any)=>row.status).sort(),['active','revoked']);
    assert.deepEqual((await list('?status=active')).subscriptions.map((row:any)=>row.id),[replacement.id]);
    assert.deepEqual((await list('?status=revoked')).subscriptions.map((row:any)=>row.id),[subscription.id]);
    assert.equal((await list('?device_id=mini')).subscriptions.length,0);
    const page=await list('?limit=1');
    assert.equal(page.subscriptions.length,1);assert.ok(page.next_cursor);
    const next=await list('?limit=1&before='+encodeURIComponent(page.next_cursor));
    assert.notEqual(next.subscriptions[0].id,page.subscriptions[0].id);assert.equal(next.next_cursor,null);
    for (const query of ['?status=all','?device_id=../x','?limit=41','?before=invalid','?unknown=1','?device_id=mbp&device_id=mini',
      '?before='+btoa(JSON.stringify(['2026-10-08','x']))]) await rejects(list(query),400);
    const detail=(await json(await syncRead(get(`/api/sync/subscriptions/${subscription.id}`),f.env))).subscription;
    assert.deepEqual(detail.audit.map((row:any)=>row.action),['create','revoke']);
    await rejects(syncRead(get(`/api/sync/subscriptions/${subscription.id}?x=1`),f.env),400);
    await rejects(syncRead(get('/api/sync/subscriptions/not-a-uuid'),f.env),400);
    await rejects(syncRead(get(`/api/sync/subscriptions/${crypto.randomUUID()}`),f.env),404);

    const db=f.env.DB;
    for (const statement of [
      db.prepare('UPDATE device_sync_subscriptions SET kinds=? WHERE id=?').bind('["summary"]',replacement.id),
      db.prepare('UPDATE device_sync_subscriptions SET revoked_at=NULL,revoked_by=NULL WHERE id=?').bind(subscription.id),
      db.prepare('UPDATE device_sync_subscriptions SET revoked_at=?,revoked_by=?,project_id=? WHERE id=?').bind('2026-10-09T00:00:00.000Z',actor,'f'.repeat(64),replacement.id),
      db.prepare('DELETE FROM device_sync_subscriptions WHERE id=?').bind(subscription.id),
      db.prepare(`INSERT INTO device_sync_subscriptions(id,device_id,project_id,kinds,created_at,created_by,revoked_at,revoked_by)
        VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),'mini',project,'["memory"]','2026-10-08T00:00:00.000Z',actor,'2026-10-08T00:00:00.000Z',actor),
    ]) await assert.rejects(statement.run(),/sync_subscription_(immutable|invalid_state)/);
    for (const statement of [db.prepare('UPDATE device_sync_audit SET actor=? WHERE subscription_id=?').bind('forged',subscription.id),
      db.prepare('DELETE FROM device_sync_audit WHERE subscription_id=?').bind(subscription.id)]) await assert.rejects(statement.run(),/sync_audit_immutable/);
    await assert.rejects(db.prepare(`INSERT INTO device_sync_subscriptions(id,device_id,project_id,kinds,created_at,created_by) VALUES(?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(),'mbp',project,'["memory"]','2026-10-08T00:00:00.000Z',actor).run(),/UNIQUE/);
    await assert.rejects(db.prepare(`INSERT INTO device_sync_subscriptions(id,device_id,project_id,kinds,created_at,created_by) VALUES(?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(),'mini',project,'["summary","memory"]','2026-10-08T00:00:00.000Z',actor).run(),/CHECK/);

    // Concurrent identical grants produce one row; the loser reports the existing grant.
    const racing=await Promise.all([1,2].map(()=>write('/api/sync/subscriptions',{device_id:'mini',project_id:project,kinds:['summary']})));
    assert.deepEqual(racing.map(response=>response!.status).sort(),[200,201]);
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM device_sync_subscriptions WHERE device_id='mini' AND revoked_at IS NULL`).first<{n:number}>())!.n,1);
    // The per-device bound is enforced inside the insert statement.
    const statements=[];
    for (let index=1;index<MAX_ACTIVE_SUBSCRIPTIONS;index++) {
      const id=sha('synthetic-project-'+index);
      statements.push(db.prepare(`INSERT INTO projects(id,name,identity,identity_kind) VALUES(?,?,?,'remote')`).bind(id,'synthetic-'+index,'repo:synthetic/'+index),
        db.prepare(`INSERT INTO device_sync_subscriptions(id,device_id,project_id,kinds,created_at,created_by) VALUES(?,?,?,?,?,?)`)
          .bind(crypto.randomUUID(),'mini',id,'["memory"]','2026-10-08T00:00:00.000Z',actor));
    }
    await db.batch(statements);
    const overflow=sha('synthetic-project-overflow');
    await db.prepare(`INSERT INTO projects(id,name,identity,identity_kind) VALUES(?,?,?,'remote')`).bind(overflow,'overflow','repo:synthetic/overflow').run();
    await rejects(write('/api/sync/subscriptions',{device_id:'mini',project_id:overflow,kinds:['memory']}),409,/100 active/);
    const one=(await list('?device_id=mini&status=active&limit=1')).subscriptions[0];
    await write(`/api/sync/subscriptions/${one.id}/revoke`,{});
    assert.equal((await write('/api/sync/subscriptions',{device_id:'mini',project_id:overflow,kinds:['memory']}))!.status,201);
    assert.equal((await json(await syncDeviceRead(get('/v1/sync/subscriptions'),f.env,fixtureDevices.mini))).subscriptions.length,MAX_ACTIVE_SUBSCRIPTIONS);
  } finally {await f.close();}
});

test('a device reads only the subscribed kinds of its own active subscriptions',async()=>{
  const f=await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('alpha-1'));
    await f.ingest(syntheticEvent('beta-1',{repo:'beta',session:'beta'}));
    const alpha=await f.event('alpha-1') as Source,beta=await f.event('beta-1') as Source;
    const memory=await entry(f.env,alpha,{kind:'memory',title:'合成記憶',content:'synthetic memory',created:'2026-10-01T00:00:00.000Z'});
    await entry(f.env,alpha,{kind:'summary',title:'合成摘要',content:'synthetic summary',created:'2026-10-01T00:00:00.000Z'});
    const read=(path:string,device:keyof typeof fixtureDevices='mbp')=>syncDeviceRead(get(path),f.env,fixtureDevices[device]);
    const denied=/No active sync subscription for this device and project/;
    await rejects(read(`/v1/sync/snapshot?project_id=${alpha.project_id}`),403,denied);
    await rejects(read(`/v1/sync/snapshot?project_id=${'f'.repeat(64)}`),403,denied);
    const grant=(await json(await syncWrite(post('/api/sync/subscriptions',{device_id:'mbp',project_id:alpha.project_id,kinds:['memory']}),f.env,actor))).subscription;
    const served=(await json(await read(`/v1/sync/snapshot?project_id=${alpha.project_id}`))).snapshot;
    assert.deepEqual(served.kinds,['memory']);assert.deepEqual(served.entries.map((item:any)=>item.id),[memory]);
    assert.equal(served.subscription_id,grant.id);
    const {subscription_id,...unwrapped}=served;
    assert.deepEqual(unwrapped,await approvedSnapshot(f.env,alpha.project_id,{kinds:['memory']}));
    await rejects(read(`/v1/sync/snapshot?project_id=${alpha.project_id}`,'mini'),403,denied);
    await rejects(read(`/v1/sync/snapshot?project_id=${beta.project_id}`),403,denied);
    for (const query of [`project_id=${alpha.project_id}&kind=summary`,`project_id=${alpha.project_id}&kind=memory`,`kind=summary`,
      `project_id=${alpha.project_id}&project_id=${alpha.project_id}`,`project_id=${alpha.project_id}&limit=1`,'project_id=x',''])
      await rejects(read('/v1/sync/snapshot?'+query),400);
    const own=await json(await read('/v1/sync/subscriptions'));
    assert.deepEqual(own,{device_id:'mbp',subscriptions:[{id:grant.id,project_id:alpha.project_id,kinds:['memory'],created_at:grant.created_at}]});
    assert.deepEqual((await json(await read('/v1/sync/subscriptions','mini'))).subscriptions,[]);
    await rejects(read('/v1/sync/subscriptions?device_id=mini'),400);
    for (const path of ['/v1/sync/other','/v1/sync/snapshot/x','/v1/sync']) assert.equal(await read(path),null);
    await syncWrite(post(`/api/sync/subscriptions/${grant.id}/revoke`,{}),f.env,actor);
    await rejects(read(`/v1/sync/snapshot?project_id=${alpha.project_id}`),403,denied);
    assert.deepEqual((await json(await read('/v1/sync/subscriptions'))).subscriptions,[]);
  } finally {await f.close();}
});

test('the bundled Worker routes snapshot, context detail, subscriptions and device sync with separate credentials',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'beacon-sync-worker-'));
  const tokens={read:'synthetic-sync-read-key-000000000000000000',review:'synthetic-sync-review-key-0000000000000000',
    mcp:'synthetic-sync-mcp-key-0000000000000000000',mbp:'synthetic-sync-mbp-key-0000000000000000000',mini:'synthetic-sync-mini-key-000000000000000000'};
  const mf=new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
    name:'beacon-sync',modules:true as const,scriptPath:resolve('dist/worker.mjs'),compatibilityDate:'2026-10-01',
    d1Databases:{DB:'sync-test-index'},r2Buckets:{RAW:'sync-test-raw'},
    bindings:{READ_TOKEN:tokens.read,REVIEW_TOKEN:tokens.review,MCP_TOKEN:tokens.mcp}}]}));
  const request=(path:string,init:Parameters<typeof mf.dispatchFetch>[1]={})=>mf.dispatchFetch('http://localhost'+path,init);
  const as=(token?:string)=>token?{headers:{Authorization:'Bearer '+token}}:{};
  const write=(path:string,body:unknown,token?:string,extra:Record<string,string>={})=>request(path,{method:'POST',
    headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  const upload=(records:unknown[],token:string)=>request('/v1/ingest/runtime',{method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-ndjson'},body:records.map(record=>JSON.stringify(record)).join('\n')+'\n'});
  const body=async(response:{json():Promise<unknown>})=>await response.json() as any;
  try {
    const db=await mf.getD1Database('DB');
    await applyMigrations(db);
    for (const [id,name,token] of [['mbp','Synthetic MBP',tokens.mbp],['mini','Synthetic Mac mini',tokens.mini]])
      await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind(id,name,sha(token),'2026-10-08T00:00:00Z').run();
    assert.equal((await upload([syntheticEvent('alpha-mbp')],tokens.mbp)).status,200);
    assert.equal((await upload([syntheticEvent('alpha-mini',{session:'mini-session'})],tokens.mini)).status,200);
    // A path-only project is named by the device's directory, which can carry markup.
    assert.equal((await upload([syntheticEvent('evil-path',{repo:'evil-->name',session:'evil',extra:{repository:''}})],tokens.mbp)).status,200);
    const sessions=(await body(await request('/api/sessions',as(tokens.read)))).sessions;
    const alpha=sessions.find((session:any)=>session.device_id==='mbp' && session.project_name.endsWith('/alpha'));
    const evil=sessions.find((session:any)=>session.project_name==='evil-->name');
    assert.ok(alpha && evil);
    const timeline=async(session:any)=>(await body(await request(`/api/sessions/${session.id}/events`,as(tokens.read)))).events[0];
    const approve=async(session:any,title:string,content:string)=>{
      const source=await timeline(session);
      const created=await write('/api/context',{kind:'memory',project_id:session.project_id,title,content,
        sources:[{event_id:source.id,payload_hash:source.payload_hash}]},tokens.review);
      assert.equal(created.status,201,await created.clone().text());
      const id=(await body(created)).context.id;
      assert.equal((await write(`/api/context/${id}/review`,{decision:'approve'},tokens.review)).status,200);
      return id;
    };
    const contextId=await approve(alpha,'合成部署規則','只部署到隔離 TEST。');
    const snapshotPath=`/api/context/snapshot?project_id=${alpha.project_id}`;

    await t.test('the snapshot route and the context detail route never shadow each other',async()=>{
      const snapshot=(await body(await request(snapshotPath,as(tokens.read)))).snapshot;
      assert.deepEqual(snapshot.entries.map((item:any)=>item.id),[contextId]);
      const detail=await request(`/api/context/${contextId}`,as(tokens.read));
      assert.equal(detail.status,200);
      const context=(await body(detail)).context;
      assert.equal(context.id,contextId);assert.equal(context.sources.length,1);assert.equal(context.authoritative,true);
      assert.deepEqual(await body(await request('/api/context/snapshot',as(tokens.read))),{error:'Invalid project identifier'});
      assert.deepEqual(await body(await request('/api/context/not-a-uuid',as(tokens.read))),{error:'Invalid context id'});
      assert.equal((await request('/api/context/snapshot/',as(tokens.read))).status,404);
      assert.ok((await body(await request('/api/context',as(tokens.read)))).context.some((item:any)=>item.id===contextId));
      assert.equal((await write('/api/context/snapshot',{},tokens.review)).status,404);
    });

    let grant:any;
    await t.test('reads need read authority and writes need the independent review credential',async()=>{
      for (const token of [undefined,tokens.mbp,tokens.review,tokens.mcp]) {
        for (const path of [snapshotPath,'/api/sync/subscriptions']) assert.equal((await request(path,as(token))).status,401,`${path} ${token}`);
      }
      const grantBody={device_id:'mbp',project_id:alpha.project_id,kinds:['memory']};
      for (const token of [undefined,tokens.read,tokens.mcp,tokens.mbp,tokens.mini])
        assert.equal((await write('/api/sync/subscriptions',grantBody,token)).status,403);
      assert.equal((await write('/api/sync/subscriptions',grantBody,tokens.review,{Origin:'https://hostile.invalid'})).status,403);
      assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM device_sync_subscriptions').first('n'),0);
      const created=await write('/api/sync/subscriptions',grantBody,tokens.review);
      assert.equal(created.status,201);
      grant=(await body(created)).subscription;
      for (const token of [undefined,tokens.mbp,tokens.review,tokens.mcp]) assert.equal((await request(`/api/sync/subscriptions/${grant.id}`,as(token))).status,401);
      assert.equal((await body(await request(`/api/sync/subscriptions/${grant.id}`,as(tokens.read)))).subscription.audit.length,1);
      for (const token of [undefined,tokens.read,tokens.mcp,tokens.mbp]) assert.equal((await write(`/api/sync/subscriptions/${grant.id}/revoke`,{},token)).status,403);
      assert.equal((await body(await request('/api/sync/subscriptions?device_id=mbp',as(tokens.read)))).subscriptions[0].status,'active');
    });

    await t.test('device routes serve only the subscribed project and never another role',async()=>{
      const devicePath=`/v1/sync/snapshot?project_id=${alpha.project_id}`;
      for (const token of [undefined,tokens.read,tokens.review,tokens.mcp]) {
        for (const path of [devicePath,'/v1/sync/subscriptions']) assert.equal((await request(path,as(token))).status,401);
      }
      const served=await request(devicePath,as(tokens.mbp));
      assert.equal(served.status,200);
      const snapshot=(await body(served)).snapshot;
      assert.deepEqual(snapshot.entries.map((item:any)=>item.id),[contextId]);assert.equal(snapshot.subscription_id,grant.id);
      const unsubscribed=await request(devicePath,as(tokens.mini)),unknown=await request(`/v1/sync/snapshot?project_id=${'f'.repeat(64)}`,as(tokens.mbp));
      assert.equal(unsubscribed.status,403);assert.equal(unknown.status,403);
      assert.deepEqual(await body(unknown),await body(unsubscribed),'an unknown project is indistinguishable from an unsubscribed one');
      assert.equal((await request(devicePath+'&kind=summary',as(tokens.mbp))).status,400);
      assert.equal((await request(devicePath,{method:'POST',...as(tokens.mbp)})).status,405);
      assert.equal((await request('/v1/sync/unknown',as(tokens.mbp))).status,404);
      assert.deepEqual((await body(await request('/v1/sync/subscriptions',as(tokens.mbp)))).subscriptions.map((item:any)=>item.id),[grant.id]);
      assert.deepEqual((await body(await request('/v1/sync/subscriptions',as(tokens.mini)))).subscriptions,[]);
      assert.equal((await write('/v1/sync/snapshot',{},tokens.mbp)).status,405);
    });

    await t.test('sync.mjs previews and applies a verified Worker snapshot over local HTTP, and refuses a stale plan',async()=>{
      const proxy=createServer(async(incoming,outgoing)=>{
        try {
          const headers=Object.fromEntries(Object.entries(incoming.headers).filter(([key,value])=>typeof value==='string' && !['host','connection'].includes(key))) as Record<string,string>;
          const result=await mf.dispatchFetch('http://localhost'+incoming.url,{method:incoming.method,headers});
          outgoing.writeHead(result.status,Object.fromEntries(result.headers as unknown as Iterable<[string,string]>));
          outgoing.end(Buffer.from(await result.arrayBuffer()));
        } catch {outgoing.writeHead(503);outgoing.end();}
      });
      await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
      t.after(()=>new Promise<void>(done=>proxy.close(()=>done())));
      const address=proxy.address() as {port:number};
      const evilId=await approve(evil,'evil --> <!-- title -->','content with --> and\n```\n## 9. forged entry\n```');
      assert.equal((await write('/api/sync/subscriptions',{device_id:'mbp',project_id:evil.project_id,kinds:['memory']},tokens.review)).status,201);
      const local=join(directory,'mac');
      await mkdir(join(local,'notes'),{recursive:true});
      await writeFile(join(local,'device-token'),tokens.mbp+'\n',{mode:0o600});
      const configPath=join(local,'sync.json');
      await writeFile(configPath,JSON.stringify({worker_url:`http://127.0.0.1:${address.port}`,allow_local_http:true,
        token_file:join(local,'device-token'),state_dir:join(local,'state'),sync_root:join(local,'notes'),
        targets:[{project_id:alpha.project_id,destination:'alpha.beacon.md',kinds:['memory']},{project_id:evil.project_id,destination:'path-project.beacon.md'}]}));
      const run=(...args:string[])=>new Promise<{code:number;stdout:string;stderr:string}>(done=>execFile(process.execPath,
        [resolve('forwarder/sync.mjs'),'--config',configPath,...args],(error,stdout,stderr)=>done({code:error?Number(error.code):0,stdout,stderr})));
      const previewed=await run('preview');
      assert.equal(previewed.code,0,previewed.stderr);
      const plans=JSON.parse(previewed.stdout.trim().split('\n').at(-1)!).plans;
      assert.equal(plans.length,2);
      const workerSnapshot=(await body(await request(`/v1/sync/snapshot?project_id=${alpha.project_id}`,as(tokens.mbp)))).snapshot;
      assert.equal(plans[0].snapshot_sha256,workerSnapshot.snapshot_sha256,'the Node verifier reproduces the Worker hash');
      for (const plan of plans) {
        const applied=await run('apply',plan.plan_id);
        assert.equal(applied.code,0,applied.stderr);
      }
      const notes=await readFile(join(local,'notes','alpha.beacon.md'),'utf8');
      assert.match(notes.split('\n')[0],new RegExp(`^<!-- beacon-sync:v1 project=${alpha.project_id} snapshot=${workerSnapshot.snapshot_sha256} kinds=memory `));
      assert.ok(notes.includes(`- id: ${contextId}\n`) && notes.includes('只部署到隔離 TEST。'));
      const pathNotes=await readFile(join(local,'notes','path-project.beacon.md'),'utf8');
      assert.ok(!pathNotes.includes('evil-->name'),'a device-controlled project name never reaches the file');
      // Outside fenced content only the two managed comment lines close a comment, and only one entry heading exists.
      const outside:string[]=[];let fence=0;
      for (const line of pathNotes.split('\n')) {
        const run=/^(`{3,})/.exec(line)?.[1].length??0;
        if (fence) {if (run>=fence && /^`+$/.test(line)) fence=0;continue;}
        if (run) {fence=run;continue;}
        outside.push(line);
      }
      assert.deepEqual(outside.filter(line=>line.includes('-->')),pathNotes.split('\n').slice(0,2));
      assert.deepEqual(outside.filter(line=>line.startsWith('## ')),['## 1. evil \\-\\-\\> \\<\\!\\-\\- title \\-\\-\\>']);
      assert.ok(pathNotes.includes(`- id: ${evilId}\n`));
      const fresh=JSON.parse((await run('preview','--target','0')).stdout.trim().split('\n').at(-1)!).plans[0];
      assert.equal(fresh.changed,false);
      await approve(alpha,'合成第二條規則','另一個已核准的合成規則。');
      const stalePlan=JSON.parse((await run('preview','--target','0')).stdout.trim().split('\n').at(-1)!).plans[0];
      assert.equal(stalePlan.changed,true);
      await approve(alpha,'合成第三條規則','預覽之後才核准。');
      const stale=await run('apply',stalePlan.plan_id);
      assert.deepEqual({code:stale.code,stderr:stale.stderr,stdout:stale.stdout},{code:1,stderr:'STALE_PLAN\n',stdout:''});
      assert.equal(await readFile(join(local,'notes','alpha.beacon.md'),'utf8'),notes);
      // Revoking the grant stops the device's reads on the next run.
      assert.equal((await write(`/api/sync/subscriptions/${grant.id}/revoke`,{},tokens.review)).status,200);
      const revoked=JSON.parse((await run('preview','--target','0')).stdout.trim().split('\n').at(-1)!).plans[0];
      assert.deepEqual(revoked,{target:0,error:'HTTP_403'});
      for (const output of [previewed,stale]) assert.ok(!`${output.stdout}${output.stderr}`.includes(tokens.mbp));
      await db.prepare(`UPDATE devices SET revoked=1 WHERE id='mbp'`).run();
      assert.equal((await request(`/v1/sync/snapshot?project_id=${evil.project_id}`,as(tokens.mbp))).status,401);
      assert.equal((await run('status')).stderr,'HTTP_401\n');
    });
  } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
