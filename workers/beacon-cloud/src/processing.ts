// Track P (roadmap phase 2), part A: rules/privacy, durable jobs with coverage-based
// selection, fenced completion and the deterministic extractive generator. The
// optional Jev stage and the budget ledger plug into processing-stage.ts and
// processing-budget.ts in part B. See BACKGROUND-PROCESSING.md.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Allotment, MaintenanceContext, MaintenanceTask } from './maintenance';
import { annotations, cursor, hashId, pageLimit, queryParams, result, workflowId } from './mcp-tools';
import { changeJob, getJob, JOB_STATUSES, listJobs, runRoute } from './processing-jobs';
import { planTick } from './processing-planner';
import { readPolicy, writePolicy } from './processing-policy';
import { runJobs, RunOptions, sweepExpiredLeases } from './processing-runner';
import { Env, HttpError, json } from './types';

export async function processingRead(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/processing/policy') return json(await readPolicy(env, url.searchParams));
  if (path === '/api/processing/jobs') return json(await listJobs(env, url.searchParams));
  const match = /^\/api\/processing\/jobs\/([^/]+)$/.exec(path);
  if (!match) return null;
  if (url.search) throw new HttpError(400, 'Job detail does not accept filters');
  return json(await getJob(env, match[1]));
}

export async function processingWrite(request: Request, env: Env, actor: string): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/processing/')) return null;
  if (url.search) throw new HttpError(400, 'Processing writes do not accept filters');
  if (path === '/api/processing/policies') return writePolicy(request, env, actor);
  if (path === '/api/processing/run') return runRoute(request, env, actor);
  const match = /^\/api\/processing\/jobs\/([^/]+)\/(retry|dismiss)$/.exec(path);
  if (match) return changeJob(request, env, actor, match[1], match[2] as 'retry' | 'dismiss');
  return null;
}

export function registerProcessingTools(server: McpServer, env: Env): void {
  server.registerTool('beacon_list_processing_jobs', {
    title: 'List background processing jobs',
    description: 'List background summarize jobs with status, skip reason, attempts and coverage counts. Identifiers and short codes only; a generated candidate is pending until a human reviews it.',
    inputSchema: z.object({ status: z.enum(JOB_STATUSES).optional(), project_id: hashId.optional(), task_id: workflowId.optional(),
      before: cursor, limit: pageLimit }).strict(),
    annotations,
  }, async (args) => result(() => listJobs(env, queryParams(args))));
  server.registerTool('beacon_get_processing_job', {
    title: 'Read one background processing job',
    description: 'Read a job with its exact source identifiers, coverage, uncalibrated evaluator signals, call ledger and audit. No event content.',
    inputSchema: z.object({ job_id: hashId }).strict(),
    annotations,
  }, async ({ job_id }) => result(() => getJob(env, job_id)));
}

/** Per-tick platform calls; enough for planning five scopes and two whole jobs. */
export const PROCESSING_ALLOTMENT: Allotment = { d1: 400, r2: 600, fetch: 0 };

/** One scheduled pass: expire dead leases, plan due scopes, then run claimable jobs. */
export async function processingTick(env: Env, ctx: MaintenanceContext, options: RunOptions = {}) {
  const expired = await sweepExpiredLeases(env, ctx.now);
  const plan = await planTick(env, ctx.now);
  const run = await runJobs(env, ctx, PROCESSING_ALLOTMENT, options);
  return { expired, workspace_enabled: plan.workspace_enabled, scanned: plan.scanned, planned: plan.planned.length,
    plan_outcomes: plan.outcomes, ...(plan.cursor_conflict ? { cursor_conflict: true } : {}),
    claimed: run.claimed, run_outcomes: run.outcomes, ...(run.stopped ? { stopped: run.stopped } : {}) };
}

export const processingMaintenance: MaintenanceTask[] = [
  { name: 'processing', schedule: 'frequent', allotment: PROCESSING_ALLOTMENT, run: (env, ctx) => processingTick(env, ctx) },
];
