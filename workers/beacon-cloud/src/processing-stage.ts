import type { MaintenanceContext } from './maintenance';
import type { ProjectedEvent } from './privacy';
import type { EffectivePolicy } from './processing-policy';
import type { Env } from './types';

/** The scope a job summarizes, as re-validated at run time. */
export interface JobScope {
  scope_type: 'task' | 'project'; scope_id: string; project_id: string; task_id: string | null; scope_key: string;
}
/** One evaluator answer; stored in processing_signals and always shown as uncalibrated. */
export interface StageSignal {
  question_id: string; probability: number; confidence: number | null; evaluator: string; model: string | null;
}
export interface StageInput {
  env: Env; ctx: MaintenanceContext; job_id: string; attempt: number; scope: JobScope; policy: EffectivePolicy;
  /** Redacted projection under the policy's summary_fields; an external stage must narrow it to external_fields. */
  projection: ProjectedEvent[];
}
export interface StageResult {
  decision: 'continue' | 'skip';
  /** Short code; required when skipping. */
  skip_reason?: string;
  /** Short code recorded on the job, e.g. jev_skip_overridden. */
  note?: string;
  signals: StageSignal[];
}
/**
 * The seam between source selection and generation. Part A runs only the
 * deterministic rule filter. Part B's optional Jev stage receives the same input,
 * must pass the deploy gate, policy and budget reservation itself, and may only add
 * signals or skip under the policy threshold; it can never approve, edit or delete.
 */
export type SelectionStage = (input: StageInput) => Promise<StageResult>;

/** Actions that by themselves never justify a summary. */
const lowSignal = new Set(['session.started', 'session.ended', 'session.created', 'session.deleted', 'session.idle',
  'session.status', 'session.activity', 'session.heartbeat', 'session.compacting', 'session.compacted']);
export function isLowSignal(action: string): boolean {
  return lowSignal.has(action) || action.startsWith('inventory.') || action.includes('heartbeat');
}
/** Events a skip decision must never hide: failures, denials and policy enforcement. */
export function isHighSignal(event: ProjectedEvent): boolean {
  return (event.exit_code !== undefined && event.exit_code !== 0) || event.action === 'tool.failed' || event.action === 'session.error'
    || ['deny', 'denied', 'reject', 'rejected', 'block', 'blocked'].includes(event.approval_decision ?? '')
    || event.action === 'approval.denied' || event.policy_enforcement === 'enforce';
}

/**
 * Deterministic default: skip only when every selected event is low-signal. Identical
 * source sets cannot reach this stage, because coverage and job identity already
 * exclude them.
 */
export const ruleFilter: SelectionStage = async ({ projection }) =>
  projection.length && projection.every((event) => isLowSignal(event.action))
    ? { decision: 'skip', skip_reason: 'low_signal_only', signals: [] }
    : { decision: 'continue', signals: [] };
