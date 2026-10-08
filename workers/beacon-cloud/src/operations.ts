// Track D (roadmap phase 3) replaces these stubs: retention, backup/restore and
// data health. See DATA-OPERATIONS.md.
import type { McpServer } from '@modelcontextprotocol/server';
import type { MaintenanceTask } from './maintenance';
import type { Env } from './types';

/** GETs that need read authorization (`/api/health/*`, `/api/retention/*`). */
export async function operationsRead(_request: Request, _env: Env): Promise<Response | null> { return null; }
/** GETs that expose backup contents (device token digests) and therefore require review authority. */
export async function operationsReviewerRead(_request: Request, _env: Env, _actor: string): Promise<Response | null> { return null; }
export async function operationsWrite(_request: Request, _env: Env, _actor: string): Promise<Response | null> { return null; }
export function registerOperationsTools(_server: McpServer, _env: Env): void {}
export const operationsMaintenance: MaintenanceTask[] = [];
