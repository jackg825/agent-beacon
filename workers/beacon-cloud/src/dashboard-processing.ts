import type { DashboardPanel } from './dashboard-panels';

// Track P (phase 2): 背景整理 policies and jobs. Every recorded or authored value
// enters the page through textContent only; the script holds no data or secrets.
const html = `<p class="notice">背景整理預設關閉。啟用後，排程只會依政策產生「自動整理・待審」候選，必須在「交接與記憶」人工審閱才會採用；原始事件不會被改寫或刪除。摘要只用本機規則產生，不呼叫生成模型；可選的 Jev 篩選只在部署允許清單、政策、金鑰與每日預算都通過時才呼叫，而且只留下未校準的訊號。</p>
<div class="two-column section-gap"><section class="panel"><div class="panel-title"><h2>整理政策</h2><p class="muted">工作區設定是上限：專案只能在工作區允許的範圍內再收窄。</p></div><div class="panel-body">
<form id="processing-policy-filter"><label>政策範圍<select id="processing-project" aria-label="政策範圍"><option value="">整個工作區</option></select></label><button type="submit">讀取政策</button></form>
<div id="processing-effective" class="list section-gap"></div>
<details id="processing-policy-edit" class="section-gap"><summary>修改政策（需要審閱金鑰）</summary><form id="processing-policy-form" class="vertical">
<p class="muted" id="processing-policy-target">儲存會整份取代所選範圍的政策，並留下稽核紀錄。</p>
<label class="source-check"><input type="checkbox" id="processing-enabled">啟用背景整理</label>
<label class="source-check"><input type="checkbox" id="processing-external">允許送出工作區（只用於可選的 Jev 篩選）</label>
<label class="source-check"><input type="checkbox" id="processing-jev">允許 Jev 篩選（只產生未校準訊號）</label>
<fieldset id="processing-summary-fields"><legend>本機整理可使用的欄位</legend></fieldset>
<fieldset id="processing-external-fields"><legend>可送出工作區的欄位（必須同時勾選於本機整理）</legend></fieldset>
<label>最少新事件數<input type="number" id="processing-min" min="1" max="1000" step="1" required></label>
<label>安靜分鐘數<input type="number" id="processing-quiet" min="0" max="1440" step="1" required></label>
<label>每份最多事件數<input type="number" id="processing-max" min="1" max="200" step="1" required></label>
<label>Jev 略過門檻（空白代表永不略過）<input type="number" id="processing-threshold" min="0" max="1" step="0.01"></label>
<button type="submit" class="primary">儲存政策</button></form></details>
<form id="processing-run-form" class="section-gap"><label>立即整理的任務<select id="processing-task" aria-label="立即整理的任務"><option value="">不指定任務（整理上方選擇的專案）</option></select></label><button type="submit">立即排入整理</button></form>
<p class="muted">立即整理只略過最少事件數與安靜時間；政策關閉的範圍仍會拒絕。實際執行在下一次排程。</p>
</div></section>
<section class="panel"><div class="panel-title"><h2>整理工作</h2><p class="muted">失敗會在 1、5、30 分鐘後自動重試，最多執行 4 次；之後需要人工重試或放棄。</p></div><div class="panel-body">
<form id="processing-job-filter"><label>工作狀態<select id="processing-status" aria-label="工作狀態"><option value="">所有狀態</option><option value="queued">排隊中</option><option value="running">執行中</option><option value="succeeded">已產生候選</option><option value="skipped">已略過</option><option value="failed">失敗・待處理</option><option value="dismissed">已放棄</option></select></label><button type="submit">篩選工作</button></form>
<div id="processing-jobs" class="list section-gap"></div><button type="button" id="processing-more" class="pagination" hidden>載入更多工作</button>
<div id="processing-job-detail" class="section-gap"></div></div></section></div>
<section class="panel section-gap"><div class="panel-title"><h2>外部呼叫預算與今日用量</h2><p class="muted">沒有預算或上限為 0 時不會發出任何外部呼叫。費用只記錄供應商回報的金額；逾時、失敗與結果不明的呼叫都已計入，本機防重不代表供應商只收一次費用。</p></div><div class="panel-body">
<div id="processing-usage" class="list"></div>
<details id="processing-budget-edit" class="section-gap"><summary>修改每日預算（需要審閱金鑰）</summary><form id="processing-budget-form" class="vertical">
<p class="muted">儲存會整份取代每日預算並留下稽核紀錄。預算只在 operator 設定的部署允許清單與金鑰之內有作用。</p>
<label>每日呼叫上限（0 代表停用）<input type="number" id="budget-calls" min="0" max="10000" step="1" required></label>
<label>每日 token 上限（0 代表停用）<input type="number" id="budget-tokens" min="0" max="100000000" step="1" required></label>
<label>每日美元上限（空白代表不設定；只依供應商回報的費用）<input type="number" id="budget-usd" min="0" max="10000" step="0.0001"></label>
<label>每次輸入字元上限<input type="number" id="budget-input" min="1000" max="200000" step="1" required></label>
<label>每次輸出 token 上限<input type="number" id="budget-output" min="1" max="8192" step="1" required></label>
<label>每次逾時（毫秒）<input type="number" id="budget-timeout" min="1000" max="30000" step="1" required></label>
<button type="submit" class="primary">儲存預算</button></form></details>
<h3 class="section-gap">今日外部呼叫</h3><div id="processing-calls" class="list"></div>
</div></section>`;

const script = String.raw`
  const processingStatus = { queued: '排隊中', running: '執行中', succeeded: '已產生候選', skipped: '已略過', failed: '失敗・待處理', dismissed: '已放棄' };
  const processingCodes = { policy_changed: '政策已變更，將重新規劃', scope_changed: '範圍已變更，將重新規劃', low_signal_only: '只有低訊號事件',
    no_matching_versions: '沒有相符的原始版本', raw_unavailable: '原始資料暫時無法讀取', lease_expired: '執行逾時', invalid_source: '來源範圍不符',
    context_conflict: '候選衝突', job_failed: '處理失敗', jev_no_new_information: 'Jev 判斷沒有新資訊（依政策門檻略過）',
    jev_skip_overridden: '有失敗、拒絕或矛盾訊號，不依 Jev 略過', jev_failed: 'Jev 呼叫失敗，沒有訊號',
    jev_outcome_unknown: 'Jev 呼叫結果不明（已計入預算）', jev_previous_outcome_unknown: '先前的 Jev 呼叫結果不明，不再重送',
    jev_previous_failed: '先前的 Jev 呼叫失敗，不再重送', jev_no_time: '剩餘時間不足，未呼叫 Jev', jev_input_too_large: '輸入超過預算上限，未呼叫 Jev',
    redirect_rejected: '供應商要求轉址，已拒絕', timeout: '逾時', network_error: '連線中斷', response_too_large: '回應過大',
    invalid_response: '回應格式不符', stale_reservation: '預約沒有完成，視為結果不明', budget_disabled: '沒有可用預算',
    daily_call_limit: '已達每日呼叫上限', daily_token_limit: '已達每日 token 上限', usd_ceiling: '已達每日美元上限',
    input_too_large: '輸入超過上限', duplicate: '重複預約', lease_lost: '工作租約已轉移' };
  const processingCallStatus = { reserved: '已預約・尚未完成', succeeded: '已完成', failed: '失敗（已計入）', outcome_unknown: '結果不明（已計入）' };
  const processingQuestion = (signal) => signal.question_id === 'new_information' ? '有新資訊'
    : signal.question_id === 'task_related' ? '與任務相關' : '可能與已核准筆記 ' + String(signal.context_id || '').slice(0, 8) + ' 矛盾';
  const processingFields = { file_path: '檔案路徑', tool_name: '工具名稱', command_text: '指令內容', command_output: '指令輸出',
    prompt_text: '提示內容', response_text: '回應內容', file_diff: '檔案差異', tool_input: '工具輸入', titles: '任務／筆記標題與專案名稱',
    approved_note_text: '已核准筆記內容', raw: '其他原始欄位' };
  const processing = { cursor: null, jobs: [], version: 0, detailVersion: 0, view: null, projects: new Map(), ready: false };
  function processingCode(value) {
    if (!value) return '';
    if (value.startsWith('jev_budget:')) return '預算未通過，未呼叫 Jev：' + processingCode(value.slice(11));
    if (/^http_\d+$/.test(value)) return '供應商回應 HTTP ' + value.slice(5);
    return processingCodes[value] || value;
  }
  const processingScope = (job) => (job.scope_type === 'task' ? '任務 ' + String(job.task_id).slice(0, 8) : '專案')
    + ' · ' + (processing.projects.get(job.project_id) || String(job.project_id).slice(0, 12));
  function processingBoxes(id) {
    const box = byId(id);
    for (const [name, label] of Object.entries(processingFields)) {
      const wrapper = text('label', '', 'source-check'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = name; wrapper.append(input, document.createTextNode(label)); box.append(wrapper);
    }
  }
  const processingChecked = (id) => [...byId(id).querySelectorAll('input:checked')].map((input) => input.value);
  function processingFill(row) {
    const value = row || processing.view.defaults;
    byId('processing-enabled').checked = !!value.enabled;
    byId('processing-external').checked = !!value.external_allowed;
    byId('processing-jev').checked = !!value.jev_enabled;
    for (const [id, list] of [['processing-summary-fields', value.summary_fields], ['processing-external-fields', value.external_fields]])
      byId(id).querySelectorAll('input').forEach((input) => { input.checked = list.includes(input.value); });
    byId('processing-min').value = value.min_new_events; byId('processing-quiet').value = value.quiet_minutes;
    byId('processing-max').value = value.max_events_per_job;
    byId('processing-threshold').value = value.jev_skip_threshold === null ? '' : value.jev_skip_threshold;
  }
  function processingPolicyLines(title, policy, missing = '沒有設定，使用內建預設（全部關閉）。') {
    const node = text('div', '', 'card-button');
    node.append(text('strong', title));
    if (!policy) { node.append(text('span', missing, 'session-meta')); return node; }
    node.append(text('span', (policy.enabled ? '已啟用' : '已關閉') + ' · 外部送出' + (policy.external_allowed ? '允許' : '不允許')
      + ' · Jev ' + (policy.jev_enabled ? '允許' : '不允許'), 'session-meta'));
    const fields = (list) => list.length ? list.map((name) => processingFields[name] || name).join('、') : '只有中繼資料';
    node.append(text('span', '本機整理欄位：' + fields(policy.summary_fields), 'session-meta'));
    node.append(text('span', '可送出欄位：' + fields(policy.external_fields), 'session-meta'));
    node.append(text('span', '最少 ' + policy.min_new_events + ' 個新事件 · 安靜 ' + policy.quiet_minutes + ' 分鐘 · 每份最多 '
      + policy.max_events_per_job + ' 個事件', 'session-meta'));
    if (policy.version) node.append(text('span', '版本 ' + policy.version + ' · ' + date(policy.updated_at) + ' · ' + policy.updated_by, 'identity'));
    return node;
  }
  async function loadProcessingPolicy() {
    const project = byId('processing-project').value;
    const data = await api('/api/processing/policy' + (project ? '?project_id=' + encodeURIComponent(project) : ''));
    processing.view = data;
    const container = byId('processing-effective'); container.replaceChildren();
    container.append(processingPolicyLines(project ? '目前生效（工作區上限 ∩ 專案設定）' : '工作區上限', project ? data.effective : data.workspace));
    if (project) {
      container.append(processingPolicyLines('專案設定', data.project, '沒有專案設定，沿用工作區上限。'), processingPolicyLines('工作區上限', data.workspace));
      const gate = data.external_gate;
      container.append(text('p', '外部呼叫條件：部署允許清單' + (gate.deploy_allowed ? '已列入' : '未列入') + ' · 金鑰'
        + (gate.key_configured ? '已設定' : '未設定') + ' · 端點與模型設定' + (gate.endpoint_valid ? '有效' : '無效')
        + ' · 政策' + (gate.policy_allowed ? '允許' : '不允許') + (gate.eligible
          ? '。每次呼叫前仍需每日預算預約成功，而且可送出欄位要包含標題或已核准筆記內容。' : '。目前這個專案不會發出任何外部呼叫。'), 'muted'));
    } else if (data.projects && data.projects.length) {
      container.append(text('p', '有專案覆寫：' + data.projects.map((row) => row.project_name + (row.enabled ? '（啟用）' : '（關閉）')).join('、'), 'muted'));
    }
    byId('processing-policy-target').textContent = project ? '儲存會整份取代所選範圍（工作區或此專案）的政策，並留下稽核紀錄。' : '儲存會整份取代工作區上限，並留下稽核紀錄。';
    processingFill(project ? data.project || data.workspace : data.workspace);
  }
  function renderProcessingJobs() {
    const container = byId('processing-jobs'); container.replaceChildren();
    if (!processing.jobs.length) container.append(text('p', '目前沒有整理工作。啟用政策並等待排程，或使用「立即排入整理」。', 'empty'));
    for (const job of processing.jobs) {
      const node = button('', () => selectProcessingJob(job.id), 'card-button');
      node.append(text('span', processingScope(job)), text('span', processingStatus[job.status] || job.status, 'badge ' + (job.status === 'failed' ? 'rejected' : job.status === 'succeeded' ? '' : 'pending')));
      node.append(text('span', job.source_count + ' 個來源 · 已涵蓋 ' + job.covered_count + ' · 嘗試 ' + job.attempts + '／' + job.max_attempts + ' · ' + date(job.created_at), 'session-meta'));
      const reason = processingCode(job.skip_reason || job.last_error);
      if (reason) node.append(text('span', reason, 'session-meta'));
      container.append(node);
    }
    byId('processing-more').hidden = !processing.cursor;
  }
  async function loadProcessingJobs(append = false) {
    const version = ++processing.version, query = new URLSearchParams({ limit: '20' });
    if (byId('processing-status').value) query.set('status', byId('processing-status').value);
    if (append && processing.cursor) query.set('before', processing.cursor);
    const data = await api('/api/processing/jobs?' + query);
    if (version !== processing.version) return;
    processing.jobs = append ? processing.jobs.concat(data.jobs) : data.jobs;
    processing.cursor = data.next_cursor;
    renderProcessingJobs();
  }
  async function selectProcessingJob(id) {
    const version = ++processing.detailVersion;
    const data = await api('/api/processing/jobs/' + encodeURIComponent(id));
    if (version !== processing.detailVersion) return;
    renderProcessingJob(data.job);
  }
  function renderProcessingJob(job) {
    const container = byId('processing-job-detail'); container.replaceChildren();
    const heading = text('div', '', 'detail-heading');
    heading.append(text('h3', processingScope(job)), text('span', processingStatus[job.status] || job.status, 'badge'));
    container.append(heading);
    const facts = text('ul', '', 'compact-list');
    facts.append(text('li', '來源 ' + job.source_count + ' 個；實際整理 ' + (job.event_count ?? '尚未執行') + ' 個；排除 ' + (job.excluded_count ?? 0) + ' 個；已涵蓋 ' + job.covered_count + ' 個'));
    // Only a queued job has a next attempt; a failed one waits for a reviewer.
    facts.append(text('li', '嘗試 ' + job.attempts + '／' + job.max_attempts + (job.status === 'queued' ? ' · 下次 ' + date(job.next_attempt_at) : '')));
    if (job.first_event_at) facts.append(text('li', '事件時間 ' + date(job.first_event_at) + ' – ' + date(job.last_event_at)));
    if (job.skip_reason) facts.append(text('li', '略過原因：' + processingCode(job.skip_reason)));
    if (job.last_error) facts.append(text('li', '最近錯誤：' + processingCode(job.last_error)));
    if (job.note) facts.append(text('li', '篩選備註：' + processingCode(job.note)));
    facts.append(text('li', '處理器 ' + job.processor_version + ' · 規劃者 ' + job.planned_by));
    container.append(facts, text('div', '工作 ' + job.id, 'identity'), text('div', '政策雜湊 ' + job.policy_hash, 'identity'));
    if (job.signals.length) {
      const signals = text('ul', '', 'compact-list');
      for (const signal of job.signals) {
        const item = text('li', processingQuestion(signal) + '：' + signal.probability + (signal.confidence === null ? '' : ' · 信心 ' + signal.confidence)
          + '（未校準分數，不代表正確率）· ' + signal.evaluator + (signal.model ? ' · ' + signal.model : ''));
        if (signal.context_id) item.append(' ', button('查看筆記', async () => {
          byId('context-status').value = 'approved'; byId('context-project').value = ''; byId('context-task').value = '';
          showTab('context'); await loadContext(); await selectContext(signal.context_id);
        }));
        signals.append(item);
      }
      container.append(text('h3', 'Jev 篩選訊號'), text('p', '訊號只供參考：不會核准、修改或刪除任何筆記；矛盾訊號只表示需要人工確認。', 'muted'), signals);
    }
    if (job.calls.length) {
      const calls = text('ul', '', 'compact-list');
      for (const call of job.calls) calls.append(text('li', processingCallText(call)));
      container.append(text('h3', '外部呼叫紀錄'), calls);
    }
    const actions = text('div', '', 'row');
    if (job.result_context_id) actions.append(button('查看自動整理候選', async () => {
      byId('context-status').value = job.result_status || 'pending';
      byId('context-project').value = ''; byId('context-task').value = '';
      showTab('context'); await loadContext(); await selectContext(job.result_context_id);
    }, 'primary'));
    if (job.status === 'failed') actions.append(button('重試工作', async () => {
      renderProcessingJob((await api('/api/processing/jobs/' + encodeURIComponent(job.id) + '/retry', {})).job);
      await loadProcessingJobs(); status('工作已重新排入，會在下一次排程執行。');
    }));
    if (job.status === 'failed' || job.status === 'queued') actions.append(button('放棄工作', async () => {
      renderProcessingJob((await api('/api/processing/jobs/' + encodeURIComponent(job.id) + '/dismiss', {})).job);
      await loadProcessingJobs(); status('工作已放棄；相同來源不會再自動處理，新的事件會重新規劃。');
    }, 'danger'));
    container.append(actions);
  }
  function processingCallText(call) {
    const tokens = call.input_tokens === null && call.output_tokens === null ? '預估 ' + call.estimated_tokens + ' token'
      : '回報 ' + (call.input_tokens ?? 0) + '＋' + (call.output_tokens ?? 0) + ' token';
    return call.provider + ' · 第 ' + call.attempt + ' 次嘗試 · ' + (processingCallStatus[call.status] || call.status)
      + (call.error_code ? '（' + processingCode(call.error_code) + '）' : '') + ' · 輸入 ' + call.input_chars + ' 字元 · ' + tokens
      + (call.reported_cost_usd === null ? '' : ' · 回報費用 $' + call.reported_cost_usd) + ' · ' + date(call.started_at);
  }
  async function loadProcessingUsage() {
    const data = await api('/api/processing/usage');
    const budget = data.budget, used = data.usage, container = byId('processing-usage');
    container.replaceChildren();
    const node = text('div', '', 'card-button');
    node.append(text('strong', data.day + '（UTC）' + (budget.allows_calls ? '' : ' · 外部呼叫已停用（上限為 0）')));
    node.append(text('span', '呼叫 ' + used.calls + '／' + budget.daily_call_limit + ' · 計入 token ' + used.counted_tokens + '／'
      + budget.daily_token_limit + '（未回報用量時以預估計入）', 'session-meta'));
    node.append(text('span', '供應商回報費用 ' + (used.reported_cost_usd === null ? '未回報' : '$' + used.reported_cost_usd)
      + (budget.daily_usd_ceiling === null ? ' · 未設定美元上限' : '／$' + budget.daily_usd_ceiling), 'session-meta'));
    node.append(text('span', '完成 ' + used.succeeded + ' · 失敗 ' + used.failed + ' · 結果不明 ' + used.outcome_unknown + ' · 已預約 ' + used.reserved, 'session-meta'));
    node.append(text('span', '每次輸入最多 ' + budget.max_input_chars + ' 字元 · 輸出 ' + budget.max_output_tokens + ' token · 逾時 ' + budget.timeout_ms + ' 毫秒', 'session-meta'));
    node.append(text('span', budget.configured ? '版本 ' + budget.version + ' · ' + date(budget.updated_at) + ' · ' + budget.updated_by : '尚未設定預算（全部為 0）', 'identity'));
    container.append(node);
    byId('budget-calls').value = budget.daily_call_limit; byId('budget-tokens').value = budget.daily_token_limit;
    byId('budget-usd').value = budget.daily_usd_ceiling === null ? '' : budget.daily_usd_ceiling;
    byId('budget-input').value = budget.max_input_chars; byId('budget-output').value = budget.max_output_tokens; byId('budget-timeout').value = budget.timeout_ms;
    const calls = byId('processing-calls'); calls.replaceChildren();
    if (!data.calls.length) calls.append(text('p', '今天沒有外部呼叫。', 'empty'));
    for (const call of data.calls) {
      const row = button('', () => selectProcessingJob(call.job_id), 'card-button');
      row.append(text('span', processingCallText(call)), text('span', '工作 ' + String(call.job_id).slice(0, 12), 'session-meta'));
      calls.append(row);
    }
  }
  onSubmit('processing-budget-form', async () => {
    const usd = byId('budget-usd').value.trim();
    await api('/api/processing/budget', { daily_call_limit: Number(byId('budget-calls').value), daily_token_limit: Number(byId('budget-tokens').value),
      daily_usd_ceiling: usd === '' ? null : Number(usd), max_input_chars: Number(byId('budget-input').value),
      max_output_tokens: Number(byId('budget-output').value), timeout_ms: Number(byId('budget-timeout').value) });
    await loadProcessingUsage(); status('預算已儲存。之後的外部呼叫依新預算預約；已計入的呼叫不會退回。');
  });
  onSubmit('processing-policy-filter', () => loadProcessingPolicy());
  onSubmit('processing-job-filter', () => loadProcessingJobs());
  byId('processing-more').addEventListener('click', () => loadProcessingJobs(true).catch(failure));
  onSubmit('processing-policy-form', async () => {
    const project = byId('processing-project').value;
    const threshold = byId('processing-threshold').value.trim();
    const body = { scope_type: project ? 'project' : 'workspace', scope_id: project || '*',
      enabled: byId('processing-enabled').checked, external_allowed: byId('processing-external').checked, jev_enabled: byId('processing-jev').checked,
      summary_fields: processingChecked('processing-summary-fields'), external_fields: processingChecked('processing-external-fields'),
      min_new_events: Number(byId('processing-min').value), quiet_minutes: Number(byId('processing-quiet').value),
      max_events_per_job: Number(byId('processing-max').value), jev_skip_threshold: threshold === '' ? null : Number(threshold) };
    await api('/api/processing/policies', body);
    await loadProcessingPolicy(); status('政策已儲存。下一次排程依新政策規劃；已排入的工作會在執行前重新檢查。');
  });
  onSubmit('processing-run-form', async () => {
    const task = byId('processing-task').value, project = byId('processing-project').value;
    if (!task && !project) throw new Error('請先在「政策範圍」選擇專案，或選擇一個任務。');
    if (!task && processing.view && processing.view.project_id === project && !processing.view.effective.enabled)
      throw new Error('這個專案的背景整理目前關閉（工作區上限或專案設定），不能立即整理。');
    const data = await api('/api/processing/run', task ? { task_id: task } : { project_id: project });
    await loadProcessingJobs();
    status('已規劃 ' + data.scopes.filter((scope) => scope.status === 'planned' || scope.status === 'requeued').length + ' 份工作；其他範圍已有工作、待審候選或沒有新事件。');
  });
  processingBoxes('processing-summary-fields'); processingBoxes('processing-external-fields');
  panelLoaders.processing = async () => {
    if (!processing.ready) {
      const projects = (await api('/api/projects')).projects;
      for (const project of projects) processing.projects.set(project.id, project.name);
      options('processing-project', projects);
      processing.ready = true;
    }
    options('processing-task', state.tasks.filter((task) => task.status === 'open'));
    await Promise.all([loadProcessingPolicy(), loadProcessingJobs(), loadProcessingUsage()]);
  };
`;

export const processingPanel: DashboardPanel | null = { tab: 'processing', label: '背景整理', html, script };
