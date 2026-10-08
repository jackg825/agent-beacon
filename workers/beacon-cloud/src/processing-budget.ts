// Typed seam for part B: call budget reservation and the processing_calls ledger.
// The schema exists in 0004; until part B implements these, every reservation is
// refused, so no external call can happen whatever the policy says.
import type { Env } from './types';

export type CallProvider = 'jev' | 'generator';
export interface CallRequest {
  job_id: string; provider: CallProvider; model: string | null; attempt: number;
  /** Characters actually sent, after redaction and the deterministic head+tail cut. */
  input_chars: number; day: string; now: string;
}
export interface CallReservation { id: string; estimated_tokens: number }
export type ReserveResult =
  | { reserved: true; call: CallReservation }
  | { reserved: false; code: 'not_implemented' | 'budget_disabled' | 'daily_call_limit' | 'daily_token_limit' | 'usd_ceiling' };
export interface CallOutcome {
  status: 'succeeded' | 'failed' | 'outcome_unknown';
  input_tokens?: number; output_tokens?: number;
  /** Provider-reported cost only; never derived from price tables. */
  reported_cost_usd?: number; error_code?: string; finished_at: string;
}

/** Part B: one INSERT…SELECT that checks the daily call, token and USD limits atomically. */
export async function reserveCall(_env: Env, _request: CallRequest): Promise<ReserveResult> {
  return { reserved: false, code: 'not_implemented' };
}
/** Part B: move a reserved row to its final state; an uncertain outcome stays outcome_unknown. */
export async function finishCall(_env: Env, _id: string, _outcome: CallOutcome): Promise<boolean> {
  return false;
}
/** Part B: mark reservations older than timeout + 60 s as outcome_unknown (counted as spent). */
export async function sweepStaleReservations(_env: Env, _now: Date): Promise<number> {
  return 0;
}
