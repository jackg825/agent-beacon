import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ingest } from '../src/ingest';
import { Device, Env } from '../src/types';
import { applyMigrations } from './migrations';

/** Synthetic device rows; their token digests never match a real credential. */
export const fixtureDevices: Record<'mbp' | 'mini', Device> = {
  mbp: { id: 'mbp', name: 'Synthetic MBP', token_hash: 'a'.repeat(64), revoked: 0 },
  mini: { id: 'mini', name: 'Synthetic Mac mini', token_hash: 'b'.repeat(64), revoked: 0 },
};

export function syntheticEvent(id: string, options: { session?: string; repo?: string; action?: string; timestamp?: string;
  harness?: string; extra?: Record<string, unknown> } = {}) {
  return { vendor: 'beacon', product: 'endpoint-agent', schema_version: '1.0', timestamp: options.timestamp ?? '2026-10-08T00:00:00Z',
    event: { id, action: options.action ?? 'command.executed', kind: 'agent_runtime', fidelity: 'observed' },
    harness: { name: options.harness ?? 'codex_cli', collection_method: 'hook' },
    session: { id: options.session ?? 'session-a', working_directory: '/synthetic/' + (options.repo ?? 'alpha') },
    repository: `https://github.com/example/${options.repo ?? 'alpha'}.git`, ...options.extra };
}

/**
 * Direct module tests: real workerd D1/R2 bindings with every committed migration
 * applied and two enrolled synthetic devices. No network, no installed Beacon data.
 */
export async function createEnvFixture(options: { backup?: boolean; bindings?: Partial<Record<keyof Env, string>> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-env-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{
    name: 'env-fixture', modules: true as const, script: 'export default {fetch(){return new Response("synthetic");}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'fixture-index' },
    r2Buckets: options.backup ? { RAW: 'fixture-raw', BACKUP: 'fixture-backup' } : { RAW: 'fixture-raw' },
  }] }));
  let env: Env;
  try {
    env = { DB: await mf.getD1Database('DB'), RAW: await mf.getR2Bucket('RAW'),
      ...(options.backup ? { BACKUP: await mf.getR2Bucket('BACKUP') } : {}), ...options.bindings } as unknown as Env;
    await applyMigrations(env.DB);
    for (const device of Object.values(fixtureDevices)) {
      await env.DB.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)')
        .bind(device.id, device.name, device.token_hash, '2026-10-08T00:00:00Z').run();
    }
  } catch (error) {
    // A failed setup must not leave workerd running: the test file could never exit.
    await mf.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    env, mf, directory,
    /** Ingest records exactly like the HTTP route would, returning its acknowledgement. */
    async ingest(records: unknown | unknown[], device: keyof typeof fixtureDevices = 'mbp', stream = 'runtime') {
      const lines = (Array.isArray(records) ? records : [records]).map(record => JSON.stringify(record)).join('\n') + '\n';
      const response = await ingest(new Request('http://localhost/v1/ingest/' + stream, { method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' }, body: lines }), env, fixtureDevices[device], stream);
      return response.json() as Promise<{ batch_id: string; accepted: number; inserted: number; duplicate: boolean }>;
    },
    /** The central index row for one upstream event.id. */
    event(eventId: string) {
      return env.DB.prepare('SELECT * FROM events WHERE event_id=?').bind(eventId).first<Record<string, any>>();
    },
    async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}
