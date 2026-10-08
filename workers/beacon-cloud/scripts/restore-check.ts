// Restore drill for one backup checkpoint into an isolated local Miniflare D1/R2 that this
// script creates in a private temporary directory. It never targets a remote database,
// never reads a Wrangler config, never writes under migrations/, and never prints the
// review token or any restored content: the report has counts, codes and hashes only.
//
//   npm run backup:restore-check -- --url https://WORKER --review-token-file /ABS/token --checkpoint UUID [--out /ABS/new-dir]
//   npm run backup:restore-check -- --dir /ABS/previous-out --checkpoint UUID
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { stableJSON } from '../src/identity';
import { applyMigrationStatements, normalizedStatement } from './migration-sql';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RAW_KEY = /^raw\/batches\/[A-Za-z0-9_-]{1,80}\/(?:runtime|inventory)\/[a-f0-9]{64}\.ndjson$/;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export class RestoreError extends Error { constructor(public code: string) { super(code); } }
/** Where checkpoint objects come from: the Worker's reviewer object route, a BACKUP binding, or a previous --out directory. */
export interface BackupSource { get(key: string): Promise<Uint8Array | null> }
type Row = Record<string, string | number | null>;
type Chunk = { seq: number; kind: 'rows' | 'final' | 'raw_list'; key: string; sha256: string; bytes: number; rows: Record<string, number> };
type Manifest = { format: string; checkpoint_id: string; table_counts: Record<string, number>; chunks: Chunk[]; raw: { objects: number } };
type RawEntry = { batch_id: string; key: string; size: number; sha256: string };
type Tally = { code: string; count: number };
export type RestoreReport = {
  format: 'beacon.restore-check.v1'; checkpoint_id: string; manifest_sha256: string; result: 'passed' | 'failed';
  counts: { tables: Record<string, number>; raw_objects: number }; failures: Tally[]; findings: Tally[];
  triggers: { expected: number; matched: number }; checks: string[];
};

export function bucketSource(bucket: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> }): BackupSource {
  return { async get(key) { const object = await bucket.get(key); return object ? new Uint8Array(await object.arrayBuffer()) : null; } };
}
/** Reviewer object route; redirects are refused so the token never follows to another origin. */
export function httpSource(base: URL, token: string, checkpointId: string, fetchImpl: typeof fetch = fetch): BackupSource & { manifestSha256(): Promise<string> } {
  const request = async (path: string) => {
    const response = await fetchImpl(new URL(path, base), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json, application/octet-stream' }, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 || (response.type as string) === 'opaqueredirect') throw new RestoreError('redirect_rejected');
    return response;
  };
  return {
    async get(key) {
      const response = await request(`/api/backups/${checkpointId}/object?` + new URLSearchParams({ key }));
      if (response.status === 404) return null;
      if (!response.ok) throw new RestoreError('http_' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_OBJECT_BYTES) throw new RestoreError('object_too_large');
      return bytes;
    },
    async manifestSha256() {
      const response = await request(`/api/backups/${checkpointId}`);
      if (!response.ok) throw new RestoreError('http_' + response.status);
      const value = (await response.json() as { checkpoint?: { manifest_sha256?: unknown } }).checkpoint?.manifest_sha256;
      if (typeof value !== 'string' || !HASH.test(value)) throw new RestoreError('checkpoint_not_completed');
      return value;
    },
  };
}
/** A directory written by --out: objects are stored under SHA-256-of-key names, never under key paths. */
export function dirSource(directory: string): BackupSource {
  return { async get(key) {
    const path = join(directory, 'objects', sha256(key));
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new RestoreError('invalid_local_object');
      return new Uint8Array(await readFile(path));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  } };
}

function validateManifest(value: unknown, checkpointId: string): Manifest {
  const manifest = value as Manifest;
  if (!manifest || typeof manifest !== 'object' || manifest.format !== 'beacon.backup.v1' || manifest.checkpoint_id !== checkpointId
    || !Array.isArray(manifest.chunks) || !manifest.table_counts || typeof manifest.table_counts !== 'object') throw new RestoreError('invalid_manifest');
  for (const [table, count] of Object.entries(manifest.table_counts)) if (!TABLE.test(table) || !Number.isInteger(count) || count < 0) throw new RestoreError('invalid_manifest');
  const seen = new Set<string>();
  for (const chunk of manifest.chunks) {
    const directory = chunk.kind === 'raw_list' ? 'raw' : 'd1';
    // Every key must have the exact shape this Worker writes; nothing else is fetched or stored.
    if (!['rows', 'final', 'raw_list'].includes(chunk.kind) || chunk.key !== `checkpoints/${checkpointId}/${directory}/${String(chunk.seq).padStart(6, '0')}.ndjson`
      || !HASH.test(chunk.sha256) || !Number.isInteger(chunk.bytes) || chunk.bytes < 0 || seen.has(chunk.key)) throw new RestoreError('invalid_manifest_key');
    seen.add(chunk.key);
  }
  return manifest;
}

async function fetchVerified(source: BackupSource, key: string, expected: string, size: number | null, save: (key: string, bytes: Uint8Array) => Promise<void>, prefix: string) {
  const bytes = await source.get(key);
  if (!bytes) throw new RestoreError(prefix + '_missing');
  if ((size !== null && bytes.byteLength !== size) || sha256(bytes) !== expected) throw new RestoreError(prefix + '_sha256_mismatch');
  await save(key, bytes);
  return bytes;
}
const lines = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).split('\n').filter(Boolean);

/** Tables in foreign-key dependency order (parents first), from PRAGMA foreign_key_list. */
async function loadOrder(db: D1Database, tables: string[]): Promise<{ order: string[]; selfRefs: Map<string, { from: string; to: string }> }> {
  const parents = new Map<string, Set<string>>(), selfRefs = new Map<string, { from: string; to: string }>();
  const lists = await db.batch<{ parent: string; from_column: string; to_column: string; id: number }>(tables.map(table =>
    db.prepare('SELECT "table" AS parent,"from" AS from_column,"to" AS to_column,id FROM pragma_foreign_key_list(?)').bind(table)));
  tables.forEach((table, index) => {
    const keys = lists[index];
    parents.set(table, new Set(keys.results.filter(key => key.parent !== table && tables.includes(key.parent)).map(key => key.parent)));
    const self = keys.results.filter(key => key.parent === table);
    if (self.length === 1) selfRefs.set(table, { from: self[0].from_column, to: self[0].to_column });
  });
  const order: string[] = [], done = new Set<string>();
  while (order.length < tables.length) {
    const ready = tables.filter(table => !done.has(table) && [...parents.get(table)!].every(parent => done.has(parent))).sort();
    if (!ready.length) throw new RestoreError('foreign_key_cycle');
    for (const table of ready) { order.push(table); done.add(table); }
  }
  return { order, selfRefs };
}
/** Parents before children inside a self-referencing table (context_entries.supersedes_id), otherwise backup (rowid) order. */
function selfOrdered(rows: Row[], reference?: { from: string; to: string }): Row[] {
  if (!reference) return rows;
  const byKey = new Map(rows.map(row => [String(row[reference.to]), row])), placed = new Set<Row>(), ordered: Row[] = [];
  const visit = (row: Row, depth = 0) => {
    if (placed.has(row) || depth > rows.length) return;
    const parent = row[reference.from] === null ? undefined : byKey.get(String(row[reference.from]));
    if (parent && parent !== row) visit(parent, depth + 1);
    if (!placed.has(row)) { placed.add(row); ordered.push(row); }
  };
  for (const row of rows) visit(row);
  return ordered;
}
function jsonGroups(rows: Row[], maxBytes = 90_000): string[] {
  const groups: string[] = []; let current: string[] = [], size = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    if (current.length && size + text.length + 1 > maxBytes) { groups.push('[' + current.join(',') + ']'); current = []; size = 2; }
    current.push(text); size += text.length + 1;
  }
  if (current.length) groups.push('[' + current.join(',') + ']');
  return groups;
}

/**
 * Download and verify every object a manifest lists, load it into a scratch database with
 * triggers deferred, recreate the triggers from the same migration text and check the
 * invariants those triggers normally guard. Always returns a report; never throws for data.
 */
export async function restoreCheck(options: { checkpointId: string; source: BackupSource; expectedManifestSha256: string; workDir: string;
  /** Tests only: a copy of the committed migrations plus a simulated later track. The CLI always uses migrations/. */
  migrationsDirectory?: string }): Promise<RestoreReport> {
  const failures = new Map<string, number>(), findings = new Map<string, number>(), checks: string[] = [];
  const fail = (code: string, count = 1) => failures.set(code, (failures.get(code) ?? 0) + count);
  const note = (code: string, count: number) => { if (count) findings.set(code, (findings.get(code) ?? 0) + count); };
  const report = (counts: RestoreReport['counts'], triggers = { expected: 0, matched: 0 }): RestoreReport => ({
    format: 'beacon.restore-check.v1', checkpoint_id: options.checkpointId, manifest_sha256: options.expectedManifestSha256,
    result: failures.size ? 'failed' : 'passed', counts,
    failures: [...failures].sort(([a], [b]) => a < b ? -1 : 1).map(([code, count]) => ({ code, count })),
    findings: [...findings].sort(([a], [b]) => a < b ? -1 : 1).map(([code, count]) => ({ code, count })), triggers, checks });
  if (!UUID.test(options.checkpointId) || !HASH.test(options.expectedManifestSha256)) { fail('invalid_checkpoint'); return report({ tables: {}, raw_objects: 0 }); }
  const objects = join(options.workDir, 'objects');
  await mkdir(objects, { recursive: true, mode: 0o700 });
  const rawPaths = new Map<string, string>();
  const save = async (key: string, bytes: Uint8Array) => {
    const path = join(objects, sha256(key));
    await writeFile(path, bytes, { mode: 0o600 });
    if (key.startsWith('raw/')) rawPaths.set(key, path);
  };
  let manifest: Manifest;
  const rows = new Map<string, Row[]>(), raw: RawEntry[] = [];
  try {
    const manifestKey = `checkpoints/${options.checkpointId}/manifest.json`;
    const bytes = await fetchVerified(options.source, manifestKey, options.expectedManifestSha256, null, save, 'manifest');
    try { manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)), options.checkpointId); }
    catch (error) { throw error instanceof RestoreError ? error : new RestoreError('invalid_manifest'); }
    checks.push('manifest_sha256');
    for (const chunk of manifest.chunks) {
      const body = await fetchVerified(options.source, chunk.key, chunk.sha256, chunk.bytes, save, 'chunk');
      const counted: Record<string, number> = {};
      for (const text of lines(body)) {
        const value = JSON.parse(text);
        if (chunk.kind === 'raw_list') {
          if (!HASH.test(value.batch_id) || !RAW_KEY.test(value.key) || !Number.isInteger(value.size) || !HASH.test(value.sha256)) throw new RestoreError('invalid_manifest_key');
          raw.push(value); counted.raw_objects = (counted.raw_objects ?? 0) + 1;
          continue;
        }
        if (!(value.t in manifest.table_counts) || !value.r || typeof value.r !== 'object' || Array.isArray(value.r)) throw new RestoreError('invalid_chunk_row');
        for (const field of Object.values(value.r)) if (field !== null && typeof field === 'object') throw new RestoreError('invalid_chunk_row');
        (rows.get(value.t) ?? rows.set(value.t, []).get(value.t)!).push(value.r);
        counted[value.t] = (counted[value.t] ?? 0) + 1;
      }
      if (Object.entries(chunk.rows).some(([name, count]) => (counted[name] ?? 0) !== count)
        || Object.keys(counted).some(name => !(name in chunk.rows))) fail('chunk_row_count_mismatch');
    }
    checks.push('chunk_sha256');
    if (raw.length !== manifest.raw.objects) fail('raw_object_count_mismatch');
    for (const entry of raw) {
      try { await fetchVerified(options.source, entry.key, entry.sha256, entry.size, save, 'raw'); }
      catch (error) { if (error instanceof RestoreError) fail(error.code); else throw error; }
    }
    checks.push('raw_sha256');
  } catch (error) {
    if (!(error instanceof RestoreError)) throw error;
    fail(error.code);
    return report({ tables: {}, raw_objects: 0 });
  }

  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(options.workDir, 'miniflare'), workers: [{
    name: 'beacon-restore-check', modules: true as const, script: 'export default {fetch(){return new Response("restore-check")}}',
    compatibilityDate: '2026-10-01', d1Databases: { DB: 'restore-check-index' }, r2Buckets: { RAW: 'restore-check-raw' } }] }));
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database, bucket = await mf.getR2Bucket('RAW');
    const deferred = await applyMigrationStatements(db, { deferTriggers: true, directory: options.migrationsDirectory });
    const tables = Object.keys(manifest.table_counts).sort();
    const columns = new Map<string, Set<string>>();
    // Read-only lookups go in D1 batches: one local round trip each instead of one per table.
    const infos = tables.length ? await db.batch<{ name: string }>(tables.map(table => db.prepare('SELECT name FROM pragma_table_info(?)').bind(table))) : [];
    tables.forEach((table, index) => {
      if (!infos[index].results.length) { fail('unknown_table'); return; }
      columns.set(table, new Set(infos[index].results.map(row => row.name)));
    });
    if (failures.size) return report({ tables: {}, raw_objects: raw.length });
    const { order, selfRefs } = await loadOrder(db, tables);
    // Migrations may seed rows (single-row state tables); the checkpoint's rows replace them.
    await db.batch([...order].reverse().map(table => db.prepare(`DELETE FROM "${table}"`)));
    for (const table of order) {
      const list = selfOrdered(rows.get(table) ?? [], selfRefs.get(table));
      const names = [...new Set(list.flatMap(row => Object.keys(row)))];
      if (names.some(name => !columns.get(table)!.has(name) || !TABLE.test(name))) { fail('unknown_column'); continue; }
      if (!list.length) continue;
      const insert = `INSERT INTO "${table}"(${names.map(name => `"${name}"`).join(',')}) SELECT ${names.map(name => `json_extract(value,'$."${name}"')`).join(',')} FROM json_each(?)`;
      const groups = jsonGroups(list);
      for (let index = 0; index < groups.length; index += 50) await db.batch(groups.slice(index, index + 50).map(group => db.prepare(insert).bind(group)));
    }
    checks.push('load_in_foreign_key_order');
    for (const entry of raw) {
      const path = rawPaths.get(entry.key);
      if (path) await bucket.put(entry.key.slice(4), new Uint8Array(await readFile(path)));
    }
    // Recreate triggers from the same migration text and compare what SQLite stored.
    let matched = 0;
    if (deferred.length) {
      await db.batch(deferred.map(statement => db.prepare(statement.sql)));
      const stored = await db.batch<{ sql: string }>(deferred.map(statement =>
        db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(statement.trigger)));
      deferred.forEach((statement, index) => { if (stored[index].results[0]?.sql === normalizedStatement(statement.sql)) matched++; });
    }
    if (matched !== deferred.length) fail('trigger_mismatch', deferred.length - matched);
    checks.push('triggers_recreated');
    const fk = await db.prepare('PRAGMA foreign_key_check').all();
    if (fk.results.length) fail('foreign_key_violation', fk.results.length);
    checks.push('foreign_key_check');
    const counts: Record<string, number> = {};
    const totals = tables.length ? await db.batch<{ n: number }>(tables.map(table => db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`))) : [];
    tables.forEach((table, index) => {
      counts[table] = totals[index].results[0].n;
      if (counts[table] !== manifest.table_counts[table]) fail('row_count_mismatch');
    });
    checks.push('row_counts');
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
    if (columns.has('context_entries') && columns.has('context_audit') && columns.has('context_sources')) {
      for (const [code, sql] of [
        ['context_review_state_invalid', `SELECT COUNT(*) AS n FROM context_entries WHERE NOT ((status='pending' AND review_id IS NULL AND reviewed_at IS NULL
          AND reviewed_by IS NULL) OR (status!='pending' AND review_id IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))`],
        ['context_review_audit_missing', `SELECT COUNT(*) AS n FROM context_entries c WHERE c.status IN ('approved','rejected','superseded')
          AND NOT EXISTS(SELECT 1 FROM context_audit a WHERE a.id=c.review_id AND a.context_id=c.id
          AND a.action=CASE WHEN c.status='rejected' THEN 'reject' ELSE 'approve' END)`],
        ['context_supersede_invalid', `SELECT COUNT(*) AS n FROM context_entries c WHERE c.status='superseded' AND NOT EXISTS(
          SELECT 1 FROM context_entries child JOIN context_audit a ON a.id=child.review_id||':supersede' AND a.context_id=c.id AND a.action='supersede'
          WHERE child.supersedes_id=c.id AND child.status IN ('approved','superseded'))`],
        ['context_sources_count_invalid', `SELECT COUNT(*) AS n FROM context_entries c WHERE (c.sealed=1
          AND (SELECT COUNT(*) FROM context_sources s WHERE s.context_id=c.id) NOT BETWEEN 1 AND 20) OR (c.sealed=0 AND c.status!='pending')`],
      ] as const) { const n = await count(sql); if (n) fail(code, n); }
      checks.push('context_review_invariants');
    }
    if (columns.has('devices')) {
      const devices = await db.prepare('SELECT COUNT(*) AS n,COUNT(DISTINCT token_hash) AS digests FROM devices').first<{ n: number; digests: number }>();
      if (devices!.n !== manifest.table_counts.devices || devices!.digests !== devices!.n) fail('device_token_digest_mismatch');
      checks.push('device_identity');
    }
    if (columns.has('event_versions') && columns.has('batches')) {
      // Every exact version must re-hash from its raw line; raw objects come only from the manifest.
      let after = 0, cachedKey = '', cachedLines: string[] = [];
      const referenced = new Set<string>();
      for (;;) {
        const page = await db.prepare(`SELECT v.rowid AS position,v.payload_hash,v.line_number,b.r2_key FROM event_versions v
          JOIN batches b ON b.id=v.batch_id WHERE v.rowid>? ORDER BY v.rowid LIMIT 2000`).bind(after)
          .all<{ position: number; payload_hash: string; line_number: number; r2_key: string }>();
        if (!page.results.length) break;
        for (const version of page.results) {
          after = version.position;
          const key = 'raw/' + version.r2_key, path = rawPaths.get(key);
          referenced.add(key);
          if (!path) { fail('raw_not_in_manifest'); continue; }
          if (cachedKey !== key) { cachedKey = key; cachedLines = new TextDecoder().decode(await readFile(path)).split('\n'); }
          const text = cachedLines[version.line_number];
          if (!text) { fail('raw_line_missing'); continue; }
          let hash = '';
          try { hash = sha256(stableJSON(JSON.parse(text))); } catch { /* counted as a mismatch below */ }
          if (hash !== version.payload_hash) fail('payload_hash_mismatch');
        }
      }
      note('raw_unreferenced', [...rawPaths.keys()].filter(key => !referenced.has(key)).length);
      checks.push('payload_rehash');
    }
    if (columns.has('events') && columns.has('sessions')) {
      // Ingest may upgrade a session's project after its events were chunked: a finding, not a failure.
      note('event_project_drift', await count('SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.project_id!=s.project_id'));
      checks.push('project_drift');
    }
    return report({ tables: counts, raw_objects: raw.length }, { expected: deferred.length, matched });
  } catch (error) {
    if (!(error instanceof RestoreError)) throw error;
    fail(error.code);
    return report({ tables: {}, raw_objects: raw.length });
  } finally { await mf.dispose(); }
}

export function reportSha256(report: RestoreReport): string { return sha256(stableJSON(report)); }
/** The body for POST /api/backups/:id/verify after a drill. */
export function verifyRequest(report: RestoreReport) {
  return { result: report.result, report_sha256: reportSha256(report), counts: report.counts };
}

/** The token file must be an absolute, private (0600) regular file; its value is never printed. */
export async function readReviewToken(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new RestoreError('token_file_not_absolute');
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new RestoreError('token_file_not_regular');
  if ((info.mode & 0o077) !== 0) throw new RestoreError('token_file_not_private');
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[^\s]{32,512}$/.test(token)) throw new RestoreError('token_file_invalid');
  return token;
}
export function workerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RestoreError('invalid_url'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw new RestoreError('invalid_url');
  return url;
}
export function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    if (!['url', 'review-token-file', 'checkpoint', 'out', 'dir'].includes(name) || argv[index + 1] === undefined || name in options) throw new RestoreError('usage');
    options[name] = argv[index + 1];
  }
  const remote = 'url' in options || 'review-token-file' in options;
  if (!options.checkpoint || !UUID.test(options.checkpoint) || remote === ('dir' in options) || (remote && !(options.url && options['review-token-file']))
    || ('dir' in options && 'out' in options) || [options.out, options.dir].some(path => path !== undefined && !isAbsolute(path))) throw new RestoreError('usage');
  return options;
}

/**
 * The command itself, with its output and fetch injectable for tests. Exit codes: 0 passed,
 * 1 failed checks, 2 refused or unable to run. Only codes, counts and hashes are written.
 */
export async function runCli(argv: string[], io: { fetch?: typeof fetch; log?: (text: string) => void; error?: (text: string) => void } = {}): Promise<number> {
  const log = io.log ?? (text => console.log(text)), fail = io.error ?? (text => console.error(text));
  try {
    const options = parseArgs(argv), checkpointId = options.checkpoint;
    let workDir: string, keep = false, source: BackupSource, expected: string;
    if (options.dir) {
      const saved = JSON.parse(await readFile(join(options.dir, 'checkpoint.json'), 'utf8')) as { checkpoint_id?: string; manifest_sha256?: string };
      if (saved.checkpoint_id !== checkpointId || !HASH.test(saved.manifest_sha256 ?? '')) throw new RestoreError('invalid_local_backup');
      source = dirSource(options.dir); expected = saved.manifest_sha256!;
      workDir = await mkdtemp(join(tmpdir(), 'beacon-restore-'));
    } else {
      const remote = httpSource(workerUrl(options.url), await readReviewToken(options['review-token-file']), checkpointId, io.fetch);
      source = remote; expected = await remote.manifestSha256();
      if (options.out) {
        let entries: string[] = [];
        try { entries = await readdir(options.out); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (entries.length) throw new RestoreError('out_not_empty');
        await mkdir(options.out, { recursive: true, mode: 0o700 });
        workDir = options.out; keep = true;
      } else workDir = await mkdtemp(join(tmpdir(), 'beacon-restore-'));
    }
    await chmod(workDir, 0o700);
    try {
      const report = await restoreCheck({ checkpointId, source, expectedManifestSha256: expected, workDir });
      if (keep) await writeFile(join(workDir, 'checkpoint.json'), JSON.stringify({ checkpoint_id: checkpointId, manifest_sha256: expected }), { mode: 0o600 });
      log(JSON.stringify({ report, report_sha256: reportSha256(report), verify_request: verifyRequest(report) }, null, 2));
      return report.result === 'passed' ? 0 : 1;
    } finally { if (!keep) await rm(workDir, { recursive: true, force: true }); }
  } catch (error) {
    // Codes only: never echo arguments, paths or the token.
    fail(JSON.stringify({ error: error instanceof RestoreError ? error.code : 'restore_check_failed' }));
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
