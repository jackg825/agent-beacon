#!/usr/bin/env node
// An opt-in customer-managed shipper. Beacon hooks and collectors are unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve, join, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code) => Object.assign(new Error(code), { code });

async function syncDir(path) {
  const handle = await fs.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Queue files are immutable; state replacement occurs only after the queue is durable.
async function atomicJSON(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temporary, path); } finally { await fs.rm(temporary, { force: true }); }
  await syncDir(dirname(path));
}

async function boundedJSON(response) {
  if ((response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) {
    await response.body?.cancel(); throw fail('INVALID_SERVER_RESPONSE');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5000) { await reader.cancel(); throw fail('INVALID_SERVER_RESPONSE'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(decoder.decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}

function positive(value, fallback, maximum, name) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw fail(`INVALID_${name}`);
  return number;
}

function safeRemote(remote) {
  if (typeof remote !== 'string' || !remote || remote.length > 2048 || /[\s?#]/.test(remote)) throw fail('INVALID_PROJECT_REMOTE');
  if (/^git@[^/:]+:[^/].+$/.test(remote)) return remote;
  let url;
  try { url = new URL(remote); } catch { throw fail('INVALID_PROJECT_REMOTE'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || (url.protocol === 'https:' && url.username)) throw fail('PROJECT_REMOTE_CONTAINS_CREDENTIALS');
  if (url.protocol === 'ssh:' && url.username && url.username !== 'git') throw fail('INVALID_PROJECT_REMOTE');
  return remote;
}

// Match the Worker's supported repository URL shapes without normalizing or
// rewriting the source field. Local paths and file:// URLs need explicit mapping.
function hasRepositoryRemote(value) {
  if (typeof value !== 'string') return false;
  let remote = value.trim();
  if (/^[^/@:]+@[^/:]+:.+/.test(remote)) remote = remote.replace(/^[^@]+@([^:]+):(.+)$/, 'ssh://$1/$2');
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return false;
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return !!path && !path.split('/').some(part => !part || part === '.' || part === '..') && !/[\s?#\\]/.test(path);
  } catch { return false; }
}

export async function loadConfig(configOrPath) {
  const config = typeof configOrPath === 'string' ? JSON.parse(await fs.readFile(configOrPath, 'utf8')) : structuredClone(configOrPath);
  if (!isObject(config) || !isObject(config.streams)) throw fail('INVALID_CONFIG');
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { throw fail('INVALID_ENDPOINT'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(config.allowLocalHttp === true && endpoint.protocol === 'http:' && local)) throw fail('HTTPS_REQUIRED');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) throw fail('INVALID_ENDPOINT');
  for (const field of ['stateDir', 'tokenFile']) if (typeof config[field] !== 'string' || !isAbsolute(config[field])) throw fail(`ABSOLUTE_${field.toUpperCase()}_REQUIRED`);
  const streams = {};
  for (const [name, source] of Object.entries(config.streams)) {
    if (!['runtime', 'inventory'].includes(name) || !isObject(source) || typeof source.path !== 'string' || !isAbsolute(source.path)) throw fail('INVALID_STREAM');
    const readFrom = source.readFrom ?? (name === 'runtime' ? 'end' : 'beginning');
    if (!['beginning', 'end'].includes(readFrom)) throw fail('INVALID_READ_FROM');
    streams[name] = { path: source.path, readFrom, rotations: positive(source.rotations, 5, 100, 'ROTATIONS') };
  }
  if (!Object.keys(streams).length) throw fail('STREAM_REQUIRED');
  const mappings = (config.projectMappings ?? []).map((mapping) => {
    if (!isObject(mapping) || typeof mapping.path !== 'string' || !isAbsolute(mapping.path)) throw fail('INVALID_PROJECT_MAPPING');
    return { path: resolve(mapping.path), remote: safeRemote(mapping.remote) };
  }).sort((a, b) => b.path.length - a.path.length);
  return {
    endpoint: endpoint.origin, tokenFile: config.tokenFile, stateDir: config.stateDir, streams, projectMappings: mappings,
    pollIntervalMs: positive(config.pollIntervalMs, 2000, 300000, 'POLL_INTERVAL'),
    maxQueueBytes: positive(config.maxQueueBytes, 512 * 1024 * 1024, 1024 * 1024 * 1024, 'QUEUE_BYTES'),
    maxBatchEvents: positive(config.maxBatchEvents, 100, 100, 'BATCH_EVENTS'),
    maxBatchBytes: positive(config.maxBatchBytes, 1024 * 1024, 1024 * 1024, 'BATCH_BYTES'),
    timeoutMs: positive(config.timeoutMs, 30000, 120000, 'TIMEOUT'),
  };
}

export function prepareEvent(line, config) {
  let event;
  try { event = JSON.parse(decoder.decode(line)); } catch { throw fail('INVALID_SOURCE_JSON'); }
  if (!isObject(event) || !isObject(event.event)) throw fail('INVALID_SOURCE_EVENT');
  // Preserve upstream event.id. Legacy ID-less records derive identity before enrichment,
  // so moving a checkout or changing project mappings does not rename an event.
  if (event.event.id === undefined || event.event.id === '') event.event.id = `forwarder-sha256:${hash(line)}`;
  if (typeof event.event.id !== 'string' || event.event.id.length > 256) throw fail('INVALID_EVENT_ID');
  const observedRemote = [event.project?.remote, event.vcs?.repository?.url?.full, event.repository, event.run?.repository]
    .some(hasRepositoryRemote);
  if (!observedRemote && typeof event.session?.working_directory === 'string') {
    if (!isAbsolute(event.session.working_directory)) return `${JSON.stringify(event)}\n`;
    const cwd = resolve(event.session.working_directory);
    const mapping = config.projectMappings.find((item) => cwd === item.path || cwd.startsWith(`${item.path}${sep}`));
    if (mapping) event.project = { ...(isObject(event.project) ? event.project : {}), remote: mapping.remote };
  }
  return `${JSON.stringify(event)}\n`;
}

export class Forwarder {
  static async open(configOrPath, options = {}) {
    const config = await loadConfig(configOrPath);
    await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(config.stateDir);
    if (!dirStat.isDirectory() || (dirStat.mode & 0o077)) throw fail('PRIVATE_STATE_DIRECTORY_REQUIRED');
    const lockPath = join(config.stateDir, 'forwarder.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') throw fail('FORWARDER_LOCKED');
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await lock.sync();
      await fs.mkdir(join(config.stateDir, 'outbox'), { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') { await lock.close(); await fs.rm(lockPath, { force: true }); throw error; }
    }
    try {
      const outboxStat = await fs.lstat(join(config.stateDir, 'outbox'));
      if (!outboxStat.isDirectory() || (outboxStat.mode & 0o077)) throw fail('PRIVATE_OUTBOX_REQUIRED');
      let state;
      try { state = JSON.parse(await fs.readFile(join(config.stateDir, 'checkpoint.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw fail('INVALID_CHECKPOINT'); state = { version: 1, streams: {} }; }
      if (state.version !== 1 || !isObject(state.streams)) throw fail('INVALID_CHECKPOINT');
      if (state.destination) {
        if (!isObject(state.destination) || typeof state.destination.endpoint !== 'string' ||
          typeof state.destination.deviceId !== 'string' || !state.destination.deviceId || state.destination.deviceId.length > 512) throw fail('INVALID_CHECKPOINT');
        if (state.destination.endpoint !== config.endpoint) throw fail('ENDPOINT_NAMESPACE_MISMATCH');
      } else if (Object.keys(state.streams).length || (await fs.readdir(join(config.stateDir, 'outbox'))).some(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        // Older unbound checkpoints cannot prove where queued private telemetry belongs.
        throw fail('UNBOUND_EXISTING_STATE');
      }
      return new Forwarder(config, state, lock, options);
    } catch (error) { await lock.close(); await fs.rm(lockPath, { force: true }); throw error; }
  }

  constructor(config, state, lock, options) {
    this.config = config; this.state = state; this.lock = lock;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.outbox = join(config.stateDir, 'outbox'); this.closed = false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.lock.close();
    await fs.rm(join(this.config.stateDir, 'forwarder.lock'));
    await syncDir(this.config.stateDir);
  }

  async save() { await atomicJSON(join(this.config.stateDir, 'checkpoint.json'), this.state); }

  async queueFiles() { return (await fs.readdir(this.outbox)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }

  async queueBytes() {
    let bytes = 0;
    for (const name of await this.queueFiles()) bytes += (await fs.stat(join(this.outbox, name))).size;
    return bytes;
  }

  async readToken() {
    const stat = await fs.lstat(this.config.tokenFile);
    if (!stat.isFile() || (stat.mode & 0o077)) throw fail('PRIVATE_TOKEN_FILE_REQUIRED');
    const token = (await fs.readFile(this.config.tokenFile, 'utf8')).trim();
    if (!token || /\s/.test(token) || token.length > 4096) throw fail('INVALID_TOKEN_FILE');
    return token;
  }

  async authenticate() {
    this.verifiedDeviceId = null;
    const token = await this.readToken();
    let response;
    try {
      response = await this.fetch(`${this.config.endpoint}/v1/ingest/health`, {
        method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch { return { blocked: 'NETWORK_UNAVAILABLE' }; }
    if (!response.ok) { await response.body?.cancel(); return { blocked: `HTTP_${response.status}` }; }
    let health;
    try { health = await boundedJSON(response); } catch { return { blocked: 'INVALID_HEALTH_RESPONSE' }; }
    if (response.status !== 200 || !isObject(health) || health.status !== 'ok' ||
      typeof health.device_id !== 'string' || !health.device_id || health.device_id.length > 512 || /\s/.test(health.device_id)) {
      return { blocked: 'INVALID_HEALTH_RESPONSE' };
    }
    if (this.state.destination && this.state.destination.deviceId !== health.device_id) throw fail('DEVICE_NAMESPACE_MISMATCH');
    if (!this.state.destination) {
      this.state.destination = { endpoint: this.config.endpoint, deviceId: health.device_id };
      await this.save(); // Bind before observing sources, writing queues, or advancing checkpoints.
    }
    this.verifiedDeviceId = health.device_id;
    return { token, blocked: null };
  }

  async drain(token) {
    if (!this.state.destination || this.verifiedDeviceId !== this.state.destination.deviceId || !token) throw fail('DEVICE_IDENTITY_NOT_VERIFIED');
    let sent = 0;
    const files = await this.queueFiles();
    if (!files.length) return { sent, blocked: null };
    for (const name of files) {
      const record = JSON.parse(await fs.readFile(join(this.outbox, name), 'utf8'));
      if (record.version !== 1 || !['runtime', 'inventory'].includes(record.stream) || typeof record.body !== 'string' ||
        !Number.isSafeInteger(record.eventCount) || record.eventCount < 1 || record.eventCount > 100 || hash(record.body) !== record.digest) throw fail('CORRUPT_OUTBOX');
      let response;
      try {
        response = await this.fetch(`${this.config.endpoint}/v1/ingest/${record.stream}`, {
          method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
          body: record.body, signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch { return { sent, blocked: 'NETWORK_UNAVAILABLE' }; }
      // Never log a server's body: it may contain user data or an echoed secret.
      if (!response.ok) {
        await response.body?.cancel();
        return { sent, blocked: `HTTP_${response.status}` };
      }
      let acknowledgement;
      try { acknowledgement = await boundedJSON(response); } catch { return { sent, blocked: 'INVALID_INGEST_ACK' }; }
      const expectedBatchId = hash(JSON.stringify([this.state.destination.deviceId, record.stream, record.digest]));
      if (response.status !== 200 || !isObject(acknowledgement) || acknowledgement.batch_id !== expectedBatchId ||
        !Number.isSafeInteger(acknowledgement.accepted) || acknowledgement.accepted !== record.eventCount) {
        return { sent, blocked: 'INVALID_INGEST_ACK' };
      }
      await fs.rm(join(this.outbox, name));
      await syncDir(this.outbox);
      sent += record.eventCount;
    }
    return { sent, blocked: null };
  }

  async scan() {
    let queued = 0;
    let queueBytes = await this.queueBytes();
    let full = false;
    for (const [stream, source] of Object.entries(this.config.streams)) {
      const streamState = this.state.streams[stream] ??= { initialized: false, files: {} };
      const candidates = [];
      // Read oldest retained archive first. File identity follows renames, not paths.
      for (let n = source.rotations; n >= 0; n--) {
        const path = n ? `${source.path}.${n}` : source.path;
        try {
          const handle = await fs.open(path, 'r');
          const stat = await handle.stat();
          if (!stat.isFile()) { await handle.close(); throw fail('INVALID_SOURCE_FILE'); }
          candidates.push({ path, handle, stat, key: `${stat.dev}:${stat.ino}` });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      try {
        for (const { handle, stat, key } of candidates) {
          const prefixBuffer = Buffer.alloc(Math.min(256, stat.size));
          await handle.read(prefixBuffer, 0, prefixBuffer.length, 0);
          const prefix = prefixBuffer.toString('base64');
          let checkpoint = streamState.files[key];
          if (!checkpoint) {
            checkpoint = streamState.files[key] = { offset: !streamState.initialized && source.readFrom === 'end' ? stat.size : 0, prefix, skipPartial: false };
            if (checkpoint.offset > 0) {
              const tail = Buffer.alloc(1);
              await handle.read(tail, 0, 1, checkpoint.offset - 1);
              checkpoint.skipPartial = tail[0] !== 10;
            }
            await this.save();
          } else if (stat.size < checkpoint.offset || !prefixBuffer.subarray(0, Buffer.from(checkpoint.prefix, 'base64').length).equals(Buffer.from(checkpoint.prefix, 'base64'))) {
            // copytruncate or reused inode: replay the new generation from byte zero.
            checkpoint = streamState.files[key] = { offset: 0, prefix, skipPartial: false };
            await this.save();
          } else if (prefixBuffer.length > Buffer.from(checkpoint.prefix, 'base64').length) {
            checkpoint.prefix = prefix;
          }
          while (checkpoint.offset < stat.size && !full) {
            const buffer = Buffer.alloc(Math.min(this.config.maxBatchBytes + 1, stat.size - checkpoint.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, checkpoint.offset);
            const data = buffer.subarray(0, bytesRead);
            let consumed = 0;
            let body = '';
            let eventCount = 0;
            let skipPartial = checkpoint.skipPartial;
            for (let start = 0; start < data.length;) {
              const end = data.indexOf(10, start);
              if (end < 0) {
                if (skipPartial && !eventCount) { consumed = data.length; break; }
                if (!consumed && data.length > this.config.maxBatchBytes) throw fail('SOURCE_LINE_TOO_LARGE');
                break;
              }
              const line = data.subarray(start, end);
              if (skipPartial) { skipPartial = false; consumed = end + 1; start = end + 1; continue; }
              if (!line.toString('utf8').trim()) { consumed = end + 1; start = end + 1; continue; }
              if (eventCount >= this.config.maxBatchEvents) break;
              const prepared = prepareEvent(line, this.config);
              if (Buffer.byteLength(prepared) > this.config.maxBatchBytes) throw fail('SOURCE_EVENT_TOO_LARGE');
              if (Buffer.byteLength(body) + Buffer.byteLength(prepared) > this.config.maxBatchBytes) break;
              body += prepared; eventCount++; consumed = end + 1; start = end + 1;
            }
            if (!consumed) break; // An incomplete JSONL line stays unread until completed.
            if (eventCount) {
              const record = { version: 1, stream, body, eventCount, digest: hash(body) };
              const name = `${hash(`${stream}\0${key}\0${checkpoint.offset}\0${body}`)}.json`;
              const recordBytes = Buffer.byteLength(JSON.stringify(record));
              let exists = false;
              try { await fs.access(join(this.outbox, name)); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (!exists && queueBytes + recordBytes > this.config.maxQueueBytes) { full = true; break; }
              await atomicJSON(join(this.outbox, name), record);
              if (!exists) { queueBytes += recordBytes; queued += eventCount; }
            }
            checkpoint.offset += consumed;
            checkpoint.skipPartial = skipPartial;
            await this.save();
          }
        }
        // Initialization with no files must still remember the consent boundary.
        streamState.initialized = true;
        await this.save();
      } finally { await Promise.all(candidates.map(({ handle }) => handle.close())); }
    }
    return { queued, full };
  }

  async runOnce() {
    const authenticated = await this.authenticate();
    if (!this.state.destination) return { queued: 0, full: false, sent: 0, blocked: authenticated.blocked, pendingBatches: (await this.queueFiles()).length };
    const scanned = await this.scan();
    // A previously bound source may spool offline, but no body leaves disk until
    // the current token has been verified as the same device at the same origin.
    const drained = authenticated.blocked ? { sent: 0, blocked: authenticated.blocked } : await this.drain(authenticated.token);
    return { ...scanned, ...drained, pendingBatches: (await this.queueFiles()).length };
  }
}

export async function runOnce(configOrPath, options) {
  const forwarder = await Forwarder.open(configOrPath, options);
  try { return await forwarder.runOnce(); } finally { await forwarder.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const configPath = args.find((arg) => !arg.startsWith('--'));
  if (!configPath || args.some((arg) => arg.startsWith('--') && arg !== '--once')) throw fail('USAGE_NODE_FORWARDER_CONFIG_JSON_OPTIONAL_ONCE');
  const forwarder = await Forwarder.open(configPath);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let retryDelay = forwarder.config.pollIntervalMs;
  try {
    do {
      const result = await forwarder.runOnce();
      // Only counters and fixed codes. No tokens, telemetry, URLs, paths or response bodies.
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (once || stopping) break;
      retryDelay = result.blocked ? Math.min(retryDelay * 2, 60000) : forwarder.config.pollIntervalMs;
      await new Promise((done) => setTimeout(done, retryDelay));
    } while (!stopping);
  } finally { await forwarder.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.code ?? 'FORWARDER_FAILED'}\n`); process.exitCode = 1; });
}
