import { Env, HttpError } from './types';
import { digest } from './auth';
import { field, projectIdentity, stableJSON } from './identity';

export function pageLimit(params: URLSearchParams): number {
  const raw = params.get('limit');
  if (raw && !/^\d+$/.test(raw)) throw new HttpError(400,'Invalid limit');
  const limit = raw ? Number(raw) : 25;
  if (limit < 1 || limit > 40) throw new HttpError(400,'Limit must be 1–40');
  return limit;
}
function encodeCursor(values: string[]): string { return btoa(JSON.stringify(values)); }
function decodeCursor(value: string): string[] {
  try {
    if (value.length > 2048) throw new Error();
    const parsed = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(v=>typeof v!=='string')) throw new Error();
    return parsed;
  } catch { throw new HttpError(400,'Invalid cursor'); }
}
const sessionSelect = `SELECT s.*,d.name AS device_name,p.name AS project_name,
  (SELECT COUNT(*) FROM events e WHERE e.session_id=s.id) AS event_count
  FROM sessions s JOIN devices d ON s.device_id=d.id JOIN projects p ON p.id=s.project_id`;

export async function listSessions(env: Env, params: URLSearchParams) {
  const limit = pageLimit(params), where = [], args: unknown[] = [];
  for (const [param,column] of [['device_id','s.device_id'],['project_id','s.project_id'],['harness','s.harness']]) {
    const value=params.get(param); if (value) { where.push(`${column}=?`); args.push(value); }
  }
  for (const [param, table, column] of [
    ['project_group_id', 'project_group_members', 'project_id=s.project_id AND group_id'],
    ['task_id', 'task_sessions', 'session_id=s.id AND task_id'],
  ]) {
    const value=params.get(param);
    if (value) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new HttpError(400,'Invalid workflow identifier');
      where.push(`EXISTS(SELECT 1 FROM ${table} WHERE ${column}=?)`); args.push(value);
    }
  }
  if (params.get('before')) {
    const [time,id] = decodeCursor(params.get('before')!);
    where.push('(s.last_event_at<? OR (s.last_event_at=? AND s.id<?))'); args.push(time,time,id);
  }
  const result = await env.DB.prepare(`${sessionSelect} ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY s.last_event_at DESC,s.id DESC LIMIT ?`).bind(...args,limit+1).all<Record<string,unknown>>();
  const sessions=result.results.slice(0,limit), last=sessions.at(-1);
  return {sessions,next_cursor:result.results.length>limit && last ? encodeCursor([String(last.last_event_at),String(last.id)]) : null};
}
export async function getTimeline(env: Env, sessionId: string, params: URLSearchParams) {
  const limit=pageLimit(params);
  const session=await env.DB.prepare(`${sessionSelect} WHERE s.id=?`).bind(sessionId).first();
  if (!session) throw new HttpError(404,'Session not found');
  const args: unknown[]=[sessionId]; let where='e.session_id=?';
  if (params.get('after')) {
    const [time,id]=decodeCursor(params.get('after')!);
    where+=' AND (e.timestamp>? OR (e.timestamp=? AND e.id>?))'; args.push(time,time,id);
  }
  const result=await env.DB.prepare(`SELECT e.*,b.r2_key,
    (SELECT COUNT(*) FROM event_versions v WHERE v.event_id=e.id) AS versions
    FROM events e JOIN batches b ON b.id=e.batch_id WHERE ${where} ORDER BY e.timestamp,e.id LIMIT ?`)
    .bind(...args,limit+1).all<{id:string;timestamp:string;r2_key:string;line_number:number}>();
  const rows=result.results.slice(0,limit);
  // Bound retained transcript memory as well as event count. Read sequentially,
  // retaining at most one raw batch, and stop at 2 MiB of returned payloads.
  const events=[]; let loadedKey='', lines:string[]=[], bytes=0;
  for (const row of rows) {
    if (row.r2_key!==loadedKey) {
      const object=await env.RAW.get(row.r2_key);
      if (!object) throw new HttpError(503,'Raw batch unavailable');
      lines=(await object.text()).split('\n'); loadedKey=row.r2_key;
    }
    const line=lines[row.line_number];
    if (!line) throw new HttpError(503,'Raw event unavailable');
    const size=new TextEncoder().encode(line).length;
    if (events.length && bytes+size>2*1024*1024) break;
    bytes+=size;
    const {r2_key,line_number,...index}=row;
    events.push({...index,payload:JSON.parse(line)});
  }
  const last=rows[events.length-1];
  return {session,events,next_cursor:result.results.length>events.length && last ? encodeCursor([last.timestamp,last.id]) : null};
}
export async function listProjects(env: Env) {
  const result=await env.DB.prepare(`SELECT p.* FROM projects p WHERE EXISTS(SELECT 1 FROM events e WHERE e.project_id=p.id)
    ORDER BY p.name,p.id LIMIT 1000`).all();
  return {projects:result.results};
}
export async function listDevices(env: Env) {
  const result=await env.DB.prepare('SELECT id,name,revoked,created_at,last_seen FROM devices ORDER BY name,id LIMIT 1000').all();
  return {devices:result.results};
}

/** Fetch a referenced immutable variant rather than substituting the first indexed payload. */
export async function getEventVersion(env: Env, eventId: string, params: URLSearchParams) {
  const hash=params.get('payload_hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new HttpError(400,'Exact payload_hash required');
  const row=await env.DB.prepare(`SELECT e.*,s.source_session_id,p.identity_kind,
    v.payload_hash AS selected_hash,v.batch_id AS selected_batch_id,v.line_number AS selected_line_number,b.r2_key
    FROM events e JOIN projects p ON p.id=e.project_id LEFT JOIN sessions s ON s.id=e.session_id
    JOIN event_versions v ON v.event_id=e.id JOIN batches b ON b.id=v.batch_id
    WHERE e.id=? AND v.payload_hash=?`).bind(eventId,hash).first<{
      selected_hash:string;selected_batch_id:string;selected_line_number:number;r2_key:string;
    } & Record<string,unknown>>();
  if (!row) throw new HttpError(404,'Event version not found');
  const object=await env.RAW.get(row.r2_key);
  if (!object) throw new HttpError(503,'Raw batch unavailable');
  const line=(await object.text()).split('\n')[row.selected_line_number];
  let payload: unknown;
  try {
    payload=JSON.parse(line);
    if (await digest(stableJSON(payload))!==hash) throw new Error();
  } catch { throw new HttpError(503,'Raw event version unavailable'); }
  const sourceProject=await projectIdentity(payload as Record<string,unknown>,String(row.device_id));
  const nativeSession=field(payload,'session','id');
  const expectedSession=row.stream==='runtime' ? await digest(stableJSON([row.device_id,
    field(payload,'harness','name')||'unknown',nativeSession?'native':'unscoped',nativeSession||`unscoped-event:${row.event_id}`])) : null;
  // Weak path/unknown evidence may be upgraded by the same session, but an
  // alternate capture claiming another remote/session cannot support a memory.
  const strength=(kind:unknown)=>kind==='remote'?2:kind==='device_path'?1:0;
  const scopeMatches=field(payload,'event','id')===row.event_id &&
    (field(payload,'harness','name')||'unknown')===row.harness && expectedSession===row.session_id && (sourceProject.id===row.project_id ||
    (!!nativeSession && strength(sourceProject.kind)<strength(row.identity_kind)));
  const {selected_hash,selected_batch_id,selected_line_number,r2_key,line_number,identity_kind,source_session_id,...index}=row;
  return {event:{...index,payload_hash:selected_hash,batch_id:selected_batch_id,
    action:field(payload,'event','action'),timestamp:field(payload,'timestamp'),
    scope_matches_index:scopeMatches,source_project:sourceProject,source_session_id:expectedSession,payload}};
}

export async function listEventVersions(env: Env, eventId: string, params: URLSearchParams) {
  const limit=pageLimit(params);
  if (!await env.DB.prepare('SELECT id FROM events WHERE id=?').bind(eventId).first()) throw new HttpError(404,'Event not found');
  const args:unknown[]=[eventId]; let where='v.event_id=?';
  if (params.get('before')) {
    const [time,hash]=decodeCursor(params.get('before')!);
    where+=' AND (b.received_at<? OR (b.received_at=? AND v.payload_hash<?))'; args.push(time,time,hash);
  }
  const rows=await env.DB.prepare(`SELECT v.payload_hash,v.batch_id,b.received_at
    FROM event_versions v JOIN batches b ON b.id=v.batch_id WHERE ${where}
    ORDER BY b.received_at DESC,v.payload_hash DESC LIMIT ?`).bind(...args,limit+1).all<{payload_hash:string;batch_id:string;received_at:string}>();
  const versions=rows.results.slice(0,limit), last=versions.at(-1);
  return {event_id:eventId,versions,next_cursor:rows.results.length>limit && last ? encodeCursor([last.received_at,last.payload_hash]) : null};
}
