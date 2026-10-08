import { panels } from './dashboard-panels';

const panelTabs = panels.map((panel) => `<button type="button" id="tab-${panel.tab}" role="tab" aria-selected="false" aria-controls="view-${panel.tab}">${panel.label}</button>`).join('');
const panelSections = panels.map((panel) => `<section id="view-${panel.tab}" role="tabpanel" aria-labelledby="tab-${panel.tab}" hidden>${panel.html}</section>\n`).join('');
const HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Beacon · 工作紀錄</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18282d;background:#f3f6f6;color-scheme:light}*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #d8e2e3;padding:24px max(24px,calc((100vw - 1320px)/2))}h1{font-size:24px;margin:0 0 8px;letter-spacing:-.03em}h2{font-size:18px;margin:0}h3{font-size:15px;margin:0}p{line-height:1.55;margin:8px 0}.muted{color:#52676d;font-size:14px}.tag,.badge{display:inline-block;font-size:12px;background:#e9f3ef;color:#17654d;border-radius:20px;padding:4px 10px;vertical-align:middle}.tag{margin-left:8px}.badge.pending{background:#fff0d3;color:#79520a}.badge.rejected{background:#fbe8e6;color:#9e3932}.badge.superseded{background:#edf0f3;color:#52616c}main{max-width:1368px;margin:auto;padding:24px}form,.filters{display:flex;gap:16px;flex-wrap:wrap;align-items:end;padding:20px;background:#fff;border:1px solid #d8e2e3;border-radius:12px}label{display:grid;gap:8px;flex:1;min-width:160px;font-size:13px;font-weight:600}select,input,button,textarea{font:inherit;border-radius:7px}select,input,textarea{width:100%;padding:10px;border:1px solid #b9cacc;background:#fff;color:inherit;min-width:0}textarea{resize:vertical;line-height:1.6}button{cursor:pointer;border:1px solid #aac1bd;background:#fff;color:#20594b;padding:10px 14px;font-weight:600;max-width:100%;overflow-wrap:anywhere}button.primary{background:#206951;color:#fff;border-color:#206951}button.danger{color:#9e3932;border-color:#d6aaa7}button:hover{filter:brightness(.97)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #52a998;outline-offset:3px}button:disabled{cursor:default;opacity:.5}#status{min-height:24px;margin:16px 0;font-size:14px}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}.tabs button[aria-selected=true]{background:#206951;color:#fff;border-color:#206951}.layout{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);gap:20px}.two-column{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}.stack{display:grid;gap:20px}.panel{background:#fff;border:1px solid #d8e2e3;border-radius:12px;overflow:hidden;min-width:0}.panel-title{padding:20px;border-bottom:1px solid #e3ebeb}.panel-body{padding:16px;min-width:0}summary.panel-title{margin:0;font-size:18px;font-weight:600}.panel form{border:0;padding:0;border-radius:0;margin-top:16px}.vertical{display:grid;width:100%;align-items:start}.full{flex-basis:100%}.list{display:grid;gap:10px}#sessions{display:grid;gap:10px}.session,.card-button{width:100%;text-align:left;padding:15px;color:#18282d;border:1px solid #d8e2e3;display:grid;gap:7px}.session[aria-pressed=true],.card-button[aria-pressed=true]{border-color:#206951;background:#eff7f3}.session-title{font-size:15px}.session-meta{font-size:12px;color:#52676d;font-weight:400;overflow-wrap:anywhere}.empty{padding:20px 12px;color:#52676d;line-height:1.7;font-size:14px}#timeline{list-style:none;margin:0;padding:0}.event{border-bottom:1px solid #e3ebeb;padding:16px 0}.event:first-child{padding-top:0}.event:last-child{border:0}.event-heading,.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}.event-action{font-weight:600;font-size:14px}.event-time{font-size:12px;color:#52676d}.event summary,details summary{margin-top:12px;cursor:pointer;font-size:13px;color:#206951}pre{font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0;padding:16px;background:#f3f6f6;border-radius:8px;max-height:420px;overflow:auto}.content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:14px;padding:16px;background:#f3f6f6;border-radius:8px}.pagination{margin-top:16px;width:100%}.write-access{background:#fff;border:1px solid #d8e2e3;border-radius:12px;padding:0 20px 16px;margin-bottom:20px}.write-access .row{justify-content:flex-start;margin-top:16px}.write-access label{max-width:520px}.notice{padding:12px 14px;border-left:3px solid #52a998;background:#edf6f2;font-size:13px;line-height:1.7}.notice.warning{border-color:#b28a38;background:#fff8e9}.source-check{display:flex;gap:8px;align-items:center;min-width:0;flex:none;margin-top:12px;font-weight:400;color:#52676d}.source-check input{width:auto}.sources{padding-left:20px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}.sources li{padding:8px 0}.sources button{font-size:12px;padding:5px 8px;margin-top:5px}.identity{overflow-wrap:anywhere;font-size:12px;color:#52676d}.section-gap{margin-top:20px}.detail-heading{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.review-actions{margin-top:16px}.review-actions label{flex-basis:100%}.compact-list{margin:12px 0 0;padding-left:20px;line-height:1.8;font-size:14px}[hidden]{display:none!important}footer{padding:20px 0;color:#52676d;font-size:12px;line-height:1.7}@media(max-width:800px){main{padding:16px}.layout,.two-column{grid-template-columns:1fr}header{padding:20px}form{padding:16px;gap:12px}label{min-width:140px}.panel-title{padding:16px}.event-heading{display:grid;gap:6px}.write-access{padding:0 16px 16px}}@media(prefers-reduced-motion:no-preference){button{transition:background .12s ease}}
</style><script src="/dashboard.js" defer></script></head>
<body><header><h1>Agent Beacon <span class="tag">私人工作區</span></h1><p class="muted">查閱兩台 Mac 的活動、串起跨專案任務，並審閱有來源的交接筆記。</p></header>
<main>
<details class="write-access" id="write-access"><summary>管理與審閱權限</summary><p class="muted">查閱使用登入權限；新增關聯、任務或筆記及核准內容，需要另外輸入審閱金鑰。金鑰只在這個頁面暫存，關閉頁面後清除。</p><div class="row"><label>審閱金鑰<input id="review-token" type="password" autocomplete="off" spellcheck="false" aria-describedby="review-note"></label><button type="button" id="lock-review">清除金鑰</button></div><p class="muted" id="review-note">不會寫入網址或瀏覽器儲存空間。請勿在筆記內容貼上金鑰。</p></details>
<nav class="tabs" role="tablist" aria-label="工作區頁面"><button type="button" id="tab-activity" role="tab" aria-selected="true" aria-controls="view-activity">活動紀錄</button><button type="button" id="tab-projects" role="tab" aria-selected="false" aria-controls="view-projects">專案關聯</button><button type="button" id="tab-context" role="tab" aria-selected="false" aria-controls="view-context">交接與記憶</button>${panelTabs}</nav>
<p id="status" role="status" aria-live="polite">正在讀取活動紀錄…</p>
<section id="view-activity" role="tabpanel" aria-labelledby="tab-activity">
<form id="filters"><label>裝置<select id="device" name="device_id" aria-label="裝置"><option value="">所有裝置</option></select></label><label>專案<select id="project" name="project_id" aria-label="專案"><option value="">所有專案</option></select></label><label>專案群組<select aria-label="專案群組" id="activity-group" name="project_group_id"><option value="">所有群組</option></select></label><label>任務<select aria-label="任務" id="activity-task" name="task_id"><option value="">所有任務</option></select></label><label>Agent<input id="harness" name="harness" placeholder="例如 codex_cli" maxlength="128"></label><button type="submit" class="primary">套用篩選</button><button type="button" id="refresh">重新整理</button></form>
<div class="layout section-gap"><section class="panel" aria-labelledby="session-heading"><div class="panel-title"><h2 id="session-heading">Session</h2><p class="muted" id="session-count">依最新事件排序</p></div><div class="panel-body"><div id="sessions"></div><button type="button" class="pagination" id="more-sessions" hidden>載入更多 session</button></div></section>
<section class="panel" aria-labelledby="timeline-heading"><div class="panel-title"><h2 id="timeline-heading">事件時間線</h2><p class="muted" id="selected-session">選擇一個 session 查看紀錄。</p><form id="session-link" hidden><label>將此 session 加入任務<select aria-label="將此 session 加入任務" id="session-task" required><option value="">選擇任務</option></select></label><button type="submit">加入任務</button></form></div><div class="panel-body"><p id="timeline-empty" class="empty">裝置保有各自的 session 身分。選擇左側紀錄後，可查看完整事件資料。</p><ol id="timeline"></ol><button type="button" class="pagination" id="more-events" hidden>載入更多事件</button><div class="row section-gap"><span id="selected-source-count" class="muted">尚未選擇筆記來源</span><button type="button" id="open-draft">撰寫交接筆記</button></div></div></section></div>
</section>
<section id="view-projects" role="tabpanel" aria-labelledby="tab-projects" hidden>
<p class="notice">群組把相關 repo 放在一起；關聯描述彼此用途。這些設定不會合併原始紀錄，也不會建立獨立存取權限。</p>
<div class="two-column section-gap"><section class="panel"><div class="panel-title"><h2>專案群組</h2><p class="muted">例如把網站、API 與 SDK 放進同一個產品群組。</p></div><div class="panel-body"><div id="groups" class="list"></div><button type="button" id="more-groups" class="pagination" hidden>載入更多群組</button><details><summary>新增群組</summary><form id="group-create"><label>群組名稱<input name="name" required maxlength="160" placeholder="例如產品 A"></label><button type="submit" class="primary">新增群組</button></form></details></div></section>
<section class="panel"><div class="panel-title"><h2>群組成員</h2><p class="muted" id="group-heading">選擇群組查看專案。</p></div><div class="panel-body"><div id="group-members"></div><button type="button" id="more-members" class="pagination" hidden>載入更多成員</button><form id="member-add" hidden><label>加入專案<select aria-label="加入專案" id="member-project" required><option value="">選擇專案</option></select></label><button type="submit">加入群組</button></form></div></section></div>
<section class="panel section-gap"><div class="panel-title"><h2>專案間的關聯</h2><p class="muted">由來源專案指向另一個專案。例如「網站依賴 API」。</p></div><div class="panel-body"><div id="relations" class="list"></div><button type="button" id="more-relations" class="pagination" hidden>載入更多關聯</button><details><summary>新增關聯</summary><form id="relation-create"><label>來源專案<select aria-label="來源專案" id="relation-from" required><option value="">選擇專案</option></select></label><label>關聯類型<select name="type"><option value="depends_on">依賴</option><option value="shares_service">共用服務</option><option value="fork_of">分支自</option></select></label><label>目標專案<select aria-label="目標專案" id="relation-to" required><option value="">選擇專案</option></select></label><button type="submit" class="primary">新增關聯</button></form></details></div></section>
</section>
<section id="view-context" role="tabpanel" aria-labelledby="tab-context" hidden>
<p class="notice">這裡提供手動筆記與人工審閱。Jev 判斷與 AI 自動 compact 尚未提供；核准不代表系統已查證內容正確。</p>
<div class="two-column section-gap"><section class="panel"><div class="panel-title"><h2>跨裝置任務</h2><p class="muted">把 MBP、Mac mini 或不同 repo 的 session 串成同一件工作。</p></div><div class="panel-body"><div id="tasks" class="list"></div><button type="button" id="more-tasks" class="pagination" hidden>載入更多任務</button><details><summary>新增任務</summary><form id="task-create"><label>任務名稱<input name="title" required maxlength="240" placeholder="例如修復登入並完成測試"></label><button type="submit" class="primary">新增任務</button></form></details></div></section>
<section class="panel"><div class="panel-title"><h2>任務紀錄</h2><p class="muted" id="task-heading">選擇任務查看相關 session。</p></div><div class="panel-body"><div id="task-detail"></div><button type="button" id="more-task-sessions" class="pagination" hidden>載入更多任務 session</button></div></section></div>
<section class="panel section-gap"><div class="panel-title"><h2>交接筆記與長期記憶</h2><p class="muted">預設只顯示已核准內容。待審內容尚未採用。</p></div><div class="panel-body"><form id="context-filters"><label>筆記專案<select aria-label="筆記專案" id="context-project" name="project_id"><option value="">所有專案</option></select></label><label>筆記任務<select aria-label="筆記任務" id="context-task" name="task_id"><option value="">所有任務</option></select></label><label>筆記類型<select name="kind"><option value="">所有類型</option><option value="summary">交接摘要</option><option value="memory">長期記憶</option></select></label><label>審閱狀態<select aria-label="審閱狀態" id="context-status" name="status"><option value="approved">已核准</option><option value="pending">待審・尚未採用</option><option value="rejected">已拒絕</option><option value="superseded">已由新版取代</option></select></label><button type="submit" class="primary">查詢筆記</button></form><div class="layout section-gap"><div><div id="context-list" class="list"></div><button type="button" id="more-context" class="pagination" hidden>載入更多筆記</button></div><div id="context-detail"><p class="empty">選擇一份筆記查看內容與原始來源。</p></div></div></div></section>
<details class="panel section-gap" id="draft-panel"><summary class="panel-title">撰寫有來源的筆記</summary><div class="panel-body"><p class="muted">先在活動時間線勾選原始事件，再填寫內容。送出後一律待審，不會直接採用。</p><p id="draft-revision" class="notice" hidden></p><ul id="draft-sources" class="sources"></ul><button type="button" id="clear-sources">清除來源與新版設定</button><form id="context-create" class="vertical"><div class="row"><label>筆記所屬專案<select aria-label="筆記所屬專案" id="draft-project" required><option value="">選擇專案</option></select></label><label>筆記所屬任務（選填）<select aria-label="筆記所屬任務（選填）" id="draft-task"><option value="">不指定任務</option></select></label><label>內容類型<select aria-label="內容類型" id="draft-kind"><option value="summary">交接摘要</option><option value="memory">長期記憶候選</option></select></label></div><label>筆記標題<input id="draft-title" required maxlength="160" placeholder="例如登入修復：已完成與待確認"></label><label>筆記內容<textarea id="draft-content" rows="7" required maxlength="12000" placeholder="已完成什麼、如何驗證、哪些事項尚未確認。請區分紀錄中的事實與自己的推測。"></textarea></label><button type="submit" class="primary">送交審閱</button></form></div></details>
</section>
${panelSections}<footer>事件與筆記可能含有私人資料，請只在受信任的環境查閱。原始事件維持保存；筆記版本與審閱不會改寫原始事件。核准內容仍只存在中央服務，不會自動寫入兩台 Mac 的 memory。</footer></main></body></html>`;

// Identity, transcript and user-authored text only enter textContent. No stored secret or embedded data.
const SCRIPT = String.raw`'use strict';
(() => {
  const byId = (id) => document.getElementById(id);
  const state = { sessions: [], selected: null, sessionCursor: null, eventCursor: null, sessionVersion: 0, timelineVersion: 0,
    groups: [], group: null, groupCursor: null, memberCursor: null, groupVersion: 0,
    tasks: [], task: null, taskCursor: null, taskSessionCursor: null, taskVersion: 0,
    relations: [], relationCursor: null, context: [], contextCursor: null, contextVersion: 0, detailVersion: 0,
    sources: new Map(), invalidSources: new Set(), supersedes: null, initialized: false };
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = String(value ?? '');
    if (className) node.className = className;
    return node;
  };
  const button = (value, action, className) => {
    const node = text('button', value, className);
    node.type = 'button';
    node.addEventListener('click', async () => {
      if (node.disabled) return;
      node.disabled = true;
      try { await action(); } catch (error) { failure(error); } finally { node.disabled = false; }
    });
    return node;
  };
  const date = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? String(value ?? '時間未知') : parsed.toLocaleString('zh-TW', { hour12: false });
  };
  const status = (message) => { byId('status').textContent = message; };
  const failure = (error) => status(error.message || '讀取失敗，請稍後重試。');
  const stateLabels = { pending: '待審・尚未採用', approved: '已核准', rejected: '已拒絕', superseded: '已由新版取代' };
  const relationLabels = { depends_on: '依賴', shares_service: '共用服務', fork_of: '分支自' };
  const tabs = ['activity', 'projects', 'context', ...${JSON.stringify(panels.map((panel) => panel.tab))}];
  const panelLoaders = {};
  function showTab(name) {
    for (const tab of tabs) {
      byId('view-' + tab).hidden = tab !== name;
      byId('tab-' + tab).setAttribute('aria-selected', String(tab === name));
      byId('tab-' + tab).tabIndex = tab === name ? 0 : -1;
    }
    if (name === 'context' && state.initialized) loadContext().catch(failure);
    if (panelLoaders[name] && state.initialized) panelLoaders[name]().catch(failure);
  }
  async function api(path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      const token = byId('review-token').value.trim();
      if (!token) {
        byId('write-access').open = true;
        byId('review-token').focus();
        throw new Error('請先在「管理與審閱權限」輸入審閱金鑰。');
      }
      headers.Authorization = 'Bearer ' + token;
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      credentials: body === undefined ? 'same-origin' : 'omit', cache: 'no-store', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 401 || response.status === 403) {
      if (body !== undefined) {
        byId('review-token').value = '';
        throw new Error('審閱權限已失效或金鑰不正確。請重新輸入審閱金鑰。');
      }
      throw new Error('存取權限已失效。請重新載入頁面並登入。');
    }
    if (response.status === 409) throw new Error('內容或狀態已變更，或來源範圍衝突。請重新讀取紀錄後再確認。');
    if (response.status === 400 || response.status === 413) throw new Error('資料格式、來源或內容長度不符合要求。請確認欄位及事件所屬專案。');
    if (response.status === 404) throw new Error('找不到這筆紀錄。請重新整理。');
    if (!response.ok) throw new Error('操作失敗，請稍後重試。');
    return response.json();
  }
  function options(id, entries) {
    const select = byId(id), value = select.value;
    while (select.options.length > 1) select.remove(1);
    for (const item of entries) {
      const option = text('option', item.name || item.title || item.identity || item.id);
      option.value = item.id;
      select.append(option);
    }
    if (entries.some((item) => item.id === value)) select.value = value;
  }
  function params(form) {
    const value = new URLSearchParams(new FormData(form));
    for (const [key, entry] of [...value]) if (!entry) value.delete(key);
    value.set('limit', '40');
    return value;
  }
  function synchronizeOptions() {
    options('activity-group', state.groups);
    for (const id of ['activity-task', 'session-task', 'context-task', 'draft-task']) options(id, state.tasks);
  }
  function renderSessions() {
    const container = byId('sessions');
    container.replaceChildren();
    byId('session-count').textContent = state.sessions.length + ' 個 session · 依最新事件排序';
    if (!state.sessions.length) container.append(text('p', '沒有符合篩選的紀錄。裝置上傳後，session 會顯示在這裡。', 'empty'));
    for (const session of state.sessions) {
      const node = button('', () => selectSession(session), 'session');
      node.setAttribute('aria-pressed', String(state.selected?.id === session.id));
      node.append(text('span', session.project_name || '未識別專案', 'session-title'));
      node.append(text('span', (session.device_name || session.device_id) + ' · ' + session.harness, 'session-meta'));
      node.append(text('span', date(session.last_event_at) + ' · ' + session.event_count + ' 個事件', 'session-meta'));
      node.append(text('span', session.source_session_id, 'session-meta'));
      container.append(node);
    }
    byId('more-sessions').hidden = !state.sessionCursor;
  }
  async function loadSessions(append = false) {
    const version = ++state.sessionVersion, query = params(byId('filters'));
    query.set('limit', '25');
    if (append && state.sessionCursor) query.set('before', state.sessionCursor);
    byId('more-sessions').disabled = true;
    status('正在讀取 session…');
    try {
      const data = await api('/api/sessions?' + query);
      if (version !== state.sessionVersion) return;
      state.sessions = append ? state.sessions.concat(data.sessions) : data.sessions;
      state.sessionCursor = data.next_cursor;
      if (!append) {
        state.timelineVersion++;
        state.selected = null;
        state.eventCursor = null;
        byId('timeline').replaceChildren();
        byId('selected-session').textContent = '選擇一個 session 查看紀錄。';
        byId('timeline-empty').hidden = false;
        byId('session-link').hidden = true;
        byId('more-events').hidden = true;
      }
      renderSessions();
      status(state.sessions.length ? '紀錄已更新。點選 session 查看事件。' : '目前沒有符合篩選的 session。');
    } finally { if (version === state.sessionVersion) byId('more-sessions').disabled = false; }
  }
  async function selectSession(session) {
    showTab('activity');
    state.selected = session;
    state.eventCursor = null;
    state.timelineVersion++;
    byId('timeline').replaceChildren();
    byId('more-events').hidden = true;
    byId('timeline-empty').hidden = false;
    byId('timeline-empty').textContent = '正在讀取事件…';
    byId('session-link').hidden = false;
    byId('selected-session').textContent = (session.device_name || session.device_id) + ' · ' + session.harness + ' · ' + session.source_session_id;
    renderSessions();
    await loadEvents();
  }
  async function loadEvents() {
    if (!state.selected) return;
    const version = state.timelineVersion, session = state.selected;
    const query = new URLSearchParams({ limit: '40' });
    if (state.eventCursor) query.set('after', state.eventCursor);
    byId('more-events').disabled = true;
    try {
      const data = await api('/api/sessions/' + encodeURIComponent(session.id) + '/events?' + query);
      if (version !== state.timelineVersion) return;
      for (const event of data.events) {
        const item = text('li', '', 'event'), heading = text('div', '', 'event-heading');
        heading.append(text('span', event.action, 'event-action'), text('time', date(event.timestamp), 'event-time'));
        const detail = document.createElement('details');
        detail.append(text('summary', '查看事件資料'), text('pre', JSON.stringify(event.payload, null, 2)));
        const select = text('label', '', 'source-check'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const key = event.id + ':' + event.payload_hash;
        checkbox.disabled = !event.payload_hash || state.invalidSources.has(key);
        checkbox.dataset.sourceKey = key;
        checkbox.checked = state.sources.has(key);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.sources.set(key, { event_id: event.id, payload_hash: event.payload_hash,
            session_id: session.id, project_id: session.project_id, device_id: session.device_id,
            device_name: session.device_name, timestamp: event.timestamp, action: event.action });
          else state.sources.delete(key);
          if (state.sources.size === 1 && !state.supersedes) byId('draft-project').value = state.sources.values().next().value.project_id;
          renderSources();
        });
        select.append(checkbox, text('span', event.payload_hash ? '作為筆記來源' : '此事件缺少版本資訊，無法選為來源'));
        item.append(heading, select, detail);
        if (event.versions > 1) item.append(text('p', '此事件有 ' + event.versions + ' 個版本；勾選的是目前顯示的版本。', 'muted'));
        byId('timeline').append(item);
      }
      state.eventCursor = data.next_cursor;
      byId('more-events').hidden = !state.eventCursor;
      byId('timeline-empty').hidden = Boolean(byId('timeline').children.length);
      byId('timeline-empty').textContent = '此 session 尚無事件。';
      status('已載入 ' + byId('timeline').children.length + ' 個事件。');
    } finally { if (version === state.timelineVersion) byId('more-events').disabled = false; }
  }
  function renderSources() {
    byId('selected-source-count').textContent = state.sources.size ? '已選 ' + state.sources.size + ' 個來源，切換 session 後仍保留。' : '尚未選擇筆記來源';
    byId('draft-sources').replaceChildren();
    if (!state.sources.size) byId('draft-sources').append(text('li', '尚未選擇來源。請到活動時間線勾選事件。'));
    for (const [key, source] of state.sources) {
      const item = text('li', (source.device_name || source.device_id || '裝置') + ' · ' + date(source.timestamp) + ' · ' + (source.action || '原始事件'));
      item.append(text('div', '事件 ' + source.event_id + ' · 版本 ' + source.payload_hash, 'identity'));
      if (state.invalidSources.has(key)) item.append(text('p', '此來源範圍不一致，不能用於新筆記。請移除並重新選擇有效來源。', 'notice warning'));
      item.append(button('移除此來源', () => { state.sources.delete(key); document.querySelectorAll('input[data-source-key]').forEach((input) => { if (input.dataset.sourceKey === key) input.checked = false; }); renderSources(); }));
      byId('draft-sources').append(item);
    }
    byId('draft-revision').hidden = !state.supersedes;
    byId('draft-revision').textContent = state.supersedes ? '這份筆記是 ' + state.supersedes + ' 的新版本。新版本核准前，舊版仍維持原狀。' : '';
  }
  async function loadGroups(append = false) {
    const query = new URLSearchParams({ limit: '40' });
    if (append && state.groupCursor) query.set('before', state.groupCursor);
    const data = await api('/api/project-groups?' + query);
    state.groups = append ? state.groups.concat(data.project_groups) : data.project_groups;
    state.groupCursor = data.next_cursor;
    byId('groups').replaceChildren();
    if (!state.groups.length) byId('groups').append(text('p', '尚無群組。新增群組後，再把相關專案加入。', 'empty'));
    for (const group of state.groups) {
      const node = button('', () => selectGroup(group), 'card-button');
      node.dataset.groupId = group.id;
      node.setAttribute('aria-pressed', String(state.group?.id === group.id));
      node.append(text('span', group.name), text('span', group.member_count + ' 個專案', 'session-meta'));
      byId('groups').append(node);
    }
    byId('more-groups').hidden = !state.groupCursor;
    synchronizeOptions();
  }
  async function selectGroup(group) {
    state.group = group; state.memberCursor = null; state.groupVersion++;
    byId('groups').querySelectorAll('button[data-group-id]').forEach((node) => { node.setAttribute('aria-pressed', String(node.dataset.groupId === group.id)); });
    byId('group-members').replaceChildren();
    byId('group-heading').textContent = group.name;
    byId('member-add').hidden = false;
    await loadMembers();
  }
  async function loadMembers() {
    if (!state.group) return;
    const version = state.groupVersion, query = new URLSearchParams({ limit: '40' });
    if (state.memberCursor) query.set('before', state.memberCursor);
    const data = await api('/api/project-groups/' + encodeURIComponent(state.group.id) + '?' + query);
    if (version !== state.groupVersion) return;
    if (!state.memberCursor) byId('group-members').replaceChildren();
    for (const member of data.members) {
      const item = text('div', '', 'notice');
      item.append(text('p', member.project_name), text('p', member.identity, 'identity'));
      item.append(button('查閱群組活動', () => { byId('activity-group').value = state.group.id; byId('project').value = ''; byId('activity-task').value = ''; showTab('activity'); return loadSessions(); }));
      byId('group-members').append(item);
    }
    if (!byId('group-members').children.length) byId('group-members').append(text('p', '這個群組還沒有專案。', 'empty'));
    state.memberCursor = data.next_cursor;
    byId('more-members').hidden = !state.memberCursor;
  }
  async function loadRelations(append = false) {
    const query = new URLSearchParams({ limit: '40' });
    if (append && state.relationCursor) query.set('before', state.relationCursor);
    const data = await api('/api/project-relations?' + query);
    state.relations = append ? state.relations.concat(data.relations) : data.relations;
    state.relationCursor = data.next_cursor;
    byId('relations').replaceChildren();
    if (!state.relations.length) byId('relations').append(text('p', '尚未設定專案關聯。', 'empty'));
    for (const relation of state.relations) byId('relations').append(text('div', relation.from_project_name + ' → ' + (relationLabels[relation.type] || relation.type) + ' → ' + relation.to_project_name, 'notice'));
    byId('more-relations').hidden = !state.relationCursor;
  }
  async function loadTasks(append = false) {
    const query = new URLSearchParams({ limit: '40' });
    if (append && state.taskCursor) query.set('before', state.taskCursor);
    const data = await api('/api/tasks?' + query);
    state.tasks = append ? state.tasks.concat(data.tasks) : data.tasks;
    state.taskCursor = data.next_cursor;
    byId('tasks').replaceChildren();
    if (!state.tasks.length) byId('tasks').append(text('p', '尚無任務。先新增任務，再從活動時間線加入 session。', 'empty'));
    for (const task of state.tasks) {
      const node = button('', () => selectTask(task), 'card-button');
      node.dataset.taskId = task.id;
      node.setAttribute('aria-pressed', String(state.task?.id === task.id));
      node.append(text('span', task.title), text('span', (task.status === 'completed' ? '已完成' : '進行中') + ' · ' + task.session_count + ' 個 session', 'session-meta'));
      byId('tasks').append(node);
    }
    byId('more-tasks').hidden = !state.taskCursor;
    synchronizeOptions();
  }
  async function selectTask(task) {
    state.task = task; state.taskSessionCursor = null; state.taskVersion++;
    byId('tasks').querySelectorAll('button[data-task-id]').forEach((node) => { node.setAttribute('aria-pressed', String(node.dataset.taskId === task.id)); });
    byId('task-detail').replaceChildren();
    byId('task-heading').textContent = task.title;
    await loadTaskSessions();
  }
  async function loadTaskSessions() {
    if (!state.task) return;
    const version = state.taskVersion, query = new URLSearchParams({ limit: '40' });
    if (state.taskSessionCursor) query.set('before', state.taskSessionCursor);
    const data = await api('/api/tasks/' + encodeURIComponent(state.task.id) + '?' + query);
    if (version !== state.taskVersion) return;
    if (!state.taskSessionCursor) {
      byId('task-detail').replaceChildren(); state.task = data.task;
      const row = text('div', '', 'row');
      row.append(text('span', data.task.status === 'completed' ? '已完成' : '進行中', 'badge'));
      row.append(button(data.task.status === 'completed' ? '重新開啟任務' : '標記任務完成', async () => {
        const result = await api('/api/tasks/' + encodeURIComponent(data.task.id) + '/status', { status: data.task.status === 'completed' ? 'open' : 'completed' });
        await loadTasks(); await selectTask(result.task); status('任務狀態已更新。');
      }));
      byId('task-detail').append(row, button('查閱此任務的筆記', () => { byId('context-task').value = data.task.id; return loadContext(); }));
    }
    for (const session of data.sessions) {
      const node = button('', () => selectSession(session), 'card-button');
      node.append(text('span', session.project_name), text('span', (session.device_name || session.device_id) + ' · ' + session.harness, 'session-meta'));
      byId('task-detail').append(node);
    }
    if (!data.sessions.length && !state.taskSessionCursor) byId('task-detail').append(text('p', '此任務尚未加入 session。請到活動紀錄選擇 session，再加入這個任務。', 'empty'));
    state.taskSessionCursor = data.next_cursor;
    byId('more-task-sessions').hidden = !state.taskSessionCursor;
  }
  async function loadContext(append = false) {
    const version = ++state.contextVersion, query = params(byId('context-filters'));
    if (append && state.contextCursor) query.set('before', state.contextCursor);
    const data = await api('/api/context?' + query);
    if (version !== state.contextVersion) return;
    state.context = append ? state.context.concat(data.context) : data.context;
    state.contextCursor = data.next_cursor;
    if (!append) { state.detailVersion++; byId('context-detail').replaceChildren(text('p', '選擇一份筆記查看內容與原始來源。', 'empty')); }
    byId('context-list').replaceChildren();
    if (!state.context.length) byId('context-list').append(text('p', '沒有符合篩選的筆記。待審內容需切換審閱狀態才能查看。', 'empty'));
    for (const entry of state.context) {
      const node = button('', () => selectContext(entry.id), 'card-button');
      node.append(text('span', entry.title), text('span', stateLabels[entry.status] || entry.status, 'badge ' + entry.status), text('span', (entry.kind === 'memory' ? '長期記憶' : '交接摘要') + ' · ' + entry.source_count + ' 個來源 · ' + date(entry.created_at), 'session-meta'));
      byId('context-list').append(node);
    }
    byId('more-context').hidden = !state.contextCursor;
  }
  async function selectContext(id) {
    const version = ++state.detailVersion;
    const data = await api('/api/context/' + encodeURIComponent(id));
    if (version !== state.detailVersion) return;
    renderContext(data.context);
  }
  function renderContext(entry) {
    const container = byId('context-detail'); container.replaceChildren();
    const heading = text('div', '', 'detail-heading');
    heading.append(text('h3', entry.title), text('span', stateLabels[entry.status] || entry.status, 'badge ' + entry.status));
    container.append(heading);
    if (entry.status !== 'approved') container.append(text('p', '這份內容目前不作為已核准的工作依據。原始紀錄仍保留。', 'notice warning'));
    else if (entry.authoritative === false) container.append(text('p', '這份筆記曾被核准，但目前來源範圍不符合採用條件。請先查閱原始來源與審閱紀錄。', 'notice warning'));
    container.append(text('p', entry.content, 'content'));
    if (entry.supersedes_id) container.append(text('p', '前一版本：' + entry.supersedes_id, 'identity'));
    const detail = document.createElement('details'), sourceList = text('ul', '', 'sources');
    detail.append(text('summary', '原始來源（' + entry.sources.length + '）'));
    for (const source of entry.sources) {
      const item = text('li', source.device_id + ' · ' + date(source.timestamp));
      item.append(text('div', '事件 ' + source.event_id, 'identity'), text('div', '版本 ' + source.payload_hash, 'identity'), text('div', 'Session ' + source.session_id, 'identity'));
      const payload = document.createElement('details');
      payload.append(text('summary', '查看此來源的原始版本'));
      let loaded = false;
      payload.addEventListener('toggle', async () => {
        if (!payload.open || loaded) return;
        loaded = true;
        try {
          const result = await api('/api/events/' + encodeURIComponent(source.event_id) + '?payload_hash=' + encodeURIComponent(source.payload_hash));
          if (result.event.scope_matches_index === false) {
            const key = source.event_id + ':' + source.payload_hash;
            state.invalidSources.add(key);
            payload.append(text('p', '此來源版本的專案或 session 資訊與中央索引不一致，不能作為核准依據。', 'notice warning'));
            container.querySelectorAll('button[data-review-decision="approve"]').forEach((node) => { node.disabled = true; });
            document.querySelectorAll('input[data-source-key]').forEach((input) => { if (input.dataset.sourceKey === key) input.disabled = true; });
            renderSources();
          }
          payload.append(text('pre', JSON.stringify(result.event.payload, null, 2)));
        } catch (error) { loaded = false; failure(error); }
      });
      item.append(payload);
      sourceList.append(item);
    }
    detail.append(sourceList); container.append(detail);
    const audit = document.createElement('details'); audit.append(text('summary', '審閱紀錄'));
    const auditList = text('ul', '', 'compact-list');
    for (const action of entry.audit || []) auditList.append(text('li', date(action.created_at) + ' · ' + action.action + (action.reason ? ' · ' + action.reason : '')));
    audit.append(auditList); container.append(audit);
    if (entry.status === 'pending') {
      const form = document.createElement('form'); form.className = 'review-actions';
      const label = text('label', '審閱說明（選填）'), reason = document.createElement('textarea'); reason.rows = 2; reason.maxLength = 2000; label.append(reason);
      form.append(label);
      for (const [decision, caption] of [['approve', '核准筆記'], ['reject', '拒絕筆記']]) {
        const action = button(caption, async () => {
        const body = { decision }; if (reason.value.trim()) body.reason = reason.value.trim();
        const result = await api('/api/context/' + encodeURIComponent(entry.id) + '/review', body);
        await loadContext(); renderContext(result.context); status(decision === 'approve' ? '筆記已人工核准。' : '筆記已拒絕。');
        }, decision === 'approve' ? 'primary' : 'danger');
        action.dataset.reviewDecision = decision;
        if (decision === 'approve' && (entry.sources_valid === false || entry.sources.some((source) => state.invalidSources.has(source.event_id + ':' + source.payload_hash)))) action.disabled = true;
        form.append(action);
      }
      container.append(form);
    }
    if (entry.status === 'approved') container.append(button('撰寫新版本', () => {
      state.supersedes = entry.id; state.sources.clear();
      for (const source of entry.sources) state.sources.set(source.event_id + ':' + source.payload_hash, source);
      byId('draft-project').value = entry.project_id;
      byId('draft-task').value = entry.task_id || '';
      byId('draft-kind').value = entry.kind;
      byId('draft-title').value = entry.title;
      byId('draft-content').value = entry.content;
      renderSources(); byId('draft-panel').open = true; byId('draft-panel').scrollIntoView({ block: 'start' });
    }));
  }
  function onSubmit(id, action) {
    byId(id).addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = byId(id).querySelector('button[type=submit]');
      if (submit) submit.disabled = true;
      try { await action(); } catch (error) { failure(error); } finally { if (submit) submit.disabled = false; }
    });
  }
  onSubmit('filters', () => loadSessions());
  onSubmit('group-create', async () => {
    const result = await api('/api/project-groups', { name: byId('group-create').elements.name.value.trim() });
    byId('group-create').reset(); await loadGroups(); await selectGroup(result.project_group); status('群組已新增。');
  });
  onSubmit('member-add', async () => {
    await api('/api/project-groups/' + encodeURIComponent(state.group.id) + '/members', { project_id: byId('member-project').value });
    await loadGroups(); await selectGroup(state.group); status('專案已加入群組。');
  });
  onSubmit('relation-create', async () => {
    await api('/api/project-relations', { from_project_id: byId('relation-from').value, to_project_id: byId('relation-to').value, type: byId('relation-create').elements.type.value });
    await loadRelations(); status('專案關聯已新增。');
  });
  onSubmit('task-create', async () => {
    const result = await api('/api/tasks', { title: byId('task-create').elements.title.value.trim() });
    byId('task-create').reset(); await loadTasks(); await selectTask(result.task); status('任務已新增。請從活動紀錄加入相關 session。');
  });
  onSubmit('session-link', async () => {
    const taskId = byId('session-task').value;
    await api('/api/tasks/' + encodeURIComponent(taskId) + '/sessions', { session_id: state.selected.id });
    await loadTasks();
    if (state.task?.id === taskId) await selectTask(state.tasks.find((task) => task.id === taskId) || state.task);
    status('此 session 已加入任務。');
  });
  onSubmit('context-filters', () => loadContext());
  onSubmit('context-create', async () => {
    if (!state.sources.size) throw new Error('請先到活動時間線選擇至少一個原始事件。');
    if ([...state.sources.keys()].some((key) => state.invalidSources.has(key))) throw new Error('筆記包含範圍不一致的來源。請先移除，再重新選擇有效事件。');
    const body = { kind: byId('draft-kind').value, project_id: byId('draft-project').value,
      title: byId('draft-title').value.trim(), content: byId('draft-content').value.trim(),
      sources: [...state.sources.values()].map((source) => ({ event_id: source.event_id, payload_hash: source.payload_hash })) };
    if (byId('draft-task').value) body.task_id = byId('draft-task').value;
    if (state.supersedes) body.supersedes_id = state.supersedes;
    const result = await api('/api/context', body);
    state.sources.clear(); state.supersedes = null; byId('context-create').reset();
    document.querySelectorAll('input[data-source-key]').forEach((input) => { input.checked = false; });
    renderSources(); byId('context-status').value = 'pending';
    byId('context-project').value = ''; byId('context-task').value = '';
    await loadContext(); renderContext(result.context); status('筆記已送交審閱，目前尚未採用。');
  });
  for (const tab of tabs) {
    byId('tab-' + tab).tabIndex = tab === 'activity' ? 0 : -1;
    byId('tab-' + tab).addEventListener('click', () => showTab(tab));
    byId('tab-' + tab).addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      showTab(tabs[index]); byId('tab-' + tabs[index]).focus();
    });
  }
  byId('refresh').addEventListener('click', () => loadSessions().catch(failure));
  byId('more-sessions').addEventListener('click', () => loadSessions(true).catch(failure));
  byId('more-events').addEventListener('click', () => loadEvents().catch(failure));
  byId('more-groups').addEventListener('click', () => loadGroups(true).catch(failure));
  byId('more-members').addEventListener('click', () => loadMembers().catch(failure));
  byId('more-relations').addEventListener('click', () => loadRelations(true).catch(failure));
  byId('more-tasks').addEventListener('click', () => loadTasks(true).catch(failure));
  byId('more-task-sessions').addEventListener('click', () => loadTaskSessions().catch(failure));
  byId('more-context').addEventListener('click', () => loadContext(true).catch(failure));
  byId('lock-review').addEventListener('click', () => { byId('review-token').value = ''; status('審閱金鑰已清除。查閱功能仍可使用。'); });
  window.addEventListener('pagehide', () => { byId('review-token').value = ''; });
  byId('open-draft').addEventListener('click', () => { showTab('context'); byId('draft-panel').open = true; byId('draft-panel').scrollIntoView({ block: 'start' }); });
  byId('clear-sources').addEventListener('click', () => { state.sources.clear(); state.supersedes = null; document.querySelectorAll('input[data-source-key]').forEach((input) => { input.checked = false; }); renderSources(); });
  renderSources();
${panels.map((panel) => panel.script).join('\n')}
  Promise.all([api('/api/devices'), api('/api/projects')]).then(async ([devices, projects]) => {
    options('device', devices.devices);
    for (const id of ['project', 'member-project', 'relation-from', 'relation-to', 'context-project', 'draft-project']) options(id, projects.projects);
    await loadSessions();
    await Promise.all([loadGroups(), loadRelations(), loadTasks()]);
    state.initialized = true;
    if (!byId('view-context').hidden) await loadContext();
    const open = tabs.find((tab) => !byId('view-' + tab).hidden);
    if (panelLoaders[open]) await panelLoaders[open]();
  }).catch(failure);
})();`;

export function dashboardResponse(): Response {
  return new Response(HTML, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  } });
}

export function dashboardScriptResponse(): Response {
  return new Response(SCRIPT, { headers: {
    'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
