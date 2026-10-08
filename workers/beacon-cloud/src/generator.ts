import { cleanLine, FieldClass, ProjectedEvent, redact } from './privacy';

/** A projected event plus the exact version it came from; citations point at these. */
export interface GeneratorEvent extends ProjectedEvent {
  event_id: string; payload_hash: string; device_id: string; session_id: string | null;
}
export interface GeneratorInput {
  scope: { type: 'task' | 'project'; project_id: string; task_id: string | null; task_open: boolean;
    /** Already reduced to the policy: a task title/project name only when `titles` is allowed. */
    label: string };
  /** Chronological, redacted projection. Never a previous summary. */
  events: GeneratorEvent[];
  fields: readonly FieldClass[];
  secrets: readonly string[];
  truncated: boolean;
}
export interface GeneratorOutput {
  title: string; content: string;
  /** Persisted in this order; citation [n] is sources[n-1]. */
  sources: { event_id: string; payload_hash: string }[];
}
/**
 * Seam for summary generators. Part A ships only the deterministic extractive one;
 * a model generator waits for a recorded provider/model/secret/data-scope/USD-cap
 * decision and must keep the same output contract (four sections, cited bullets).
 */
export interface Generator {
  readonly processor: string;
  readonly version: number;
  /** Part of the job identity: changing it re-plans every scope. */
  readonly processorVersion: string;
  /** Audit actor; never a reviewer identity, so it can never approve. */
  readonly actor: string;
  generate(input: GeneratorInput): Promise<GeneratorOutput>;
}

export const MAX_CONTEXT_SOURCES = 20;
export const MAX_CONTENT = 12_000;
export const SECTIONS = ['## 進度', '## 決策', '## 已驗證結果', '## 待辦與風險'] as const;
const failureActions = new Set(['tool.failed', 'session.error', 'command.failed']);
const successActions = new Set(['tool.completed']);
const fileWriteActions = new Set(['file.modified', 'file.created', 'file.deleted', 'file.written', 'file.renamed', 'session.diff']);
const verification = /\b(?:test|tests|check|checks|build|lint|vet|typecheck|tsc|pytest|jest|vitest|spec|verify)\b/i;
const decisionLabels: Record<string, string> = { allow: '允許', allowed: '允許', approve: '允許', approved: '允許',
  deny: '拒絕', denied: '拒絕', reject: '拒絕', rejected: '拒絕', ask: '詢問', requested: '待決定', block: '阻擋', blocked: '阻擋' };

const failed = (event: ProjectedEvent) => (event.exit_code !== undefined && event.exit_code !== 0) || failureActions.has(event.action);
const succeeded = (event: ProjectedEvent) => event.exit_code === 0 || successActions.has(event.action);
const decision = (event: ProjectedEvent) => !!event.approval_decision || !!event.policy_enforcement || /^(?:approval|policy)\./.test(event.action);
const fileWrite = (event: ProjectedEvent) => fileWriteActions.has(event.action);
const key = (event: ProjectedEvent) => event.command_text || event.tool_name || event.action;
function minute(value: string) {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) ? value.slice(0, 10) + ' ' + value.slice(11, 16) : value;
}

const EXTRACTIVE_VERSION = 'beacon.extractive.v1';
export const extractiveGenerator: Generator = {
  processor: 'beacon.extractive', version: 1, processorVersion: EXTRACTIVE_VERSION, actor: 'pipeline:beacon.extractive@1',
  async generate(input) {
    const events = input.events, line = (value: string, limit = 160) => cleanLine(value, { secrets: input.secrets }, limit);
    const commandText = input.fields.includes('command_text');
    const indices = events.map((_, index) => index);
    const failures = indices.filter((index) => failed(events[index]));
    // A failure is resolved by a later success of the same command (anywhere, when the
    // command text is visible) or of the same tool/action in the same session.
    const resolution = new Map<number, number>();
    for (const index of failures) {
      const later = indices.find((other) => other > index && succeeded(events[other]) && key(events[other]) === key(events[index])
        && (events[other].session_id === events[index].session_id || (commandText && !!events[index].command_text)));
      if (later !== undefined) resolution.set(index, later);
    }
    const unresolved = failures.filter((index) => !resolution.has(index));
    const verified = indices.filter((index) => events[index].exit_code === 0
      && (commandText ? !!events[index].command_text && verification.test(events[index].command_text!) : true));
    const decisions = indices.filter((index) => decision(events[index]));
    const writes = indices.filter((index) => fileWrite(events[index]));

    // Choose at most 20 sources: failures, verifications, decisions, file writes, the
    // successes that resolved failures, then the latest events.
    const chosen = new Set<number>();
    const take = (list: number[], count: number) => { for (const index of list) { if (chosen.size >= MAX_CONTEXT_SOURCES || count <= 0) break; if (!chosen.has(index)) { chosen.add(index); count--; } } };
    take(unresolved, 6); take([...resolution.keys()], 3); take([...resolution.values()], 3); take(verified, 5);
    take(decisions, 4); take(writes, 4); take([...indices].reverse(), MAX_CONTEXT_SOURCES);
    const order = [...chosen].sort((a, b) => a - b);
    const number = new Map(order.map((index, position) => [index, position + 1]));
    const cite = (list: number[], limit = 3) => {
      const refs = [...new Set(list.filter((index) => number.has(index)))].slice(0, limit).map((index) => `[${number.get(index)}]`);
      return refs.length ? ' ' + refs.join('') : '';
    };
    const bullets = (items: string[]) => items.filter((item) => / (?:\[\d+\])+$/.test(item));

    const devices = [...new Set(events.map((event) => event.device_id))];
    const sessions = new Set(events.map((event) => event.session_id ?? 'unscoped'));
    const counts = new Map<string, number>();
    for (const event of events) counts.set(event.action, (counts.get(event.action) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
    const progress = [
      `- 涵蓋 ${devices.length} 台裝置（${devices.map((item) => line(item, 40)).join('、')}）、${sessions.size} 個 session、${events.length} 個事件，時間 ${minute(events[0].timestamp)}–${minute(events.at(-1)!.timestamp)}（UTC）。${cite([order[0], order.at(-1)!], 2)}`,
      `- 動作統計：${top.map(([action, count]) => `${line(action, 60)} ${count}`).join('、')}。${cite(top.map(([action]) => order.find((index) => events[index].action === action)!).filter((index) => index !== undefined))}`,
    ];
    if (writes.length) {
      const names = [...new Set(writes.map((index) => events[index].file_path ? line(events[index].file_path!, 120)
        : events[index].file_ext ?? ''))].filter(Boolean).slice(0, 6);
      progress.push(`- 檔案變更 ${writes.length} 筆${names.length ? (events[writes[0]].file_path ? '：' : '（副檔名：') + names.join('、') + (events[writes[0]].file_path ? '' : '）') : ''}。${cite(writes, 4)}`);
    }
    for (const [index, later] of [...resolution].slice(0, 4))
      progress.push(`- 先前失敗後已成功：「${line(key(events[index]))}」（結束碼 ${events[index].exit_code ?? '未記錄'} → 成功）。${cite([index, later], 2)}`);

    const decided = decisions.slice(0, 6).map((index) => {
      const event = events[index], raw = event.approval_decision ?? event.policy_enforcement ?? event.action.split('.').pop()!;
      return `- ${line(event.action, 60)}：${decisionLabels[raw] ?? line(raw, 32)}${event.tool_name ? '（' + line(event.tool_name, 80) + '）' : ''}。${cite([index], 1)}`;
    });
    const checks = verified.slice(0, 5).map((index) => commandText
      ? `- 「${line(events[index].command_text!)}」結束碼 0。${cite([index], 1)}`
      : `- ${line(events[index].action, 60)} 結束碼 0（政策未允許指令內容，無法判斷檢查類型）。${cite([index], 1)}`);
    const risks = unresolved.slice(0, 6).map((index) =>
      `- 「${line(key(events[index]))}」失敗（結束碼 ${events[index].exit_code ?? '未記錄'}），之後沒有看到同一項目的成功紀錄。${cite([index], 1)}`);
    if (input.scope.task_open) risks.push(`- 任務仍為進行中，交接前請確認下一步。${cite([order.at(-1)!], 1)}`);

    const section = (heading: string, items: string[], empty: string) => [heading, ...(bullets(items).length ? bullets(items) : [empty])].join('\n');
    const parts = [
      `> 自動整理（${EXTRACTIVE_VERSION}）：只依下列編號來源的中繼資料與政策允許的欄位產生，尚未經人工審閱。`,
      ...(input.truncated ? ['> 部分來源內容超過長度上限，已截斷或省略。'] : []),
      section(SECTIONS[0], progress, '紀錄中沒有可整理的進度。'),
      section(SECTIONS[1], decided, '紀錄中沒有明確決策。'),
      section(SECTIONS[2], checks, '紀錄中沒有可辨識的驗證結果。'),
      section(SECTIONS[3], risks, '紀錄中沒有未解決的失敗。'),
    ];
    let content = redact(parts.join('\n\n'), { secrets: input.secrets });
    if (content.length > MAX_CONTENT) content = content.slice(0, content.lastIndexOf('\n', MAX_CONTENT));
    const span = (value: string) => value.slice(0, 10);
    const dates = span(events[0].timestamp) === span(events.at(-1)!.timestamp) ? span(events[0].timestamp)
      : `${span(events[0].timestamp)}–${span(events.at(-1)!.timestamp)}`;
    const prefix = '自動整理：', suffix = `（${dates}）`;
    const title = redact(prefix + line(input.scope.label, 160 - prefix.length - suffix.length) + suffix, { secrets: input.secrets });
    return { title, content, sources: order.map((index) => ({ event_id: events[index].event_id, payload_hash: events[index].payload_hash })) };
  },
};

/** Every bullet must end with in-range citations; used by tests and future generators. */
export function validateGenerated(output: GeneratorOutput): string | null {
  if (!output.title.trim() || output.title.length > 160) return 'invalid_title';
  if (!output.content.trim() || output.content.length > MAX_CONTENT) return 'invalid_length';
  if (!output.sources.length || output.sources.length > MAX_CONTEXT_SOURCES) return 'invalid_sources';
  if (SECTIONS.some((heading) => !output.content.split('\n').includes(heading))) return 'missing_section';
  for (const item of output.content.split('\n').filter((row) => row.startsWith('- '))) {
    const refs = / ((?:\[\d+\])+)$/.exec(item);
    if (!refs) return 'uncited_bullet';
    if ([...refs[1].matchAll(/\[(\d+)\]/g)].some(([, n]) => Number(n) < 1 || Number(n) > output.sources.length)) return 'citation_out_of_range';
  }
  return null;
}
