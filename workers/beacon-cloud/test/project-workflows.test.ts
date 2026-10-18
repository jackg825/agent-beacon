import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { projectRead, projectWrite } from '../src/project-workflows';
import { Env, HttpError } from '../src/types';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const projectIds=['web','api','sdk'].map(name=>hash('synthetic-project-'+name));
const sessionIds=['mbp-web','mini-api'].map(name=>hash('synthetic-session-'+name));
const reviewer='synthetic-reviewer';

test('explicit groups, project relations and cross-machine tasks with real D1',async(t)=> {
  const directory=await mkdtemp(join(tmpdir(),'beacon-project-workflows-'));
  const options=convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
    name:'project-workflows',modules:true as const,script:'export default {fetch(){return new Response("synthetic")}}',
    compatibilityDate:'2026-10-01',d1Databases:{DB:'synthetic-project-workflows'}}]});
  let mf=new Miniflare(options),db=await mf.getD1Database('DB');
  let env={DB:db} as Env;
  const read=async(path:string)=>(await projectRead(new Request('http://localhost'+path),env))!;
  const write=async(path:string,data:unknown,actor=reviewer)=>(await projectWrite(new Request('http://localhost'+path,
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),env,actor))!;
  const bad=async(operation:()=>Promise<unknown>,status:number)=>assert.rejects(operation,
    (error:unknown)=>error instanceof HttpError && error.status===status);
  const count=async(table:string,where='',args:unknown[]=[])=>
    (await db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).bind(...args).first<{count:number}>())!.count;
  let groupId='',taskId='';
  try {
    const initial=await readFile('migrations/0001_initial.sql','utf8');
    const [tables,trigger]=initial.split('CREATE TRIGGER');
    for(const sql of tables.replace(/--[^\n]*/g,'').split(';').filter(sql=>sql.trim())) await db.prepare(sql).run();
    await db.prepare('CREATE TRIGGER'+trigger).run();
    const workflows=await readFile('migrations/0002_project_workflows.sql','utf8');
    for(const sql of workflows.replace(/--[^\n]*/g,'').split(';').filter(sql=>sql.trim())) await db.prepare(sql).run();
    for(const device of ['mbp','mini']) await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)')
      .bind(device,'Synthetic '+device,hash('synthetic-'+device),'2026-10-07T00:00:00.000Z').run();
    for(const [index,id] of projectIds.entries()) await db.prepare('INSERT INTO projects(id,name,identity,identity_kind) VALUES(?,?,?,?)')
      .bind(id,['Synthetic website','Synthetic API','Synthetic SDK'][index],'repo:synthetic.invalid/'+id,'remote').run();
    for(const [index,id] of sessionIds.entries()) await db.prepare(`INSERT INTO sessions
      (id,device_id,source_session_id,project_id,harness,started_at,last_event_at) VALUES(?,?,?,?,?,?,?)`)
      .bind(id,['mbp','mini'][index],'same-native-session',projectIds[index],'codex_cli',
        '2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z').run();

    await t.test('groups preserve project identities and membership retries are atomic and idempotent',async()=> {
      const created=await write('/api/project-groups',{name:'Synthetic product'});
      assert.equal(created.status,201);
      const data=await created.json() as any;groupId=data.project_group.id;
      assert.match(groupId,/^[a-f0-9-]{36}$/);assert.equal(data.project_group.member_count,0);
      const responses=await Promise.all([write(`/api/project-groups/${groupId}/members`,{project_id:projectIds[0]}),
        write(`/api/project-groups/${groupId}/members`,{project_id:projectIds[0]})]);
      assert.deepEqual(responses.map(response=>response.status).sort(),[200,201]);
      await write(`/api/project-groups/${groupId}/members`,{project_id:projectIds[1]});
      const group=await (await read(`/api/project-groups/${groupId}`)).json() as any;
      assert.equal(group.project_group.member_count,2);
      assert.equal(new Set(group.members.map((row:any)=>row.project_id)).size,2);
      assert.ok(group.members.every((row:any)=>row.project_name.startsWith('Synthetic')));
      const updatedAt=group.project_group.updated_at;
      assert.equal((await write(`/api/project-groups/${groupId}/members`,{project_id:projectIds[0]})).status,200);
      assert.equal((await (await read(`/api/project-groups/${groupId}`)).json() as any).project_group.updated_at,updatedAt);
      assert.equal(await count('project_group_members'),2);
      assert.equal(await count('project_workflow_audit',"WHERE action='project_group.member_linked'"),2);
      assert.equal(await count('projects'),3);
    });

    await t.test('explicit directional relations reject guessed merges and duplicate links',async()=> {
      const payload={from_project_id:projectIds[0],to_project_id:projectIds[1],type:'depends_on'};
      const responses=await Promise.all([write('/api/project-relations',payload),write('/api/project-relations',payload)]);
      assert.deepEqual(responses.map(response=>response.status).sort(),[200,201]);
      const values=await Promise.all(responses.map(response=>response.json())) as any[];
      assert.equal(values[0].relation.id,values[1].relation.id);
      assert.equal(values[0].relation.from_project_name,'Synthetic website');
      await write('/api/project-relations',{from_project_id:projectIds[2],to_project_id:projectIds[0],type:'shares_service'});
      const data=await (await read('/api/project-relations?project_id='+projectIds[1])).json() as any;
      assert.equal(data.relations.length,1);
      assert.equal(data.relations[0].type,'depends_on');
      await bad(()=>write('/api/project-relations',{...payload,to_project_id:projectIds[0]}),400);
      await bad(()=>write('/api/project-relations',{...payload,type:'same_project'}),400);
      await bad(()=>write('/api/project-relations',{...payload,to_project_id:hash('missing')}),404);
      assert.equal(await count('project_relations'),2);
      assert.equal(await count('project_workflow_audit',"WHERE action='project_relation.created'"),2);
    });

    await t.test('a task links distinct sessions across devices and repositories and records status once',async()=> {
      const created=await write('/api/tasks',{title:'Synthetic cross-repo login fix'});
      assert.equal(created.status,201);taskId=(await created.json() as any).task.id;
      const repeated=await Promise.all([write(`/api/tasks/${taskId}/sessions`,{session_id:sessionIds[0]}),
        write(`/api/tasks/${taskId}/sessions`,{session_id:sessionIds[0]})]);
      assert.deepEqual(repeated.map(response=>response.status).sort(),[200,201]);
      await write(`/api/tasks/${taskId}/sessions`,{session_id:sessionIds[1]});
      const detail=await (await read(`/api/tasks/${taskId}`)).json() as any;
      assert.equal(detail.task.status,'open');assert.equal(detail.task.session_count,2);
      assert.equal(new Set(detail.sessions.map((row:any)=>row.id)).size,2);
      assert.equal(new Set(detail.sessions.map((row:any)=>row.device_id)).size,2);
      assert.equal(new Set(detail.sessions.map((row:any)=>row.project_id)).size,2);
      assert.ok(detail.sessions.every((row:any)=>row.source_session_id==='same-native-session'));
      const statuses=await Promise.all([write(`/api/tasks/${taskId}/status`,{status:'completed'}),
        write(`/api/tasks/${taskId}/status`,{status:'completed'})]);
      const changed=await Promise.all(statuses.map(response=>response.json())) as any[];
      assert.equal(changed.filter(value=>value.changed).length,1);
      assert.equal(await count('project_workflow_audit',"WHERE action='task.status.completed'"),1);
      assert.equal((await (await read('/api/tasks?status=open')).json() as any).tasks.length,0);
      assert.equal((await (await read('/api/tasks?status=completed')).json() as any).tasks.length,1);
      await write(`/api/tasks/${taskId}/status`,{status:'open'});
      assert.equal(await count('sessions'),2);
    });

    await t.test('keyset listings bound groups, links, relations, tasks and sessions without omissions',async()=> {
      await write('/api/project-groups',{name:'Synthetic secondary group'});
      await write('/api/tasks',{title:'Synthetic secondary task'});
      for(const [path,field,idField] of [['/api/project-groups','project_groups','id'],
        [`/api/project-groups/${groupId}`,'members','project_id'],['/api/project-relations','relations','id'],
        ['/api/tasks','tasks','id'],[`/api/tasks/${taskId}`,'sessions','id']]) {
        const first=await (await read(path+'?limit=1')).json() as any;
        assert.equal(first[field].length,1);assert.ok(first.next_cursor);
        const second=await (await read(path+'?limit=1&before='+encodeURIComponent(first.next_cursor))).json() as any;
        assert.equal(second[field].length,1);assert.equal(second.next_cursor,null);
        assert.notEqual(first[field][0][idField],second[field][0][idField]);
        await bad(()=>read(path+'?before=invalid'),400);
        await bad(()=>read(path+'?limit=41'),400);
      }
    });

    await t.test('strict mutation schemas reject forged actors, invalid identifiers and missing references',async()=> {
      await bad(()=>write('/api/tasks',{title:'ok',actor:'forged-reviewer'}),400);
      await bad(()=>write('/api/project-groups',{name:''}),400);
      await bad(()=>write('/api/project-groups',{name:'x'.repeat(161)}),400);
      await bad(()=>write('/api/tasks',{title:'embedded\ncontrol'}),400);
      await bad(()=>write('/api/tasks',[]),400);
      await bad(()=>write(`/api/tasks/${taskId}/sessions`,{session_id:'same-native-session'}),400);
      await bad(()=>write(`/api/tasks/${taskId}/sessions`,{session_id:hash('missing')}),404);
      await bad(()=>write(`/api/tasks/${taskId}/status`,{status:'cancelled'}),400);
      await bad(()=>write('/api/project-groups/00000000-0000-4000-8000-000000000000/members',{project_id:projectIds[0]}),404);
      await bad(()=>read('/api/tasks/invalid-id'),400);
      await bad(()=>read('/api/tasks?status=cancelled'),400);
      await bad(()=>read('/api/project-relations?project_id=invalid'),400);
      assert.equal(await projectRead(new Request('http://localhost/api/unknown'),env),null);
      assert.equal(await projectWrite(new Request('http://localhost/api/unknown',{method:'POST'}),env,reviewer),null);
      const actors=await db.prepare('SELECT DISTINCT actor FROM project_workflow_audit').all<{actor:string}>();
      assert.deepEqual(actors.results,[{actor:reviewer}]);
    });

    await t.test('audit failures roll back creations, membership additions and task status changes',async()=> {
      await db.prepare(`CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON project_workflow_audit
        WHEN NEW.actor='synthetic-blocked-reviewer' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END`).run();
      await assert.rejects(()=>write('/api/project-groups',{name:'Synthetic rollback'},'synthetic-blocked-reviewer'));
      assert.equal(await count('project_groups','WHERE name=?',['Synthetic rollback']),0);
      await assert.rejects(()=>write(`/api/project-groups/${groupId}/members`,{project_id:projectIds[2]},'synthetic-blocked-reviewer'));
      assert.equal(await count('project_group_members','WHERE group_id=? AND project_id=?',[groupId,projectIds[2]]),0);
      await assert.rejects(()=>write(`/api/tasks/${taskId}/status`,{status:'completed'},'synthetic-blocked-reviewer'));
      assert.equal((await (await read(`/api/tasks/${taskId}`)).json() as any).task.status,'open');
      await db.prepare('DROP TRIGGER synthetic_audit_failure').run();
    });

    await t.test('group, relation, task and audit records survive workerd storage restart',async()=> {
      const audits=await count('project_workflow_audit');
      await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');env={DB:db} as Env;
      assert.equal((await (await read(`/api/project-groups/${groupId}`)).json() as any).members.length,2);
      assert.equal((await (await read(`/api/tasks/${taskId}`)).json() as any).sessions.length,2);
      assert.equal((await (await read('/api/project-relations')).json() as any).relations.length,2);
      assert.equal(await count('project_workflow_audit'),audits);
    });
  } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
