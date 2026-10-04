// Opt-in acceptance for the isolated test Worker only. Never read installed Beacon logs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { verifyMcp } from '../test/mcp-client';
// @ts-expect-error Node-only synthetic producer, unchanged shipping hook binary.
import { produceBeaconFixture } from '../test/collector-fixture.mjs';
// @ts-expect-error Standalone customer-managed forwarder.
import { runOnce } from '../forwarder/forwarder.mjs';

type Secrets={READ_TOKEN:string;MCP_TOKEN:string;devices:{mbp:{id:string;token:string};mini:{id:string;token:string}}};
type State={marker:string;started_at:string;endpoint:string;hook_ids?:string[];hook_records?:Record<string,any>[]};
// These names are evaluated inside Chromium, never in the Node runner.
declare const document: {querySelectorAll(selector:string):{length:number;[index:number]:{textContent:string|null}};documentElement:{scrollWidth:number}};
declare const window: {innerWidth:number};
async function main() {
const args=process.argv.slice(2);
function option(name:string,fallback?:string) {const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];}
const mode=option('mode','seed'), endpoint=new URL(option('endpoint')||'');
if (!['seed','verify'].includes(mode!) || endpoint.protocol!=='https:' || !/^agent-beacon-cloud-test\.[a-z0-9-]+\.workers\.dev$/.test(endpoint.hostname)
  || endpoint.pathname!=='/' || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error('Isolated test endpoint required');
const secretsPath=resolve(option('secrets-file')||'.local/test-secrets.json');
if(((await stat(secretsPath)).mode&0o077)!==0) throw new Error('Private secrets file required');
const secrets=JSON.parse(await readFile(secretsPath,'utf8')) as Secrets;
const tokens=[secrets.READ_TOKEN,secrets.MCP_TOKEN,secrets.devices?.mbp?.token,secrets.devices?.mini?.token];
if(tokens.some(token=>typeof token!=='string'||!/^[A-Za-z0-9._~-]{32,512}$/.test(token))||new Set(tokens).size!==4||
  [secrets.devices?.mbp?.id,secrets.devices?.mini?.id].some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(id))||
  secrets.devices.mbp.id===secrets.devices.mini.id) throw new Error('Distinct private test credentials and device identities required');
const statePath=resolve(option('state-file')||'.local/cloud-smoke-state.json');
const resultPath=resolve(option('result-file')||`.local/cloud-smoke-${mode}.json`);
let state:State;
try {state=JSON.parse(await readFile(statePath,'utf8'));} catch(error) {
  if(mode!=='seed' || (error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error('Existing seed state required');
  state={marker:'cloud-synthetic-'+randomUUID(),started_at:new Date().toISOString(),endpoint:endpoint.origin};
  await writeFile(statePath,JSON.stringify(state),{mode:0o600,flag:'wx'});
}
if(state.endpoint!==endpoint.origin) throw new Error('Test state endpoint mismatch');
if(!/^cloud-synthetic-[a-f0-9-]{36}$/.test(state.marker)||!Number.isFinite(Date.parse(state.started_at))) throw new Error('Invalid synthetic state');
if(state.hook_ids&&!state.hook_records) throw new Error('Existing synthetic records unavailable; use a new private state file');
const checks:string[]=[];
async function check(label:string,work:()=>Promise<void>) {await work();checks.push(label);console.log('PASS '+label);}
const request=(path:string,init:RequestInit={})=>fetch(new URL(path,endpoint),{...init,redirect:'error'});
const read=(path:string)=>request(path,{headers:{Authorization:'Bearer '+secrets.READ_TOKEN}});
const upload=(records:unknown[],token:string)=>request('/v1/ingest/runtime',{method:'POST',
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-ndjson'},body:records.map(r=>JSON.stringify(r)).join('\n')+'\n'});
function record(id:string,remote:string) {return {vendor:'beacon',product:'endpoint-agent',schema_version:'1.0',timestamp:state.started_at,
  event:{id:state.marker+'-'+id,kind:'agent_runtime',action:'command.executed',fidelity:'observed'},
  harness:{name:'codex_cli',collection_method:'hook'},session:{id:state.marker,working_directory:'/synthetic/test-checkout'},
  repository:remote,message:'Cloudflare synthetic acceptance only',command:{command:'echo synthetic',exit_code:0}};}
try {
  await check('anonymous and cross-role requests rejected',async()=> {
    for(const path of ['/dashboard','/api/sessions','/mcp','/v1/ingest/health']) assert.equal((await request(path)).status,401);
    assert.equal((await request('/api/devices',{headers:{Authorization:'Bearer '+secrets.devices.mbp.token}})).status,401);
    assert.equal((await request('/mcp',{headers:{Authorization:'Bearer '+secrets.READ_TOKEN}})).status,401);
    assert.equal((await upload([record('wrong-role','https://github.com/example/cloud-smoke')],secrets.READ_TOKEN)).status,401);
    assert.equal((await upload([{...record('forged','https://github.com/example/cloud-smoke'),device_id:secrets.devices.mini.id}],secrets.devices.mbp.token)).status,403);
  });
  if(mode==='seed') {
    await check('real Worker accepts raw batches and concurrent regrouped replays',async()=> {
      const events=[record('one','git@github.com:Example/Cloud-Smoke.git'),record('two','git@github.com:Example/Cloud-Smoke.git')];
      for(const response of await Promise.all([upload(events,secrets.devices.mbp.token),upload(events,secrets.devices.mbp.token),upload([events[0]],secrets.devices.mbp.token)]))
        assert.equal(response.status,200);
      assert.equal((await upload([record('one','https://github.com/example/cloud-smoke/')],secrets.devices.mini.token)).status,200);
    });
    await check('shipping hook producer forwards synthetic JSONL to Cloudflare',async()=> {
      const directory=await mkdtemp(join(tmpdir(),'beacon-cloud-acceptance-'));
      try {
        if(!state.hook_records) {
          const fixture=await produceBeaconFixture(directory,{sessionId:state.marker+'-hook'});
          // Keep known synthetic wire fields, clearing OS identity and generated
          // temp paths. Newly added upstream metadata is not forwarded implicitly.
          const fields=['vendor','product','schema_version','timestamp','event','harness','message','model',
            'origin','sequence','severity','trace','command','tool','gen_ai'];
          state.hook_records=fixture.events.map((event:any)=>({...Object.fromEntries(fields.filter(key=>key in event).map(key=>[key,event[key]])),
            endpoint:{hostname:'Synthetic MBP',os:'darwin'},user:{name:'synthetic-user'},
            session:{id:state.marker+'-hook',working_directory:'/synthetic/shipping-hook'},
            repository:'https://github.com/example/cloud-smoke.git',project:{remote:'https://github.com/example/cloud-smoke.git'}}));
          state.hook_ids=state.hook_records!.map(event=>event.event.id);
          // Persist before the first upload. A retry replays identical event IDs
          // and bytes even after interruption or an uncertain network response.
          await writeFile(statePath,JSON.stringify(state),{mode:0o600});
        }
        const sanitized=state.hook_records!;
        assert.equal(sanitized.length,2);
        assert.deepEqual(sanitized.map(event=>event.event.id),state.hook_ids);
        const logPath=join(directory,'sanitized-runtime.jsonl');
        await writeFile(logPath,sanitized.map((event:any)=>JSON.stringify(event)).join('\n')+'\n',{mode:0o600});
        const tokenFile=join(directory,'device-token');await writeFile(tokenFile,secrets.devices.mbp.token,{mode:0o600});
        const config={endpoint:endpoint.origin,tokenFile,stateDir:join(directory,'state'),streams:{runtime:{path:logPath,readFrom:'beginning'}}};
        const result=await runOnce(config);assert.equal(result.sent,2);assert.equal(result.pendingBatches,0);
        assert.equal((await runOnce(config)).sent,0);
      } finally {await rm(directory,{recursive:true,force:true});}
    });
  }
  let primaryId='';
  await check('D1 sessions isolate devices and normalize SSH HTTPS projects',async()=> {
    const response=await read('/api/sessions');assert.equal(response.status,200);
    const data=await response.json() as any;
    const sessions=data.sessions.filter((s:any)=>s.source_session_id===state.marker);
    assert.equal(sessions.length,2);
    const mbp=sessions.find((s:any)=>s.device_id===secrets.devices.mbp.id),mini=sessions.find((s:any)=>s.device_id===secrets.devices.mini.id);
    assert.ok(mbp && mini);assert.notEqual(mbp.id,mini.id);assert.equal(mbp.project_id,mini.project_id);
    assert.equal(mbp.event_count,2);assert.equal(mini.event_count,1);primaryId=mbp.id;
    const filtered=await (await read('/api/sessions?device_id='+encodeURIComponent(secrets.devices.mini.id)+'&project_id='+mbp.project_id)).json() as any;
    assert.equal(filtered.sessions.filter((s:any)=>s.source_session_id===state.marker).length,1);
  });
  await check('R2-backed timelines retain exact synthetic evidence after restart or redeploy',async()=> {
    const data=await (await read('/api/sessions/'+primaryId+'/events')).json() as any;
    assert.equal(data.events.length,2);
    for(const id of ['one','two']) assert.deepEqual(data.events.find((event:any)=>event.event_id===state.marker+'-'+id)?.payload,
      record(id,'git@github.com:Example/Cloud-Smoke.git'));
    const sessions=await (await read('/api/sessions')).json() as any;
    const hook=sessions.sessions.find((s:any)=>s.source_session_id===state.marker+'-hook');
    assert.ok(hook);assert.equal(hook.event_count,2);
    const timeline=await (await read('/api/sessions/'+hook.id+'/events')).json() as any;
    assert.deepEqual(timeline.events.map((e:any)=>e.event_id).sort(),state.hook_ids!.slice().sort());
    for(const event of timeline.events) assert.deepEqual(event.payload,state.hook_records!.find(record=>record.event.id===event.event_id));
  });
  await check('official modern and legacy MCP clients read the deployed backend',async()=> {
    for(const result of await verifyMcp(new URL('/mcp',endpoint).href,secrets.MCP_TOKEN,primaryId)) {
      const timeline=result.timeline as any;
      assert.equal(timeline.session.id,primaryId);assert.equal(timeline.events.length,2);
      assert.deepEqual(timeline.events.map((event:any)=>event.event_id).sort(),['one','two'].map(id=>state.marker+'-'+id).sort());
    }
  });
  if(process.env.BEACON_PLAYWRIGHT_MODULE) await check('deployed dashboard works in authenticated desktop and mobile Chromium',async()=> {
    const {chromium}=await import(process.env.BEACON_PLAYWRIGHT_MODULE!);
    const browser=await chromium.launch({headless:true,executablePath:process.env.BEACON_CHROMIUM_EXECUTABLE});
    try {
      const context=await browser.newContext({httpCredentials:{username:'beacon',password:secrets.READ_TOKEN}});
      const page=await context.newPage();page.setDefaultTimeout(15000);const errors:string[]=[];
      page.on('pageerror',(error:Error)=>errors.push(error.message));
      await page.goto(new URL('/dashboard',endpoint).href);
      const primary=page.locator('.session').filter({has:page.getByText(state.marker,{exact:true})});
      await primary.first().waitFor();await primary.first().click();await page.locator('.event').first().waitFor();
      await page.locator('.event summary').first().click();
      assert.equal(JSON.parse(await page.locator('.event pre').first().textContent()).message,'Cloudflare synthetic acceptance only');
      await page.getByLabel('裝置',{exact:true}).selectOption(secrets.devices.mini.id);
      await page.getByRole('button',{name:'套用篩選'}).click();
      await page.waitForFunction((marker:string)=>Array.from(document.querySelectorAll('.session .session-meta:last-child'))
        .filter(node=>node.textContent===marker).length===1,state.marker);
      await page.setViewportSize({width:375,height:812});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);
      await context.close();
    } finally {await browser.close();}
  });
  await writeFile(resultPath,JSON.stringify({date:new Date().toISOString(),phase:mode,endpoint:endpoint.origin,
    marker:state.marker,checks,passed:true,synthetic_only:true},null,2),{mode:0o600});
  console.log('Cloud acceptance complete: '+checks.length+' checks, synthetic data only.');
} catch {
  console.error('Cloud acceptance failed at check '+(checks.length+1)+'; no response bodies or credentials printed.');
  process.exitCode=1;
}
}
main().catch(()=> {
  // Startup parsing and file errors are sanitized too: JSON parser exceptions
  // can otherwise include fragments of the private credential file.
  console.error('Cloud acceptance setup failed; no file contents or credentials printed.');process.exitCode=1;
});
