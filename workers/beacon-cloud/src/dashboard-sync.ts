import type { DashboardPanel } from './dashboard-panels';

// Track S (phase 3): reviewer-managed Mac sync subscriptions. Reads use dashboard
// read access; creating or revoking a grant sends the page-scoped review key.
// Recorded names, titles and note content only ever enter textContent.
const html = `<p class="notice">Mac 同步只讓指定裝置讀取指定專案的已核准筆記。中央服務不會寫入任何 Mac；使用者在那台 Mac 執行同步工具，先預覽差異再套用，也不會改動 AGENTS.md、skills 或 collector 設定。</p>
<div class="two-column section-gap"><section class="panel"><div class="panel-title"><h2>新增同步訂閱</h2><p class="muted">需要審閱金鑰。每台裝置對每個專案只有一份有效訂閱；要改變內容類型，先撤銷再新增。</p></div><div class="panel-body"><form id="sync-create" class="vertical"><label>接收裝置<select id="sync-device" aria-label="同步接收裝置" required><option value="">選擇裝置</option></select></label><label>來源專案<select id="sync-project" aria-label="同步來源專案" required><option value="">選擇專案</option></select></label><div class="row" role="group" aria-label="同步內容類型"><label class="source-check"><input type="checkbox" id="sync-kind-memory" aria-label="同步長期記憶" checked>長期記憶</label><label class="source-check"><input type="checkbox" id="sync-kind-summary" aria-label="同步交接摘要">交接摘要</label></div><button type="submit" class="primary">新增訂閱</button></form></div></section>
<section class="panel"><div class="panel-title"><h2>同步訂閱</h2><p class="muted" id="sync-count">依建立時間排序</p></div><div class="panel-body"><form id="sync-filters"><label>裝置<select id="sync-filter-device" name="device_id" aria-label="篩選同步裝置"><option value="">所有裝置</option></select></label><label>狀態<select name="status" aria-label="同步訂閱狀態"><option value="">全部</option><option value="active">有效</option><option value="revoked">已撤銷</option></select></label><button type="submit">查詢訂閱</button></form><div id="sync-list" class="list section-gap"></div><button type="button" id="more-sync" class="pagination" hidden>載入更多訂閱</button></div></section></div>
<section class="panel section-gap"><div class="panel-title"><h2>裝置會收到的內容</h2><p class="muted" id="sync-preview-heading">選擇一份訂閱，查看目前已核准且來源範圍有效的筆記。</p></div><div class="panel-body" id="sync-preview"><p class="empty">尚未選擇訂閱。</p></div></section>`;

const script = String.raw`  const syncState = { items: [], cursor: null, version: 0, previewVersion: 0, loaded: false };
  const syncKindLabels = { memory: '長期記憶', summary: '交接摘要' };
  const syncKindText = (kinds) => kinds.map((kind) => syncKindLabels[kind] || kind).join('、');
  async function loadSyncOptions() {
    const [devices, projects] = await Promise.all([api('/api/devices'), api('/api/projects')]);
    options('sync-device', devices.devices.filter((device) => !device.revoked));
    options('sync-filter-device', devices.devices);
    options('sync-project', projects.projects);
    syncState.loaded = true;
  }
  function renderSyncSubscriptions() {
    const list = byId('sync-list');
    list.replaceChildren();
    byId('sync-count').textContent = syncState.items.length + ' 份訂閱 · 依建立時間排序';
    if (!syncState.items.length) list.append(text('p', '沒有符合篩選的訂閱。新增訂閱後，該裝置才能讀取專案的已核准筆記。', 'empty'));
    for (const item of syncState.items) {
      const card = text('div', '', 'card-button'), heading = text('div', '', 'row'), actions = text('div', '', 'row');
      heading.append(text('span', item.project_name || item.project_id), text('span', item.status === 'active' ? '有效' : '已撤銷', item.status === 'active' ? 'badge' : 'badge rejected'));
      card.append(heading,
        text('span', (item.device_name || item.device_id) + (item.device_revoked ? '（裝置金鑰已撤銷）' : '') + ' · ' + syncKindText(item.kinds), 'session-meta'),
        text('span', '建立 ' + date(item.created_at) + (item.revoked_at ? ' · 撤銷 ' + date(item.revoked_at) : ''), 'session-meta'),
        text('span', '訂閱 ' + item.id, 'identity'));
      actions.append(button('預覽同步內容', () => previewSyncSubscription(item)));
      if (item.status === 'active') actions.append(button('撤銷訂閱', async () => {
        await api('/api/sync/subscriptions/' + encodeURIComponent(item.id) + '/revoke', {});
        await loadSyncSubscriptions();
        status('訂閱已撤銷。這台裝置之後無法再讀取這個專案的筆記；已同步到 Mac 的檔案不會被刪除。');
      }, 'danger'));
      card.append(actions);
      list.append(card);
    }
    byId('more-sync').hidden = !syncState.cursor;
  }
  async function loadSyncSubscriptions(append = false) {
    const version = ++syncState.version, query = params(byId('sync-filters'));
    if (append && syncState.cursor) query.set('before', syncState.cursor);
    const data = await api('/api/sync/subscriptions?' + query);
    if (version !== syncState.version) return;
    syncState.items = append ? syncState.items.concat(data.subscriptions) : data.subscriptions;
    syncState.cursor = data.next_cursor;
    renderSyncSubscriptions();
  }
  async function previewSyncSubscription(item) {
    const version = ++syncState.previewVersion, query = new URLSearchParams({ project_id: item.project_id });
    if (item.kinds.length === 1) query.set('kind', item.kinds[0]);
    const data = await api('/api/context/snapshot?' + query);
    if (version !== syncState.previewVersion) return;
    const snapshot = data.snapshot, container = byId('sync-preview'), list = text('ul', '', 'sources');
    byId('sync-preview-heading').textContent = (item.project_name || item.project_id) + ' · ' + syncKindText(snapshot.kinds) + ' · ' + snapshot.entry_count + ' 份已核准筆記';
    container.replaceChildren(text('p', '快照雜湊 ' + snapshot.snapshot_sha256, 'identity'));
    if (item.status !== 'active') container.append(text('p', '這份訂閱已撤銷，裝置目前無法讀取以下內容。', 'notice warning'));
    if (!snapshot.entries.length) container.append(text('p', '目前沒有符合訂閱的已核准筆記。', 'empty'));
    for (const entry of snapshot.entries) {
      const row = text('li', entry.title), detail = document.createElement('details');
      row.append(text('div', (syncKindLabels[entry.kind] || entry.kind) + ' · 核准於 ' + date(entry.reviewed_at), 'session-meta'), text('div', '內容雜湊 ' + entry.content_sha256, 'identity'));
      detail.append(text('summary', '查看內容'), text('p', entry.content, 'content'));
      row.append(detail);
      list.append(row);
    }
    container.append(list);
  }
  onSubmit('sync-create', async () => {
    const kinds = ['memory', 'summary'].filter((kind) => byId('sync-kind-' + kind).checked);
    if (!kinds.length) throw new Error('請至少選擇一種同步內容類型。');
    const result = await api('/api/sync/subscriptions', { device_id: byId('sync-device').value, project_id: byId('sync-project').value, kinds });
    await loadSyncSubscriptions();
    status(result.created ? '訂閱已新增。仍需在那台 Mac 上自行預覽並套用。' : '相同的有效訂閱已存在，沒有重複新增。');
  });
  onSubmit('sync-filters', () => loadSyncSubscriptions());
  byId('more-sync').addEventListener('click', () => loadSyncSubscriptions(true).catch(failure));
  panelLoaders.sync = async () => {
    if (!syncState.loaded) await loadSyncOptions();
    await loadSyncSubscriptions();
  };`;

export const syncPanel: DashboardPanel | null = { tab: 'sync', label: 'Mac 同步', html, script };
