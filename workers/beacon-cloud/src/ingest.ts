import { digest } from './auth';
import { field, projectIdentity, required, stableJSON } from './identity';
import { Device, Env, HttpError, RecordData, json } from './types';

export const MAX_BYTES = 1024 * 1024;
export const MAX_EVENTS = 100;
async function boundedBody(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) throw new HttpError(400, 'Empty batch');
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new HttpError(413, 'Batch exceeds 1 MiB'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

export async function ingest(request: Request, env: Env, device: Device, stream: string): Promise<Response> {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/x-ndjson')
    throw new HttpError(415, 'Use application/x-ndjson');
  let bytes = await boundedBody(request.body);
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding !== 'identity') {
    if (encoding !== 'gzip') throw new HttpError(415, 'Unsupported content encoding');
    try {
      bytes = await boundedBody(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'Invalid gzip batch');
    }
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new HttpError(400, 'Invalid UTF-8'); }
  const lines = text.split('\n').map((line, line_number) => ({line, line_number})).filter(({line}) => line.trim());
  if (!lines.length || lines.length > MAX_EVENTS) throw new HttpError(400, 'Batch requires 1–100 events');
  const batchId = await digest(stableJSON([device.id, stream, await digest(bytes)]));
  const r2Key = `batches/${device.id}/${stream}/${batchId}.ndjson`;
  const records = await Promise.all(lines.map(async ({line, line_number}) => {
    let record: RecordData;
    try { record = JSON.parse(line); }
    catch { throw new HttpError(400, `Invalid JSON at line ${line_number + 1}`); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new HttpError(400, 'Expected event object');
    if (record.vendor !== 'beacon' || record.schema_version !== '1.0') throw new HttpError(400, 'Unsupported Beacon schema');
    if ([field(record, 'device_id'),field(record, 'device', 'id')].some(id=>id && id!==device.id))
      throw new HttpError(403, 'Device identity mismatch');
    const event_id = required(record, 'event', 'id');
    const action = required(record, 'event', 'action');
    const rawTime = required(record, 'timestamp');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(rawTime) || !/(Z|[+-]\d{2}:\d{2})$/.test(rawTime) || !Number.isFinite(Date.parse(rawTime)))
      throw new HttpError(400, 'Invalid timestamp');
    const timestamp = new Date(rawTime).toISOString();
    const harness = field(record, 'harness', 'name') || 'unknown';
    if (harness.length > 512) throw new HttpError(400, 'Invalid harness.name');
    const nativeSession = field(record, 'session', 'id');
    // Missing native identity is explicitly unscoped: do not fabricate one shared
    // session for unrelated repositories or jobs on the same machine/day.
    const source_session_id = nativeSession || `unscoped-event:${event_id}`;
    if (source_session_id.length > 512) throw new HttpError(400, 'Invalid session.id');
    return { id: await digest(stableJSON([device.id, stream, event_id])), device_id: device.id,
      stream, event_id, action, timestamp, harness, source_session_id,
      session_id: stream === 'runtime' ? await digest(stableJSON([device.id,harness,nativeSession?'native':'unscoped',source_session_id])) : null,
      project: await projectIdentity(record, device.id), line_number, batch_id: batchId,
      payload_hash: await digest(stableJSON(record)) };
  }));
  const sessionIds = [...new Set(records.map(r=>r.session_id).filter(Boolean))];
  const existing = await env.DB.prepare(`SELECT s.id,p.id AS project_id,p.identity,p.name,p.identity_kind AS kind
    FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(sessionIds)).all<{id:string;project_id:string;identity:string;name:string;kind:string}>();
  const prior = new Map(existing.results.map(s=>[s.id,s]));
  for (const id of sessionIds) {
    const group = records.filter(r=>r.session_id===id);
    const remote = group.find(r=>r.project.kind==='remote')?.project;
    const previous = prior.get(id!);
    if (remote && ((previous?.kind==='remote' && previous.identity!==remote.identity) ||
      group.some(r=>r.project.kind==='remote' && r.project.id!==remote.id))) throw new HttpError(409, 'Session project identity conflict');
    const candidate = remote || group.find(r=>r.project.kind==='device_path')?.project || group[0].project;
    const strength = (kind:string)=>kind==='remote'?2:kind==='device_path'?1:0;
    const chosen = previous && strength(previous.kind)>=strength(candidate.kind)
      ? {id:previous.project_id,identity:previous.identity,name:previous.name,kind:previous.kind} : candidate;
    for (const record of group) record.project = chosen as typeof record.project;
  }
  // R2 precedes the atomic D1 index transaction. A crash can leave a harmless orphan;
  // a retry overwrites the same content-addressed object and completes the index.
  await env.RAW.put(r2Key, bytes, { httpMetadata: { contentType: 'application/x-ndjson' } });
  const input = JSON.stringify(records.map(r=>({...r,project_id:r.project.id})));
  const prepare = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args);
  let results: D1Result[];
  try { results = await env.DB.batch([
    prepare(`INSERT INTO batches(id,device_id,stream,r2_key,received_at,event_count) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      batchId,device.id,stream,r2Key,new Date().toISOString(),records.length),
    prepare(`INSERT INTO projects(id,name,identity,identity_kind)
      SELECT DISTINCT json_extract(value,'$.project.id'),json_extract(value,'$.project.name'),
      json_extract(value,'$.project.identity'),json_extract(value,'$.project.kind') FROM json_each(?) WHERE true
      ON CONFLICT(id) DO NOTHING`,input),
    prepare(`INSERT INTO sessions(id,device_id,source_session_id,project_id,harness,started_at,last_event_at)
      SELECT json_extract(value,'$.session_id'),json_extract(value,'$.device_id'),json_extract(value,'$.source_session_id'),
      json_extract(value,'$.project_id'),json_extract(value,'$.harness'),MIN(json_extract(value,'$.timestamp')),MAX(json_extract(value,'$.timestamp'))
      FROM json_each(?) WHERE json_extract(value,'$.session_id') IS NOT NULL GROUP BY json_extract(value,'$.session_id')
      ON CONFLICT(id) DO UPDATE SET started_at=MIN(sessions.started_at,excluded.started_at),
      last_event_at=MAX(sessions.last_event_at,excluded.last_event_at),project_id=CASE
      WHEN (SELECT identity_kind FROM projects WHERE id=excluded.project_id)='remote' THEN excluded.project_id
      WHEN (SELECT identity_kind FROM projects WHERE id=sessions.project_id)='unknown' THEN excluded.project_id
      ELSE sessions.project_id END`,input),
    prepare(`INSERT INTO events(id,device_id,stream,event_id,session_id,project_id,timestamp,action,harness,batch_id,line_number,payload_hash)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.device_id'),json_extract(value,'$.stream'),json_extract(value,'$.event_id'),
      json_extract(value,'$.session_id'),json_extract(value,'$.project_id'),json_extract(value,'$.timestamp'),json_extract(value,'$.action'),
      json_extract(value,'$.harness'),json_extract(value,'$.batch_id'),json_extract(value,'$.line_number'),json_extract(value,'$.payload_hash')
      FROM json_each(?) WHERE true ON CONFLICT(id) DO NOTHING`,input),
    prepare(`INSERT INTO event_versions(event_id,payload_hash,batch_id,line_number)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.payload_hash'),json_extract(value,'$.batch_id'),json_extract(value,'$.line_number')
      FROM json_each(?) WHERE true ON CONFLICT(event_id,payload_hash) DO NOTHING`,input),
    prepare(`UPDATE events SET project_id=(SELECT s.project_id FROM sessions s WHERE s.id=events.session_id)
      WHERE session_id IN (SELECT value FROM json_each(?))`,JSON.stringify(sessionIds)),
    prepare('UPDATE devices SET last_seen=? WHERE id=?',new Date().toISOString(),device.id)
  ]); } catch (error) {
    if (String(error).includes('session_project_conflict')) throw new HttpError(409,'Session project identity conflict');
    throw error;
  }
  return json({ batch_id:batchId, accepted:records.length, inserted:results[3].meta.changes,
    duplicate:results[0].meta.changes === 0 });
}
