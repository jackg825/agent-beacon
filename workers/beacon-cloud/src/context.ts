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
export type ContextRow = {
  id:string;kind:string;project_id:string;task_id:string|null;title:string;content:string;
  status:string;supersedes_id:string|null;created_at:string;reviewed_at:string|null;
  valid_from:string|null;valid_until:string|null;open_flags:number;
  source_count:number;sources_valid:number;
  generation_job_id:string|null;generation_processor:string|null;generation_previous_context_id:string|null;
  share_id?:string|null;shared_from_project_id?:string|null;
};

// Shared with the Jev stage, which reads only authoritative notes.
export const invalidSourceScope = `EXISTS(SELECT 1 FROM context_sources s JOIN events e ON e.id=s.event_id
    WHERE s.context_id=c.id AND (e.project_id!=c.project_id OR (c.task_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM task_sessions ts WHERE ts.task_id=c.task_id AND ts.session_id=e.session_id
    ))))`;
/**
 * Validity window: an entry is valid from its approval until the approval of the
 * revision that superseded it (at most one child is ever approved). Authority is
 * separate: an approved entry whose sources left its scope stays in its window but
 * is not authoritative.
 */
export const validUntil = `(SELECT child.reviewed_at FROM context_entries child WHERE child.supersedes_id=c.id
    AND child.status IN ('approved','superseded') ORDER BY child.reviewed_at LIMIT 1)`;
export const contextColumns = `c.id,c.kind,c.project_id,c.task_id,c.title,c.content,c.status,
  c.supersedes_id,c.created_at,c.reviewed_at,
  CASE WHEN c.status IN ('approved','superseded') THEN c.reviewed_at END AS valid_from,${validUntil} AS valid_until,
  (SELECT COUNT(*) FROM context_flags f WHERE f.context_id=c.id AND f.status='open') AS open_flags,
  (SELECT COUNT(*) FROM context_sources s WHERE s.context_id=c.id) AS source_count,
  NOT ${invalidSourceScope} AS sources_valid,g.job_id AS generation_job_id,g.processor AS generation_processor,
  g.previous_context_id AS generation_previous_context_id`;
export const contextFrom = 'FROM context_entries c LEFT JOIN context_generation g ON g.context_id=c.id';
const contextSelect = `SELECT ${contextColumns} ${contextFrom}`;

export function contextView(row:ContextRow) {
  const {sources_valid,generation_job_id,generation_processor,generation_previous_context_id,share_id,shared_from_project_id,...result}=row;
  // Approval records human review, not a guarantee that the prose is true.
  // If session/project evidence changes, the old derivative is no longer authoritative.
  // Pipeline output is marked as such; it always needed the same explicit review.
  // An open flag asks for another look; it changes neither approval nor authority.
  return {...result,open_flags:Number(row.open_flags),sources_valid:!!sources_valid,authoritative:row.status==='approved' && !!sources_valid,
    origin:generation_job_id?'pipeline' as const:'manual' as const,
    generation:generation_job_id?{job_id:generation_job_id,processor:generation_processor,previous_context_id:generation_previous_context_id}:null,
    // Present only when include_shared asked for it; shared rows name the share and the owning project.
    ...(share_id!==undefined?{share_id,shared_from_project_id}:{})};
}
const view=contextView;
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

/** A UTC instant (seconds or milliseconds), normalized to the stored toISOString() form. */
export function isoInstant(value:string|null,label='as_of'):string {
  const parsed=value && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)?Date.parse(value):NaN;
  if (!Number.isFinite(parsed)) throw new HttpError(400,`${label} must be a UTC ISO 8601 time`);
  return new Date(parsed).toISOString();
}
const flagSwitch=z.enum(['0','1']);
const openFlag=`EXISTS(SELECT 1 FROM context_flags f WHERE f.context_id=c.id AND f.status='open')`;

export async function listContext(env:Env,params:URLSearchParams) {
  const allowed=new Set(['project_id','task_id','kind','status','before','limit','as_of','include_shared','flagged']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length!==1)
    throw new HttpError(400,'Invalid context filter');
  const limit=pageLimit(params),where=['c.sealed=1'],args:unknown[]=[];
  const asOf=params.has('as_of')?isoInstant(params.get('as_of')):null;
  const shared=params.has('include_shared') && parse(flagSwitch,params.get('include_shared'))==='1';
  const flagged=params.has('flagged') && parse(flagSwitch,params.get('flagged'))==='1';
  if (asOf && params.has('status')) throw new HttpError(400,'as_of selects entries approved at that time; remove status');
  // Shared entries are always current authoritative memories of another project, so they
  // join only an approved-only recall of exactly one project, never a task or a past instant.
  if (shared && (!params.has('project_id') || params.has('task_id') || asOf || (params.has('status') && params.get('status')!=='approved')))
    throw new HttpError(400,'include_shared needs project_id and approved entries, without task_id or as_of');
  for (const [name,schema] of [['project_id',hash],['task_id',uuid]] as const) {
    if (params.has(name)) {where.push(`c.${name}=?`);args.push(parse(schema,params.get(name)));}
  }
  const kind=params.has('kind')?parse(z.enum(['summary','memory']),params.get('kind')):null;
  if (kind) {where.push('c.kind=?');args.push(kind);}
  if (asOf) {
    // History: approved at that instant and not yet replaced by an approved revision.
    // Current source scope is not applied; authoritative still reports today's state.
    where.push(`c.status IN ('approved','superseded') AND c.reviewed_at<=? AND (${validUntil} IS NULL OR ${validUntil}>?)`);
    args.push(asOf,asOf);
  } else {
    const status=parse(z.enum(['pending','approved','rejected','superseded']),params.get('status')??'approved');
    where.push('c.status=?');args.push(status);
    // Default recall returns usable approved records. An explicit approved filter
    // retains invalid-scope derivatives for review, always marked non-authoritative.
    if (!params.has('status')) where.push(`NOT ${invalidSourceScope}`);
  }
  if (flagged) where.push(openFlag);
  const page:string[]=[],pageArgs:unknown[]=[];
  if (params.has('before')) {
    const [time,id]=cursor(params.get('before')!);
    page.push('(c.created_at<? OR (c.created_at=? AND c.id<?))');pageArgs.push(time,time,id);
  }
  let result:D1Result<ContextRow>;
  if (!shared) {
    result=await env.DB.prepare(`${contextSelect} WHERE ${[...where,...page].join(' AND ')}
      ORDER BY c.created_at DESC,c.id DESC LIMIT ?`).bind(...args,...pageArgs,limit+1).all<ContextRow>();
  } else {
    // Read-time authority: a share is served only while it is active and the shared
    // entry is still approved with valid sources. Default recall never includes shares.
    const sharedWhere=[`sh.target_type='project' AND sh.target_id=? AND sh.revoked_at IS NULL AND c.sealed=1 AND c.status='approved'
      AND c.kind='memory' AND NOT ${invalidSourceScope}`,...kind?['c.kind=?']:[],...flagged?[openFlag]:[],...page];
    // Each arm keeps its own order and limit, so the project's entries are read in index order
    // and stop after one page instead of being computed in full for every page. The shared arm
    // starts from the project's active shares (CROSS JOIN fixes that order) rather than walking
    // every approved entry to look for a share.
    result=await env.DB.prepare(`SELECT * FROM (
      SELECT * FROM (SELECT ${contextColumns},NULL AS share_id,NULL AS shared_from_project_id ${contextFrom}
        WHERE ${[...where,...page].join(' AND ')} ORDER BY c.created_at DESC,c.id DESC LIMIT ?)
      UNION ALL SELECT * FROM (SELECT ${contextColumns},sh.id AS share_id,c.project_id AS shared_from_project_id
        FROM context_shares sh CROSS JOIN context_entries c ON c.id=sh.context_id LEFT JOIN context_generation g ON g.context_id=c.id
        WHERE ${sharedWhere.join(' AND ')} ORDER BY c.created_at DESC,c.id DESC LIMIT ?)
    ) ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...args,...pageArgs,limit+1,params.get('project_id'),...kind?[kind]:[],...pageArgs,limit+1,limit+1)
      .all<ContextRow>();
  }
  const rows=result.results.slice(0,limit),last=rows.at(-1);
  return {context:rows.map(view),next_cursor:result.results.length>limit && last?btoa(JSON.stringify([last.created_at,last.id])):null};
}

/** Flags and shares listed with one entry: open flags first, then the newest. */
export const DETAIL_ROWS = 50;
export type FlagRow = { id:string;context_id:string;kind:string;origin:string;job_id:string|null;evidence:string;note:string|null;
  status:string;created_at:string;created_by:string;resolved_at:string|null;resolved_by:string|null;resolution_reason:string|null };
export const flagSelect = `SELECT f.id,f.context_id,f.kind,f.origin,f.job_id,f.evidence,f.note,f.status,f.created_at,f.created_by,
  f.resolved_at,f.resolved_by,f.resolution_reason FROM context_flags f`;
export function flagView(row:FlagRow) {
  return {...row,evidence:JSON.parse(row.evidence) as {event_id:string;payload_hash:string}[]};
}
export type ShareRow = { id:string;context_id:string;target_type:string;target_id:string;target_name:string|null;created_at:string;
  created_by:string;revoked_at:string|null;revoked_by:string|null };
export const shareSelect = `SELECT sh.id,sh.context_id,sh.target_type,sh.target_id,p.name AS target_name,sh.created_at,sh.created_by,
  sh.revoked_at,sh.revoked_by FROM context_shares sh LEFT JOIN projects p ON p.id=sh.target_id`;
/** `inactive`: not revoked, but the entry is no longer authoritative, so nothing is served. */
export function shareView(row:ShareRow,authoritative:boolean) {
  return {...row,status:row.revoked_at?'revoked' as const:authoritative?'active' as const:'inactive' as const};
}

export async function getContext(env:Env,id:string) {
  if (!uuid.safeParse(id).success) throw new HttpError(400,'Invalid context id');
  const row=await env.DB.prepare(`${contextSelect} WHERE c.id=? AND c.sealed=1`).bind(id).first<ContextRow>();
  if (!row) throw new HttpError(404,'Context not found');
  const [sources,audit,flags,shares]=await Promise.all([
    env.DB.prepare(`SELECT s.event_id,s.payload_hash,e.session_id,e.device_id,e.timestamp
      FROM context_sources s JOIN events e ON e.id=s.event_id WHERE s.context_id=? ORDER BY s.ordinal`).bind(id).all(),
    env.DB.prepare('SELECT id,actor,action,reason,created_at FROM context_audit WHERE context_id=? ORDER BY created_at,id').bind(id).all(),
    env.DB.prepare(`${flagSelect} WHERE f.context_id=? ORDER BY f.status='open' DESC,f.created_at DESC,f.id DESC LIMIT ?`)
      .bind(id,DETAIL_ROWS+1).all<FlagRow>(),
    env.DB.prepare(`${shareSelect} WHERE sh.context_id=? ORDER BY sh.revoked_at IS NULL DESC,sh.created_at DESC,sh.id DESC LIMIT ?`)
      .bind(id,DETAIL_ROWS+1).all<ShareRow>(),
  ]);
  const entry=view(row);
  return {context:{...entry,sources:sources.results,audit:audit.results,
    flags:flags.results.slice(0,DETAIL_ROWS).map(flagView),flags_truncated:flags.results.length>DETAIL_ROWS,
    shares:shares.results.slice(0,DETAIL_ROWS).map(share=>shareView(share,entry.authoritative)),shares_truncated:shares.results.length>DETAIL_ROWS}};
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
