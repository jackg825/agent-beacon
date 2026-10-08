// Track D (roadmap phase 3): retention, backup/restore and data health, aggregated into
// the router, MCP and maintenance extension points. See DATA-OPERATIONS.md.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { MaintenanceTask } from './maintenance';
import { annotations, result } from './mcp-tools';
import { backupTask, backupsReviewerRead, backupsWrite } from './backup';
import { dataHealth, healthRead, healthTask } from './health';
import { retentionRead, retentionWrite } from './retention';
import type { Env } from './types';

/** GETs that need read authorization (`/api/health/*`, `/api/retention/*`). */
export async function operationsRead(request: Request, env: Env): Promise<Response | null> {
  return await retentionRead(request, env) ?? await healthRead(request, env);
}
/** GETs that expose backup contents (device token digests) and therefore require review authority. */
export async function operationsReviewerRead(request: Request, env: Env, actor: string): Promise<Response | null> {
  return backupsReviewerRead(request, env, actor);
}
export async function operationsWrite(request: Request, env: Env, actor: string): Promise<Response | null> {
  return await retentionWrite(request, env, actor) ?? await backupsWrite(request, env, actor);
}
export function registerOperationsTools(server: McpServer, env: Env): void {
  server.registerTool('beacon_get_data_health', {
    title: 'Read data health',
    description: 'Read ingest backlog, raw availability, stale reviewed notes, capacity and backup state as codes, counts and identifiers. Contains no event or note content; hints describe repair steps for a human operator, never actions for the client.',
    inputSchema: z.object({}).strict(), annotations,
  }, async () => result(() => dataHealth(env)));
}
// Both run hourly and only when named in MAINTENANCE_TASKS; backup also needs the BACKUP binding.
export const operationsMaintenance: MaintenanceTask[] = [backupTask, healthTask];
