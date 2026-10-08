// Budget and ledger for external calls. A call happens only after one atomic
// INSERT…SELECT reserved it against the daily call, token and USD limits while the
// job lease was still held. Every reservation counts whatever its outcome; an
// uncertain outcome stays outcome_unknown and is never reported as success.
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';

export type CallProvider = 'jev' | 'generator';
export interface CallRequest {
  job_id: string; provider: CallProvider; model: string | null; attempt: number;
  /** The reservation commits only while this owner still holds the job lease for `attempt`. */
  lease_owner: string;
  /** Characters actually sent, after redaction and the deterministic head+tail cut. */
  input_chars: number; day: string; now: string;
}
export interface CallReservation { id: string; estimated_tokens: number }
export type RefusalCode = 'budget_disabled' | 'daily_call_limit' | 'daily_token_limit' | 'usd_ceiling' | 'input_too_large'
  | 'duplicate' | 'lease_lost';
export type ReserveResult = { reserved: true; call: CallReservation } | { reserved: false; code: RefusalCode };
export interface CallOutcome {
  status: 'succeeded' | 'failed' | 'outcome_unknown';
  input_tokens?: number; output_tokens?: number;
  /** Provider-reported cost only; never derived from price tables. */
  reported_cost_usd?: number; error_code?: string; finished_at: string;
}

export interface BudgetValues {
  daily_call_limit: number; daily_token_limit: number;
  /** Null means no USD ceiling; it can only bind on cost the provider reports. */
  daily_usd_ceiling: number | null;
  max_input_chars: number; max_output_tokens: number; timeout_ms: number;
}
export interface BudgetRow extends BudgetValues { version: number; updated_at: string; updated_by: string }
/** An absent budget row means these: every limit zero, so no external call can be reserved. */
export const DEFAULT_BUDGET: BudgetValues = Object.freeze({ daily_call_limit: 0, daily_token_limit: 0, daily_usd_ceiling: null,
  max_input_chars: 20_000, max_output_tokens: 512, timeout_ms: 15_000 }) as BudgetValues;
export const BUDGET_BOUNDS = { daily_call_limit: [0, 10_000], daily_token_limit: [0, 100_000_000], max_input_chars: [1000, 200_000],
  max_output_tokens: [1, 8192], timeout_ms: [1000, 30_000] } as const;
export const MAX_USD_CEILING = 10_000;
/** The largest timeout a budget allows; a reservation older than this plus 60 s is stale. */
export const MAX_CALL_TIMEOUT_MS = BUDGET_BOUNDS.timeout_ms[1];
export const STALE_GRACE_MS = 60_000;

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);
/** Tokens a reservation holds until the provider reports real usage. */
export const estimateTokens = (inputChars: number, maxOutputTokens: number) => Math.ceil(inputChars / 3) + maxOutputTokens;

export async function readBudget(env: Env): Promise<BudgetRow | null> {
  return env.DB.prepare(`SELECT daily_call_limit,daily_token_limit,daily_usd_ceiling,max_input_chars,max_output_tokens,timeout_ms,
    version,updated_at,updated_by FROM processing_budget WHERE id=1`).first<BudgetRow>();
}

const spentTokens = 'COALESCE(SUM(COALESCE(input_tokens+output_tokens,estimated_tokens)),0)';
/**
 * Reserve one call. A single statement checks, against the current budget row, that
 * the job lease is still held, the input fits, and today's calls, counted tokens
 * (reported, else estimated) and reported USD stay within their limits; D1 runs it
 * atomically, so concurrent reservations can never overshoot a limit together.
 */
export async function reserveCall(env: Env, request: CallRequest): Promise<ReserveResult> {
  const id = crypto.randomUUID(), chars = request.input_chars;
  // ceil(input_chars/3)+max_output_tokens, in integer arithmetic whatever type the binding carries.
  const estimate = '(CAST(? AS INTEGER)+2)/3+b.max_output_tokens';
  const row = await env.DB.prepare(`INSERT INTO processing_calls(id,job_id,provider,model,attempt,status,day,input_chars,estimated_tokens,started_at)
    SELECT ?,?,?,?,?,'reserved',?,?,${estimate},? FROM processing_budget b
    WHERE b.id=1 AND ?<=b.max_input_chars
      AND EXISTS(SELECT 1 FROM processing_jobs j WHERE j.id=? AND j.status='running' AND j.lease_owner=? AND j.attempts=?)
      AND (SELECT COUNT(*) FROM processing_calls WHERE day=?)<b.daily_call_limit
      AND (SELECT ${spentTokens} FROM processing_calls WHERE day=?)+${estimate}<=b.daily_token_limit
      AND (b.daily_usd_ceiling IS NULL OR (SELECT COALESCE(SUM(reported_cost_usd),0) FROM processing_calls WHERE day=?)<b.daily_usd_ceiling)
    ON CONFLICT DO NOTHING RETURNING id,estimated_tokens`)
    .bind(id, request.job_id, request.provider, request.model, request.attempt, request.day, chars, chars, request.now,
      chars, request.job_id, request.lease_owner, request.attempt, request.day, request.day, chars, request.day)
    .first<CallReservation>();
  if (row) return { reserved: true, call: row };
  return { reserved: false, code: await refusal(env, request) };
}

/** Best-effort reason for a refused reservation; the refusal itself was atomic. */
async function refusal(env: Env, request: CallRequest): Promise<RefusalCode> {
  const state = await env.DB.prepare(`SELECT b.daily_call_limit,b.daily_token_limit,b.daily_usd_ceiling,b.max_input_chars,b.max_output_tokens,
    (SELECT COUNT(*) FROM processing_calls WHERE day=?) AS calls,(SELECT ${spentTokens} FROM processing_calls WHERE day=?) AS tokens,
    (SELECT COALESCE(SUM(reported_cost_usd),0) FROM processing_calls WHERE day=?) AS cost,
    EXISTS(SELECT 1 FROM processing_calls WHERE job_id=? AND provider=? AND attempt=?) AS duplicate,
    EXISTS(SELECT 1 FROM processing_jobs WHERE id=? AND status='running' AND lease_owner=? AND attempts=?) AS leased
    FROM (SELECT 1) LEFT JOIN processing_budget b ON b.id=1`)
    .bind(request.day, request.day, request.day, request.job_id, request.provider, request.attempt, request.job_id, request.lease_owner,
      request.attempt).first<BudgetValues & { calls: number; tokens: number; cost: number; duplicate: number; leased: number }>();
  if (!state || state.daily_call_limit === null || state.daily_call_limit === 0 || state.daily_token_limit === 0) return 'budget_disabled';
  if (state.duplicate) return 'duplicate';
  if (!state.leased) return 'lease_lost';
  if (request.input_chars > state.max_input_chars) return 'input_too_large';
  if (state.calls >= state.daily_call_limit) return 'daily_call_limit';
  if (state.tokens + estimateTokens(request.input_chars, state.max_output_tokens) > state.daily_token_limit) return 'daily_token_limit';
  return 'usd_ceiling';
}

const count = (value: number | undefined, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
/** Move a reserved call to its final state; any other current state is left alone. */
export function finishCallStatement(env: Env, id: string, outcome: CallOutcome): D1PreparedStatement {
  const cost = outcome.reported_cost_usd;
  const code = outcome.error_code && /^[a-z0-9_.:-]{1,64}$/.test(outcome.error_code) ? outcome.error_code : outcome.error_code ? 'call_failed' : null;
  return env.DB.prepare(`UPDATE processing_calls SET status=?,input_tokens=?,output_tokens=?,reported_cost_usd=?,error_code=?,finished_at=?
    WHERE id=? AND status='reserved'`).bind(outcome.status, count(outcome.input_tokens, 1e9), count(outcome.output_tokens, 1e9),
    typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= MAX_USD_CEILING ? cost : null, code, outcome.finished_at, id);
}
export async function finishCall(env: Env, id: string, outcome: CallOutcome): Promise<boolean> {
  return (await finishCallStatement(env, id, outcome).run()).meta.changes > 0;
}

/**
 * A reservation whose caller died never resolves by itself. Once it is older than the
 * largest call timeout plus 60 s and its job attempt no longer holds a live lease, it
 * becomes outcome_unknown: still counted as spent, and never re-sent for that job.
 */
export async function sweepStaleReservations(env: Env, now: Date): Promise<number> {
  const time = now.toISOString(), cutoff = new Date(now.getTime() - MAX_CALL_TIMEOUT_MS - STALE_GRACE_MS).toISOString();
  return (await env.DB.prepare(`UPDATE processing_calls SET status='outcome_unknown',error_code='stale_reservation',finished_at=?
    WHERE status='reserved' AND started_at<? AND NOT EXISTS(SELECT 1 FROM processing_jobs j WHERE j.id=processing_calls.job_id
      AND j.status='running' AND j.attempts=processing_calls.attempt AND j.lease_until>=?)`).bind(time, cutoff, time).run()).meta.changes;
}

const budgetKeys = ['daily_call_limit', 'daily_token_limit', 'daily_usd_ceiling', 'max_input_chars', 'max_output_tokens', 'timeout_ms'];
function bounded(value: unknown, label: keyof typeof BUDGET_BOUNDS): number {
  const [min, max] = BUDGET_BOUNDS[label];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new HttpError(400, `${label} must be an integer ${min}–${max}`);
  return value;
}
/** Full replacement; every field is required. Zero calls or tokens disables external calls. */
export function parseBudget(value: unknown): BudgetValues {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !budgetKeys.includes(key))
    || budgetKeys.some((key) => !Object.hasOwn(value, key)))
    throw new HttpError(400, 'Budget must contain exactly the budget fields');
  const input = value as Record<string, unknown>, ceiling = input.daily_usd_ceiling;
  if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0 || ceiling > MAX_USD_CEILING))
    throw new HttpError(400, `daily_usd_ceiling must be null or 0–${MAX_USD_CEILING}`);
  return { daily_call_limit: bounded(input.daily_call_limit, 'daily_call_limit'), daily_token_limit: bounded(input.daily_token_limit, 'daily_token_limit'),
    daily_usd_ceiling: ceiling as number | null, max_input_chars: bounded(input.max_input_chars, 'max_input_chars'),
    max_output_tokens: bounded(input.max_output_tokens, 'max_output_tokens'), timeout_ms: bounded(input.timeout_ms, 'timeout_ms') };
}

export async function writeBudget(request: Request, env: Env, actor: string): Promise<Response> {
  const input = parseBudget(await readJson(request)), time = new Date().toISOString();
  // Upsert and its audit commit together; the audit captures exactly the stored row.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO processing_budget(id,daily_call_limit,daily_token_limit,daily_usd_ceiling,max_input_chars,max_output_tokens,
      timeout_ms,version,updated_at,updated_by) VALUES(1,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET
      daily_call_limit=excluded.daily_call_limit,daily_token_limit=excluded.daily_token_limit,daily_usd_ceiling=excluded.daily_usd_ceiling,
      max_input_chars=excluded.max_input_chars,max_output_tokens=excluded.max_output_tokens,timeout_ms=excluded.timeout_ms,
      version=processing_budget.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(input.daily_call_limit, input.daily_token_limit, input.daily_usd_ceiling, input.max_input_chars, input.max_output_tokens,
        input.timeout_ms, time, actor),
    env.DB.prepare(`INSERT INTO processing_budget_audit(id,version,budget,actor,created_at) SELECT ?,version,json_object(
      'daily_call_limit',daily_call_limit,'daily_token_limit',daily_token_limit,'daily_usd_ceiling',daily_usd_ceiling,
      'max_input_chars',max_input_chars,'max_output_tokens',max_output_tokens,'timeout_ms',timeout_ms),?,? FROM processing_budget WHERE id=1`)
      .bind(crypto.randomUUID(), actor, time),
  ]);
  return json(await usageView(env, utcDay(new Date())));
}

/** One UTC day of the ledger: counts, tokens, reported cost and the latest calls. Identifiers and codes only. */
export async function usageView(env: Env, day: string) {
  const [budget, totals, providers, calls, audit] = await env.DB.batch([
    env.DB.prepare(`SELECT daily_call_limit,daily_token_limit,daily_usd_ceiling,max_input_chars,max_output_tokens,timeout_ms,
      version,updated_at,updated_by FROM processing_budget WHERE id=1`),
    env.DB.prepare(`SELECT COUNT(*) AS calls,COALESCE(SUM(status='reserved'),0) AS reserved,COALESCE(SUM(status='succeeded'),0) AS succeeded,
      COALESCE(SUM(status='failed'),0) AS failed,COALESCE(SUM(status='outcome_unknown'),0) AS outcome_unknown,
      ${spentTokens} AS counted_tokens,COALESCE(SUM(input_tokens),0) AS reported_input_tokens,
      COALESCE(SUM(output_tokens),0) AS reported_output_tokens,COALESCE(SUM(reported_cost_usd),0) AS reported_cost_usd,
      COUNT(reported_cost_usd) AS cost_reports FROM processing_calls WHERE day=?`).bind(day),
    env.DB.prepare(`SELECT provider,COUNT(*) AS calls,${spentTokens} AS counted_tokens FROM processing_calls WHERE day=?
      GROUP BY provider ORDER BY provider`).bind(day),
    env.DB.prepare(`SELECT id,job_id,provider,model,attempt,status,input_chars,estimated_tokens,input_tokens,output_tokens,reported_cost_usd,
      error_code,started_at,finished_at FROM processing_calls WHERE day=? ORDER BY started_at DESC,id DESC LIMIT 20`).bind(day),
    env.DB.prepare('SELECT id,version,actor,created_at FROM processing_budget_audit ORDER BY version DESC LIMIT 10'),
  ]);
  const row = budget.results[0] as BudgetRow | undefined;
  const limits: BudgetValues = row ?? DEFAULT_BUDGET;
  const used = totals.results[0] as { calls: number; counted_tokens: number; reported_cost_usd: number; cost_reports: number } & Record<string, number>;
  // allows_calls reflects only these limits; the deploy gate and policy are reported by the policy view.
  return { day, budget: { ...limits, configured: !!row, version: row?.version ?? null, updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null, allows_calls: limits.daily_call_limit > 0 && limits.daily_token_limit > 0 },
    usage: { ...used, reported_cost_usd: used.cost_reports ? used.reported_cost_usd : null },
    remaining: { calls: Math.max(0, limits.daily_call_limit - used.calls), tokens: Math.max(0, limits.daily_token_limit - used.counted_tokens),
      usd: limits.daily_usd_ceiling === null ? null : Math.max(0, limits.daily_usd_ceiling - used.reported_cost_usd) },
    // Cost is what providers reported, never derived from price tables. Reserved and
    // outcome_unknown calls count as spent: local idempotency is not a billing guarantee.
    cost_basis: 'provider_reported', providers: providers.results, calls: calls.results, audit: audit.results };
}

export async function readUsage(env: Env, params: URLSearchParams) {
  for (const key of params.keys()) if (key !== 'day' || params.getAll(key).length !== 1) throw new HttpError(400, 'Invalid usage filter');
  const day = params.get('day') ?? utcDay(new Date());
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z')) || utcDay(new Date(day + 'T00:00:00Z')) !== day)
    throw new HttpError(400, 'day must be a UTC date YYYY-MM-DD');
  return usageView(env, day);
}
