import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { later, latestCheckpoint, operationsTokens, operationsWorker } from './operations-fixture.ts';
import { syntheticEvent } from './env-fixture.ts';

const { chromium }=await import(process.env.BEACON_PLAYWRIGHT_MODULE||'playwright');
const run=promisify(execFile);
const sha=value=>createHash('sha256').update(value).digest('hex');
const DAY=24*60*60_000;
// Synthetic devices, events, notes and credentials only. The restore drill runs the real CLI
// against this process's loopback server and its own temporary Miniflare; nothing leaves the machine.
const markup='<img src=x onerror="window.__beaconInjected=1">';
test('actual Worker dashboard grants Mac sync, runs and drills a backup, and renders health and a retention plan',async t=>{
  const worker=await operationsWorker({MAINTENANCE_TASKS:'backup,health'});let browser;
  const drillDir=await mkdtemp(join(tmpdir(),'beacon-ops-browser-'));
  const server=createServer(async(request,response)=>{
    try {
      const chunks=[];for await(const chunk of request) chunks.push(chunk);
      const result=await worker.mf.dispatchFetch('http://'+request.headers.host+request.url,{
        method:request.method,headers:Object.fromEntries(Object.entries(request.headers).filter(([,v])=>v!==undefined)),
        body:chunks.length?Buffer.concat(chunks):undefined});
      response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
    }catch{response.writeHead(503);response.end();}
  });
  const read=async path=>{const response=await worker.bearer(path,operationsTokens.read);assert.equal(response.status,200,path);return response.json();};
  const write=async(path,body,expected=201)=>{const response=await worker.write(path,body);assert.equal(response.status,expected,path+' '+await response.clone().text());return response.json();};
  try {
    // A device that never uploaded, named with markup: it must surface as a stale-device finding, rendered as text.
    await worker.env.DB.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)')
      .bind('stale-mac',markup+'合成閒置 Mac',sha('synthetic-stale-device-key-never-used'),'2026-10-01T00:00:00Z').run();
    // Three batches: two alpha sessions and one beta session.
    for(const [id,options] of [['ops-alpha-1',{session:'ops-a'}],['ops-alpha-2',{session:'ops-b'}],['ops-beta-1',{repo:'beta',session:'ops-beta'}]])
      assert.equal((await worker.upload([syntheticEvent(id,options)])).status,200);
    const {projects}=await read('/api/projects');
    const alpha=projects.find(p=>p.name.endsWith('/alpha')),beta=projects.find(p=>p.name.endsWith('/beta'));
    const source=async(project,session)=>{
      const {sessions}=await read('/api/sessions?project_id='+project.id);
      const [event]=(await read('/api/sessions/'+sessions.find(s=>s.source_session_id===session).id+'/events')).events;
      return {event_id:event.id,payload_hash:event.payload_hash};
    };
    const alphaSource=await source(alpha,'ops-a'),betaSource=await source(beta,'ops-beta');
    const approved=async(body)=>{const {context}=await write('/api/context',body);await write('/api/context/'+context.id+'/review',{decision:'approve'},200);return context.id;};
    // Both alpha notes cite the same batch, so the other alpha batch stays unreferenced for the retention plan.
    await approved({kind:'memory',project_id:alpha.id,title:'合成登入規則 <b>不是標記</b>',content:'合成：登入使用 cookie session。'+markup,sources:[alphaSource]});
    await approved({kind:'summary',project_id:alpha.id,title:'合成交接摘要',content:'合成：MBP 修好 callback，待 Mac mini 驗證。',sources:[alphaSource]});
    const betaMemory=await approved({kind:'memory',project_id:beta.id,title:'合成共用服務規則',content:'合成：API 與網站共用 session 服務。',sources:[betaSource]});
    await write('/api/context/'+betaMemory+'/shares',{target_type:'project',target_id:alpha.id});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.BEACON_CHROMIUM_EXECUTABLE});
    const context=await browser.newContext({httpCredentials:{username:'beacon',password:operationsTokens.read},viewport:{width:1280,height:900}});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/dashboard');await page.locator('.session').first().waitFor();

    // Mac 同步: the grant needs the reviewer key; the preview is exactly what the device route returns.
    await page.getByRole('tab',{name:'Mac 同步',exact:true}).click();
    await page.getByText('沒有符合篩選的訂閱。新增訂閱後，該裝置才能讀取專案的已核准筆記。',{exact:true}).waitFor();
    await page.getByLabel('同步接收裝置',{exact:true}).selectOption('mbp');
    await page.getByLabel('同步來源專案',{exact:true}).selectOption(alpha.id);
    await page.getByLabel('同步交接摘要',{exact:true}).check();
    await page.getByLabel('同時接收其他專案共享的長期記憶',{exact:true}).check();
    await page.getByRole('button',{name:'新增訂閱',exact:true}).click();
    await page.getByText('請先在「管理與審閱權限」輸入審閱金鑰。',{exact:true}).waitFor();
    assert.equal((await read('/api/sync/subscriptions')).subscriptions.length,0);
    assert.equal((await worker.bearer('/v1/sync/snapshot?project_id='+alpha.id,operationsTokens.mbp)).status,403);
    await page.getByLabel('審閱金鑰',{exact:true}).fill(operationsTokens.review);
    await page.getByRole('button',{name:'新增訂閱',exact:true}).click();
    await page.getByText('訂閱已新增。仍需在那台 Mac 上自行預覽並套用。',{exact:true}).waitFor();
    const [subscription]=(await read('/api/sync/subscriptions')).subscriptions;
    assert.deepEqual([subscription.device_id,subscription.project_id,subscription.kinds,subscription.include_shared,subscription.status],
      ['mbp',alpha.id,['memory','summary'],true,'active']);
    assert.match(subscription.created_by,/^reviewer:[a-f0-9]{16}$/);
    await page.locator('#sync-list').getByText('含其他專案共享的長期記憶',{exact:false}).waitFor();
    await page.getByRole('button',{name:'預覽同步內容',exact:true}).click();
    await page.locator('#sync-preview-heading').getByText(/份已核准筆記/).waitFor();
    const device=await worker.bearer('/v1/sync/snapshot?project_id='+alpha.id,operationsTokens.mbp);
    assert.equal(device.status,200);
    const {snapshot}=await device.json();
    assert.deepEqual([snapshot.subscription_id,snapshot.entry_count,snapshot.include_shared,snapshot.entries.filter(e=>e.shared_from_project_id).length],
      [subscription.id,3,true,1]);
    assert.equal(await page.locator('#sync-preview-heading').textContent(),
      alpha.name+' · 長期記憶、交接摘要 · 含其他專案共享的長期記憶 · 3 份已核准筆記（其中 1 份來自其他專案）');
    assert.equal(await page.locator('#sync-preview > .identity').first().textContent(),'快照雜湊 '+snapshot.snapshot_sha256);
    // Each row starts with the entry title as a plain text node, in the device snapshot's order.
    assert.deepEqual(await page.locator('#sync-preview li').evaluateAll(items=>items.map(item=>item.firstChild.nodeValue)),
      snapshot.entries.map(entry=>entry.title));
    assert.ok(snapshot.entries.some(entry=>entry.title==='合成登入規則 <b>不是標記</b>'));
    await page.locator('#sync-preview').getByText('共享自 '+beta.name,{exact:false}).waitFor();
    assert.equal(await page.locator('#sync-preview img, #sync-preview b').count(),0);

    // 資料維護: health findings as text, a reviewer-started checkpoint advanced by the hourly tick.
    await page.getByRole('tab',{name:'資料維護',exact:true}).click();
    await page.getByText('資料維護資訊已更新。',{exact:true}).waitFor();
    const findingsMatch=async()=>{
      const health=await read('/api/health/data');
      const shown=await page.locator('#ops-findings > li').evaluateAll(items=>items.map(item=>({strong:item.querySelector('strong').textContent,
        hint:item.querySelector('p').textContent,ids:item.querySelector('.identity')?.textContent??null})));
      assert.equal(shown.length,health.findings.length);
      health.findings.forEach((finding,index)=>{
        assert.ok(shown[index].strong.endsWith('（'+finding.count+'）'),finding.code);
        assert.equal(shown[index].hint,finding.hint);
        assert.equal(shown[index].ids,finding.sample_ids.length?'例如：'+finding.sample_ids.join('、'):null);
      });
      return health;
    };
    const before=await findingsMatch();
    assert.deepEqual(before.findings.find(f=>f.code==='device_stale').sample_ids,['stale-mac']);
    await page.locator('summary').filter({hasText:'裝置、容量與備份狀態'}).click();
    await page.locator('#ops-devices').getByText(markup+'合成閒置 Mac · 最後上傳 從未',{exact:true}).waitFor();
    assert.equal(await page.locator('#ops-devices img').count(),0);
    await page.getByRole('button',{name:'讀取備份',exact:true}).click();
    await page.getByText('尚無備份紀錄。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'立即備份',exact:true}).click();
    await page.getByText('已建立備份 checkpoint，排程會在下一次執行時推進。',{exact:true}).waitFor();
    await page.locator('#ops-backups').getByText('進行中',{exact:true}).waitFor();
    const started=(await latestCheckpoint(worker.env));
    assert.deepEqual([started.status,started.started_by.startsWith('reviewer:')],['running',true]);
    assert.equal((await (await worker.mf.getWorker()).scheduled({cron:'17 * * * *',scheduledTime:later(15)})).outcome,'ok');
    const checkpoint=await latestCheckpoint(worker.env);
    assert.deepEqual([checkpoint.id,checkpoint.status,!!checkpoint.integrity_verified_at,checkpoint.raw_object_count],[started.id,'completed',true,3]);
    await page.getByRole('button',{name:'讀取備份',exact:true}).click();
    await page.locator('#ops-backups').getByText('已完成・待演練',{exact:true}).waitFor();
    await page.locator('#ops-backups').getByText(checkpoint.id,{exact:true}).waitFor();
    await page.locator('#ops-backups').getByText(/^原文 3 個（.+）· 完整性 已檢查$/).waitFor();

    // Restore drill through the reviewer object route, then offline from the saved objects.
    const tokenFile=join(drillDir,'review-token'),objects=join(drillDir,'objects');
    await writeFile(tokenFile,operationsTokens.review+'\n',{mode:0o600});
    const cli=async args=>JSON.parse((await run(process.execPath,['--import','tsx','scripts/restore-check.ts',...args,'--checkpoint',checkpoint.id])).stdout);
    const remote=await cli(['--url',base,'--review-token-file',tokenFile,'--out',objects]);
    const offline=await cli(['--dir',objects]);
    assert.equal(remote.report.result,'passed',JSON.stringify(remote.report.failures));
    assert.equal(offline.report.result,'passed',JSON.stringify(offline.report.failures));
    assert.equal(offline.report_sha256,remote.report_sha256);
    assert.deepEqual(offline.verify_request,remote.verify_request);
    const tables=Object.values(offline.report.counts.tables);
    t.diagnostic(`restore drill --dir: ${offline.report.result}, ${tables.length} tables, ${tables.reduce((a,b)=>a+b,0)} rows, `
      +`${offline.report.counts.raw_objects} raw objects, triggers ${offline.report.triggers.matched}/${offline.report.triggers.expected}, `
      +`${offline.report.checks.length} checks, ${offline.report.findings.length} findings`);
    await page.locator('#ops-backups textarea').fill(JSON.stringify(offline.verify_request));
    await page.getByRole('button',{name:'記錄還原演練結果',exact:true}).click();
    await page.getByText('還原演練結果已記錄。',{exact:true}).waitFor();
    await page.locator('#ops-backups').getByText('已驗證',{exact:true}).waitFor();
    assert.equal((await latestCheckpoint(worker.env)).status,'verified');

    // Retention: a reviewer policy, then a plan that leaves the cited batches alone.
    await page.locator('summary').filter({hasText:'設定保存期限'}).click();
    await page.locator('#ops-policy-class').selectOption('raw');
    await page.getByLabel('保存天數（空白代表永久）',{exact:true}).fill('1');
    await page.getByRole('button',{name:'儲存期限',exact:true}).click();
    await page.getByText('保存期限已更新；不會自動刪除任何資料。',{exact:true}).waitFor();
    await page.locator('#ops-policies').getByText('原始事件：保存 1 天',{exact:true}).waitFor();
    await worker.env.DB.prepare('UPDATE batches SET received_at=?').bind(new Date(Date.now()-3*DAY).toISOString()).run();
    const [planResponse]=await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/retention/plan'),
      page.getByRole('button',{name:'產生刪除計畫',exact:true}).click()]);
    const planned=await planResponse.json();
    await page.getByText('已產生刪除計畫，尚未刪除任何資料。',{exact:true}).waitFor();
    const raw=planned.classes.find(item=>item.data_class==='raw');
    assert.deepEqual([planned.plan.batch_ids.length,raw.eligible.batches,raw.blocked.find(item=>item.reason==='referenced_by_context')?.count],[1,1,2]);
    await page.locator('#ops-plan').getByText('這次計畫會刪除 1 批、1 個事件、',{exact:false}).waitFor();
    assert.equal(await page.locator('#ops-plan .identity').textContent(),'計畫雜湊 '+planned.plan.plan_sha256);
    await page.locator('#ops-plan').getByText('被筆記引用：2',{exact:true}).waitFor();
    await page.getByRole('button',{name:'套用刪除計畫',exact:true}).click();
    await page.getByText('請先勾選確認。',{exact:true}).waitFor();
    assert.equal((await worker.env.DB.prepare('SELECT COUNT(*) AS n FROM batches').first()).n,3);
    await page.getByLabel('我已確認備份可還原，並了解這些原文會從主要儲存刪除',{exact:true}).check();
    await page.getByRole('button',{name:'套用刪除計畫',exact:true}).click();
    await page.getByText('已刪除 1 批原文。備份複本會在寬限期後移除。',{exact:true}).waitFor();
    assert.equal((await worker.env.DB.prepare('SELECT COUNT(*) AS n FROM batches').first()).n,2);
    await page.getByRole('button',{name:'重新檢查',exact:true}).click();
    await page.getByText('資料健康已更新。',{exact:true}).waitFor();
    await findingsMatch();
    // The device still reads the same notes: retention removed only the uncited batch.
    assert.equal((await (await worker.bearer('/v1/sync/snapshot?project_id='+alpha.id,operationsTokens.mbp)).json()).snapshot.snapshot_sha256,snapshot.snapshot_sha256);

    assert.equal(await page.evaluate(()=>window.__beaconInjected),undefined);
    for(const storage of ['localStorage','sessionStorage']) assert.equal(await page.evaluate(key=>JSON.stringify({...window[key]}),storage),'{}');
    const output=process.env.BEACON_WORKFLOW_SCREENSHOT_DIR;
    if(output) await mkdir(output,{recursive:true});
    for(const width of [1280,375]) {
      await page.setViewportSize({width,height:900});
      for(const [name,slug,marker,rendered] of [['Mac 同步','sync','sync-count','1 份訂閱 · 依建立時間排序'],['資料維護','operations','status','資料維護資訊已更新。']]) {
        // Opening a tab reloads its lists and rewrites the marker; measure after that reload has rendered.
        await page.evaluate(id=>{document.getElementById(id).textContent='';},marker);
        await page.getByRole('tab',{name,exact:true}).click();
        await page.waitForFunction(([id,text])=>document.getElementById(id).textContent===text,[marker,rendered]);
        await page.waitForFunction(()=>[...document.querySelectorAll('[role="tab"]')].every(tab=>!tab.disabled));
        // The preview, backups list and plan result stay rendered across tab switches, so they are measured too.
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),slug+' '+width);
        if(output) await page.screenshot({path:output+'/'+slug+'-'+width+'.png',fullPage:true});
      }
    }
    assert.deepEqual(errors,[]);
  }finally {
    await browser?.close();if(server.listening) await new Promise(resolve=>server.close(resolve));
    await worker.close();await rm(drillDir,{recursive:true,force:true});
  }
});
