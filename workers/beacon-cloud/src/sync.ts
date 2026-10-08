// Track S (roadmap phase 3) replaces these stubs: the approved-note snapshot,
// reviewer-managed device subscriptions and the device read route. See MAC-SYNC.md.
import type { Device, Env } from './types';

export async function syncRead(_request: Request, _env: Env): Promise<Response | null> { return null; }
export async function syncWrite(_request: Request, _env: Env, _actor: string): Promise<Response | null> { return null; }
/** Device-token GETs under /v1/sync/; the device is already authenticated and not revoked. */
export async function syncDeviceRead(_request: Request, _env: Env, _device: Device): Promise<Response | null> { return null; }
