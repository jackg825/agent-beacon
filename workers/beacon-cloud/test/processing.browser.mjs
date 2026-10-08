import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { workflowFixture, workflowTokens, workflowEvent } from './workflow-fixture.ts';

const { chromium }=await import(process.env.BEACON_PLAYWRIGHT_MODULE||'playwright');
// Synthetic events only; the Worker has no Jev key or deploy gate, so nothing can leave the process.
const commandEvent=(id,command,exit_code,second,session='processing-session')=>({...workflowEvent(id,'alpha',session),
  timestamp:'2026-10-07T00:00:'+String(second).padStart(2,'0')+'Z',command:{command,exit_code}});
test('actual Worker dashboard saves a processing policy, plans a scope and shows the scheduled pending candidate',async()=>{
  const f=await workflowFixture({MAINTENANCE_TASKS:'processing'});let browser;
  const server=createServer(async(request,response)=>{
    try {
      const chunks=[];for await(const chunk of request) chunks.push(chunk);
      const result=await f.runtime().dispatchFetch('http://'+request.headers.host+request.url,{
        method:request.method,headers:Object.fromEntries(Object.entries(request.headers).filter(([,v])=>v!==undefined)),
        body:chunks.length?Buffer.concat(chunks):undefined});
      response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
    }catch{response.writeHead(503);response.end();}
  });
  try {
    assert.equal((await f.upload([commandEvent('proc-fail','npm test -- login',1,10),commandEvent('proc-pass','npm test -- login',0,20)])).status,200);
    assert.equal((await f.upload([commandEvent('proc-mini','npm run lint',0,30,'mini-processing-session')],workflowTokens.mini)).status,200);
    const project=(await (await f.read('/api/projects')).json()).projects.find(p=>p.name.endsWith('/alpha'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.BEACON_CHROMIUM_EXECUTABLE});
    const context=await browser.newContext({httpCredentials:{username:'beacon',password:workflowTokens.read},viewport:{width:1280,height:900}});
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/dashboard');await page.locator('.session').first().waitFor();
    await page.getByRole('tab',{name:'背景整理',exact:true}).click();
    await page.locator('#processing-effective').getByText('工作區上限',{exact:true}).waitFor();
    await page.getByText('今天沒有外部呼叫。',{exact:true}).waitFor();
    await page.locator('#processing-usage').getByText(/外部呼叫已停用（上限為 0）/).waitFor();
    // Saving without the reviewer key is refused in the page and stores nothing.
    await page.locator('summary').filter({hasText:'修改政策（需要審閱金鑰）'}).click();
    await page.getByLabel('啟用背景整理',{exact:true}).check();
    for(const field of ['指令內容','任務／筆記標題與專案名稱']) await page.locator('#processing-summary-fields').getByLabel(field,{exact:true}).check();
    await page.getByLabel('最少新事件數',{exact:true}).fill('1');
    await page.getByLabel('安靜分鐘數',{exact:true}).fill('0');
    await page.getByRole('button',{name:'儲存政策',exact:true}).click();
    await page.getByText('請先在「管理與審閱權限」輸入審閱金鑰。',{exact:true}).waitFor();
    assert.equal((await (await f.read('/api/processing/policy')).json()).workspace,null);
    await page.getByLabel('審閱金鑰',{exact:true}).fill(workflowTokens.review);
    await page.getByRole('button',{name:'儲存政策',exact:true}).click();
    await page.getByText('政策已儲存。下一次排程依新政策規劃；已排入的工作會在執行前重新檢查。',{exact:true}).waitFor();
    const saved=(await (await f.read('/api/processing/policy')).json()).workspace;
    assert.deepEqual([saved.enabled,saved.external_allowed,saved.jev_enabled,saved.summary_fields.sort(),saved.min_new_events,saved.quiet_minutes,saved.version],
      [true,false,false,['command_text','titles'],1,0,1]);
    assert.match(saved.updated_by,/^reviewer:[a-f0-9]{16}$/);
    // Narrow to the project, then plan that scope now; execution waits for the scheduled tick.
    await page.getByLabel('政策範圍',{exact:true}).selectOption(project.id);
    await page.getByRole('button',{name:'讀取政策',exact:true}).click();
    await page.locator('#processing-effective').getByText(/外部呼叫條件：部署允許清單未列入 · 金鑰未設定/).waitFor();
    await page.getByRole('button',{name:'立即排入整理',exact:true}).click();
    await page.getByText(/^已規劃 1 份工作；/).waitFor();
    await page.locator('#processing-jobs').getByText('排隊中',{exact:true}).waitFor();
    const [queued]=(await (await f.read('/api/processing/jobs')).json()).jobs;
    assert.deepEqual([queued.status,queued.scope_type,queued.project_id,queued.source_count,queued.result_context_id],['queued','project',project.id,4,null]);
    const worker=await f.runtime().getWorker();
    assert.equal((await worker.scheduled({cron:'*/15 * * * *',scheduledTime:new Date(Date.now()+120*60_000)})).outcome,'ok');
    await page.getByRole('button',{name:'篩選工作',exact:true}).click();
    await page.locator('#processing-jobs').getByText('已產生候選',{exact:true}).waitFor();
    const [done]=(await (await f.read('/api/processing/jobs')).json()).jobs;
    assert.deepEqual([done.id,done.status,done.covered_count],[queued.id,'succeeded',4]);
    await page.locator('#processing-jobs .card-button').first().click();
    await page.locator('#processing-job-detail').getByText('處理器 beacon.extractive.v1',{exact:false}).waitFor();
    await page.getByRole('button',{name:'查看自動整理候選',exact:true}).click();
    await page.locator('#context-detail').getByText('自動整理・待審',{exact:true}).waitFor();
    assert.equal(await page.locator('#context-list').getByText('自動整理・待審',{exact:true}).count(),1);
    await page.locator('#context-detail').getByText(/^這份候選由背景整理自動產生/).waitFor();
    const candidate=(await (await f.read('/api/context/'+done.result_context_id)).json()).context;
    assert.deepEqual([candidate.status,candidate.origin,candidate.kind,candidate.authoritative,candidate.generation.job_id],['pending','pipeline','summary',false,done.id]);
    assert.equal(candidate.audit[0].actor,'pipeline:beacon.extractive@1');
    assert.equal(await page.locator('#context-detail .content').textContent(),candidate.content);
    const section=heading=>candidate.content.split('\n\n').find(part=>part.startsWith(heading));
    assert.match(section('## 已驗證結果'),/「npm test -- login」結束碼 0/);
    assert.match(section('## 進度'),/先前失敗後已成功：「npm test -- login」/);
    // Default recall still returns only approved knowledge; the pipeline approved nothing.
    assert.equal((await (await f.read('/api/context')).json()).context.length,0);
    for(const storage of ['localStorage','sessionStorage']) assert.equal(await page.evaluate(key=>JSON.stringify({...window[key]}),storage),'{}');
    const output=process.env.BEACON_WORKFLOW_SCREENSHOT_DIR;
    if(output) await mkdir(output,{recursive:true});
    for(const width of [1280,375]) {
      await page.setViewportSize({width,height:900});
      for(const [name,slug] of [['背景整理','processing'],['交接與記憶','processing-context']]) {
        await page.getByRole('tab',{name,exact:true}).click();
        await page.waitForFunction(()=>[...document.querySelectorAll('[role="tab"]')].every(tab=>!tab.disabled));
        if(slug==='processing') {
          await page.locator('#processing-jobs .card-button').first().waitFor();
          await page.locator('#processing-jobs .card-button').first().click();
          await page.getByRole('button',{name:'查看自動整理候選',exact:true}).waitFor();
        } else {
          // Opening the tab reloads the pending list and clears the detail; select the candidate again.
          await page.locator('#context-detail .empty').waitFor();
          await page.locator('#context-list button').first().click();
          await page.locator('#context-detail').getByText('自動整理・待審',{exact:true}).waitFor();
        }
        // The policy editor stays open: its field checkboxes and number inputs must also fit at 375px.
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),slug+' '+width);
        if(output) await page.screenshot({path:output+'/'+slug+'-'+width+'.png',fullPage:true});
      }
    }
    assert.deepEqual(errors,[]);
  }finally {await browser?.close();await new Promise(resolve=>server.close(resolve));await f.close();}
});
