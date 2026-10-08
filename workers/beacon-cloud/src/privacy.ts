import type { Env } from './types';

/**
 * Field classes a processing policy can allow. Only the always-on metadata below is
 * projected without being listed: event action/kind, timestamp, harness name, command
 * exit status, gen_ai.usage numbers and the approval decision. When `file_path` is
 * not allowed a projection carries only the file extension.
 */
export const FIELD_CLASSES = ['file_path','tool_name','command_text','command_output','prompt_text','response_text',
  'file_diff','tool_input','titles','approved_note_text','raw'] as const;
export type FieldClass = typeof FIELD_CLASSES[number];
export const MAX_PROJECTION_TEXT = 1200;
/** Total retained characters across one projection; later content fields are omitted. */
export const MAX_PROJECTION_CHARS = 120_000;
/** Characters of one field scanned for secrets; the kept head is far inside it. */
const MAX_SCAN_CHARS = 64 * 1024;
const MARK = '[REDACTED]';

// Ported from pkg/asymptoteobserve/privacy.go RedactString, with the key vocabulary
// widened, an optional closing quote for JSON keys, and the sk- prefix variants.
const keys = String.raw`(?:aws_secret_access_key|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|client[_-]?secret|private[_-]?key|api[_-]?key|auth[_-]?token|token|secret|passwd|password|pwd|credentials?|authorization|cookie|session)`;
const labelled: RegExp[] = [
  /authorization\s*[:=]\s*bearer\s+[^"',\s]+/gi,
  new RegExp(keys + String.raw`["']?\s*[:=]\s*["'\x60]?[^"'\x60,\s]+`, 'gi'),
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
];
const assignedPattern = new RegExp(keys + String.raw`["']?\s*[:=]\s*["'\x60]?([^"'\x60,\s]+)`, 'gi');
// Credential shapes common in agent telemetry, including this Worker's own device keys.
const shaped: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /bcn_cf_[A-Za-z0-9_-]{20,}/g,
  /bcn_device_[A-Za-z0-9_-]{8,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
];
const userinfo = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]+@/gi;
const homes: [RegExp, string][] = [
  [/\/Users\/[^/\s"'\x60]+(?=\/|$|[\s"'\x60])/g, '~'],
  [/\/home\/[^/\s"'\x60]+(?=\/|$|[\s"'\x60])/g, '~'],
  [/\b[A-Za-z]:\\Users\\[^\\\s"'\x60]+\\/g, '~/'],
  [/\b[A-Za-z]:\\Users\\[^\\\s"'\x60]+(?=$|[\s"'\x60])/g, '~'],
];

export interface RedactOptions {
  /** Exact secret values (this Worker's own credentials) removed wherever they appear. */
  secrets?: readonly string[];
  /** Values assigned to secret-like keys anywhere in the same projection. */
  assigned?: Iterable<string>;
}

/** This Worker's own secrets, as exact values to strip from any derived text. */
export function workerSecrets(env: Partial<Env>): string[] {
  return [env.READ_TOKEN, env.MCP_TOKEN, env.REVIEW_TOKEN, env.JEV_API_KEY]
    .filter((value): value is string => typeof value === 'string' && value.length >= 8);
}

/** Values assigned to secret-like keys (≥ 8 characters), so bare copies can be removed too. */
export function assignedValues(value: string): string[] {
  const found: string[] = [];
  for (const match of value.slice(0, MAX_SCAN_CHARS).matchAll(assignedPattern)) {
    if (match[1] && match[1].length >= 8 && match[1] !== MARK) found.push(match[1]);
  }
  return found;
}

/**
 * Remove credentials and home-directory user names from one string. Applied to the
 * complete string; callers truncate afterwards and redact again after any cut.
 */
export function redact(value: string, options: RedactOptions = {}): string {
  const assigned = new Set([...assignedValues(value), ...(options.assigned ?? [])]);
  for (const pattern of labelled) {
    value = value.replace(pattern, (match) => {
      if (match.includes('=')) return match.slice(0, match.indexOf('=') + 1) + MARK;
      if (match.includes(':')) return match.slice(0, match.indexOf(':') + 1) + MARK;
      return MARK;
    });
  }
  for (const pattern of shaped) value = value.replace(pattern, MARK);
  value = value.replace(userinfo, `$1${MARK}@`);
  // Longest first, so a secret containing another secret is removed whole.
  const exact = [...(options.secrets ?? []), ...assigned].filter((item) => item.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of exact) value = value.split(secret).join(MARK);
  for (const [pattern, replacement] of homes) value = value.replace(pattern, replacement);
  return value;
}

/** Head-only cut like upstream TruncateString, never splitting a surrogate pair. */
export function truncate(value: string, limit = MAX_PROJECTION_TEXT): string {
  if (value.length <= limit) return value;
  if (limit < 32) return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
  return value.slice(0, limit - 14).replace(/[\uD800-\uDBFF]$/, '') + '...[truncated]';
}

/** Redact the whole string, cut it, then redact again (the cut can expose a new boundary). */
export function cleanText(value: string, options: RedactOptions = {}, limit = MAX_PROJECTION_TEXT): string {
  return redact(truncate(redact(value.slice(0, MAX_SCAN_CHARS), options), limit), options);
}

/** One line, bounded, redacted: for titles, labels and inline values. */
export function cleanLine(value: string, options: RedactOptions = {}, limit = 160): string {
  return cleanText(value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), options, limit);
}

export interface ProjectedEvent {
  /** Always-on metadata. */
  action: string; kind: string; timestamp: string; harness: string;
  exit_code?: number; approval_decision?: string; policy_enforcement?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  /** Present only when `file_path` is not allowed. */
  file_ext?: string;
  file_path?: string; tool_name?: string; command_text?: string; command_output?: string; prompt_text?: string;
  response_text?: string; file_diff?: string; tool_input?: string; raw?: string;
}
type ContentKey = 'file_path'|'tool_name'|'command_text'|'command_output'|'prompt_text'|'response_text'|'file_diff'|'tool_input'|'raw';
const contentKeys: ContentKey[] = ['file_path','tool_name','command_text','command_output','prompt_text','response_text','file_diff','tool_input','raw'];

function get(record: unknown, ...path: string[]): unknown {
  let value = record;
  for (const part of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function serialized(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value)?.slice(0, MAX_SCAN_CHARS) ?? ''; } catch { return ''; }
}
function token(value: unknown, max = 32): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]*$/i.test(value) && value.length <= max ? value.toLowerCase() : undefined;
}
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function relative(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '');
  if (base && base !== '/' && (path === base || path.startsWith(base + '/'))) return path.slice(base.length + 1) || '.';
  return path;
}

/** Raw (un-redacted) candidate values per content class for one payload. */
function contentValues(payload: unknown, root: string): Partial<Record<ContentKey, string>> {
  const action = str(get(payload, 'event', 'action'));
  const path = str(get(payload, 'file', 'path')) || str(get(payload, 'tool', 'path'));
  const mcpTool = [str(get(payload, 'mcp', 'server')), str(get(payload, 'mcp', 'tool'))].filter(Boolean).join('/');
  const message = str(get(payload, 'message'));
  const agent = action.startsWith('agent.');
  const raw = [serialized(get(payload, 'raw')), agent ? '' : message, str(get(payload, 'error', 'message'))].filter(Boolean).join('\n');
  return {
    file_path: path ? relative(path, root) : '',
    tool_name: str(get(payload, 'tool', 'name')) || mcpTool || str(get(payload, 'gen_ai', 'tool', 'name')),
    command_text: str(get(payload, 'command', 'command')) || str(get(payload, 'tool', 'command')),
    command_output: str(get(payload, 'command', 'output')) || serialized(get(payload, 'gen_ai', 'tool', 'call', 'result')),
    prompt_text: str(get(payload, 'prompt', 'text')),
    response_text: [agent ? message : '', serialized(get(payload, 'gen_ai', 'output', 'messages'))].filter(Boolean).join('\n'),
    file_diff: str(get(payload, 'file', 'diff')),
    tool_input: serialized(get(payload, 'gen_ai', 'tool', 'call', 'arguments')) || serialized(get(payload, 'tool', 'input'))
      || serialized(get(payload, 'tool', 'arguments')),
    raw,
  };
}

export interface ProjectionInput { payload: unknown; timestamp?: string; projectRoot?: string }

/**
 * Project payloads under one policy. Every retained string is redacted; values
 * assigned to secret-like keys anywhere in the projection are also removed where
 * they reappear bare in another field or event. Bounded per string and in total.
 */
export function projectEvents(inputs: readonly ProjectionInput[], fields: readonly FieldClass[],
  options: { secrets?: readonly string[] } = {}): { events: ProjectedEvent[]; truncated: boolean; chars: number } {
  const allowed = new Set(fields);
  const values = inputs.map((input) => contentValues(input.payload,
    input.projectRoot ?? str(get(input.payload, 'session', 'working_directory'))));
  const assigned = new Set<string>();
  for (const value of values) for (const key of contentKeys) {
    if (allowed.has(key) && value[key]) for (const item of assignedValues(value[key]!)) assigned.add(item);
  }
  const redaction = { secrets: options.secrets, assigned };
  let chars = 0, truncated = false;
  const events = inputs.map((input, index) => {
    const payload = input.payload;
    const event: ProjectedEvent = {
      action: cleanLine(str(get(payload, 'event', 'action')) || 'unknown', redaction, 128),
      kind: cleanLine(str(get(payload, 'event', 'kind')) || 'unknown', redaction, 64),
      timestamp: cleanLine(input.timestamp ?? str(get(payload, 'timestamp')), redaction, 40),
      harness: cleanLine(str(get(payload, 'harness', 'name')) || 'unknown', redaction, 128),
    };
    const exit = get(payload, 'command', 'exit_code');
    if (typeof exit === 'number' && Number.isInteger(exit)) event.exit_code = exit;
    const decision = token(get(payload, 'approval', 'decision'));
    if (decision) event.approval_decision = decision;
    const enforcement = token(get(payload, 'policy', 'enforcement'));
    if (enforcement) event.policy_enforcement = enforcement;
    const usage = { input_tokens: finite(get(payload, 'gen_ai', 'usage', 'input_tokens')),
      output_tokens: finite(get(payload, 'gen_ai', 'usage', 'output_tokens')), cost_usd: finite(get(payload, 'gen_ai', 'usage', 'cost_usd')) };
    if (Object.values(usage).some((item) => item !== undefined))
      event.usage = Object.fromEntries(Object.entries(usage).filter(([, item]) => item !== undefined));
    const value = values[index];
    if (!allowed.has('file_path') && value.file_path) {
      const ext = /\.([A-Za-z0-9]{1,10})$/.exec(value.file_path.split(/[\\/]/).pop() ?? '')?.[1];
      if (ext) event.file_ext = '.' + ext.toLowerCase();
    }
    for (const key of contentKeys) {
      const text = value[key];
      if (!allowed.has(key) || !text) continue;
      if (chars >= MAX_PROJECTION_CHARS) { truncated = true; continue; }
      const limit = key === 'tool_name' ? 200 : Math.min(MAX_PROJECTION_TEXT, MAX_PROJECTION_CHARS - chars);
      const cleaned = key === 'tool_name' || key === 'file_path' ? cleanLine(text, redaction, limit) : cleanText(text, redaction, limit);
      if (cleaned.length < text.length) truncated ||= cleaned.endsWith('...[truncated]');
      chars += cleaned.length;
      event[key] = cleaned;
    }
    return event;
  });
  return { events, truncated, chars };
}

/** Single-event projection; prefer projectEvents so bare copies are found across events. */
export function projectEvent(payload: unknown, fields: readonly FieldClass[],
  options: { projectRoot?: string; secrets?: readonly string[] } = {}): ProjectedEvent {
  return projectEvents([{ payload, projectRoot: options.projectRoot }], fields, { secrets: options.secrets }).events[0];
}
