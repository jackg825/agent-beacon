import { Env, HttpError } from './types';

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
