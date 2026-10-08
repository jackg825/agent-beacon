import { pageLimit } from './queries';
import { planRequest } from './processing-planner';
import { projectPattern } from './processing-policy';
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';

const jobPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'skipped', 'failed', 'dismissed'] as const;
// Identifiers, statuses, counts, hashes and short codes only: never event content,
// titles, provider bodies or credentials.
const jobSelect = `SELECT j.id,j.kind,j.scope_type,j.scope_id,j.project_id,j.task_id,j.status,j.attempts,j.max_attempts,
  j.next_attempt_at,j.lease_until,j.skip_reason,j.last_error,j.note,j.source_count,j.event_count,j.excluded_count,
  (SELECT COUNT(*) FROM processing_coverage c WHERE c.job_id=j.id) AS covered_count,j.first_event_at,j.last_event_at,
  j.result_context_id,(SELECT status FROM context_entries WHERE id=j.result_context_id) AS result_status,
  j.processor_version,j.policy_hash,j.source_set_hash,j.input_hash,j.scope_key,j.planned_by,j.created_at,j.updated_at
  FROM processing_jobs j`;

function cursor(value: string): [string, string] {
  try {
    if (value.length > 512) throw new Error();
    const parsed = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string'
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed[0]) || typeof parsed[1] !== 'string' || !jobPattern.test(parsed[1]))
      throw new Error();
    return [parsed[0], parsed[1]];
  } catch { throw new HttpError(400, 'Invalid processing cursor'); }
}

export async function listJobs(env: Env, params: URLSearchParams) {
  const allowed = new Set(['status', 'project_id', 'task_id', 'before', 'limit']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new HttpError(400, 'Invalid processing filter');
  const limit = pageLimit(params), where: string[] = [], args: unknown[] = [];
  if (params.has('status')) {
    if (!(JOB_STATUSES as readonly string[]).includes(params.get('status')!)) throw new HttpError(400, 'Invalid job status');
    where.push('j.status=?'); args.push(params.get('status'));
  }
  if (params.has('project_id')) {
    if (!projectPattern.test(params.get('project_id')!)) throw new HttpError(400, 'Invalid project identifier');
    where.push('j.project_id=?'); args.push(params.get('project_id'));
  }
  if (params.has('task_id')) {
    if (!uuidPattern.test(params.get('task_id')!)) throw new HttpError(400, 'Invalid task identifier');
    where.push('j.task_id=?'); args.push(params.get('task_id'));
  }
  if (params.has('before')) {
    const [time, id] = cursor(params.get('before')!);
    where.push('(j.created_at<? OR (j.created_at=? AND j.id<?))'); args.push(time, time, id);
  }
  const rows = (await env.DB.prepare(`${jobSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).bind(...args, limit + 1).all<{ created_at: string; id: string }>()).results;
  const jobs = rows.slice(0, limit), last = jobs.at(-1);
  return { jobs, next_cursor: rows.length > limit && last ? btoa(JSON.stringify([last.created_at, last.id])) : null };
}

export async function getJob(env: Env, id: string) {
  if (!jobPattern.test(id)) throw new HttpError(400, 'Invalid job identifier');
  const [job, sources, signals, calls, audit] = await env.DB.batch([
    env.DB.prepare(`${jobSelect} WHERE j.id=?`).bind(id),
    env.DB.prepare(`SELECT s.event_id,s.payload_hash,s.ordinal,EXISTS(SELECT 1 FROM processing_coverage c
      WHERE c.job_id=s.job_id AND c.event_id=s.event_id) AS covered FROM processing_job_sources s WHERE s.job_id=? ORDER BY s.ordinal`).bind(id),
    env.DB.prepare(`SELECT question_id,probability,confidence,evaluator,model,calibrated,created_at FROM processing_signals
      WHERE job_id=? ORDER BY question_id`).bind(id),
    env.DB.prepare(`SELECT id,provider,model,attempt,status,day,input_chars,estimated_tokens,input_tokens,output_tokens,
      reported_cost_usd,error_code,started_at,finished_at FROM processing_calls WHERE job_id=? ORDER BY started_at,id`).bind(id),
    env.DB.prepare('SELECT id,actor,action,reason,created_at FROM processing_job_audit WHERE job_id=? ORDER BY created_at,id').bind(id),
  ]);
  if (!job.results.length) throw new HttpError(404, 'Processing job not found');
  return { job: { ...job.results[0] as Record<string, unknown>,
    sources: (sources.results as { covered: number }[]).map((row) => ({ ...row, covered: !!row.covered })),
    // Evaluator probabilities are uncalibrated scores, never accuracy claims. A
    // contradiction signal names the one approved note it was asked about.
    signals: (signals.results as { question_id: string; calibrated: number }[]).map((row) => ({ ...row, calibrated: !!row.calibrated,
      label: 'uncalibrated', context_id: row.question_id.startsWith('contradiction:') ? row.question_id.slice(14) : null })),
    calls: calls.results, audit: audit.results } };
}

async function body(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  const value = await readJson(request);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new HttpError(400, 'Body contains unsupported fields');
  return value as Record<string, unknown>;
}
function reason(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2000) throw new HttpError(400, 'reason must be at most 2,000 characters');
  return value.trim() || null;
}

/** Reviewer retry (failed → queued, attempts reset) or dismiss (failed/queued → dismissed). Coverage is untouched. */
export async function changeJob(request: Request, env: Env, actor: string, id: string, action: 'retry' | 'dismiss') {
  if (!jobPattern.test(id)) throw new HttpError(400, 'Invalid job identifier');
  const note = reason((await body(request, ['reason'])).reason), time = new Date().toISOString();
  const update = action === 'retry'
    ? env.DB.prepare(`UPDATE processing_jobs SET status='queued',attempts=0,next_attempt_at=?,last_error=NULL,lease_owner=NULL,
        lease_until=NULL,updated_at=? WHERE id=? AND status='failed'`).bind(time, time, id)
    : env.DB.prepare(`UPDATE processing_jobs SET status='dismissed',lease_owner=NULL,lease_until=NULL,updated_at=?
        WHERE id=? AND status IN ('failed','queued')`).bind(time, id);
  const [result] = await env.DB.batch([update, env.DB.prepare(`INSERT INTO processing_job_audit(id,job_id,actor,action,reason,created_at)
    SELECT ?,?,?,?,?,? WHERE changes()>0`).bind(crypto.randomUUID(), id, actor, action, note, time)]);
  if (!result.meta.changes) {
    if (!await env.DB.prepare('SELECT id FROM processing_jobs WHERE id=?').bind(id).first()) throw new HttpError(404, 'Processing job not found');
    throw new HttpError(409, action === 'retry' ? 'Only failed jobs can be retried' : 'Only failed or queued jobs can be dismissed');
  }
  return json(await getJob(env, id));
}

export async function runRoute(request: Request, env: Env, actor: string) {
  const input = await body(request, ['task_id', 'project_id']);
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new HttpError(400, 'Provide exactly one of task_id or project_id');
  if (keys[0] === 'task_id' && (typeof input.task_id !== 'string' || !uuidPattern.test(input.task_id)))
    throw new HttpError(400, 'Invalid task identifier');
  if (keys[0] === 'project_id' && (typeof input.project_id !== 'string' || !projectPattern.test(input.project_id)))
    throw new HttpError(400, 'Invalid project identifier');
  return json(await planRequest(env, input as { task_id?: string; project_id?: string }, actor, new Date()));
}
