const HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Beacon · 活動紀錄</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18282d;background:#f3f6f6;color-scheme:light}*{box-sizing:border-box}body{margin:0}header{background:#fff;border-bottom:1px solid #d8e2e3;padding:24px max(24px,calc((100vw - 1320px)/2))}h1{font-size:24px;margin:0 0 8px;letter-spacing:-.03em}h2{font-size:18px;margin:0}p{line-height:1.55;margin:8px 0}.muted{color:#52676d;font-size:14px}.tag{display:inline-block;font-size:12px;background:#e9f3ef;color:#17654d;border-radius:20px;padding:4px 10px;margin-left:8px;vertical-align:middle}main{max-width:1368px;margin:auto;padding:24px}form{display:flex;gap:16px;flex-wrap:wrap;align-items:end;padding:20px;background:#fff;border:1px solid #d8e2e3;border-radius:12px}label{display:grid;gap:8px;flex:1;min-width:170px;font-size:13px;font-weight:600}select,input,button{font:inherit;border-radius:7px}select,input{width:100%;padding:10px;border:1px solid #b9cacc;background:#fff;color:inherit}button{cursor:pointer;border:1px solid #aac1bd;background:#fff;color:#20594b;padding:10px 14px;font-weight:600}button.primary{background:#206951;color:#fff;border-color:#206951}button:hover{filter:brightness(.97)}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #52a998;outline-offset:3px}button:disabled{cursor:default;opacity:.5}#status{min-height:24px;margin:16px 0;font-size:14px}.layout{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);gap:20px}.panel{background:#fff;border:1px solid #d8e2e3;border-radius:12px;overflow:hidden}.panel-title{padding:20px;border-bottom:1px solid #e3ebeb}.panel-body{padding:16px}#sessions{display:grid;gap:10px}.session{width:100%;text-align:left;padding:15px;color:#18282d;border:1px solid #d8e2e3;display:grid;gap:7px}.session[aria-pressed=true]{border-color:#206951;background:#eff7f3}.session-title{font-size:15px}.session-meta{font-size:12px;color:#52676d;font-weight:400;overflow-wrap:anywhere}.empty{padding:24px 12px;color:#52676d;line-height:1.7;font-size:14px}#timeline{list-style:none;margin:0;padding:0}.event{border-bottom:1px solid #e3ebeb;padding:16px 0}.event:first-child{padding-top:0}.event:last-child{border:0}.event-heading{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.event-action{font-weight:600;font-size:14px}.event-time{font-size:12px;color:#52676d}.event summary{margin-top:12px;cursor:pointer;font-size:13px;color:#206951}pre{font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0;padding:16px;background:#f3f6f6;border-radius:8px;max-height:420px;overflow:auto}.pagination{margin-top:16px;width:100%}[hidden]{display:none!important}footer{padding:20px 0;color:#52676d;font-size:12px;line-height:1.7}@media(max-width:800px){main{padding:16px}.layout{grid-template-columns:1fr}header{padding:20px}form{padding:16px;gap:12px}label{min-width:140px}.panel-title{padding:16px}.event-heading{display:grid;gap:6px}}@media(prefers-reduced-motion:no-preference){button{transition:background .12s ease}}
</style><script src="/dashboard.js" defer></script></head>
<body><header><h1>Agent Beacon <span class="tag">唯讀</span></h1><p class="muted">跨裝置查閱 agent 的 session 與事件紀錄。</p></header>
<main><form id="filters"><label>裝置<select id="device" name="device_id" aria-label="裝置"><option value="">所有裝置</option></select></label><label>專案<select id="project" name="project_id" aria-label="專案"><option value="">所有專案</option></select></label><label>Agent<input id="harness" name="harness" placeholder="例如 codex_cli" maxlength="128"></label><button type="submit" class="primary">套用篩選</button><button type="button" id="refresh">重新整理</button></form>
<p id="status" role="status" aria-live="polite">正在讀取活動紀錄…</p><div class="layout"><section class="panel" aria-labelledby="session-heading"><div class="panel-title"><h2 id="session-heading">Session</h2><p class="muted" id="session-count">依最新事件排序</p></div><div class="panel-body"><div id="sessions"></div><button type="button" class="pagination" id="more-sessions" hidden>載入更多 session</button></div></section>
<section class="panel" aria-labelledby="timeline-heading"><div class="panel-title"><h2 id="timeline-heading">事件時間線</h2><p class="muted" id="selected-session">選擇一個 session 查看紀錄。</p></div><div class="panel-body"><p id="timeline-empty" class="empty">裝置保有各自的 session 身分。選擇左側紀錄後，可查看完整事件資料。</p><ol id="timeline"></ol><button type="button" class="pagination" id="more-events" hidden>載入更多事件</button></div></section></div>
<footer>事件內容可能含有私人資料，請只在受信任的環境查閱。Memory 候選、審閱與核准尚未提供。</footer></main></body></html>`;

// Event and identity strings only enter textContent. No transcript is embedded in HTML.
const SCRIPT = `'use strict';
(() => {
  const byId = (id) => document.getElementById(id);
  const state = { sessions: [], selected: null, sessionCursor: null, eventCursor: null, sessionVersion: 0, timelineVersion: 0 };
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = String(value ?? '');
    if (className) node.className = className;
    return node;
  };
  const date = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? String(value ?? '時間未知') : parsed.toLocaleString('zh-TW', { hour12: false });
  };
  const status = (message) => { byId('status').textContent = message; };
  const failure = (error) => status(error.message || '讀取失敗，請稍後重試。');
  async function api(path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (response.status === 401 || response.status === 403) throw new Error('存取權限已失效。請重新載入頁面並登入。');
    if (!response.ok) throw new Error('讀取失敗，請稍後重試。');
    return response.json();
  }
  function options(id, entries) {
    const select = byId(id);
    while (select.options.length > 1) select.remove(1);
    for (const item of entries) {
      const option = text('option', item.name || item.identity || item.id);
      option.value = item.id;
      select.append(option);
    }
  }
  function renderSessions() {
    const container = byId('sessions');
    container.replaceChildren();
    byId('session-count').textContent = state.sessions.length + ' 個 session · 依最新事件排序';
    if (!state.sessions.length) container.append(text('p', '沒有符合篩選的紀錄。裝置上傳後，session 會顯示在這裡。', 'empty'));
    for (const session of state.sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session';
      button.setAttribute('aria-pressed', String(state.selected?.id === session.id));
      button.append(text('span', session.project_name || '未識別專案', 'session-title'));
      button.append(text('span', (session.device_name || session.device_id) + ' · ' + session.harness, 'session-meta'));
      button.append(text('span', date(session.last_event_at) + ' · ' + session.event_count + ' 個事件', 'session-meta'));
      button.append(text('span', session.source_session_id, 'session-meta'));
      button.addEventListener('click', () => selectSession(session).catch(failure));
      container.append(button);
    }
    byId('more-sessions').hidden = !state.sessionCursor;
  }
  async function loadSessions(append = false) {
    const version = ++state.sessionVersion;
    const params = new URLSearchParams(new FormData(byId('filters')));
    for (const [key, value] of [...params]) if (!value) params.delete(key);
    params.set('limit', '25');
    if (append && state.sessionCursor) params.set('before', state.sessionCursor);
    byId('more-sessions').disabled = true;
    status('正在讀取 session…');
    try {
      const data = await api('/api/sessions?' + params);
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
        byId('more-events').hidden = true;
      }
      renderSessions();
      status(state.sessions.length ? '紀錄已更新。點選 session 查看事件。' : '目前沒有符合篩選的 session。');
    } finally { if (version === state.sessionVersion) byId('more-sessions').disabled = false; }
  }
  async function selectSession(session) {
    state.selected = session;
    state.eventCursor = null;
    state.timelineVersion++;
    byId('timeline').replaceChildren();
    byId('more-events').hidden = true;
    byId('timeline-empty').hidden = false;
    byId('timeline-empty').textContent = '正在讀取事件…';
    byId('selected-session').textContent = (session.device_name || session.device_id) + ' · ' + session.harness + ' · ' + session.source_session_id;
    renderSessions();
    await loadEvents();
  }
  async function loadEvents() {
    if (!state.selected) return;
    const version = state.timelineVersion;
    const params = new URLSearchParams({ limit: '40' });
    if (state.eventCursor) params.set('after', state.eventCursor);
    byId('more-events').disabled = true;
    try {
      const data = await api('/api/sessions/' + encodeURIComponent(state.selected.id) + '/events?' + params);
      if (version !== state.timelineVersion) return;
      for (const event of data.events) {
        const item = document.createElement('li');
        item.className = 'event';
        const heading = text('div', '', 'event-heading');
        heading.append(text('span', event.action, 'event-action'), text('time', date(event.timestamp), 'event-time'));
        const detail = document.createElement('details');
        detail.append(text('summary', '查看事件資料'), text('pre', JSON.stringify(event.payload, null, 2)));
        item.append(heading, detail);
        byId('timeline').append(item);
      }
      state.eventCursor = data.next_cursor;
      byId('more-events').hidden = !state.eventCursor;
      byId('timeline-empty').hidden = Boolean(byId('timeline').children.length);
      byId('timeline-empty').textContent = '此 session 尚無事件。';
      status('已載入 ' + byId('timeline').children.length + ' 個事件。');
    } finally { if (version === state.timelineVersion) byId('more-events').disabled = false; }
  }
  byId('filters').addEventListener('submit', (event) => { event.preventDefault(); loadSessions().catch(failure); });
  byId('refresh').addEventListener('click', () => loadSessions().catch(failure));
  byId('more-sessions').addEventListener('click', () => loadSessions(true).catch(failure));
  byId('more-events').addEventListener('click', () => loadEvents().catch(failure));
  Promise.all([api('/api/devices'), api('/api/projects')])
    .then(([devices, projects]) => { options('device', devices.devices); options('project', projects.projects); return loadSessions(); })
    .catch(failure);
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
