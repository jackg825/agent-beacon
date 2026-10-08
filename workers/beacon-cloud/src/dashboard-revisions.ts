// Phase 3 revisions in the context detail: validity window, revision chain, review
// flags (reviewer create/resolve) and project shares (reviewer share/revoke). Runs
// inside the main dashboard closure, so it uses byId, text, button, date, status,
// failure, api, state, selectContext and loadContext. Recorded and authored values
// (titles, notes, reasons, project names, actors) only ever enter textContent.
export const revisionsScript = String.raw`
  const flagKinds = { contradiction: '可能矛盾', needs_review: '需要再確認' };
  const flagOrigins = { jev: 'Jev 訊號・未校準', reviewer: '人工' };
  const flagStates = { open: '待處理', resolved: '已處理', dismissed: '已駁回' };
  const shareStates = { active: '共享中', inactive: '暫停：這份筆記已不是有效的已核准版本', revoked: '已撤銷' };
  const revisionPlaces = { self: '目前這份', ancestor: '較早版本', descendant: '較新版本' };
  function validityText(entry) {
    if (entry.valid_from) return '有效期間：' + date(entry.valid_from) + ' 起' + (entry.valid_until ? '，至 ' + date(entry.valid_until) + ' 由新版本取代。' : '，目前仍在有效期間內。');
    return entry.status === 'pending' || entry.status === 'rejected' ? '尚未核准，沒有有效期間。' : '';
  }
  // Writes reload the list (badges) and then this entry, exactly like a review.
  async function reviseAndReload(entry, path, body, message) {
    await api(path, body);
    await loadContext(); await selectContext(entry.id); status(message);
  }
  function renderRevisionChain(entry) {
    const chain = document.createElement('details'), list = text('ol', '', 'compact-list');
    chain.append(text('summary', '修訂鏈與有效期間'), list);
    let loaded = false;
    chain.addEventListener('toggle', async () => {
      if (!chain.open || loaded) return;
      loaded = true;
      try {
        const data = await api('/api/context/' + encodeURIComponent(entry.id) + '/history');
        list.replaceChildren();
        for (const item of data.entries) {
          const row = text('li', (revisionPlaces[item.relation] || item.relation) + ' · ' + (stateLabels[item.status] || item.status) + ' · ' + item.title);
          const period = validityText(item);
          if (period) row.append(text('div', period, 'session-meta'));
          if (item.open_flags) row.append(text('div', item.open_flags + ' 個待處理標記', 'session-meta'));
          row.append(text('div', item.id, 'identity'));
          if (item.relation !== 'self') row.append(button('查看這個版本', () => selectContext(item.id)));
          list.append(row);
        }
        if (data.truncated) list.append(text('li', '修訂鏈很長，只列出最接近這份筆記的 ' + data.entries.length + ' 份（依修訂距離），更早或更晚的版本未列出。'));
      } catch (error) { loaded = false; failure(error); }
    });
    return chain;
  }
  function renderFlags(entry) {
    const flags = entry.flags || [], open = entry.open_flags || 0, block = document.createElement('details');
    block.open = open > 0;
    block.append(text('summary', '審閱標記（' + open + ' 個待處理）'));
    for (const flag of flags) {
      const item = text('div', '', flag.status === 'open' ? 'notice warning' : 'notice');
      item.append(text('p', (flagKinds[flag.kind] || flag.kind) + ' · ' + (flagOrigins[flag.origin] || flag.origin) + ' · ' + (flagStates[flag.status] || flag.status)));
      if (flag.note) item.append(text('p', flag.note));
      item.append(text('div', '建立 ' + date(flag.created_at) + ' · ' + flag.created_by, 'identity'));
      if (flag.job_id) item.append(text('div', '整理工作 ' + flag.job_id + '（Jev 只回答「可能矛盾」，不指出是哪一句）', 'identity'));
      if (flag.evidence.length) {
        const evidence = text('ul', '', 'sources');
        for (const pair of flag.evidence) evidence.append(text('li', '事件 ' + pair.event_id + ' · 版本 ' + pair.payload_hash));
        item.append(evidence);
      }
      if (flag.status !== 'open') item.append(text('p', (flagStates[flag.status] || flag.status) + '：' + flag.resolution_reason + ' · ' + date(flag.resolved_at) + ' · ' + flag.resolved_by, 'muted'));
      else {
        const label = text('label', '處理理由'), reason = document.createElement('textarea');
        reason.rows = 2; reason.maxLength = 2000; label.append(reason);
        const actions = text('div', '', 'row');
        for (const [resolution, caption, message] of [['resolved', '標記已處理', '標記已處理。標記不會修改筆記；需要修正時請撰寫新版本。'], ['dismissed', '駁回標記', '標記已駁回。']]) {
          actions.append(button(caption, async () => {
            if (!reason.value.trim()) throw new Error('請填寫處理理由。');
            await reviseAndReload(entry, '/api/context/flags/' + encodeURIComponent(flag.id) + '/resolve', { resolution, reason: reason.value.trim() }, message);
          }, resolution === 'dismissed' ? 'danger' : undefined));
        }
        item.append(label, actions);
      }
      block.append(item);
    }
    if (!flags.length) block.append(text('p', '沒有標記。', 'empty'));
    if (entry.flags_truncated) block.append(text('p', '只列出最近的標記。', 'muted'));
    if (entry.status === 'approved') {
      const form = text('div', '', 'review-actions'), kindLabel = text('label', '標記類型'), kind = document.createElement('select');
      kind.setAttribute('aria-label', '標記類型');
      for (const [value, caption] of Object.entries(flagKinds)) { const option = text('option', caption); option.value = value; kind.append(option); }
      kindLabel.append(kind);
      const noteLabel = text('label', '標記說明（選填）'), note = document.createElement('textarea');
      note.rows = 2; note.maxLength = 2000; noteLabel.append(note);
      const evidenceLabel = text('label', '', 'source-check'), withEvidence = document.createElement('input');
      withEvidence.type = 'checkbox';
      evidenceLabel.append(withEvidence, text('span', '附上目前在活動時間線勾選的事件作為證據（最多 20 個）'));
      form.append(kindLabel, noteLabel, evidenceLabel, button('新增標記', async () => {
        const body = { kind: kind.value };
        if (note.value.trim()) body.note = note.value.trim();
        if (withEvidence.checked) {
          if (!state.sources.size) throw new Error('請先到活動時間線勾選事件，或不附證據。');
          body.evidence = [...state.sources.values()].slice(0, 20).map((source) => ({ event_id: source.event_id, payload_hash: source.payload_hash }));
        }
        await reviseAndReload(entry, '/api/context/' + encodeURIComponent(entry.id) + '/flags', body, '標記已新增。標記只提醒再確認，不會改變核准狀態。');
      }));
      block.append(form);
    }
    return block;
  }
  function renderShares(entry) {
    const shares = entry.shares || [], block = document.createElement('details');
    // Open while any share is unrevoked, so the reviewer sees where this memory is served.
    block.open = shares.some((share) => !share.revoked_at);
    block.append(text('summary', '跨專案共享（' + shares.filter((share) => share.status === 'active').length + ' 個共享中）'));
    for (const share of shares) {
      const item = text('div', '', share.status === 'inactive' ? 'notice warning' : 'notice');
      item.append(text('p', (share.target_name || share.target_id) + ' · ' + (shareStates[share.status] || share.status)));
      item.append(text('div', '建立 ' + date(share.created_at) + ' · ' + share.created_by + (share.revoked_at ? ' · 撤銷 ' + date(share.revoked_at) : ''), 'identity'));
      if (!share.revoked_at) item.append(button('撤銷共享', () => reviseAndReload(entry, '/api/context/shares/' + encodeURIComponent(share.id) + '/revoke', {},
        '共享已撤銷。對方專案之後不會再讀到這份筆記；已同步到 Mac 的副本不會被刪除。'), 'danger'));
      block.append(item);
    }
    if (!shares.length) block.append(text('p', '沒有共享。', 'empty'));
    if (entry.kind === 'memory' && entry.authoritative) {
      const label = text('label', '共享到專案'), target = document.createElement('select');
      target.setAttribute('aria-label', '共享到專案');
      target.append(text('option', '選擇專案'));
      target.options[0].value = '';
      for (const option of byId('context-project').options) if (option.value && option.value !== entry.project_id) {
        const copy = text('option', option.textContent); copy.value = option.value; target.append(copy);
      }
      label.append(target);
      const form = text('div', '', 'review-actions');
      form.append(text('p', '只共享到單一專案；對方查詢時要明確包含共享內容。這份筆記被取代或來源失效後會自動停止提供。', 'muted'), label,
        button('共享這份記憶', async () => {
          if (!target.value) throw new Error('請選擇要共享的專案。');
          await reviseAndReload(entry, '/api/context/' + encodeURIComponent(entry.id) + '/shares', { target_type: 'project', target_id: target.value },
            '已共享。對方專案查詢時明確包含共享內容才會看到。');
        }));
      block.append(form);
    } else if (entry.kind === 'memory') block.append(text('p', '只有已核准且來源範圍有效的長期記憶可以共享。', 'muted'));
    return block;
  }
  function renderRevisions(container, entry) {
    const section = text('div', '', 'revision-block');
    const period = validityText(entry);
    if (period) section.append(text('p', period, 'muted'));
    // The detail is the canonical entry; the recall row it was opened from says whether it arrived through a share.
    const listed = state.context.find((item) => item.id === entry.id && item.shared_from_project_id);
    if (listed) section.append(text('p', '這份長期記憶屬於其他專案（' + listed.shared_from_project_id + '），由審閱者共享到目前查詢的專案。', 'notice'));
    if (entry.open_flags) section.append(text('p', '這份筆記有待處理標記：可能已過時或與新紀錄矛盾。標記不會改變核准狀態；確認後請處理標記，需要修正時撰寫新版本。', 'notice warning'));
    section.append(renderFlags(entry));
    if (entry.kind === 'memory' && (entry.status === 'approved' || (entry.shares || []).length)) section.append(renderShares(entry));
    section.append(renderRevisionChain(entry));
    container.append(section);
  }
`;
