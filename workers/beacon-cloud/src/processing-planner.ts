import { digest } from './auth';
import { extractiveGenerator } from './generator';
import { stableJSON } from './identity';
import { EffectivePolicy, effectivePolicy, policyRow, resolvePolicy } from './processing-policy';
import type { JobScope } from './processing-stage';
import { Env, HttpError } from './types';

/** Processor identity in every job id; a new generator version re-plans every scope. */
export const PROCESSOR_VERSION = extractiveGenerator.processorVersion;
export const PLANNER_ACTOR = 'pipeline:planner';
export const MAX_ATTEMPTS = 4;
/** Batches are timestamped before their D1 commit; wait this long beyond quiet_minutes. */
export const SETTLE_MS = 2 * 60_000;
export const SCOPES_PER_TICK = 5;

export async function scopeKey(scopeType: 'task' | 'project', scopeId: string, projectId: string): Promise<string> {
  return digest(stableJSON([scopeType, scopeId, projectId]));
}
export async function makeScope(scopeType: 'task' | 'project', scopeId: string, projectId: string): Promise<JobScope> {
  return { scope_type: scopeType, scope_id: scopeId, project_id: projectId, task_id: scopeType === 'task' ? scopeId : null,
    scope_key: await scopeKey(scopeType, scopeId, projectId) };
}

/**
 * Uncovered runtime events of one scope. A task scope is the task's linked sessions
 * within one project; a project scope is the project's sessions that no open task
 * links. Coverage, not timestamps, decides what is pending, so backfilled events and
 * sessions linked later are still selected.
 */
function pendingEvents(scope: JobScope): { from: string; args: unknown[] } {
  const uncovered = 'NOT EXISTS(SELECT 1 FROM processing_coverage c WHERE c.scope_key=? AND c.event_id=e.id)';
  return scope.scope_type === 'task'
    ? { from: `FROM task_sessions ts JOIN events e ON e.session_id=ts.session_id JOIN batches b ON b.id=e.batch_id
        WHERE ts.task_id=? AND e.project_id=? AND e.stream='runtime' AND ${uncovered}`, args: [scope.task_id, scope.project_id, scope.scope_key] }
    : { from: `FROM events e JOIN batches b ON b.id=e.batch_id WHERE e.project_id=? AND e.stream='runtime'
        AND NOT EXISTS(SELECT 1 FROM task_sessions ts JOIN tasks t ON t.id=ts.task_id WHERE ts.session_id=e.session_id AND t.status='open')
        AND ${uncovered}`, args: [scope.project_id, scope.scope_key] };
}

export type PlanStatus = 'planned' | 'requeued' | 'exists' | 'live_job' | 'pending_candidate' | 'not_due' | 'empty' | 'disabled';
export interface PlanResult { status: PlanStatus; scope_type: string; scope_id: string; project_id: string; job_id?: string;
  context_id?: string; source_count?: number; pending_events?: number }

/**
 * Plan at most one job for a scope. D1 only (no raw reads): the exact sources are
 * the oldest uncovered events, the job id is derived from them and the current
 * effective policy, and a scope with a live/failed job or an unreviewed pipeline
 * candidate is left alone. `force` (reviewer run) skips only the timing rules.
 */
export async function planScope(env: Env, scope: JobScope, policy: EffectivePolicy, now: Date,
  options: { force?: boolean; actor?: string } = {}): Promise<PlanResult> {
  const base = { scope_type: scope.scope_type, scope_id: scope.scope_id, project_id: scope.project_id };
  if (!policy.enabled) return { ...base, status: 'disabled' };
  const blocked = await env.DB.prepare(`SELECT
    (SELECT id FROM processing_jobs WHERE scope_key=? AND status IN ('queued','running','failed') LIMIT 1) AS live,
    (SELECT g.context_id FROM context_generation g JOIN context_entries c ON c.id=g.context_id
      WHERE g.scope_key=? AND c.status='pending' LIMIT 1) AS pending`).bind(scope.scope_key, scope.scope_key)
    .first<{ live: string | null; pending: string | null }>();
  if (blocked?.live) return { ...base, status: 'live_job', job_id: blocked.live };
  if (blocked?.pending) return { ...base, status: 'pending_candidate', context_id: blocked.pending };
  const query = pendingEvents(scope);
  const rows = (await env.DB.prepare(`SELECT e.id AS event_id,e.payload_hash,COUNT(*) OVER () AS pending,
    MAX(b.received_at) OVER () AS newest ${query.from} ORDER BY e.timestamp,e.id LIMIT ?`)
    .bind(...query.args, policy.max_events_per_job).all<{ event_id: string; payload_hash: string; pending: number; newest: string }>()).results;
  if (!rows.length) return { ...base, status: 'empty', pending_events: 0 };
  const pending = rows[0].pending;
  if (!options.force && (pending < policy.min_new_events
    || Date.parse(rows[0].newest) > now.getTime() - policy.quiet_minutes * 60_000 - SETTLE_MS))
    return { ...base, status: 'not_due', pending_events: pending };
  const sources = rows.map(({ event_id, payload_hash }) => ({ event_id, payload_hash }));
  const sourceSetHash = await digest(stableJSON(sources.map((source) => `${source.event_id}:${source.payload_hash}`).sort()));
  const id = await digest(stableJSON(['summarize', scope.scope_key, sourceSetHash, policy.policy_hash, PROCESSOR_VERSION]));
  const time = now.toISOString(), actor = options.actor ?? PLANNER_ACTOR;
  const audit = () => env.DB.prepare(`INSERT INTO processing_job_audit(id,job_id,actor,action,created_at)
    SELECT ?,?,?,'run',? WHERE changes()>0`).bind(crypto.randomUUID(), id, actor, time);
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      // The same inputs abandoned before any work (policy or scope moved) run again.
      env.DB.prepare(`UPDATE processing_jobs SET status='queued',attempts=0,next_attempt_at=?,skip_reason=NULL,last_error=NULL,
        note=NULL,planned_by=?,updated_at=? WHERE id=? AND status='skipped' AND skip_reason IN ('policy_changed','scope_changed')`)
        .bind(time, actor, time, id),
      ...(options.actor ? [audit()] : []),
      env.DB.prepare(`INSERT INTO processing_jobs(id,kind,scope_type,scope_id,project_id,task_id,scope_key,source_set_hash,policy_hash,
        processor_version,status,attempts,max_attempts,next_attempt_at,source_count,planned_by,created_at,updated_at)
        VALUES(?,'summarize',?,?,?,?,?,?,?,?,'queued',0,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(id, scope.scope_type, scope.scope_id, scope.project_id, scope.task_id, scope.scope_key, sourceSetHash, policy.policy_hash,
          PROCESSOR_VERSION, MAX_ATTEMPTS, time, sources.length, actor, time, time),
      ...(options.actor ? [audit()] : []),
      env.DB.prepare(`INSERT INTO processing_job_sources(job_id,event_id,payload_hash,ordinal)
        SELECT ?,json_extract(value,'$.event_id'),json_extract(value,'$.payload_hash'),key FROM json_each(?)
        WHERE EXISTS(SELECT 1 FROM processing_jobs WHERE id=?) ON CONFLICT DO NOTHING`).bind(id, JSON.stringify(sources), id),
    ]);
  } catch (error) {
    // A concurrent planner made another job live for this scope first.
    if (/UNIQUE constraint failed/.test(String(error))) return { ...base, status: 'live_job' };
    throw error;
  }
  const requeued = results[0].meta.changes > 0, inserted = results[options.actor ? 2 : 1].meta.changes > 0;
  if (!requeued && !inserted && !await env.DB.prepare('SELECT id FROM processing_jobs WHERE id=?').bind(id).first())
    return { ...base, status: 'live_job' };
  // Identical inputs that already finished are never processed again.
  return { ...base, status: inserted ? 'planned' : requeued ? 'requeued' : 'exists', job_id: id, source_count: sources.length,
    pending_events: pending };
}

type ScopeRow = { scan_key: string; scope_type: 'task' | 'project'; scope_id: string; project_id: string };
/** Enabled scopes in stable key order: 'p:<project>' and 't:<task>:<project>'. */
async function enabledScopes(env: Env, after: string, upTo: string, limit: number): Promise<ScopeRow[]> {
  return (await env.DB.prepare(`WITH enabled AS (SELECT p.id FROM projects p LEFT JOIN processing_policies pp
      ON pp.scope_type='project' AND pp.scope_id=p.id WHERE COALESCE(pp.enabled,1)=1),
    scopes AS (SELECT 'p:'||id AS scan_key,'project' AS scope_type,id AS scope_id,id AS project_id FROM enabled
      UNION SELECT 't:'||t.id||':'||s.project_id,'task',t.id,s.project_id FROM tasks t JOIN task_sessions ts ON ts.task_id=t.id
      JOIN sessions s ON s.id=ts.session_id JOIN enabled en ON en.id=s.project_id WHERE t.status='open')
    SELECT * FROM scopes WHERE scan_key>? AND scan_key<=? ORDER BY scan_key LIMIT ?`).bind(after, upTo, limit).all<ScopeRow>()).results;
}

export interface PlanTickResult { workspace_enabled: boolean; scanned: number; cursor_conflict?: boolean;
  outcomes: Partial<Record<PlanStatus, number>>; planned: string[] }
/**
 * One planning pass: nothing at all unless the workspace policy is enabled, then at
 * most `limit` enabled scopes from a rotating cursor advanced by compare-and-swap.
 */
export async function planTick(env: Env, now: Date, limit = SCOPES_PER_TICK): Promise<PlanTickResult> {
  const result: PlanTickResult = { workspace_enabled: false, scanned: 0, outcomes: {}, planned: [] };
  const workspace = await env.DB.prepare(`SELECT * FROM processing_policies WHERE scope_type='workspace' AND scope_id='*'`)
    .first<Parameters<typeof policyRow>[0]>();
  if (!workspace?.enabled) return result;
  result.workspace_enabled = true;
  const cursor = (await env.DB.prepare('SELECT scan_key FROM processing_scan_cursor WHERE id=1').first<{ scan_key: string }>())?.scan_key ?? '';
  let scopes = await enabledScopes(env, cursor, '\uffff', limit);
  if (scopes.length < limit && cursor) scopes = scopes.concat(await enabledScopes(env, '', cursor, limit - scopes.length));
  if (!scopes.length) return result;
  // Claim this range first; an overlapping invocation that lost the swap plans nothing.
  const swap = await env.DB.prepare('UPDATE processing_scan_cursor SET scan_key=?,updated_at=? WHERE id=1 AND scan_key=?')
    .bind(scopes.at(-1)!.scan_key, now.toISOString(), cursor).run();
  if (!swap.meta.changes) return { ...result, cursor_conflict: true };
  const projects = [...new Set(scopes.map((scope) => scope.project_id))];
  const rows = (await env.DB.prepare(`SELECT * FROM processing_policies WHERE scope_type='project'
    AND scope_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(projects)).all<Parameters<typeof policyRow>[0]>()).results;
  const policies = new Map<string, EffectivePolicy>();
  for (const project of projects) {
    const row = rows.find((item) => item.scope_id === project);
    policies.set(project, await resolvePolicy(policyRow(workspace), row ? policyRow(row) : null));
  }
  for (const row of scopes) {
    const outcome = await planScope(env, await makeScope(row.scope_type, row.scope_id, row.project_id), policies.get(row.project_id)!, now);
    result.scanned++;
    result.outcomes[outcome.status] = (result.outcomes[outcome.status] ?? 0) + 1;
    if ((outcome.status === 'planned' || outcome.status === 'requeued') && outcome.job_id) result.planned.push(outcome.job_id);
  }
  return result;
}

/**
 * Reviewer "run now" for one task or project: plans immediately (ignoring only
 * min_new_events and quiet_minutes) and returns job ids; execution still happens in
 * the scheduled task. A disabled scope is refused with 409, never forced.
 */
export async function planRequest(env: Env, input: { task_id?: string; project_id?: string }, actor: string, now: Date) {
  if (input.project_id) {
    if (!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(input.project_id).first()) throw new HttpError(404, 'Project not found');
    const policy = await effectivePolicy(env, input.project_id);
    if (!policy.enabled) throw new HttpError(409, 'Background processing is disabled for this project');
    return { scopes: [await planScope(env, await makeScope('project', input.project_id, input.project_id), policy, now, { force: true, actor })] };
  }
  const task = await env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind(input.task_id).first<{ status: string }>();
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status !== 'open') throw new HttpError(409, 'Only open tasks are processed');
  const projects = (await env.DB.prepare(`SELECT DISTINCT s.project_id FROM task_sessions ts JOIN sessions s ON s.id=ts.session_id
    WHERE ts.task_id=? ORDER BY s.project_id LIMIT 100`).bind(input.task_id).all<{ project_id: string }>()).results;
  const policies = await Promise.all(projects.map(({ project_id }) => effectivePolicy(env, project_id)));
  if (!policies.some((policy) => policy.enabled)) throw new HttpError(409, 'Background processing is disabled for this task scope');
  const scopes: PlanResult[] = [];
  for (const [index, { project_id }] of projects.entries()) {
    scopes.push(await planScope(env, await makeScope('task', input.task_id!, project_id), policies[index], now, { force: true, actor }));
  }
  return { scopes };
}
