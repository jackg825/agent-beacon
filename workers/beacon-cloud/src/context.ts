import { z } from 'zod';
import { getEventVersion, pageLimit } from './queries';
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const createSchema = z.object({
  kind: z.enum(['summary','memory']), project_id: hash, task_id: uuid.optional(),
  title: z.string().min(1).max(160).refine(value=>!!value.trim()),
  content: z.string().min(1).max(12000).refine(value=>!!value.trim()),
  sources: z.array(z.object({event_id:hash,payload_hash:hash}).strict()).min(1).max(20),
  supersedes_id: uuid.optional()
}).strict();
const reviewSchema = z.object({decision:z.enum(['approve','reject']),reason:z.string().max(2000).optional()}).strict();
type ContextRow = {
  id:string;kind:string;project_id:string;task_id:string|null;title:string;content:string;
  status:string;supersedes_id:string|null;created_at:string;reviewed_at:string|null;
  source_count:number;sources_valid:number;
  generation_job_id:string|null;generation_processor:string|null;generation_previous_context_id:string|null;
};

const invalidSourceScope = `EXISTS(SELECT 1 FROM context_sources s JOIN events e ON e.id=s.event_id
    WHERE s.context_id=c.id AND (e.project_id!=c.project_id OR (c.task_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM task_sessions ts WHERE ts.task_id=c.task_id AND ts.session_id=e.session_id
    ))))`;
const contextSelect = `SELECT c.id,c.kind,c.project_id,c.task_id,c.title,c.content,c.status,
  c.supersedes_id,c.created_at,c.reviewed_at,
  (SELECT COUNT(*) FROM context_sources s WHERE s.context_id=c.id) AS source_count,
  NOT ${invalidSourceScope} AS sources_valid,g.job_id AS generation_job_id,g.processor AS generation_processor,
  g.previous_context_id AS generation_previous_context_id
  FROM context_entries c LEFT JOIN context_generation g ON g.context_id=c.id`;

function view(row:ContextRow) {
  const {sources_valid,generation_job_id,generation_processor,generation_previous_context_id,...result}=row;
  // Approval records human review, not a guarantee that the prose is true.
  // If session/project evidence changes, the old derivative is no longer authoritative.
  // Pipeline output is marked as such; it always needed the same explicit review.
  return {...result,sources_valid:!!sources_valid,authoritative:row.status==='approved' && !!sources_valid,
    origin:generation_job_id?'pipeline' as const:'manual' as const,
    generation:generation_job_id?{job_id:generation_job_id,processor:generation_processor,previous_context_id:generation_previous_context_id}:null};
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if (!result.success) throw new HttpError(400,'Invalid context request');
  return result.data;
}
function cursor(value:string):[string,string] {
  try {
    if (value.length>512) throw new Error();
    const parsed=JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length!==2 || typeof parsed[0]!=='string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[0])
      || !uuid.safeParse(parsed[1]).success) throw new Error();
    return [parsed[0],parsed[1]];
  } catch {throw new HttpError(400,'Invalid context cursor');}
}
function dbError(error:unknown):never {
  const message=error instanceof Error?error.message:'';
  if (/context_stale_revision|context_review_conflict/.test(message))
    throw new HttpError(409,'Context review conflict; reload the current entry');
  if (/context_invalid_source/.test(message))
    throw new HttpError(400,'Source version does not belong to this project and task');
  throw error;
}

async function verifyRawSources(env:Env,sources:{event_id:string;payload_hash:string}[],review=false) {
  for (const source of sources) {
    let version;
    try {version=await getEventVersion(env,source.event_id,new URLSearchParams({payload_hash:source.payload_hash}));}
    catch (error) {
      if (error instanceof HttpError && error.status===404)
        throw new HttpError(review?409:400,'Referenced event version unavailable');
      // Raw R2 absence or corruption remains a service failure, never a false
      // provenance claim or a reason to substitute a different payload version.
      throw error;
    }
    if (!version.event.scope_matches_index)
      throw new HttpError(review?409:400,'Raw source version conflicts with the indexed project or session');
  }
}

export async function listContext(env:Env,params:URLSearchParams) {
  const allowed=new Set(['project_id','task_id','kind','status','before','limit']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length!==1)
    throw new HttpError(400,'Invalid context filter');
  const limit=pageLimit(params),where=['c.sealed=1'],args:unknown[]=[];
  for (const [name,schema] of [['project_id',hash],['task_id',uuid]] as const) {
    if (params.has(name)) {where.push(`c.${name}=?`);args.push(parse(schema,params.get(name)));}
  }
  if (params.has('kind')) {where.push('c.kind=?');args.push(parse(z.enum(['summary','memory']),params.get('kind')));}
  const status=parse(z.enum(['pending','approved','rejected','superseded']),params.get('status')??'approved');
  where.push('c.status=?');args.push(status);
  // Default recall returns usable approved records. An explicit approved filter
  // retains invalid-scope derivatives for review, always marked non-authoritative.
  if (!params.has('status')) where.push(`NOT ${invalidSourceScope}`);
  if (params.has('before')) {
    const [time,id]=cursor(params.get('before')!);
    where.push('(c.created_at<? OR (c.created_at=? AND c.id<?))');args.push(time,time,id);
  }
  const result=await env.DB.prepare(`${contextSelect} WHERE ${where.join(' AND ')}
    ORDER BY c.created_at DESC,c.id DESC LIMIT ?`).bind(...args,limit+1).all<ContextRow>();
  const rows=result.results.slice(0,limit),last=rows.at(-1);
  return {context:rows.map(view),next_cursor:result.results.length>limit && last?btoa(JSON.stringify([last.created_at,last.id])):null};
}

export async function getContext(env:Env,id:string) {
  if (!uuid.safeParse(id).success) throw new HttpError(400,'Invalid context id');
  const row=await env.DB.prepare(`${contextSelect} WHERE c.id=? AND c.sealed=1`).bind(id).first<ContextRow>();
  if (!row) throw new HttpError(404,'Context not found');
  const [sources,audit]=await Promise.all([
    env.DB.prepare(`SELECT s.event_id,s.payload_hash,e.session_id,e.device_id,e.timestamp
      FROM context_sources s JOIN events e ON e.id=s.event_id WHERE s.context_id=? ORDER BY s.ordinal`).bind(id).all(),
    env.DB.prepare('SELECT id,actor,action,reason,created_at FROM context_audit WHERE context_id=? ORDER BY created_at,id').bind(id).all()
  ]);
  return {context:{...view(row),sources:sources.results,audit:audit.results}};
}

export type CandidateInput = z.infer<typeof createSchema>;
export interface CandidateExtras {
  /** Statements committed first in the same D1 batch (e.g. a job lease fence). */
  before?: D1PreparedStatement[];
  /** Statements committed after the candidate, given its new id and creation time. */
  after?: (contextId:string,createdAt:string)=>D1PreparedStatement[];
  now?: string;
}

/**
 * The one way a candidate enters context_entries, used by the manual route and the
 * background pipeline alike: same validation, same exact raw-version verification,
 * same triggers, and one atomic D1 batch including any caller statements.
 */
export async function insertCandidate(env:Env,candidate:CandidateInput,actor:string,extras:CandidateExtras={}):Promise<string> {
  const input=parse(createSchema,candidate);
  const pairs=input.sources.map(source=>`${source.event_id}:${source.payload_hash}`);
  if (new Set(pairs).size!==pairs.length) throw new HttpError(400,'Duplicate context sources');
  if (!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(input.project_id).first())
    throw new HttpError(404,'Project not found');
  if (input.task_id && !await env.DB.prepare('SELECT id FROM tasks WHERE id=?').bind(input.task_id).first())
    throw new HttpError(404,'Task not found');
  await verifyRawSources(env,input.sources);
  if (input.supersedes_id) {
    const parent=await env.DB.prepare('SELECT status,kind,project_id,task_id FROM context_entries WHERE id=? AND sealed=1')
      .bind(input.supersedes_id).first<{status:string;kind:string;project_id:string;task_id:string|null}>();
    if (!parent) throw new HttpError(404,'Parent context not found');
    if (parent.status!=='approved' || parent.kind!==input.kind || parent.project_id!==input.project_id
      || parent.task_id!==(input.task_id??null)) throw new HttpError(409,'Revision must replace a current approved entry in the same scope');
  }
  const id=crypto.randomUUID(),now=extras.now??new Date().toISOString();
  const statements=[...extras.before??[],env.DB.prepare(`INSERT INTO context_entries(id,kind,project_id,task_id,title,content,supersedes_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(id,input.kind,input.project_id,input.task_id??null,input.title,input.content,input.supersedes_id??null,now)];
  input.sources.forEach((source,ordinal)=>statements.push(env.DB.prepare(`INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal)
    VALUES(?,?,?,?)`).bind(id,source.event_id,source.payload_hash,ordinal)));
  statements.push(env.DB.prepare('UPDATE context_entries SET sealed=1 WHERE id=?').bind(id));
  statements.push(env.DB.prepare(`INSERT INTO context_audit(id,context_id,actor,action,created_at) VALUES(?,?,?,'create',?)`)
    .bind(crypto.randomUUID(),id,actor,now));
  statements.push(...extras.after?.(id,now)??[]);
  try {await env.DB.batch(statements);} catch(error) {dbError(error);}
  return id;
}

async function createContext(request:Request,env:Env,actor:string) {
  const id=await insertCandidate(env,parse(createSchema,await readJson(request)),actor);
  return json(await getContext(env,id),201);
}

async function reviewContext(request:Request,env:Env,id:string,actor:string) {
  const input=parse(reviewSchema,await readJson(request));
  const entry=await env.DB.prepare('SELECT status FROM context_entries WHERE id=? AND sealed=1').bind(id).first<{status:string}>();
  if (!entry) throw new HttpError(404,'Context not found');
  if (entry.status!=='pending') throw new HttpError(409,'Context already reviewed; reload the current entry');
  if (input.decision==='approve') {
    const sources=await env.DB.prepare('SELECT event_id,payload_hash FROM context_sources WHERE context_id=? ORDER BY ordinal')
      .bind(id).all<{event_id:string;payload_hash:string}>();
    await verifyRawSources(env,sources.results,true);
  }
  // D1 serializes each statement with its triggers. CAS, source validation,
  // parent supersession and every review audit record commit together.
  const status=input.decision==='approve'?'approved':'rejected';
  let result:{id:string}|null;
  try {
    result=await env.DB.prepare(`UPDATE context_entries SET status=?,review_id=?,reviewed_at=?,reviewed_by=?,review_reason=?
      WHERE id=? AND status='pending' AND sealed=1 RETURNING id`)
      .bind(status,crypto.randomUUID(),new Date().toISOString(),actor,input.reason??null,id).first<{id:string}>();
  } catch(error) {dbError(error);}
  if (!result!) throw new HttpError(409,'Context already reviewed; reload the current entry');
  return json(await getContext(env,id));
}

export async function contextRead(request:Request,env:Env):Promise<Response|null> {
  if (request.method!=='GET') return null;
  const url=new URL(request.url);
  if (url.pathname==='/api/context') return json(await listContext(env,url.searchParams));
  const match=/^\/api\/context\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  if (url.search) throw new HttpError(400,'Context detail does not accept filters');
  return json(await getContext(env,match[1]));
}
export async function contextWrite(request:Request,env:Env,actor:string):Promise<Response|null> {
  if (request.method!=='POST') return null;
  const url=new URL(request.url);
  if (url.pathname==='/api/context') {
    if (url.search) throw new HttpError(400,'Context writes do not accept filters');
    return createContext(request,env,actor);
  }
  const match=/^\/api\/context\/([^/]+)\/review$/.exec(url.pathname);
  if (!match) return null;
  if (!uuid.safeParse(match[1]).success || url.search) throw new HttpError(400,'Invalid context review path');
  return reviewContext(request,env,match[1],actor);
}
