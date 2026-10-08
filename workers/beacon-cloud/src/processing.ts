// Track P (roadmap phase 2) replaces these stubs: rules/privacy, durable jobs,
// optional Jev filter, generation and cost control. See BACKGROUND-PROCESSING.md.
import type { McpServer } from '@modelcontextprotocol/server';
import type { MaintenanceTask } from './maintenance';
import type { Env } from './types';

export async function processingRead(_request: Request, _env: Env): Promise<Response | null> { return null; }
export async function processingWrite(_request: Request, _env: Env, _actor: string): Promise<Response | null> { return null; }
export function registerProcessingTools(_server: McpServer, _env: Env): void {}
export const processingMaintenance: MaintenanceTask[] = [];
