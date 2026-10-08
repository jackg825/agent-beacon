import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { workflowFixture, workflowTokens, workflowEvent } from './workflow-fixture';
import { digest, reviewAuth } from '../src/auth';
import { Env, HttpError } from '../src/types';

test('protected workflows upgrade existing data, link Macs, review immutable evidence and survive restart',async(t)=>{
  const f=await workflowFixture();
  try {
    await t.test('review authority is separate and writes are bounded',async()=>{
      for (const key of [undefined,workflowTokens.read,workflowTokens.mcp,workflowTokens.mbp]) {
        const response=await f.request('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json',
          ...(key?{Authorization:'Bearer '+key}:{})},body:JSON.stringify({title:'synthetic unauthorized task'})});
        assert.equal(response.status,403);
      }
      for (const path of ['/api/tasks','/mcp','/v1/ingest/health']) {
        assert.equal((await f.request(path,{headers:{Authorization:'Bearer '+workflowTokens.review}})).status,401);
      }
      assert.equal((await f.request('/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+workflowTokens.review,
        'Content-Type':'application/json',Origin:'https://hostile.invalid'},body:'{"title":"synthetic"}'})).status,403);
      assert.equal((await f.request('/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+workflowTokens.review,
        'Content-Type':'text/plain'},body:'{"title":"synthetic"}'})).status,415);
      assert.equal((await f.write('/api/tasks',{title:'synthetic',actor:'forged'})).status,400);
      assert.equal((await f.write('/api/tasks',{title:'x'.repeat(66000)})).status,413);
      const malformed=new Uint8Array([123,34,120,34,58,34,255,34,125]);
      assert.equal((await f.request('/api/tasks',{method:'POST',headers:{Authorization:'Bearer '+workflowTokens.review,
        'Content-Type':'application/json'},body:malformed})).status,400);
    });
    await t.test('missing, short and reused review credentials fail closed even when configured to match',async()=>{
      const request=(token:string,scheme='Bearer')=>new Request('http://localhost/api/tasks',{
        headers:{Authorization:scheme==='Basic'?'Basic '+btoa('beacon:'+token):'Bearer '+token}});
      const env={DB:f.db,READ_TOKEN:workflowTokens.read,MCP_TOKEN:workflowTokens.mcp} as Env;
      for(const token of [undefined,'synthetic-short-review',workflowTokens.read,workflowTokens.mcp,workflowTokens.mbp,workflowTokens.mini]) {
        await assert.rejects(reviewAuth(request(token??workflowTokens.review),{...env,REVIEW_TOKEN:token}),
          (error:unknown)=>error instanceof HttpError&&error.status===403);
      }
      const reviewer={...env,REVIEW_TOKEN:workflowTokens.review};
      await assert.rejects(reviewAuth(request(workflowTokens.review,'Basic'),reviewer),
        (error:unknown)=>error instanceof HttpError&&error.status===403);
      assert.equal(await reviewAuth(request(workflowTokens.review),reviewer),'reviewer:'+(await digest(workflowTokens.review)).slice(0,16));
    });
    assert.equal((await f.upload([workflowEvent('mini-event')],workflowTokens.mini)).status,200);
    assert.equal((await f.upload([workflowEvent('beta-event','beta','beta-session')])).status,200);
    const sessions=(await (await f.read('/api/sessions')).json() as any).sessions;
    assert.equal(sessions.length,3);
    const mbp=sessions.find((s:any)=>s.device_id==='mbp'&&s.project_name.endsWith('/alpha'));
    const mini=sessions.find((s:any)=>s.device_id==='mini');
    const beta=sessions.find((s:any)=>s.project_name.endsWith('/beta'));
    assert.equal(mbp.project_id,mini.project_id);assert.notEqual(mbp.id,mini.id);
    const group=(await (await f.write('/api/project-groups',{name:'合成產品群組'})).json() as any).project_group;
    for(const project_id of [mbp.project_id,beta.project_id]) assert.equal((await f.write(`/api/project-groups/${group.id}/members`,{project_id})).status,201);
    const task=(await (await f.write('/api/tasks',{title:'合成跨機交接'})).json() as any).task;
    for(const session of sessions) assert.equal((await f.write(`/api/tasks/${task.id}/sessions`,{session_id:session.id})).status,201);
    await t.test('explicit project/task filters preserve identities',async()=>{
      assert.equal((await f.write('/api/project-relations',{from_project_id:beta.project_id,to_project_id:mbp.project_id,type:'depends_on'})).status,201);
      assert.equal((await (await f.read('/api/sessions?project_group_id='+group.id)).json() as any).sessions.length,3);
      assert.equal((await (await f.read('/api/sessions?task_id='+task.id+'&device_id=mini')).json() as any).sessions.length,1);
      assert.equal((await f.read('/api/sessions?task_id=invalid')).status,400);
      assert.equal((await (await f.read('/api/tasks/'+task.id)).json() as any).sessions.length,3);
    });
    const timeline=(await (await f.read('/api/sessions/'+mbp.id+'/events')).json() as any).events;
    const original=timeline[0];
    assert.equal((await f.upload([workflowEvent('initial-event','alpha','same-native-session','synthetic alternate evidence')])).status,200);
    const versions=(await (await f.read('/api/events/'+original.id+'/versions')).json() as any).versions;
    assert.equal(versions.length,2);
    const alternate=versions.find((v:any)=>v.payload_hash!==original.payload_hash);
    const exact=(await (await f.read('/api/events/'+original.id+'?payload_hash='+alternate.payload_hash)).json() as any).event;
    assert.equal(exact.payload.message,'synthetic alternate evidence');
    assert.equal((await f.read('/api/events/'+original.id+'?payload_hash='+'0'.repeat(64))).status,404);
    assert.equal((await f.write('/api/context',{kind:'summary',project_id:mbp.project_id,title:'合成 Unicode 上限',
      content:'字'.repeat(12000),sources:[{event_id:original.id,payload_hash:alternate.payload_hash}]})).status,201);
    const candidate=(await (await f.write('/api/context',{kind:'summary',project_id:mbp.project_id,task_id:task.id,
      title:'合成交接摘要',content:'<img src=x onerror="window.syntheticInjection=true"> 合成證據：Mac mini 待驗證。',
      sources:[{event_id:original.id,payload_hash:alternate.payload_hash}]})).json() as any).context;
    assert.equal(candidate.status,'pending');assert.equal(candidate.authoritative,false);
    assert.equal((await (await f.read('/api/context')).json() as any).context.length,0);
    const approved=await f.write(`/api/context/${candidate.id}/review`,{decision:'approve',reason:'合成人工審閱'});
    assert.equal(approved.status,200,await approved.clone().text());
    assert.equal((await approved.json() as any).context.authoritative,true);
    await t.test('current and legacy MCP read context and exact versions without write tools',async()=>{
      for(const modern of [true,false]) {
        const client=new Client({name:'synthetic-context-client',version:'1.0.0'},modern?{versionNegotiation:{mode:'auto'}}:{});
        const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{
          requestInit:{headers:{Authorization:'Bearer '+workflowTokens.mcp}},fetch:f.runtime().dispatchFetch.bind(f.runtime()) as unknown as typeof fetch});
        try {
          await client.connect(transport);
          const tools=(await client.listTools()).tools;assert.equal(tools.length,14);
          assert.ok(tools.every(tool=>tool.annotations?.readOnlyHint&&tool.annotations?.destructiveHint===false));
          for(const call of [
            {name:'beacon_get_task',arguments:{task_id:task.id}},
            {name:'beacon_get_context',arguments:{context_id:candidate.id}},
            {name:'beacon_list_context',arguments:{}},
            {name:'beacon_get_event',arguments:{event_id:original.id,payload_hash:alternate.payload_hash}},
          ]) {const value=await client.callTool(call);assert.equal(value.isError,undefined);}
          await assert.rejects(client.callTool({name:'beacon_approve_context',arguments:{context_id:candidate.id}}),/not found/);
        } finally {await client.close();}
      }
    });
    await t.test('a recreated Worker retains groups, task links and approved source versions',async()=>{
      await f.restart();
      assert.equal((await (await f.read('/api/project-groups/'+group.id)).json() as any).members.length,2);
      assert.equal((await (await f.read('/api/tasks/'+task.id)).json() as any).sessions.length,3);
      const retained=(await (await f.read('/api/context/'+candidate.id)).json() as any).context;
      assert.equal(retained.status,'approved');assert.equal(retained.sources[0].payload_hash,alternate.payload_hash);
      assert.equal((await f.read('/api/events/'+original.id+'?payload_hash='+alternate.payload_hash)).status,200);
    });
  } finally {await f.close();}
});
