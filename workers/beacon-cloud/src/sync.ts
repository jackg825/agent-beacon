// Roadmap phase 3: a reliable approved-note snapshot, reviewer-managed device
// subscriptions and the one new device capability, reading the approved notes a
// reviewer explicitly subscribed that device to. Nothing here writes to a Mac;
// forwarder/sync.mjs previews and applies locally. See MAC-SYNC.md.
import { digest } from './auth';
import { stableJSON } from './identity';
import { pageLimit } from './queries';
import { Device, Env, HttpError, json } from './types';
import { readJson } from './workflow';

export const SNAPSHOT_SCHEMA = 'beacon.context.snapshot.v1';
export const SNAPSHOT_MAX_ENTRIES = 500;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ACTIVE_SUBSCRIPTIONS = 100;
export const SYNC_KINDS = ['memory', 'summary'] as const;
export type SyncKind = typeof SYNC_KINDS[number];

const hashPattern=/^[a-f0-9]{64}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const devicePattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const timePattern=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// Same authority rule as context.ts default recall: an approved entry whose source
// events left its project/task scope is no longer authoritative. test/sync.test.ts
// asserts the snapshot set equals default recall so the two cannot drift.
const invalidSourceScope = `EXISTS(SELECT 1 FROM context_sources s JOIN events e ON e.id=s.event_id
    WHERE s.context_id=c.id AND (e.project_id!=c.project_id OR (c.task_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM task_sessions ts WHERE ts.task_id=c.task_id AND ts.session_id=e.session_id
    ))))`;
const subscriptionSelect=`SELECT s.id,s.device_id,s.project_id,s.kinds,s.created_at,s.created_by,s.revoked_at,s.revoked_by,
  d.name AS device_name,d.revoked AS device_revoked,p.name AS project_name
  FROM device_sync_subscriptions s JOIN devices d ON d.id=s.device_id JOIN projects p ON p.id=s.project_id`;
type SubscriptionRow={id:string;device_id:string;project_id:string;kinds:string;created_at:string;created_by:string;
  revoked_at:string|null;revoked_by:string|null;device_name:string;device_revoked:number;project_name:string};
type EntryRow={id:string;kind:SyncKind;title:string;content:string;task_id:string|null;supersedes_id:string|null;reviewed_at:string};

function canonicalKinds(kinds:readonly string[]):SyncKind[] {
  if (!Array.isArray(kinds) || !kinds.length || kinds.length>SYNC_KINDS.length || new Set(kinds).size!==kinds.length
    || kinds.some(kind=>!SYNC_KINDS.includes(kind as SyncKind))) throw new HttpError(400,'kinds must list memory and/or summary once each');
  return SYNC_KINDS.filter(kind=>kinds.includes(kind));
}
function hashId(value:unknown,label='project'):string {
  if (typeof value!=='string' || !hashPattern.test(value)) throw new HttpError(400,`Invalid ${label} identifier`);
  return value;
}
function strict(params:URLSearchParams,allowed:string[]):URLSearchParams {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length!==1)
    throw new HttpError(400,'Invalid sync query');
  return params;
}
function view(row:SubscriptionRow) {
  const {device_revoked,...rest}=row;
  return {...rest,kinds:JSON.parse(row.kinds) as SyncKind[],status:row.revoked_at?'revoked':'active',device_revoked:!!device_revoked};
}
function dbError(error:unknown):never {
  if (/sync_subscription_(?:immutable|invalid_state)|sync_audit_immutable/.test(error instanceof Error?error.message:''))
    throw new HttpError(409,'Sync subscription changed; reload the current subscription');
  throw error;
}

/**
 * Every authoritative approved entry of one project and the selected kinds, in
 * (kind, created_at, id) order, with a hash over the canonical list. Over 500
 * entries or 2 MiB of title+content bytes fails with 413 before any content is
 * read; the response is never silently truncated.
 */
export async function approvedSnapshot(env:Env,projectId:string,options:{kinds:readonly string[]}) {
  const kinds=canonicalKinds(options.kinds);
  const scope=`c.project_id=? AND c.status='approved' AND c.sealed=1 AND c.kind IN (${kinds.map(()=>'?').join(',')})
    AND NOT ${invalidSourceScope}`;
  const size=await env.DB.prepare(`SELECT COUNT(*) AS entries,
    COALESCE(SUM(length(CAST(c.title AS BLOB))+length(CAST(c.content AS BLOB))),0) AS bytes
    FROM context_entries c WHERE ${scope}`).bind(projectId,...kinds).first<{entries:number;bytes:number}>();
  const tooLarge=()=>new HttpError(413,'Approved snapshot exceeds 500 entries or 2 MiB; narrow the subscription kinds');
  if (!size || size.entries>SNAPSHOT_MAX_ENTRIES || size.bytes>SNAPSHOT_MAX_BYTES) throw tooLarge();
  const rows=await env.DB.prepare(`SELECT c.id,c.kind,c.title,c.content,c.task_id,c.supersedes_id,c.reviewed_at
    FROM context_entries c WHERE ${scope} ORDER BY c.kind,c.created_at,c.id LIMIT ?`)
    .bind(projectId,...kinds,SNAPSHOT_MAX_ENTRIES+1).all<EntryRow>();
  // An approval between the two reads can grow the set; re-check what was loaded.
  const encoder=new TextEncoder();
  const bytes=rows.results.reduce((total,row)=>total+encoder.encode(row.title).length+encoder.encode(row.content).length,0);
  if (rows.results.length>SNAPSHOT_MAX_ENTRIES || bytes>SNAPSHOT_MAX_BYTES) throw tooLarge();
  const entries=await Promise.all(rows.results.map(async row=>({id:row.id,kind:row.kind,title:row.title,content:row.content,
    content_sha256:await digest(row.content),task_id:row.task_id,supersedes_id:row.supersedes_id,
    reviewed_at:row.reviewed_at,valid_from:row.reviewed_at})));
  const reviewed=entries.map(entry=>entry.reviewed_at).sort().at(-1)??null;
  return {schema:SNAPSHOT_SCHEMA,project_id:projectId,kinds,entry_count:entries.length,content_bytes:bytes,reviewed_through:reviewed,
    snapshot_sha256:await digest(stableJSON({schema:SNAPSHOT_SCHEMA,project_id:projectId,kinds,entries})),entries};
}

function cursor(value:string):[string,string] {
  try {
    if (value.length>512) throw new Error();
    const parsed=JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length!==2 || typeof parsed[0]!=='string' || !timePattern.test(parsed[0])
      || typeof parsed[1]!=='string' || !uuidPattern.test(parsed[1])) throw new Error();
    return [parsed[0],parsed[1]];
  } catch {throw new HttpError(400,'Invalid sync cursor');}
}
export async function listSubscriptions(env:Env,params:URLSearchParams) {
  strict(params,['device_id','status','before','limit']);
  const limit=pageLimit(params),where:string[]=[],args:unknown[]=[];
  if (params.has('device_id')) {
    const device=params.get('device_id')!;
    if (!devicePattern.test(device)) throw new HttpError(400,'Invalid device identifier');
    where.push('s.device_id=?');args.push(device);
  }
  if (params.has('status')) {
    const status=params.get('status');
    if (status!=='active' && status!=='revoked') throw new HttpError(400,'Invalid subscription status');
    where.push(status==='active'?'s.revoked_at IS NULL':'s.revoked_at IS NOT NULL');
  }
  if (params.has('before')) {
    const [time,id]=cursor(params.get('before')!);
    where.push('(s.created_at<? OR (s.created_at=? AND s.id<?))');args.push(time,time,id);
  }
  const result=await env.DB.prepare(`${subscriptionSelect} ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY s.created_at DESC,s.id DESC LIMIT ?`).bind(...args,limit+1).all<SubscriptionRow>();
  const rows=result.results.slice(0,limit),last=rows.at(-1);
  return {subscriptions:rows.map(view),next_cursor:result.results.length>limit && last?btoa(JSON.stringify([last.created_at,last.id])):null};
}
export async function getSubscription(env:Env,id:string) {
  if (!uuidPattern.test(id)) throw new HttpError(400,'Invalid subscription id');
  const row=await env.DB.prepare(`${subscriptionSelect} WHERE s.id=?`).bind(id).first<SubscriptionRow>();
  if (!row) throw new HttpError(404,'Subscription not found');
  const audit=await env.DB.prepare('SELECT id,actor,action,created_at FROM device_sync_audit WHERE subscription_id=? ORDER BY created_at,id')
    .bind(id).all();
  return {subscription:{...view(row),audit:audit.results}};
}

async function body(request:Request,keys:string[]):Promise<Record<string,unknown>> {
  const value=await readJson(request);
  if (!value || typeof value!=='object' || Array.isArray(value) ||
      Object.keys(value).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(value,key)))
    throw new HttpError(400,'Body must contain only the required fields');
  return value as Record<string,unknown>;
}
async function createSubscription(request:Request,env:Env,actor:string) {
  const value=await body(request,['device_id','project_id','kinds']);
  if (typeof value.device_id!=='string' || !devicePattern.test(value.device_id)) throw new HttpError(400,'Invalid device identifier');
  const deviceId=value.device_id,projectId=hashId(value.project_id);
  const kinds=JSON.stringify(canonicalKinds(Array.isArray(value.kinds)?value.kinds:[]));
  const device=await env.DB.prepare('SELECT revoked FROM devices WHERE id=?').bind(deviceId).first<{revoked:number}>();
  if (!device) throw new HttpError(404,'Device not found');
  if (device.revoked) throw new HttpError(409,'Device credential is revoked');
  if (!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(projectId).first()) throw new HttpError(404,'Project not found');
  const id=crypto.randomUUID(),now=new Date().toISOString();
  // The count, revocation and uniqueness checks run inside the insert statement,
  // so concurrent grants cannot exceed the bound or create two active rows.
  let result;
  try {
    result=await env.DB.prepare(`INSERT INTO device_sync_subscriptions(id,device_id,project_id,kinds,created_at,created_by)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0)
        AND (SELECT COUNT(*) FROM device_sync_subscriptions WHERE device_id=? AND revoked_at IS NULL)<?
      ON CONFLICT DO NOTHING`).bind(id,deviceId,projectId,kinds,now,actor,deviceId,deviceId,MAX_ACTIVE_SUBSCRIPTIONS).run();
  } catch (error) {dbError(error);}
  if (result!.meta.changes>0) return json({...await getSubscription(env,id),created:true},201);
  const active=await env.DB.prepare('SELECT id,kinds FROM device_sync_subscriptions WHERE device_id=? AND project_id=? AND revoked_at IS NULL')
    .bind(deviceId,projectId).first<{id:string;kinds:string}>();
  if (active && active.kinds===kinds) return json({...await getSubscription(env,active.id),created:false});
  if (active) throw new HttpError(409,'An active subscription with other kinds exists; revoke it first');
  throw new HttpError(409,`Device credential is revoked or already has ${MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions`);
}
async function revokeSubscription(request:Request,env:Env,id:string,actor:string) {
  await body(request,[]);
  let row:{id:string}|null;
  try {
    row=await env.DB.prepare(`UPDATE device_sync_subscriptions SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL RETURNING id`)
      .bind(new Date().toISOString(),actor,id).first<{id:string}>();
  } catch (error) {dbError(error);}
  if (!row!) {
    if (await env.DB.prepare('SELECT id FROM device_sync_subscriptions WHERE id=?').bind(id).first())
      throw new HttpError(409,'Subscription already revoked');
    throw new HttpError(404,'Subscription not found');
  }
  return json(await getSubscription(env,id));
}

/** Read-authenticated GETs. Returns null for every path it does not own exactly. */
export async function syncRead(request:Request,env:Env):Promise<Response|null> {
  if (request.method!=='GET') return null;
  const url=new URL(request.url),path=url.pathname;
  if (path==='/api/context/snapshot') {
    const params=strict(url.searchParams,['project_id','kind']),projectId=hashId(params.get('project_id'));
    const kinds=params.has('kind')?[params.get('kind')!]:[...SYNC_KINDS];
    if (!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(projectId).first()) throw new HttpError(404,'Project not found');
    return json({snapshot:await approvedSnapshot(env,projectId,{kinds})});
  }
  if (path==='/api/sync/subscriptions') return json(await listSubscriptions(env,url.searchParams));
  const match=/^\/api\/sync\/subscriptions\/([^/]+)$/.exec(path);
  if (!match) return null;
  if (url.search) throw new HttpError(400,'Subscription detail does not accept filters');
  return json(await getSubscription(env,match[1]));
}
/** Reviewer-authenticated POSTs; the router has already checked origin and review authority. */
export async function syncWrite(request:Request,env:Env,actor:string):Promise<Response|null> {
  if (request.method!=='POST') return null;
  const url=new URL(request.url),path=url.pathname;
  const match=/^\/api\/sync\/subscriptions\/([^/]+)\/revoke$/.exec(path);
  if (path!=='/api/sync/subscriptions' && !match) return null;
  if (!actor || actor.length>128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new HttpError(500,'Invalid reviewer identity');
  if (url.search) throw new HttpError(400,'Sync writes do not accept filters');
  if (!match) return createSubscription(request,env,actor);
  if (!uuidPattern.test(match[1])) throw new HttpError(400,'Invalid subscription id');
  return revokeSubscription(request,env,match[1],actor);
}
/**
 * Device-token GETs under /v1/sync/; the device is already authenticated and not
 * revoked. A device only ever sees its own active subscriptions, and an unknown
 * project answers exactly like a known project without a subscription.
 */
export async function syncDeviceRead(request:Request,env:Env,device:Device):Promise<Response|null> {
  const url=new URL(request.url);
  if (url.pathname==='/v1/sync/subscriptions') {
    if (url.search) throw new HttpError(400,'Invalid sync query');
    const rows=await env.DB.prepare(`SELECT id,project_id,kinds,created_at FROM device_sync_subscriptions
      WHERE device_id=? AND revoked_at IS NULL ORDER BY created_at,id LIMIT ?`).bind(device.id,MAX_ACTIVE_SUBSCRIPTIONS)
      .all<{id:string;project_id:string;kinds:string;created_at:string}>();
    return json({device_id:device.id,subscriptions:rows.results.map(row=>({...row,kinds:JSON.parse(row.kinds) as SyncKind[]}))});
  }
  if (url.pathname!=='/v1/sync/snapshot') return null;
  // The subscription decides the kinds; a query parameter can never widen them.
  if (url.searchParams.has('kind')) throw new HttpError(400,'The subscription decides the kinds; remove kind');
  const projectId=hashId(strict(url.searchParams,['project_id']).get('project_id'));
  const subscription=await env.DB.prepare(`SELECT id,kinds FROM device_sync_subscriptions
    WHERE device_id=? AND project_id=? AND revoked_at IS NULL`).bind(device.id,projectId).first<{id:string;kinds:string}>();
  if (!subscription) throw new HttpError(403,'No active sync subscription for this device and project');
  const snapshot=await approvedSnapshot(env,projectId,{kinds:JSON.parse(subscription.kinds)});
  return json({snapshot:{...snapshot,subscription_id:subscription.id}});
}
