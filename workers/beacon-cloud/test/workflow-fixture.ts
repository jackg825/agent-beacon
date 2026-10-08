import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { disposeOnFailure } from './env-fixture';
import { applyMigrations } from './migrations';

export const workflowTokens={read:'synthetic-workflow-read-key-00000000000000',review:'synthetic-workflow-review-key-00000000000',
  mcp:'synthetic-workflow-mcp-key-000000000000000',mbp:'synthetic-workflow-mbp-key-000000000000000',mini:'synthetic-workflow-mini-key-00000000000000'};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function workflowEvent(id:string,repo='alpha',session='same-native-session',message='synthetic only') {
  return {vendor:'beacon',product:'endpoint-agent',schema_version:'1.0',timestamp:'2026-10-07T00:00:00Z',
    event:{id,action:'command.executed',kind:'agent_runtime',fidelity:'observed'},harness:{name:'codex_cli',collection_method:'hook'},
    session:{id:session,working_directory:'/synthetic/'+repo},repository:'https://github.com/Example/'+repo+'.git',message};
}
/** `bindings` adds vars to the synthetic Worker, e.g. MAINTENANCE_TASKS for a scheduled-processing check. */
export async function workflowFixture(bindings:Record<string,string>={}) {
  const directory=await mkdtemp(join(tmpdir(),'beacon-context-'));
  const options=convertV4MiniflareOptions({resourcePersistencePath:join(directory,'storage'),workers:[{
    name:'beacon-context',modules:true as const,scriptPath:resolve('dist/worker.mjs'),compatibilityDate:'2026-10-01',
    d1Databases:{DB:'workflow-test-index'},r2Buckets:{RAW:'workflow-test-raw'},bindings:{READ_TOKEN:workflowTokens.read,
      REVIEW_TOKEN:workflowTokens.review,MCP_TOKEN:workflowTokens.mcp,...bindings}}]});
  let mf=new Miniflare(options);
  const request=(path:string,init:Parameters<typeof mf.dispatchFetch>[1]={})=>mf.dispatchFetch('http://localhost'+path,init);
  const read=(path:string)=>request(path,{headers:{Authorization:'Bearer '+workflowTokens.read}});
  const write=(path:string,data:unknown,token=workflowTokens.review)=>request(path,{method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
  const upload=(records:unknown[],token=workflowTokens.mbp)=>request('/v1/ingest/runtime',{method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-ndjson'},body:records.map(record=>JSON.stringify(record)).join('\n')+'\n'});
  const close=async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});};
  const db=await disposeOnFailure(close,async()=>{
    const db=await mf.getD1Database('DB');
    // Exercise upgrading a populated initial database, rather than only a fresh schema.
    await applyMigrations(db,['0001_initial.sql']);
    for (const [id,name,token] of [['mbp','Synthetic MBP',workflowTokens.mbp],['mini','Synthetic Mac mini',workflowTokens.mini]]) {
      await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)')
        .bind(id,name,hash(token),'2026-10-07T00:00:00Z').run();
    }
    const initial=await upload([workflowEvent('initial-event')]);
    if (!initial.ok) throw new Error('Synthetic seed failed');
    // Then every later committed migration, as an operator would before deploying new code.
    await applyMigrations(db,(await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name) && name!=='0001_initial.sql').sort());
    return db;
  });
  return {request,read,write,upload,db,
    runtime:()=>mf,
    async restart(){await mf.dispose();mf=new Miniflare(options);},
    close};
}
