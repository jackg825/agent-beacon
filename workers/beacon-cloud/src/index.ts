import { checkOrigin, deviceAuth, readAuth, reviewAuth } from './auth';
import { dashboardResponse, dashboardScriptResponse } from './dashboard';
import { ingest } from './ingest';
import { handleMcp } from './mcp';
import { mcpChallenge, mcpMetadata } from './mcp-auth';
import { getEventVersion, listEventVersions, getTimeline, listDevices, listProjects, listSessions } from './queries';
import { projectRead, projectWrite } from './project-workflows';
import { contextRead, contextWrite } from './context';
import { revisionsRead, revisionsWrite } from './context-revisions';
import { processingRead, processingWrite } from './processing';
import { syncDeviceRead, syncRead, syncWrite } from './sync';
import { operationsRead, operationsReviewerRead, operationsWrite } from './operations';
import { HOURLY_CRON, runMaintenance } from './maintenance';
import { Env, HttpError, json } from './types';

type Handler = (request: Request, env: Env) => Promise<Response | null>;
type ActorHandler = (request: Request, env: Env, actor: string) => Promise<Response | null>;
// Handlers return null for paths they do not own; the first match answers. Sync
// owns /api/context/snapshot, so it precedes the /api/context/:id detail route.
const readHandlers: Handler[] = [syncRead, projectRead, contextRead, revisionsRead, processingRead, operationsRead];
const writeHandlers: ActorHandler[] = [projectWrite, contextWrite, revisionsWrite, processingWrite, syncWrite, operationsWrite];
const writePaths = /^\/api\/(?:project-groups|project-relations|tasks|context|processing|sync|retention|backups)(?:\/|$)/;
// Backups hold device token digests, so even reading them needs review authority.
const reviewerReadPaths = /^\/api\/backups(?:\/|$)/;

async function first<T extends unknown[]>(handlers: ((request: Request, env: Env, ...rest: T) => Promise<Response | null>)[],
  request: Request, env: Env, ...rest: T): Promise<Response | null> {
  for (const handler of handlers) {
    const response = await handler(request, env, ...rest);
    if (response) return response;
  }
  return null;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url=new URL(request.url), path=url.pathname;
  if (['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(path)) {
    if (request.method!=='GET') throw new HttpError(405,'Metadata requires GET');
    return mcpMetadata(env);
  }
  checkOrigin(request,env);
  if (path==='/health' && request.method==='GET') return json({service:'agent-beacon-cloud',status:'ok'});
  if (path.startsWith('/v1/ingest/')) {
    const device=await deviceAuth(request,env);
    if (path==='/v1/ingest/health' && request.method==='GET') return json({status:'ok',device_id:device.id});
    if (request.method==='POST' && ['/v1/ingest/runtime','/v1/ingest/inventory'].includes(path))
      return ingest(request,env,device,path.split('/').at(-1)!);
    throw new HttpError(405,'Unsupported ingest route or method');
  }
  if (path.startsWith('/v1/sync/')) {
    const device=await deviceAuth(request,env);
    if (request.method!=='GET') throw new HttpError(405,'Sync is read-only');
    const response=await syncDeviceRead(request,env,device);
    if (response) return response;
    throw new HttpError(404,'Not found');
  }
  if (path==='/mcp') {
    await readAuth(request,env,true);
    return handleMcp(request,env);
  }
  if (path==='/' || path==='/dashboard' || path==='/dashboard.js' || path.startsWith('/api/')) {
    if (request.method==='POST' && writePaths.test(path)) {
      const actor = await reviewAuth(request, env);
      const response = await first(writeHandlers, request, env, actor);
      if (response) return response;
      throw new HttpError(404, 'Not found');
    }
    if (request.method==='GET' && reviewerReadPaths.test(path)) {
      const actor = await reviewAuth(request, env);
      const response = await operationsReviewerRead(request, env, actor);
      if (response) return response;
      throw new HttpError(404, 'Not found');
    }
    await readAuth(request,env);
    if (request.method!=='GET') throw new HttpError(405,'Read-only endpoint');
    if (path==='/' || path==='/dashboard') return dashboardResponse();
    if (path==='/dashboard.js') return dashboardScriptResponse();
    if (path==='/api/sessions') return json(await listSessions(env,url.searchParams));
    if (path==='/api/projects') return json(await listProjects(env));
    if (path==='/api/devices') return json(await listDevices(env));
    const workflow = await first(readHandlers, request, env);
    if (workflow) return workflow;
    const eventMatch=/^\/api\/events\/([a-f0-9]{64})(\/versions)?$/.exec(path);
    if (eventMatch) return json(await (eventMatch[2] ? listEventVersions(env,eventMatch[1],url.searchParams) : getEventVersion(env,eventMatch[1],url.searchParams)));
    const match=/^\/api\/sessions\/([a-f0-9]{64})\/events$/.exec(path);
    if (match) return json(await getTimeline(env,match[1],url.searchParams));
  }
  throw new HttpError(404,'Not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response=await route(request,env); }
    catch (error) {
      // Logs and responses never contain request bodies, token values, or D1 error SQL.
      const known=error instanceof HttpError;
      response=json({error:known?error.message:'Service unavailable; retry with the same batch'},known?error.status:503);
      if (known && (error.status===401 || error.authError==='insufficient_scope')) response.headers.set('WWW-Authenticate',
        new URL(request.url).pathname==='/mcp' ? mcpChallenge(env,error.authError) : 'Basic realm="Agent Beacon", charset="UTF-8"');
      if (!known) response.headers.set('Retry-After','5');
    }
    const headers=new Headers(response.headers);
    headers.set('Cache-Control','no-store');
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','no-referrer');
    headers.set('X-Frame-Options','DENY');
    return new Response(response.body,{status:response.status,headers});
  },
  // Background work is discovered from the committed index, never from the ingest
  // request, so a failing task cannot change an ingest acknowledgement.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const report=await runMaintenance(env,{now:new Date(controller.scheduledTime),
      schedule:controller.cron===HOURLY_CRON?'hourly':'frequent'});
    // Task names, durations and short codes only; results can carry counts but never content.
    console.log(JSON.stringify({maintenance:Object.fromEntries(Object.entries(report).map(([name,value])=>[name,{ok:value.ok,error:value.error,duration_ms:value.duration_ms,usage:value.usage}]))}));
  }
};
