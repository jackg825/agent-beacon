import { Env, HttpError, json } from './types';
import { pageLimit } from './queries';
import { readJson } from './workflow';

const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const centralPattern=/^[a-f0-9]{64}$/;
const relationTypes=['depends_on','shares_service','fork_of'] as const;
const statuses=['open','completed'] as const;
type Group={id:string;name:string;created_at:string;updated_at:string;member_count:number};
type Task={id:string;title:string;status:string;created_at:string;updated_at:string;session_count:number};
type Relation={id:string;from_project_id:string;to_project_id:string;type:string;created_at:string;
  from_project_name:string;to_project_name:string};

const groupSelect=`SELECT g.*,(SELECT COUNT(*) FROM project_group_members m WHERE m.group_id=g.id) AS member_count
  FROM project_groups g`;
const taskSelect=`SELECT t.*,(SELECT COUNT(*) FROM task_sessions l WHERE l.task_id=t.id) AS session_count FROM tasks t`;
const relationSelect=`SELECT r.*,fp.name AS from_project_name,tp.name AS to_project_name
  FROM project_relations r JOIN projects fp ON fp.id=r.from_project_id JOIN projects tp ON tp.id=r.to_project_id`;

function identifier(value:unknown,kind:'UUID'|'project'|'session'):string {
  if (typeof value!=='string' || !(kind==='UUID'?uuidPattern:centralPattern).test(value))
    throw new HttpError(400,`Invalid ${kind} identifier`);
  return value;
}
function text(value:unknown,label:string,max:number):string {
  if (typeof value!=='string' || !value.trim() || value.length>max || /[\u0000-\u001f\u007f]/.test(value))
    throw new HttpError(400,`${label} must be 1–${max} characters without control characters`);
  return value.trim();
}
function choice<T extends string>(value:unknown,values:readonly T[],label:string):T {
  if (typeof value!=='string' || !values.includes(value as T)) throw new HttpError(400,`Invalid ${label}`);
  return value as T;
}
async function body(request:Request,keys:string[]):Promise<Record<string,unknown>> {
  const value=await readJson(request);
  if (!value || typeof value!=='object' || Array.isArray(value) ||
      Object.keys(value).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(value,key)))
    throw new HttpError(400,'Body must contain only the required fields');
  return value as Record<string,unknown>;
}
function cursor(params:URLSearchParams,key:'UUID'|'project'|'session'):[string,string]|null {
  if (!params.has('before')) return null;
  try {
    const raw=params.get('before')!;
    if (raw.length>512) throw new Error();
    const value=JSON.parse(atob(raw));
    if (!Array.isArray(value) || value.length!==2 || typeof value[0]!=='string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value[0]) ||
        !Number.isFinite(Date.parse(value[0]))) throw new Error();
    identifier(value[1],key);
    return [value[0],value[1]];
  } catch {throw new HttpError(400,'Invalid cursor');}
}
function boundary(params:URLSearchParams,time:string,id:string,key:'UUID'|'project'|'session',where:string[],args:unknown[]) {
  const value=cursor(params,key);
  if(value) {where.push(`(${time}<? OR (${time}=? AND ${id}<?))`);args.push(value[0],value[0],value[1]);}
}
function page<T extends Record<string,unknown>>(rows:T[],limit:number,time:string,id='id') {
  const items=rows.slice(0,limit),last=items.at(-1);
  return {items,next_cursor:rows.length>limit && last?btoa(JSON.stringify([last[time],last[id]])):null};
}
async function requireRow(env:Env,table:'projects'|'sessions'|'project_groups'|'tasks',id:string,label:string) {
  if (!await env.DB.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(id).first()) throw new HttpError(404,`${label} not found`);
}
async function group(env:Env,id:string):Promise<Group> {
  const value=await env.DB.prepare(`${groupSelect} WHERE g.id=?`).bind(id).first<Group>();
  if (!value) throw new HttpError(404,'Project group not found');
  return value;
}
async function task(env:Env,id:string):Promise<Task> {
  const value=await env.DB.prepare(`${taskSelect} WHERE t.id=?`).bind(id).first<Task>();
  if (!value) throw new HttpError(404,'Task not found');
  return value;
}
function audit(env:Env,actor:string,action:string,resourceType:string,resourceId:string,time:string,
    auditId=crypto.randomUUID(),condition='') {
  return env.DB.prepare(`INSERT INTO project_workflow_audit(id,actor,action,resource_type,resource_id,created_at)
    SELECT ?,?,?,?,?,? ${condition}`).bind(auditId,actor,action,resourceType,resourceId,time);
}

// The main router authenticates GETs and enforces reviewer auth/origin for POSTs.
export async function projectRead(request:Request,env:Env):Promise<Response|null> {
  if (request.method!=='GET') return null;
  const url=new URL(request.url),path=url.pathname,params=url.searchParams;
  if (path==='/api/project-groups') {
    const limit=pageLimit(params),where:string[]=[],args:unknown[]=[];
    boundary(params,'g.created_at','g.id','UUID',where,args);
    const rows=await env.DB.prepare(`${groupSelect} ${where.length?'WHERE '+where.join(' AND '):''}
      ORDER BY g.created_at DESC,g.id DESC LIMIT ?`).bind(...args,limit+1).all<Group>();
    const result=page(rows.results,limit,'created_at');
    return json({project_groups:result.items,next_cursor:result.next_cursor});
  }
  const groupMatch=/^\/api\/project-groups\/([^/]+)$/.exec(path);
  if (groupMatch) {
    const id=identifier(groupMatch[1],'UUID'),projectGroup=await group(env,id),limit=pageLimit(params);
    const where=['m.group_id=?'],args:unknown[]=[id];
    boundary(params,'m.linked_at','m.project_id','project',where,args);
    const rows=await env.DB.prepare(`SELECT m.project_id,m.linked_at,p.name AS project_name,p.identity,p.identity_kind
      FROM project_group_members m JOIN projects p ON p.id=m.project_id WHERE ${where.join(' AND ')}
      ORDER BY m.linked_at DESC,m.project_id DESC LIMIT ?`).bind(...args,limit+1).all<Record<string,unknown>>();
    const result=page(rows.results,limit,'linked_at','project_id');
    return json({project_group:projectGroup,members:result.items,next_cursor:result.next_cursor});
  }
  if (path==='/api/project-relations') {
    const limit=pageLimit(params),where:string[]=[],args:unknown[]=[];
    if(params.has('project_id')) {
      const projectId=identifier(params.get('project_id'),'project');
      where.push('(r.from_project_id=? OR r.to_project_id=?)');args.push(projectId,projectId);
    }
    boundary(params,'r.created_at','r.id','UUID',where,args);
    const rows=await env.DB.prepare(`${relationSelect} ${where.length?'WHERE '+where.join(' AND '):''}
      ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).bind(...args,limit+1).all<Relation>();
    const result=page(rows.results,limit,'created_at');
    return json({relations:result.items,next_cursor:result.next_cursor});
  }
  if (path==='/api/tasks') {
    const limit=pageLimit(params),where:string[]=[],args:unknown[]=[];
    if(params.has('status')) {where.push('t.status=?');args.push(choice(params.get('status'),statuses,'task status'));}
    boundary(params,'t.created_at','t.id','UUID',where,args);
    const rows=await env.DB.prepare(`${taskSelect} ${where.length?'WHERE '+where.join(' AND '):''}
      ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).bind(...args,limit+1).all<Task>();
    const result=page(rows.results,limit,'created_at');
    return json({tasks:result.items,next_cursor:result.next_cursor});
  }
  const taskMatch=/^\/api\/tasks\/([^/]+)$/.exec(path);
  if(taskMatch) {
    const id=identifier(taskMatch[1],'UUID'),value=await task(env,id),limit=pageLimit(params);
    const where=['l.task_id=?'],args:unknown[]=[id];
    boundary(params,'l.linked_at','l.session_id','session',where,args);
    const rows=await env.DB.prepare(`SELECT s.*,l.linked_at,d.name AS device_name,p.name AS project_name,
      (SELECT COUNT(*) FROM events e WHERE e.session_id=s.id) AS event_count
      FROM task_sessions l JOIN sessions s ON s.id=l.session_id JOIN devices d ON d.id=s.device_id
      JOIN projects p ON p.id=s.project_id WHERE ${where.join(' AND ')}
      ORDER BY l.linked_at DESC,l.session_id DESC LIMIT ?`).bind(...args,limit+1).all<Record<string,unknown>>();
    const result=page(rows.results,limit,'linked_at');
    return json({task:value,sessions:result.items,next_cursor:result.next_cursor});
  }
  return null;
}

export async function projectWrite(request:Request,env:Env,actor:string):Promise<Response|null> {
  if(request.method!=='POST') return null;
  const path=new URL(request.url).pathname;
  if (!['/api/project-groups','/api/project-relations','/api/tasks'].includes(path) &&
      !/^\/api\/(project-groups\/[^/]+\/members|tasks\/[^/]+\/(sessions|status))$/.test(path)) return null;
  // A caller cannot inject its own audit identity through a body field.
  if (!actor || actor.length>128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new HttpError(500,'Invalid reviewer identity');
  const time=new Date().toISOString();
  if(path==='/api/project-groups') {
    const value=await body(request,['name']),name=text(value.name,'Group name',160),id=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO project_groups(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(id,name,time,time),
      audit(env,actor,'project_group.created','project_group',id,time)
    ]);
    return json({project_group:await group(env,id)},201);
  }
  const memberMatch=/^\/api\/project-groups\/([^/]+)\/members$/.exec(path);
  if(memberMatch) {
    const id=identifier(memberMatch[1],'UUID'),value=await body(request,['project_id']);
    const projectId=identifier(value.project_id,'project');
    await requireRow(env,'project_groups',id,'Project group');await requireRow(env,'projects',projectId,'Project');
    const auditId=crypto.randomUUID();
    const result=await env.DB.batch([
      env.DB.prepare('INSERT INTO project_group_members(group_id,project_id,linked_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(id,projectId,time),
      audit(env,actor,'project_group.member_linked','project_group_member',id+'/'+projectId,time,auditId,'WHERE changes()>0'),
      env.DB.prepare('UPDATE project_groups SET updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM project_workflow_audit WHERE id=?)').bind(time,id,auditId)
    ]);
    return json({group_id:id,project_id:projectId,created:result[0].meta.changes>0},result[0].meta.changes>0?201:200);
  }
  if(path==='/api/project-relations') {
    const value=await body(request,['from_project_id','to_project_id','type']);
    const from=identifier(value.from_project_id,'project'),to=identifier(value.to_project_id,'project');
    const type=choice(value.type,relationTypes,'relation type');
    if(from===to) throw new HttpError(400,'A project cannot relate to itself');
    await requireRow(env,'projects',from,'Source project');await requireRow(env,'projects',to,'Target project');
    const id=crypto.randomUUID();
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT INTO project_relations(id,from_project_id,to_project_id,type,created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(from_project_id,to_project_id,type) DO NOTHING`).bind(id,from,to,type,time),
      audit(env,actor,'project_relation.created','project_relation',id,time,crypto.randomUUID(),'WHERE changes()>0')
    ]);
    const relation=await env.DB.prepare(`${relationSelect} WHERE r.from_project_id=? AND r.to_project_id=? AND r.type=?`)
      .bind(from,to,type).first<Relation>();
    return json({relation,created:result[0].meta.changes>0},result[0].meta.changes>0?201:200);
  }
  if(path==='/api/tasks') {
    const value=await body(request,['title']),title=text(value.title,'Task title',240),id=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES(?,?,'open',?,?)").bind(id,title,time,time),
      audit(env,actor,'task.created','task',id,time)
    ]);
    return json({task:await task(env,id)},201);
  }
  const sessionMatch=/^\/api\/tasks\/([^/]+)\/sessions$/.exec(path);
  if(sessionMatch) {
    const id=identifier(sessionMatch[1],'UUID'),value=await body(request,['session_id']);
    const sessionId=identifier(value.session_id,'session');
    await requireRow(env,'tasks',id,'Task');await requireRow(env,'sessions',sessionId,'Session');
    const auditId=crypto.randomUUID();
    const result=await env.DB.batch([
      env.DB.prepare('INSERT INTO task_sessions(task_id,session_id,linked_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(id,sessionId,time),
      audit(env,actor,'task.session_linked','task_session',id+'/'+sessionId,time,auditId,'WHERE changes()>0'),
      env.DB.prepare('UPDATE tasks SET updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM project_workflow_audit WHERE id=?)').bind(time,id,auditId)
    ]);
    return json({task_id:id,session_id:sessionId,created:result[0].meta.changes>0},result[0].meta.changes>0?201:200);
  }
  const statusMatch=/^\/api\/tasks\/([^/]+)\/status$/.exec(path);
  if(statusMatch) {
    const id=identifier(statusMatch[1],'UUID'),value=await body(request,['status']);
    const status=choice(value.status,statuses,'task status');
    await requireRow(env,'tasks',id,'Task');
    const result=await env.DB.batch([
      env.DB.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status<>?').bind(status,time,id,status),
      audit(env,actor,'task.status.'+status,'task',id,time,crypto.randomUUID(),'WHERE changes()>0')
    ]);
    return json({task:await task(env,id),changed:result[0].meta.changes>0});
  }
  return null;
}
