import assert from 'node:assert/strict';
import { contextWrite } from '../src/context';
import { MaintenanceReport, MaintenanceTask, runMaintenance } from '../src/maintenance';
import { processingMaintenance, processingTick, processingWrite } from '../src/processing';
import type { SelectionStage } from '../src/processing-stage';
import { projectWrite } from '../src/project-workflows';
import { Env, HttpError } from '../src/types';
import { syntheticEvent } from './env-fixture';

/** Synthetic reviewer actor, shaped like reviewAuth's output. */
export const reviewer = 'reviewer:5e7e7e7e7e7e7e7e';
export const openPolicy = { enabled: true, external_allowed: false, jev_enabled: false, summary_fields: [] as string[],
  external_fields: [] as string[], min_new_events: 1, quiet_minutes: 0, max_events_per_job: 200, jev_skip_threshold: null as number | null };

export function post(path: string, body: unknown) {
  return new Request('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
export async function setPolicy(env: Env, scope: { scope_type: 'workspace' | 'project'; scope_id: string }, overrides: Partial<typeof openPolicy> = {}) {
  const response = await processingWrite(post('/api/processing/policies', { ...openPolicy, ...scope, ...overrides }), env, reviewer);
  assert.equal(response!.status, 200);
  return response!.json() as Promise<any>;
}
export const workspace = { scope_type: 'workspace' as const, scope_id: '*' };
/** Far enough after any real ingest time that quiet_minutes and the settle lag have passed. */
export const later = (minutes = 120) => new Date(Date.now() + minutes * 60_000);

/** One scheduled processing tick exactly as the cron would run it. */
export async function tick(env: Env, now = later(), options: { fetcher?: typeof fetch } = {}) {
  const report = await runMaintenance({ ...env, MAINTENANCE_TASKS: 'processing' } as Env, { now, schedule: 'frequent',
    tasks: processingMaintenance, ...options });
  // Results are plain counts and codes; tests read them loosely.
  return report.processing as Omit<MaintenanceReport[string], 'result'> & { result?: any };
}
export async function review(env: Env, id: string, decision: 'approve' | 'reject' = 'reject') {
  const response = await contextWrite(post(`/api/context/${id}/review`, { decision }), env, reviewer);
  assert.equal(response!.status, 200);
}
export async function jobs(env: Env) {
  return (await env.DB.prepare('SELECT * FROM processing_jobs ORDER BY created_at,id').all<any>()).results;
}
export async function count(env: Env, sql: string, ...args: unknown[]) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).bind(...args).first<{ n: number }>())!.n;
}

export const at = (second: number) => new Date(Date.UTC(2026, 9, 7, 8, 0, second)).toISOString();
export const command = (id: string, text: string, exit: number, options: Parameters<typeof syntheticEvent>[1] = {}) =>
  syntheticEvent(id, { ...options, action: 'command.executed', extra: { command: { command: text, exit_code: exit }, ...options.extra } });
export const rejects = (operation: Promise<unknown>, status: number) =>
  assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status);
export async function link(env: Env, taskId: string, sessionId: string) {
  assert.equal((await projectWrite(post(`/api/tasks/${taskId}/sessions`, { session_id: sessionId }), env, reviewer))!.status, 201);
}
export async function newTask(env: Env, title: string, sessions: string[] = []) {
  const response = await projectWrite(post('/api/tasks', { title }), env, reviewer);
  const id = ((await response!.json()) as any).task.id as string;
  for (const session of sessions) await link(env, id, session);
  return id;
}
export async function run(env: Env, body: unknown) {
  const response = await processingWrite(post('/api/processing/run', body), env, reviewer);
  return response!.json() as Promise<any>;
}
export async function job(env: Env, id: string) {
  return (await env.DB.prepare('SELECT * FROM processing_jobs WHERE id=?').bind(id).first<any>())!;
}
/** A processing task with a different stage, registered exactly like the real one. */
export function staged(stage: SelectionStage): MaintenanceTask[] {
  return [{ ...processingMaintenance[0], run: (env, ctx) => processingTick(env, ctx, { stage }) }];
}
