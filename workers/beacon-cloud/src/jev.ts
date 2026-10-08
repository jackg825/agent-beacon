// Optional Jev (TypeSafe System One) evaluator stage. Signal-only by default: it
// stores uncalibrated answers and can skip a job only under an explicit policy
// threshold, never past high-signal events. It runs only when the operator's deploy
// gate, the effective policy, the key and an atomic budget reservation all allow it.
// Wire contract: cli/beacon/internal/learning/evaluator.go (POST {model,state,
// questions:{id:{type:'noul',instructions,criteria}}}, Bearer key, answers
// {id:{noul|probability|score,confidence}}, optional usage).
import { digest } from './auth';
import { invalidSourceScope } from './context';
import { contradictionFlagStatements } from './context-revisions';
import { externalFetch } from './external-fetch';
import { assignedValues, cleanLine, cleanText, FieldClass, ProjectedEvent, redact, workerSecrets } from './privacy';
import { CallOutcome, finishCallStatement, readBudget, reserveCall, utcDay } from './processing-budget';
import { externalGate, jevConfig } from './processing-policy';
import { CONTRADICTION_SIGNAL, isHighSignal, ruleFilter, SelectionStage, StageInput, StageResult, StageSignal } from './processing-stage';
import type { Env } from './types';

export const JEV_RUBRIC_VERSION = 'beacon.cloud.jev.v1';
export const JEV_QUESTION_TYPE = 'noul';
export const MAX_JEV_NOTES = 10;
export const MAX_JEV_NOTE_CHARS = 2000;
export const MAX_JEV_RESPONSE_BYTES = 1024 * 1024;
/** A contradiction answer at or above this is a high-signal fact that blocks a skip and flags that entry. */
export { CONTRADICTION_SIGNAL };
export const JEV_INSTRUCTIONS = {
  new_information: 'Does the new activity contain information not already captured by the approved notes listed in state?',
  task_related: 'Is the new activity related to the task named in state?',
  contradiction: (id: string) => `Does the new activity contradict the approved note ${id} listed in state?`,
};
const criteria = { true: 'The new activity satisfies this criterion.', false: 'The new activity does not satisfy this criterion.' };

export interface JevQuestion { type: typeof JEV_QUESTION_TYPE; instructions: string; criteria: Record<'true' | 'false', string> }
export interface JevNote { id: string; kind: string; title?: string; content: string; content_sha256: string }
export interface JevRequest { model: string; state: Record<string, unknown>; questions: Record<string, JevQuestion> }
export interface JevAnswer { probability: number; confidence: number | null }
export interface JevParsed { answers: Map<string, JevAnswer>; usage: { input_tokens?: number; output_tokens?: number; cost_usd?: number } }

const question = (instructions: string): JevQuestion => ({ type: JEV_QUESTION_TYPE, instructions, criteria });
/**
 * new_information and per-entry contradiction need note content in state, so they are
 * asked only when approved_note_text may leave the workspace and a note exists;
 * task_related needs the task title, so only for a task scope under `titles`.
 */
export function jevQuestions(notes: readonly Pick<JevNote, 'id'>[], taskRelated: boolean): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  if (notes.length) questions.new_information = question(JEV_INSTRUCTIONS.new_information);
  if (taskRelated) questions.task_related = question(JEV_INSTRUCTIONS.task_related);
  for (const note of notes) questions['contradiction:' + note.id] = question(JEV_INSTRUCTIONS.contradiction(note.id));
  return questions;
}

const contentKeys = ['tool_name', 'command_text', 'command_output', 'prompt_text', 'response_text', 'file_diff', 'tool_input', 'raw'] as const;
const extension = (path: string) => /\.([A-Za-z0-9]{1,10})$/.exec(path.split(/[\\/]/).pop() ?? '')?.[1]?.toLowerCase();
/** Narrow a summary projection to the classes that may leave the workspace; metadata stays. */
export function externalEvent(event: ProjectedEvent, fields: ReadonlySet<FieldClass>, number: number): Record<string, unknown> {
  const out: Record<string, unknown> = { number, action: event.action, kind: event.kind, timestamp: event.timestamp, harness: event.harness };
  if (event.exit_code !== undefined) out.exit_code = event.exit_code;
  if (event.approval_decision) out.approval_decision = event.approval_decision;
  if (event.policy_enforcement) out.policy_enforcement = event.policy_enforcement;
  if (event.usage) out.usage = event.usage;
  if (event.file_path !== undefined) {
    const ext = extension(event.file_path);
    if (fields.has('file_path')) out.file_path = event.file_path; else if (ext) out.file_ext = '.' + ext;
  } else if (event.file_ext) out.file_ext = event.file_ext;
  for (const key of contentKeys) if (fields.has(key) && event[key] !== undefined) out[key] = event[key];
  return out;
}

const identifierKeys = new Set(['id', 'content_sha256']);
/**
 * Collect values assigned to secret-like keys across every string of the request,
 * then redact every string with them and the Worker's own secrets. Identifiers
 * (note ids and content hashes) are left exact so questions keep pointing at them.
 */
function redactAll<T>(value: T, secrets: readonly string[]): T {
  const assigned = new Set<string>();
  const visit = (item: unknown, key = ''): void => {
    if (typeof item === 'string') { if (!identifierKeys.has(key)) for (const found of assignedValues(item)) assigned.add(found); }
    else if (Array.isArray(item)) item.forEach((entry) => visit(entry));
    else if (item && typeof item === 'object') for (const [name, entry] of Object.entries(item)) visit(entry, name);
  };
  visit(value);
  const map = (item: unknown, key = ''): unknown => typeof item === 'string' ? (identifierKeys.has(key) ? item : redact(item, { secrets, assigned }))
    : Array.isArray(item) ? item.map((entry) => map(entry))
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, map(entry, name)])) : item;
  return map(value) as T;
}

/**
 * Fit the request under max_input_chars deterministically: keep the opening and the
 * closing events around an omission marker (upstream head + tail), down to one
 * event, then drop the oldest-ranked notes and their questions. Whole events and
 * notes are removed, never cut, so no string boundary can expose part of a secret.
 */
export function fitJevRequest(model: string, base: Record<string, unknown>, events: Record<string, unknown>[], notes: JevNote[] | null,
  taskRelated: boolean, maxChars: number): { request: JevRequest; body: string; kept_events: number; kept_notes: number } | null {
  const parts = events.map((event) => JSON.stringify(event)), sizes = [0];
  for (const part of parts) sizes.push(sizes.at(-1)! + part.length);
  const n = parts.length;
  for (let keep = notes?.length ?? 0; keep >= 0; keep--) {
    const kept = notes ? notes.slice(0, keep) : null, questions = jevQuestions(kept ?? [], taskRelated);
    if (!Object.keys(questions).length) return null;
    const state = (list: unknown[]) => ({ ...base, event_count: n, events: list, ...(kept ? { approved_notes: kept } : {}) });
    const shell = JSON.stringify({ model, state: state([]), questions }).length;
    for (let k = n; k >= 1; k--) {
      const head = k === n ? n : Math.floor(k / 2), tail = k - head;
      const marker = k === n ? '' : JSON.stringify({ omitted_events: n - k });
      const elements = k + (marker ? 1 : 0);
      const size = shell + sizes[head] + (sizes[n] - sizes[n - tail]) + marker.length + elements - 1;
      if (size > maxChars) continue;
      const list = k === n ? events : [...events.slice(0, head), { omitted_events: n - k }, ...events.slice(n - tail)];
      const request = { model, state: state(list), questions };
      return { request, body: JSON.stringify(request), kept_events: k, kept_notes: keep };
    }
  }
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const unit = (value: number) => Math.min(1, Math.max(0, value));
const tokens = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : undefined;
/**
 * Accept answers only for questions that were asked, as numbers. Like upstream, the
 * value is noul, else probability, else score; the earlier questions/results array
 * shapes are accepted when answers is absent. Nothing else from the body is kept:
 * no model string, no text, no reasons.
 */
export function parseJevResponse(text: string, asked: readonly string[]): JevParsed | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isObject(data)) return null;
  const answers = new Map<string, JevAnswer>();
  const confidence = (value: unknown) => { const number = finite(value); return number === undefined ? null : unit(number); };
  if (isObject(data.answers)) for (const id of asked) {
    const answer = data.answers[id];
    if (!isObject(answer)) continue;
    const value = finite(answer.noul) ?? finite(answer.probability) ?? finite(answer.score);
    if (value !== undefined) answers.set(id, { probability: unit(value), confidence: confidence(answer.confidence) });
  }
  for (const list of [data.questions, data.results]) {
    if (answers.size || !Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item) || typeof item.id !== 'string' || !asked.includes(item.id) || answers.has(item.id)) continue;
      const value = finite(item.probability);
      if (value !== undefined) answers.set(item.id, { probability: unit(value), confidence: confidence(item.confidence) });
    }
  }
  const usage = isObject(data.usage) ? data.usage : {};
  const cost = finite(usage.cost_usd);
  return { answers, usage: { input_tokens: tokens(usage.input_tokens), output_tokens: tokens(usage.output_tokens),
    cost_usd: cost !== undefined && cost >= 0 ? cost : undefined } };
}

type NoteRow = { id: string; kind: string; title: string; content: string };
/** Up to ten current authoritative notes owned by the scope's project (task notes plus project-wide ones). */
async function currentNotes(env: Env, input: StageInput): Promise<NoteRow[]> {
  return (await env.DB.prepare(`SELECT c.id,c.kind,c.title,c.content FROM context_entries c WHERE c.project_id=? AND c.status='approved'
    AND c.sealed=1 AND (c.task_id IS NULL OR c.task_id=?) AND NOT ${invalidSourceScope} ORDER BY c.created_at DESC,c.id DESC LIMIT ?`)
    .bind(input.scope.project_id, input.scope.task_id, MAX_JEV_NOTES).all<NoteRow>()).results;
}

/**
 * Store-then-decide. Skip only when the policy sets a threshold, new_information was
 * answered below it, and nothing in the source set is high-signal (non-zero exit,
 * denial, policy enforcement, or any contradiction answer ≥ 0.5).
 */
export function jevDecision(input: { policy: { jev_skip_threshold: number | null }; projection: ProjectedEvent[] },
  signals: Pick<StageSignal, 'question_id' | 'probability'>[],
  note?: string): StageResult {
  const fresh = signals.find((signal) => signal.question_id === 'new_information')?.probability;
  const threshold = input.policy.jev_skip_threshold;
  if (threshold !== null && fresh !== undefined && fresh < threshold) {
    const contradiction = signals.some((signal) => signal.question_id.startsWith('contradiction:') && signal.probability >= CONTRADICTION_SIGNAL);
    if (contradiction || input.projection.some(isHighSignal)) return { decision: 'continue', note: 'jev_skip_overridden', signals: [] };
    return { decision: 'skip', skip_reason: 'jev_no_new_information', signals: [] };
  }
  return { decision: 'continue', signals: [], ...(note ? { note } : {}) };
}

const proceed = (note?: string): StageResult => ({ decision: 'continue', signals: [], ...(note ? { note } : {}) });

/**
 * The optional evaluator. Every condition is checked before any data leaves: deploy
 * gate (operator var, effective external_allowed and jev_enabled, key, valid
 * endpoint), something it may ask, no earlier call for this job, a budget, time,
 * an input that fits, and finally an atomic reservation under the held lease.
 * Answers are committed with the call outcome behind the lease fence; a failure
 * never fails the job, because Jev is advisory.
 */
export const jevStage: SelectionStage = async (input) => {
  const { env, ctx, policy, scope } = input;
  const gate = externalGate(env, scope.project_id, policy), config = jevConfig(env);
  if (!gate.eligible || !config.endpoint || !config.model || !env.JEV_API_KEY) return proceed();
  const fields = new Set(policy.external_fields);
  const notesAllowed = fields.has('approved_note_text'), titles = fields.has('titles');
  const taskTitle = titles && scope.scope_type === 'task' && input.labels.task_title ? input.labels.task_title : null;
  // Without note text or a task title there is nothing Jev could answer: no call at all.
  if (!notesAllowed && !taskTitle) return proceed();
  // One evaluation per job: never re-send after an uncertain or failed call.
  const prior = (await env.DB.prepare(`SELECT status FROM processing_calls WHERE job_id=? AND provider='jev'`).bind(input.job_id)
    .all<{ status: string }>()).results;
  if (prior.some((call) => call.status === 'succeeded')) {
    const stored = (await env.DB.prepare('SELECT question_id,probability FROM processing_signals WHERE job_id=?').bind(input.job_id)
      .all<{ question_id: string; probability: number }>()).results;
    return jevDecision(input, stored);
  }
  if (prior.length) return proceed(prior.some((call) => call.status === 'failed') ? 'jev_previous_failed' : 'jev_previous_outcome_unknown');
  const budget = await readBudget(env);
  if (!budget || !budget.daily_call_limit || !budget.daily_token_limit) return proceed('jev_budget:budget_disabled');
  const timeoutMs = Math.min(budget.timeout_ms, ctx.remaining() - 2_000);
  if (timeoutMs < 1_000) return proceed('jev_no_time');

  const secrets = workerSecrets(env);
  const rows = notesAllowed ? await currentNotes(env, input) : [];
  const notes: JevNote[] | null = notesAllowed ? await Promise.all(rows.map(async (row) => ({ id: row.id, kind: row.kind,
    ...(titles ? { title: cleanLine(row.title, { secrets }, 160) } : {}), content: cleanText(row.content, { secrets }, MAX_JEV_NOTE_CHARS),
    content_sha256: await digest(row.content) }))) : null;
  const base = { rubric_version: JEV_RUBRIC_VERSION, scope: { type: scope.scope_type,
    ...(taskTitle ? { task_title: cleanLine(taskTitle, { secrets }, 160) } : {}),
    ...(titles && input.labels.project_name ? { project_name: cleanLine(input.labels.project_name, { secrets }, 160) } : {}) } };
  const events = input.projection.map((event, index) => externalEvent(event, fields, index + 1));
  // Redact the whole request before fitting; the fit removes whole events and notes only.
  const clean = redactAll({ base, events, notes }, secrets);
  const fit = fitJevRequest(config.model, clean.base, clean.events, clean.notes, !!taskTitle, budget.max_input_chars);
  if (!fit) return proceed(Object.keys(jevQuestions(notes ?? [], !!taskTitle)).length ? 'jev_input_too_large' : undefined);

  const reservation = await reserveCall(env, { job_id: input.job_id, provider: 'jev', model: config.model, attempt: input.attempt,
    lease_owner: input.lease_owner, input_chars: fit.body.length, day: utcDay(ctx.now), now: ctx.now.toISOString() });
  if (!reservation.reserved) return proceed('jev_budget:' + reservation.code);
  const asked = Object.keys(fit.request.questions);
  const result = await externalFetch(ctx.fetch, config.endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + env.JEV_API_KEY }, body: fit.body },
    { timeoutMs, maxBytes: MAX_JEV_RESPONSE_BYTES });
  const finished = ctx.now.toISOString();
  let outcome: CallOutcome, signals: StageSignal[] = [], note: string | undefined;
  if (!result.ok) {
    outcome = { status: result.outcome, error_code: result.code, finished_at: finished };
    note = result.outcome === 'outcome_unknown' ? 'jev_outcome_unknown' : 'jev_failed';
  } else {
    const parsed = parseJevResponse(result.text, asked);
    const usage = parsed?.usage ?? {};
    const reported = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, reported_cost_usd: usage.cost_usd };
    if (!parsed || !parsed.answers.size) {
      outcome = { status: 'failed', error_code: 'invalid_response', finished_at: finished, ...reported };
      note = 'jev_failed';
    } else {
      outcome = { status: 'succeeded', finished_at: finished, ...reported };
      const evaluator = ('jev:' + new URL(config.endpoint).host).slice(0, 64);
      signals = [...parsed.answers].sort(([a], [b]) => a.localeCompare(b)).map(([question_id, answer]) =>
        ({ question_id, probability: answer.probability, confidence: answer.confidence, evaluator, model: config.model }));
    }
  }
  // The outcome, its answers and the flags they raise commit together, only while this
  // lease still holds; otherwise the reservation stays and the sweep records it as outcome_unknown.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO processing_job_fence(job_id,lease_owner,attempts) VALUES(?,?,?)').bind(input.job_id, input.lease_owner, input.attempt),
    finishCallStatement(env, reservation.call.id, outcome),
    ...signals.map((signal) => env.DB.prepare(`INSERT INTO processing_signals(job_id,question_id,probability,confidence,evaluator,model,
      calibrated,created_at) VALUES(?,?,?,?,?,?,0,?) ON CONFLICT DO NOTHING`).bind(input.job_id, signal.question_id, signal.probability,
      signal.confidence, signal.evaluator, signal.model, finished)),
    ...contradictionFlagStatements(env.DB, { job_id: input.job_id, signals, evidence: input.evidence ?? [], now: finished }),
  ]);
  return signals.length ? jevDecision(input, signals) : proceed(note);
};

/** The default selection stage: deterministic rules first, then the optional evaluator. */
export const defaultStage: SelectionStage = async (input) => {
  const rules = await ruleFilter(input);
  return rules.decision === 'skip' ? rules : jevStage(input);
};
