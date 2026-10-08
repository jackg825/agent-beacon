import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { workflowFixture, workflowTokens, workflowEvent } from './workflow-fixture.ts';

const { chromium }=await import(process.env.BEACON_PLAYWRIGHT_MODULE||'playwright');
test('actual Worker dashboard creates related projects, cross-Mac tasks and reviewed versioned notes',async()=>{
  const f=await workflowFixture();let browser;
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
    await f.upload([workflowEvent('mini-event')],workflowTokens.mini);
    await f.upload([workflowEvent('beta-event','beta','beta-session')]);
    const sessions=(await (await f.read('/api/sessions')).json()).sessions;
    const alpha=sessions.find(s=>s.device_id==='mbp'&&s.project_name.endsWith('/alpha'));
    const mini=sessions.find(s=>s.device_id==='mini');const beta=sessions.find(s=>s.project_name.endsWith('/beta'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    assert.equal((await fetch(base+'/dashboard')).status,401);
    browser=await chromium.launch({headless:true,executablePath:process.env.BEACON_CHROMIUM_EXECUTABLE});
    const context=await browser.newContext({httpCredentials:{username:'beacon',password:workflowTokens.read},viewport:{width:1280,height:900}});
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/dashboard');await page.locator('.session').first().waitFor();
    await page.getByRole('tab',{name:'專案關聯',exact:true}).click();
    await page.locator('summary').filter({hasText:'新增群組'}).click();
    await page.getByLabel('群組名稱',{exact:true}).fill('合成產品');
    await page.getByRole('button',{name:'新增群組',exact:true}).click();
    await page.getByText('請先在「管理與審閱權限」輸入審閱金鑰。',{exact:true}).waitFor();
    assert.equal((await (await f.read('/api/project-groups')).json()).project_groups.length,0);
    await page.getByLabel('審閱金鑰',{exact:true}).fill(workflowTokens.review);
    await page.getByRole('button',{name:'新增群組',exact:true}).click();
    await page.getByRole('button',{name:/合成產品.*0 個專案/}).waitFor();
    for(const project of [alpha.project_id,beta.project_id]) {
      await page.getByLabel('加入專案',{exact:true}).selectOption(project);
      await page.getByRole('button',{name:'加入群組',exact:true}).click();
      await page.getByText('專案已加入群組。',{exact:true}).waitFor();
    }
    await page.getByRole('button',{name:/合成產品.*2 個專案/}).waitFor();
    await page.locator('summary').filter({hasText:'新增關聯'}).click();
    await page.getByLabel('來源專案',{exact:true}).selectOption(beta.project_id);
    await page.getByLabel('目標專案',{exact:true}).selectOption(alpha.project_id);
    await page.getByRole('button',{name:'新增關聯',exact:true}).click();
    await page.locator('#relations').getByText(/beta.*依賴.*alpha/).waitFor();
    await page.getByRole('tab',{name:'交接與記憶',exact:true}).click();
    await page.locator('summary').filter({hasText:'新增任務'}).click();
    await page.getByLabel('任務名稱',{exact:true}).fill('合成跨機交接');
    await page.getByRole('button',{name:'新增任務',exact:true}).click();
    await page.getByRole('button',{name:/合成跨機交接.*進行中/}).waitFor();
    const task=(await (await f.read('/api/tasks')).json()).tasks[0];
    await page.getByRole('tab',{name:'活動紀錄',exact:true}).click();
    for(const device of ['Synthetic Mac mini','Synthetic MBP']) {
      await page.getByRole('button',{name:new RegExp('alpha.*'+device)}).click();
      await page.getByLabel('將此 session 加入任務',{exact:true}).selectOption(task.id);
      await page.getByRole('button',{name:'加入任務',exact:true}).click();
      await page.getByText('此 session 已加入任務。',{exact:true}).waitFor();
    }
    assert.equal((await (await f.read('/api/tasks/'+task.id)).json()).sessions.length,2);
    await page.getByLabel('作為筆記來源',{exact:true}).check();
    await page.getByRole('button',{name:'撰寫交接筆記',exact:true}).click();
    await page.getByLabel('筆記所屬任務（選填）',{exact:true}).selectOption(task.id);
    await page.getByLabel('筆記標題',{exact:true}).fill('合成交接摘要');
    const prose='<img src=x onerror="window.syntheticInjection=true"> 合成內容，真實裝置尚未驗證。';
    await page.getByLabel('筆記內容',{exact:true}).fill(prose);
    await page.getByRole('button',{name:'送交審閱',exact:true}).click();
    await page.getByText('筆記已送交審閱，目前尚未採用。',{exact:true}).waitFor();
    const candidate=(await (await f.read('/api/context?status=pending')).json()).context[0];
    assert.equal(candidate.authoritative,false);assert.equal((await (await f.read('/api/context')).json()).context.length,0);
    assert.equal(await page.locator('#context-detail .content').textContent(),prose);
    assert.equal(await page.locator('#context-detail img, #context-detail script').count(),0);
    await page.getByText('原始來源（1）',{exact:true}).click();
    await page.getByText('查看此來源的原始版本',{exact:true}).click();
    await page.locator('#context-detail pre').waitFor();
    assert.equal(JSON.parse(await page.locator('#context-detail pre').textContent()).event.id,'initial-event');
    await page.getByRole('button',{name:'核准筆記',exact:true}).click();
    await page.getByText('筆記已人工核准。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'撰寫新版本',exact:true}).click();
    await page.getByLabel('筆記內容',{exact:true}).fill('合成新版本：保留前版直到核准。');
    await page.getByRole('button',{name:'送交審閱',exact:true}).click();
    await page.getByText('筆記已送交審閱，目前尚未採用。',{exact:true}).waitFor();
    assert.equal((await (await f.read('/api/context/'+candidate.id)).json()).context.status,'approved');
    await page.getByRole('button',{name:'核准筆記',exact:true}).click();
    await page.getByText('筆記已人工核准。',{exact:true}).waitFor();
    assert.equal((await (await f.read('/api/context/'+candidate.id)).json()).context.status,'superseded');
    // Phase 3 revisions in the detail: validity window, a flag created and dismissed, a share created
    // and revoked through the include-shared recall of the other project, and the revision chain.
    const events=(await (await f.read('/api/sessions/'+alpha.id+'/events')).json()).events;
    const memory=(await (await f.write('/api/context',{kind:'memory',project_id:alpha.project_id,title:'合成長期記憶',
      content:'合成：登入流程使用 cookie session。',sources:[{event_id:events[0].id,payload_hash:events[0].payload_hash}]})).json()).context;
    assert.equal((await f.write('/api/context/'+memory.id+'/review',{decision:'approve'})).status,200);
    await page.getByLabel('審閱狀態',{exact:true}).selectOption('approved');
    await page.getByRole('button',{name:'查詢筆記',exact:true}).click();
    await page.getByRole('button',{name:/合成長期記憶/}).click();
    await page.getByText(/^有效期間：.*目前仍在有效期間內。$/).waitFor();
    await page.locator('summary').filter({hasText:'審閱標記（0 個待處理）'}).click();
    await page.getByLabel('標記類型',{exact:true}).selectOption('contradiction');
    const flagNote='<img src=x onerror="window.syntheticInjection=true"> 合成：新紀錄可能與此矛盾。';
    await page.getByLabel('標記說明（選填）',{exact:true}).fill(flagNote);
    await page.getByRole('button',{name:'新增標記',exact:true}).click();
    await page.getByText('標記已新增。標記只提醒再確認，不會改變核准狀態。',{exact:true}).waitFor();
    const flagged=(await (await f.read('/api/context/'+memory.id)).json()).context;
    assert.deepEqual([flagged.status,flagged.open_flags,flagged.flags[0].note],['approved',1,flagNote]);
    await page.getByRole('button',{name:/合成長期記憶.*1 個待處理標記/}).waitFor();
    assert.equal(await page.getByText(flagNote,{exact:true}).count(),1);
    assert.equal(await page.locator('#context-detail img, #context-detail script').count(),0);
    await page.getByLabel('處理理由',{exact:true}).fill('合成：已核對，內容仍正確。');
    await page.getByRole('button',{name:'駁回標記',exact:true}).click();
    await page.getByText('標記已駁回。',{exact:true}).waitFor();
    assert.equal((await (await f.read('/api/context/flags/'+flagged.flags[0].id)).json()).flag.status,'dismissed');
    await page.locator('summary').filter({hasText:'跨專案共享（0 個共享中）'}).click();
    await page.getByLabel('共享到專案',{exact:true}).selectOption(beta.project_id);
    await page.getByRole('button',{name:'共享這份記憶',exact:true}).click();
    await page.getByText('已共享。對方專案查詢時明確包含共享內容才會看到。',{exact:true}).waitFor();
    assert.deepEqual((await (await f.read('/api/context?project_id='+beta.project_id+'&include_shared=1')).json()).context.map(entry=>entry.id),[memory.id]);
    await page.getByLabel('筆記專案',{exact:true}).selectOption(beta.project_id);
    await page.getByLabel('包含其他專案共享的長期記憶',{exact:true}).check();
    await page.getByRole('button',{name:'查詢筆記',exact:true}).click();
    await page.getByRole('button',{name:/合成長期記憶.*其他專案共享/}).click();
    await page.getByText(/^這份長期記憶屬於其他專案/).waitFor();
    await page.getByRole('button',{name:'撤銷共享',exact:true}).click();
    await page.getByText(/^共享已撤銷。/).waitFor();
    assert.equal((await (await f.read('/api/context?project_id='+beta.project_id+'&include_shared=1')).json()).context.length,0);
    await page.getByLabel('包含其他專案共享的長期記憶',{exact:true}).uncheck();
    await page.getByLabel('筆記專案',{exact:true}).selectOption('');
    await page.getByRole('button',{name:'查詢筆記',exact:true}).click();
    await page.getByRole('button',{name:/合成交接摘要/}).click();
    await page.locator('summary').filter({hasText:'修訂鏈與有效期間'}).click();
    await page.getByText(/^較早版本 · 已由新版取代 · 合成交接摘要/).waitFor();
    await page.getByText(/^目前這份 · 已核准 · 合成交接摘要/).waitFor();
    assert.equal(await page.evaluate(()=>window.syntheticInjection),undefined);
    for(const storage of ['localStorage','sessionStorage']) assert.equal(await page.evaluate(key=>JSON.stringify({...window[key]}),storage),'{}');
    assert.deepEqual(errors,[]);
    const output=process.env.BEACON_WORKFLOW_SCREENSHOT_DIR;
    if(output) await mkdir(output,{recursive:true});
    for(const width of [1280,375]) {
      await page.setViewportSize({width,height:900});
      for(const [name,slug] of [['活動紀錄','activity'],['專案關聯','projects'],['交接與記憶','context']]) {
        await page.getByRole('tab',{name,exact:true}).click();
        await page.waitForFunction(()=>[...document.querySelectorAll('[role="tab"]')].every(tab=>!tab.disabled));
        if(slug==='context') {
          await page.getByLabel('審閱狀態',{exact:true}).selectOption('approved');
          await page.getByRole('button',{name:'查詢筆記',exact:true}).click();
          await page.locator('#context-list button').first().waitFor();
          await page.locator('#context-list button').first().click();
          await page.locator('#context-detail .content').waitFor();
          await page.waitForFunction(()=>!document.querySelector('#context-list button:disabled'));
        }
        await page.evaluate(()=>document.querySelectorAll('details.panel').forEach(panel=>panel.open=false));
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
        if(output) await page.screenshot({path:output+'/'+slug+'-'+width+'.png',fullPage:true});
      }
    }
    await page.reload();await page.locator('.session').first().waitFor();
    assert.equal(await page.getByLabel('審閱金鑰',{exact:true}).inputValue(),'');
    assert.notEqual(alpha.id,mini.id);
  }finally {await browser?.close();await new Promise(resolve=>server.close(resolve));await f.close();}
});
