import type { DashboardPanel } from './dashboard-panels';

// Track D (phase 3): data health, retention and backups. Every value from the API enters
// textContent only. Backup reads carry the reviewer key because backups hold device token digests.
const html = `<p class="notice">資料維護只顯示識別碼、數量與修復建議，不顯示事件或筆記內容。原文只會在審閱者套用已確認的刪除計畫後刪除，而且必須先有通過還原演練與完整性檢查的備份。</p>
<section class="panel section-gap" aria-labelledby="ops-health-heading"><div class="panel-title"><h2 id="ops-health-heading">資料健康</h2><p class="muted" id="ops-health-time">尚未檢查。</p></div><div class="panel-body"><button type="button" id="ops-health-refresh">重新檢查</button><ul id="ops-findings" class="list section-gap"></ul><details><summary>裝置、容量與備份狀態</summary><ul id="ops-devices" class="compact-list"></ul><ul id="ops-capacity" class="compact-list"></ul></details></div></section>
<div class="two-column section-gap"><section class="panel" aria-labelledby="ops-retention-heading"><div class="panel-title"><h2 id="ops-retention-heading">保存期限</h2><p class="muted">未設定代表永久保存。目前只有原始事件可以實際刪除；摘要、候選與稽核紀錄只記錄期限。</p></div><div class="panel-body"><ul id="ops-policies" class="compact-list"></ul><details><summary>設定保存期限</summary><form id="ops-policy-form"><label>資料類別<select id="ops-policy-class" aria-label="保存期限資料類別"><option value="raw">原始事件</option><option value="summary">摘要</option><option value="candidate">候選</option><option value="audit">稽核紀錄</option></select></label><label>保存天數（空白代表永久）<input id="ops-policy-days" type="number" min="1" max="36500" inputmode="numeric"></label><button type="submit" class="primary">儲存期限</button></form></details><button type="button" id="ops-plan-refresh" class="section-gap">產生刪除計畫</button><div id="ops-plan" class="section-gap"></div></div></section>
<section class="panel" aria-labelledby="ops-backup-heading"><div class="panel-title"><h2 id="ops-backup-heading">備份</h2><p class="muted">備份含裝置金鑰雜湊，查看與操作都需要審閱金鑰。排程備份每小時推進一次。</p></div><div class="panel-body"><div class="row"><button type="button" id="ops-backups-load">讀取備份</button><button type="button" id="ops-backup-run">立即備份</button></div><div id="ops-backups" class="list section-gap"></div><button type="button" id="ops-more-backups" class="pagination" hidden>載入更多備份</button></div></section></div>`;

// Block-scoped: every panel script shares one closure, so names here cannot collide with another track's.
const script = String.raw`
  {
  const opsState = { plan: null, backupCursor: null, backups: [] };
  const severityLabels = { critical: '嚴重', warning: '注意', info: '提示' };
  const findingLabels = { raw_missing: '原文缺失', raw_orphan: '沒有索引的原文', device_stale: '裝置未上傳', ingest_backlog: '上傳積壓',
    context_sources_invalid: '筆記來源已失效', context_aging: '筆記可能過時', open_flags: '待處理標記', processing_failed: '背景整理失敗',
    processing_queue_stale: '背景整理積壓', backup_not_configured: '未設定備份', backup_not_scheduled: '備份未排程', backup_stale: '備份過舊',
    backup_failed: '備份失敗', backup_unverified: '沒有可用的已驗證備份', backup_integrity_failed: '備份完整性錯誤', backup_raw_lag: '原文備份落後',
    backup_raw_source_missing: '備份時原文缺失', retention_raw_delete_pending: '原文刪除待完成', resurrected_batch: '已刪除批次重新出現',
    raw_scan_stale: '原文比對未更新' };
  const classLabels = { raw: '原始事件', summary: '摘要', candidate: '候選', audit: '稽核紀錄' };
  const reasonLabels = { no_verified_backup: '沒有已驗證備份', referenced_by_context: '被筆記引用', referenced_by_processing: '背景整理使用中',
    referenced_by_flag: '被標記引用', shared_event_versions: '事件版本跨批次', within_keep_days: '仍在保存期限內', class_report_only: '只記錄期限' };
  const backupLabels = { running: '進行中', completed: '已完成・待演練', failed: '失敗', verified: '已驗證', expired: '已到期' };
  const bytes = (value) => value === null || value === undefined ? '未測量' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MiB' : Math.round(value / 1024) + ' KiB';
  async function reviewerGet(path) {
    const token = byId('review-token').value.trim();
    if (!token) { byId('write-access').open = true; byId('review-token').focus(); throw new Error('備份資料需要審閱金鑰。請先在「管理與審閱權限」輸入。'); }
    const response = await fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
    if (response.status === 401 || response.status === 403) { byId('review-token').value = ''; throw new Error('審閱權限已失效或金鑰不正確。請重新輸入審閱金鑰。'); }
    if (!response.ok) throw new Error('讀取備份失敗，請稍後重試。');
    return response.json();
  }
  async function loadHealth() {
    const data = await api('/api/health/data');
    byId('ops-health-time').textContent = '檢查時間：' + date(data.generated_at);
    const list = byId('ops-findings'); list.replaceChildren();
    if (!data.findings.length) list.append(text('li', '目前沒有需要處理的項目。', 'empty'));
    for (const item of data.findings) {
      const node = text('li', '', item.severity === 'info' ? 'notice' : 'notice warning');
      node.append(text('strong', (severityLabels[item.severity] || item.severity) + '・' + (findingLabels[item.code] || item.code) + '（' + item.count + '）'));
      node.append(text('p', item.hint));
      if (item.sample_ids.length) node.append(text('p', '例如：' + item.sample_ids.join('、'), 'identity'));
      list.append(node);
    }
    byId('ops-devices').replaceChildren();
    for (const device of data.devices) byId('ops-devices').append(text('li', (device.name || device.id) + (device.revoked ? '（已撤銷）' : '') + ' · 最後上傳 '
      + (device.last_seen ? date(device.last_seen) : '從未') + (device.lag_seconds ? ' · 近 24 小時延遲中位數 ' + Math.round(device.lag_seconds.median / 60) + ' 分鐘' : '')));
    const capacity = byId('ops-capacity'); capacity.replaceChildren();
    capacity.append(text('li', 'D1 大小：' + bytes(data.capacity.d1_size_bytes) + ' · 原文：' + bytes(data.capacity.raw_bytes)));
    capacity.append(text('li', '事件約 ' + (data.capacity.approx_rows.events || 0) + ' 筆（以最大 rowid 估計）'));
    capacity.append(text('li', data.backup.configured ? (data.backup.retention_ready ? '可供保存期限使用的備份：' + data.backup.retention_ready.id : '尚無可供保存期限使用的已驗證備份') : '尚未綁定 BACKUP bucket'));
  }
  async function loadPolicies() {
    const data = await api('/api/retention/policies');
    byId('ops-policies').replaceChildren();
    for (const policy of data.policies) byId('ops-policies').append(text('li', (classLabels[policy.data_class] || policy.data_class) + '：'
      + (policy.keep_days === null ? '永久保存' : '保存 ' + policy.keep_days + ' 天') + (policy.enforced ? '' : '（只記錄，不會刪除）')));
  }
  function renderPlan(data) {
    const container = byId('ops-plan'); container.replaceChildren();
    const raw = data.classes.find((item) => item.data_class === 'raw');
    if (raw.cutoff === null) { container.append(text('p', '原始事件設定為永久保存，沒有可刪除的批次。', 'empty')); return; }
    container.append(text('p', '刪除 ' + date(raw.cutoff) + ' 以前收到的批次。檢查 ' + raw.scanned + ' 批' + (raw.scan_limited ? '（只檢查最舊的部分）' : '') + '，符合條件 ' + raw.eligible.batches + ' 批。', 'muted'));
    const reasons = text('ul', '', 'compact-list');
    for (const item of raw.blocked) reasons.append(text('li', (reasonLabels[item.reason] || item.reason) + '：' + (item.count === null ? '—' : item.count)));
    container.append(reasons);
    if (!data.plan) { container.append(text('p', '目前沒有可以安全刪除的批次。', 'empty')); return; }
    container.append(text('p', '這次計畫會刪除 ' + data.plan.batch_ids.length + ' 批、' + data.plan.events + ' 個事件、' + bytes(data.plan.bytes) + ' 原文。計畫在 1 小時內有效。', 'notice warning'));
    container.append(text('p', '計畫雜湊 ' + data.plan.plan_sha256, 'identity'));
    const confirm = text('label', '', 'source-check'), box = document.createElement('input'); box.type = 'checkbox';
    confirm.append(box, text('span', '我已確認備份可還原，並了解這些原文會從主要儲存刪除'));
    const apply = button('套用刪除計畫', async () => {
      if (!box.checked) throw new Error('請先勾選確認。');
      const plan = opsState.plan;
      const result = await api('/api/retention/apply', { data_class: 'raw', generated_at: plan.generated_at, cutoff: plan.cutoff, batch_ids: plan.batch_ids, plan_sha256: plan.plan_sha256 });
      opsState.plan = null; container.replaceChildren(text('p', '已刪除 ' + result.run.batch_count + ' 批原文。備份複本會在寬限期後移除。', 'notice'));
      status('保存期限已套用。'); await loadHealth();
    }, 'danger');
    container.append(confirm, apply);
  }
  async function loadPlan() { const data = await api('/api/retention/plan'); opsState.plan = data.plan; renderPlan(data); status('已產生刪除計畫，尚未刪除任何資料。'); }
  function renderBackup(checkpoint) {
    const card = text('div', '', 'notice');
    const heading = text('div', '', 'detail-heading');
    heading.append(text('strong', date(checkpoint.started_at)), text('span', backupLabels[checkpoint.status] || checkpoint.status, 'badge'));
    card.append(heading, text('p', checkpoint.id, 'identity'));
    card.append(text('p', '原文 ' + checkpoint.raw_object_count + ' 個（' + bytes(checkpoint.raw_bytes) + '）· 完整性 '
      + (checkpoint.integrity_verified_at ? '已檢查' : checkpoint.integrity_error ? '錯誤 ' + checkpoint.integrity_error : '尚未完成')
      + (checkpoint.error_code ? ' · 錯誤 ' + checkpoint.error_code : '') + (checkpoint.raw_pruned_at ? ' · 部分原文複本已依保存期限移除' : ''), 'session-meta'));
    if (checkpoint.status === 'completed') {
      const form = document.createElement('form'); form.className = 'review-actions';
      const label = text('label', '貼上 restore-check 輸出的 verify_request'), input = document.createElement('textarea'); input.rows = 3; label.append(input);
      form.append(label, button('記錄還原演練結果', async () => {
        let body; try { body = JSON.parse(input.value); } catch { throw new Error('verify_request 不是有效的 JSON。'); }
        await api('/api/backups/' + encodeURIComponent(checkpoint.id) + '/verify', body); status('還原演練結果已記錄。'); await loadBackups();
      }));
      card.append(form);
    }
    if (checkpoint.status !== 'expired' || !checkpoint.objects_deleted_at) {
      const confirm = text('label', '', 'source-check'), box = document.createElement('input'); box.type = 'checkbox';
      confirm.append(box, text('span', '刪除這個 checkpoint 的資料庫匯出檔（共用的原文複本保留）'));
      card.append(confirm, button(checkpoint.status === 'expired' ? '繼續刪除匯出檔' : '設為到期', async () => {
        if (!box.checked) throw new Error('請先勾選確認。');
        const result = await api('/api/backups/' + encodeURIComponent(checkpoint.id) + '/expire', {});
        status(result.objects_deleted ? 'Checkpoint 已到期，匯出檔已刪除。' : 'Checkpoint 已到期，匯出檔尚未全部刪除，可再按一次繼續。'); await loadBackups();
      }, 'danger'));
    }
    return card;
  }
  async function loadBackups(append = false) {
    const query = new URLSearchParams({ limit: '20' });
    if (append && opsState.backupCursor) query.set('before', opsState.backupCursor);
    const data = await reviewerGet('/api/backups?' + query);
    opsState.backups = append ? opsState.backups.concat(data.checkpoints) : data.checkpoints;
    opsState.backupCursor = data.next_cursor;
    const list = byId('ops-backups'); list.replaceChildren();
    if (!data.configured) list.append(text('p', '尚未綁定 BACKUP bucket，備份功能停用。', 'empty'));
    else if (!data.scheduled) list.append(text('p', 'MAINTENANCE_TASKS 尚未啟用 backup；手動啟動的備份不會推進。', 'notice warning'));
    if (!opsState.backups.length) list.append(text('p', '尚無備份紀錄。', 'empty'));
    for (const checkpoint of opsState.backups) list.append(renderBackup(checkpoint));
    byId('ops-more-backups').hidden = !opsState.backupCursor;
  }
  byId('ops-health-refresh').addEventListener('click', () => loadHealth().then(() => status('資料健康已更新。')).catch(failure));
  byId('ops-plan-refresh').addEventListener('click', () => loadPlan().catch(failure));
  byId('ops-backups-load').addEventListener('click', () => loadBackups().catch(failure));
  byId('ops-more-backups').addEventListener('click', () => loadBackups(true).catch(failure));
  byId('ops-backup-run').addEventListener('click', async () => {
    try { await api('/api/backups/run', {}); status('已建立備份 checkpoint，排程會在下一次執行時推進。'); await loadBackups(); } catch (error) { failure(error); }
  });
  onSubmit('ops-policy-form', async () => {
    const days = byId('ops-policy-days').value.trim();
    await api('/api/retention/policies', { data_class: byId('ops-policy-class').value, keep_days: days ? Number(days) : null });
    await loadPolicies(); status('保存期限已更新；不會自動刪除任何資料。');
  });
  panelLoaders.operations = async () => { await Promise.all([loadHealth(), loadPolicies()]); status('資料維護資訊已更新。'); };
  }
`;

export const operationsPanel: DashboardPanel | null = { tab: 'operations', label: '資料維護', html, script };
