import { digest } from './auth';
import { insertCandidate } from './context';
import { extractiveGenerator, Generator, GeneratorEvent, validateGenerated } from './generator';
import { stableJSON } from './identity';
import { defaultStage } from './jev';
import type { Allotment, MaintenanceContext } from './maintenance';
import { cleanLine, projectEvents, workerSecrets } from './privacy';
import { EffectivePolicy, effectivePolicy } from './processing-policy';
import { JobScope, SelectionStage, StageSignal } from './processing-stage';
import { versionScope } from './queries';
import { MAX_CALL_TIMEOUT_MS } from './processing-budget';
import { Env, HttpError } from './types';

export const LEASE_MIN_MS = 10 * 60_000;
/** Largest external call timeout a job may make (the budget's timeout_ms cap), added to every lease. */
export const EXTERNAL_TIMEOUT_MS = MAX_CALL_TIMEOUT_MS;
export const BACKOFF_MINUTES = [1, 5, 30, 120];
export const MAX_JOBS_PER_TICK = 2;
/**
 * Platform calls a single job may need: claim, checks, versions, ≤20 verifications and
 * one batch, plus the optional evaluator (prior-call and budget reads, notes,
 * reservation, one outbound fetch and a fenced batch of up to twelve answers).
 */
export const JOB_RESERVE: Allotment = { d1: 110, r2: 260, fetch: 1 };
export const MAX_JOB_RAW_READS = 240;
export const MAX_JOB_RAW_BYTES = 48 * 1024 * 1024;
const MAX_VERSIONS = 1000;

export interface JobRow {
  id: string; scope_type: 'task' | 'project'; scope_id: string; project_id: string; task_id: string | null; scope_key: string;
  source_set_hash: string; policy_hash: string; processor_version: string; status: string; attempts: number; max_attempts: number;
  lease_owner: string | null; lease_until: string | null;
}
export type JobOutcome = 'succeeded' | 'skipped' | 'retry' | 'failed' | 'lease_lost' | 'recovered';
class JobError extends Error { constructor(public code: string) { super(code); } }

/** Short codes only; D1/R2 messages can quote SQL, keys or content. */
function errorCode(error: unknown): string {
  if (error instanceof JobError) return error.code;
  if (error instanceof HttpError) return error.status === 503 ? 'raw_unavailable' : error.status === 400 ? 'invalid_source'
    : error.status === 409 ? 'context_conflict' : error.status === 404 ? 'not_found' : 'http_' + error.status;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^budget_exhausted:[a-z0-9]+$/.test(code)) return code;
  if (/processing_lease_lost/.test(String(error))) return 'lease_lost';
  return 'job_failed';
}

async function claim(env: Env, now: Date, owner: string, leaseUntil: string): Promise<JobRow | null> {
  const time = now.toISOString();
  // One atomic statement: the oldest due queued job, or a running job whose lease expired.
  return env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=?
    WHERE id=(SELECT id FROM (
      SELECT id,next_attempt_at AS due FROM processing_jobs WHERE status='queued' AND next_attempt_at<=?
      UNION ALL SELECT id,lease_until FROM processing_jobs WHERE status='running' AND lease_until<? AND attempts<max_attempts
    ) ORDER BY due,id LIMIT 1) AND (status='queued' OR (status='running' AND lease_until<? AND attempts<max_attempts))
    RETURNING id,scope_type,scope_id,project_id,task_id,scope_key,source_set_hash,policy_hash,processor_version,status,
      attempts,max_attempts,lease_owner,lease_until`).bind(owner, leaseUntil, time, time, time, time).first<JobRow>();
}

/** A job that crashed on its last attempt ends failed instead of being claimed again. */
export async function sweepExpiredLeases(env: Env, now: Date): Promise<number> {
  const time = now.toISOString();
  return (await env.DB.prepare(`UPDATE processing_jobs SET status='failed',last_error='lease_expired',lease_owner=NULL,lease_until=NULL,
    updated_at=? WHERE status='running' AND lease_until<? AND attempts>=max_attempts`).bind(time, time).run()).meta.changes;
}

type Lease = { job: JobRow; owner: string; now: string };
const fence = (env: Env, { job, owner }: Lease) =>
  env.DB.prepare('INSERT INTO processing_job_fence(job_id,lease_owner,attempts) VALUES(?,?,?)').bind(job.id, owner, job.attempts);
const fenced = 'WHERE id=? AND status=\'running\' AND lease_owner=? AND attempts=?';
const coverage = (env: Env, { job, now }: Lease, eventIds: string[]) => env.DB.prepare(`INSERT INTO processing_coverage(scope_key,event_id,job_id,created_at)
  SELECT ?,value,?,? FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(job.scope_key, job.id, now, JSON.stringify(eventIds));
const signalRows = (env: Env, { job, now }: Lease, signals: StageSignal[]) => signals.map((signal) => env.DB.prepare(`INSERT INTO
  processing_signals(job_id,question_id,probability,confidence,evaluator,model,calibrated,created_at) VALUES(?,?,?,?,?,?,0,?)
  ON CONFLICT DO NOTHING`).bind(job.id, signal.question_id, signal.probability, signal.confidence, signal.evaluator, signal.model, now));

async function finish(env: Env, lease: Lease, statements: D1PreparedStatement[]): Promise<boolean> {
  try { await env.DB.batch([fence(env, lease), ...statements]); return true; }
  catch (error) { if (/processing_lease_lost/.test(String(error))) return false; throw error; }
}
/** Skips that happen before any work leave coverage untouched, so the planner re-plans the scope. */
async function skip(env: Env, lease: Lease, reason: string, covered: string[], signals: StageSignal[] = [], note: string | null = null) {
  return finish(env, lease, [...(covered.length ? [coverage(env, lease, covered)] : []), ...signalRows(env, lease, signals),
    env.DB.prepare(`UPDATE processing_jobs SET status='skipped',skip_reason=?,note=?,last_error=NULL,lease_owner=NULL,lease_until=NULL,
      updated_at=? ${fenced}`).bind(reason, note, lease.now, lease.job.id, lease.owner, lease.job.attempts)]);
}
async function succeed(env: Env, lease: Lease, contextId: string, covered: string[]) {
  return finish(env, lease, [coverage(env, lease, covered), env.DB.prepare(`UPDATE processing_jobs SET status='succeeded',
    result_context_id=?,last_error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? ${fenced}`)
    .bind(contextId, lease.now, lease.job.id, lease.owner, lease.job.attempts)]);
}

type SourceRow = { event_id: string; payload_hash: string; ordinal: number; present: string | null; upstream_event_id: string;
  project_id: string; session_id: string | null; device_id: string; stream: string; harness: string; timestamp: string;
  identity_kind: string; in_scope: number };

/**
 * Re-check, at run time, that every source still belongs to the job's scope: the
 * event exists, its project is unchanged, and its session is still linked to the
 * (open) task, or for a project scope still not linked to any open task.
 */
async function currentSources(env: Env, job: JobRow) {
  const [task, sources] = await env.DB.batch([
    env.DB.prepare(`SELECT t.status,t.title,p.name AS project_name FROM projects p LEFT JOIN tasks t ON t.id=? WHERE p.id=?`)
      .bind(job.task_id, job.project_id),
    env.DB.prepare(`SELECT s.event_id,s.payload_hash,s.ordinal,e.id AS present,e.event_id AS upstream_event_id,e.project_id,e.session_id,
      e.device_id,e.stream,e.harness,e.timestamp,p.identity_kind,
      CASE WHEN ? IS NULL THEN NOT EXISTS(SELECT 1 FROM task_sessions ts JOIN tasks t ON t.id=ts.task_id
        WHERE ts.session_id=e.session_id AND t.status='open')
      ELSE EXISTS(SELECT 1 FROM task_sessions ts WHERE ts.task_id=? AND ts.session_id=e.session_id) END AS in_scope
      FROM processing_job_sources s LEFT JOIN events e ON e.id=s.event_id LEFT JOIN projects p ON p.id=e.project_id
      WHERE s.job_id=? ORDER BY s.ordinal`).bind(job.task_id, job.task_id, job.id),
  ]);
  const scope = task.results[0] as { status: string | null; title: string | null; project_name: string } | undefined;
  const rows = sources.results as SourceRow[];
  const valid = !!scope && (job.scope_type !== 'task' || scope.status === 'open') && rows.length > 0
    && rows.every((row) => row.present && row.project_id === job.project_id && row.stream === 'runtime' && !!row.in_scope);
  return { valid, rows, task_title: scope?.title ?? null, project_name: scope?.project_name ?? null };
}

/**
 * Choose, per event, a raw version whose recorded scope matches the index: the planned
 * (first indexed) version when it matches, otherwise another stored version. Raw objects
 * are read grouped by batch, one object in memory at a time. Missing or corrupt raw
 * data is a failure, never a reason to substitute a version.
 */
async function exactVersions(env: Env, rows: SourceRow[]) {
  const versions = (await env.DB.prepare(`SELECT v.event_id,v.payload_hash,v.line_number,b.r2_key FROM event_versions v
    JOIN batches b ON b.id=v.batch_id WHERE v.event_id IN (SELECT value FROM json_each(?)) ORDER BY b.r2_key,v.line_number LIMIT ?`)
    .bind(JSON.stringify(rows.map((row) => row.event_id)), MAX_VERSIONS + 1)
    .all<{ event_id: string; payload_hash: string; line_number: number; r2_key: string }>()).results;
  if (versions.length > MAX_VERSIONS) throw new JobError('too_many_versions');
  const index = new Map(rows.map((row) => [row.event_id, row]));
  const chosen = new Map<string, { payload: unknown; payload_hash: string }>();
  let reads = 0, bytes = 0;
  const pass = async (list: typeof versions) => {
    const keys = [...new Set(list.map((version) => version.r2_key))];
    for (const key of keys) {
      const wanted = list.filter((version) => version.r2_key === key && !chosen.has(version.event_id));
      if (!wanted.length) continue;
      if (++reads > MAX_JOB_RAW_READS) throw new JobError('raw_read_limit');
      const object = await env.RAW.get(key);
      if (!object) throw new HttpError(503, 'Raw batch unavailable');
      const text = await object.text();
      if ((bytes += text.length) > MAX_JOB_RAW_BYTES) throw new JobError('raw_byte_limit');
      const lines = text.split('\n');
      for (const version of wanted) {
        const row = index.get(version.event_id)!;
        let payload: unknown;
        try {
          payload = JSON.parse(lines[version.line_number]);
          if (await digest(stableJSON(payload)) !== version.payload_hash) throw new Error();
        } catch { throw new HttpError(503, 'Raw event version unavailable'); }
        const scope = await versionScope(payload, { event_id: row.upstream_event_id, harness: row.harness, session_id: row.session_id,
          project_id: row.project_id, device_id: row.device_id, stream: row.stream, identity_kind: row.identity_kind });
        if (scope.matches) chosen.set(version.event_id, { payload, payload_hash: version.payload_hash });
      }
    }
  };
  const planned = (version: typeof versions[number]) => version.payload_hash === index.get(version.event_id)?.payload_hash;
  await pass(versions.filter(planned));
  await pass(versions.filter((version) => !planned(version) && !chosen.has(version.event_id)));
  return chosen;
}

export interface RunOptions { stage?: SelectionStage; generator?: Generator }

/** Run one claimed job to a fenced end state. */
async function runClaimed(env: Env, ctx: MaintenanceContext, lease: Lease, options: RunOptions): Promise<JobOutcome> {
  const { job } = lease;
  const generator = options.generator ?? extractiveGenerator;
  // Crash recovery: a candidate already committed for this job is recorded, never duplicated.
  const existing = await env.DB.prepare('SELECT context_id FROM context_generation WHERE job_id=?').bind(job.id).first<{ context_id: string }>();
  const allSources = async () => (await env.DB.prepare('SELECT event_id FROM processing_job_sources WHERE job_id=? ORDER BY ordinal')
    .bind(job.id).all<{ event_id: string }>()).results.map((row) => row.event_id);
  if (existing) return await succeed(env, lease, existing.context_id, await allSources()) ? 'recovered' : 'lease_lost';
  // Re-validate before reading raw data, reserving budget or calling anything.
  const policy: EffectivePolicy = await effectivePolicy(env, job.project_id);
  if (policy.policy_hash !== job.policy_hash || !policy.enabled)
    return await skip(env, lease, 'policy_changed', []) ? 'skipped' : 'lease_lost';
  const current = await currentSources(env, job);
  if (!current.valid) return await skip(env, lease, 'scope_changed', []) ? 'skipped' : 'lease_lost';
  const covered = current.rows.map((row) => row.event_id);
  const versions = await exactVersions(env, current.rows);
  const used = current.rows.filter((row) => versions.has(row.event_id));
  const secrets = workerSecrets(env);
  const projection = projectEvents(used.map((row) => ({ payload: versions.get(row.event_id)!.payload, timestamp: row.timestamp })),
    policy.summary_fields, { secrets });
  const events: GeneratorEvent[] = projection.events.map((event, index) => ({ ...event, event_id: used[index].event_id,
    payload_hash: versions.get(used[index].event_id)!.payload_hash, device_id: used[index].device_id, session_id: used[index].session_id }));
  const counts = { event_count: events.length, excluded_count: current.rows.length - events.length,
    first_event_at: used[0]?.timestamp ?? null, last_event_at: used.at(-1)?.timestamp ?? null,
    input_hash: await digest(stableJSON({ policy_hash: policy.policy_hash, projection: projection.events })) };
  await env.DB.prepare(`UPDATE processing_jobs SET event_count=?,excluded_count=?,first_event_at=?,last_event_at=?,input_hash=?,updated_at=?
    ${fenced}`).bind(counts.event_count, counts.excluded_count, counts.first_event_at, counts.last_event_at, counts.input_hash,
    lease.now, job.id, lease.owner, job.attempts).run();
  if (!events.length) return await skip(env, lease, 'no_matching_versions', covered) ? 'skipped' : 'lease_lost';
  const scope: JobScope = { scope_type: job.scope_type, scope_id: job.scope_id, project_id: job.project_id, task_id: job.task_id,
    scope_key: job.scope_key };
  const decision = await (options.stage ?? defaultStage)({ env, ctx, job_id: job.id, attempt: job.attempts, lease_owner: lease.owner,
    scope, policy, projection: projection.events, labels: { task_title: current.task_title, project_name: current.project_name } });
  if (decision.decision === 'skip')
    return await skip(env, lease, decision.skip_reason ?? 'stage_skip', covered, decision.signals, decision.note ?? null) ? 'skipped' : 'lease_lost';
  const titles = policy.summary_fields.includes('titles');
  const named = job.scope_type === 'task' ? current.task_title : current.project_name;
  const label = titles && named ? cleanLine(named, { secrets }, 120)
    : job.scope_type === 'task' ? `任務 ${job.scope_id.slice(0, 8)}` : `專案 ${job.project_id.slice(0, 8)}`;
  // Always rebuilt from the raw projection, never from a previous summary.
  const output = await generator.generate({ scope: { type: job.scope_type, project_id: job.project_id, task_id: job.task_id,
    task_open: job.scope_type === 'task', label }, events, fields: policy.summary_fields, secrets, truncated: projection.truncated });
  const invalid = validateGenerated(output);
  if (invalid) throw new JobError('generator_' + invalid);
  const previous = await env.DB.prepare(`SELECT context_id FROM context_generation WHERE scope_key=?
    ORDER BY created_at DESC,context_id DESC LIMIT 1`).bind(job.scope_key).first<{ context_id: string }>();
  try {
    // Candidate, generation link, coverage, signals and job completion commit together, behind the lease fence.
    await insertCandidate(env, { kind: 'summary', project_id: job.project_id, ...(job.task_id ? { task_id: job.task_id } : {}),
      title: output.title, content: output.content, sources: output.sources }, generator.actor, { now: lease.now,
      before: [fence(env, lease)],
      after: (contextId, createdAt) => [
        env.DB.prepare(`INSERT INTO context_generation(context_id,job_id,processor,scope_key,previous_context_id,created_at)
          VALUES(?,?,?,?,?,?)`).bind(contextId, job.id, generator.processorVersion, job.scope_key, previous?.context_id ?? null, createdAt),
        coverage(env, lease, covered), ...signalRows(env, lease, decision.signals),
        env.DB.prepare(`UPDATE processing_jobs SET status='succeeded',result_context_id=?,note=?,last_error=NULL,lease_owner=NULL,
          lease_until=NULL,updated_at=? ${fenced}`).bind(contextId, decision.note ?? null, lease.now, job.id, lease.owner, job.attempts),
      ] });
    return 'succeeded';
  } catch (error) {
    if (/processing_lease_lost/.test(String(error))) return 'lease_lost';
    // The UNIQUE job_id rolled the whole batch back: record the candidate that already exists.
    if (/UNIQUE constraint failed: context_generation\.job_id/.test(String(error))) {
      const winner = await env.DB.prepare('SELECT context_id FROM context_generation WHERE job_id=?').bind(job.id).first<{ context_id: string }>();
      if (winner) return await succeed(env, lease, winner.context_id, covered) ? 'recovered' : 'lease_lost';
    }
    throw error;
  }
}

async function fail(env: Env, lease: Lease, code: string, now: Date): Promise<JobOutcome> {
  const { job } = lease, last = job.attempts >= job.max_attempts;
  const next = new Date(now.getTime() + BACKOFF_MINUTES[Math.min(job.attempts, BACKOFF_MINUTES.length) - 1] * 60_000).toISOString();
  const result = await env.DB.prepare(`UPDATE processing_jobs SET status=?,next_attempt_at=?,last_error=?,lease_owner=NULL,lease_until=NULL,
    updated_at=? ${fenced}`).bind(last ? 'failed' : 'queued', next, code, now.toISOString(), job.id, lease.owner, job.attempts).run();
  return !result.meta.changes ? 'lease_lost' : last ? 'failed' : 'retry';
}

export interface RunTickResult { claimed: number; outcomes: Partial<Record<JobOutcome, number>>; stopped?: string }
/**
 * Claim and run up to `maxJobs` jobs while time and the task's allotment leave room
 * for a whole job, so a job never runs out of budget half way through.
 */
export async function runJobs(env: Env, ctx: MaintenanceContext, allotment: Allotment,
  options: RunOptions & { maxJobs?: number } = {}): Promise<RunTickResult> {
  const result: RunTickResult = { claimed: 0, outcomes: {} };
  const owner = crypto.randomUUID();
  for (let count = 0; count < (options.maxJobs ?? MAX_JOBS_PER_TICK); count++) {
    const used = ctx.usage();
    if (ctx.remaining() < 5_000) { result.stopped = 'time'; break; }
    if ((['d1', 'r2', 'fetch'] as const).some((kind) => used[kind] + JOB_RESERVE[kind] > allotment[kind])) { result.stopped = 'allotment'; break; }
    const leaseUntil = new Date(ctx.now.getTime() + Math.max(LEASE_MIN_MS, ctx.remaining() + EXTERNAL_TIMEOUT_MS + 60_000)).toISOString();
    const job = await claim(env, ctx.now, owner, leaseUntil);
    if (!job) break;
    result.claimed++;
    const lease = { job, owner, now: ctx.now.toISOString() };
    let outcome: JobOutcome;
    try { outcome = await runClaimed(env, ctx, lease, options); }
    catch (error) {
      const code = errorCode(error);
      // An exhausted allotment leaves the lease to expire rather than spending more calls.
      if (code.startsWith('budget_exhausted:')) throw error;
      outcome = code === 'lease_lost' ? 'lease_lost' : await fail(env, lease, code, ctx.now);
    }
    result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
  }
  return result;
}
