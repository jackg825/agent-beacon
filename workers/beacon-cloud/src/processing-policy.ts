import { digest } from './auth';
import { externalEndpoint } from './external-fetch';
import { stableJSON } from './identity';
import { FIELD_CLASSES, FieldClass } from './privacy';
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';

export const projectPattern = /^[a-f0-9]{64}$/;
type Flags = { enabled: boolean; external_allowed: boolean; jev_enabled: boolean };
export interface PolicyValues extends Flags {
  summary_fields: FieldClass[];
  /** Classes that may leave the workspace; always a subset of summary_fields. */
  external_fields: FieldClass[];
  min_new_events: number; quiet_minutes: number; max_events_per_job: number;
  /** Null never skips on an evaluator answer. */
  jev_skip_threshold: number | null;
}
export interface PolicyRow extends PolicyValues {
  scope_type: 'workspace' | 'project'; scope_id: string; version: number; updated_at: string; updated_by: string;
}
export interface EffectivePolicy extends PolicyValues { policy_hash: string }

/** Built-in defaults: everything off, nothing allowed. A missing workspace row means these. */
export const DEFAULT_POLICY: PolicyValues = Object.freeze({
  enabled: false, external_allowed: false, jev_enabled: false, summary_fields: [], external_fields: [],
  min_new_events: 20, quiet_minutes: 30, max_events_per_job: 200, jev_skip_threshold: null,
}) as PolicyValues;
export const POLICY_BOUNDS = { min_new_events: [1, 1000], quiet_minutes: [0, 1440], max_events_per_job: [1, 200] } as const;

type StoredRow = Omit<PolicyRow, keyof Flags | 'summary_fields' | 'external_fields'> & {
  enabled: number; external_allowed: number; jev_enabled: number; summary_fields: string; external_fields: string;
};
function fields(value: string): FieldClass[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? FIELD_CLASSES.filter((item) => parsed.includes(item)) : [];
  } catch { return []; }
}
export function policyRow(row: StoredRow): PolicyRow {
  return { ...row, enabled: !!row.enabled, external_allowed: !!row.external_allowed, jev_enabled: !!row.jev_enabled,
    summary_fields: fields(row.summary_fields), external_fields: fields(row.external_fields) };
}
function values(row: PolicyValues): PolicyValues {
  const { enabled, external_allowed, jev_enabled, summary_fields, external_fields, min_new_events, quiet_minutes,
    max_events_per_job, jev_skip_threshold } = row;
  return { enabled, external_allowed, jev_enabled, summary_fields, external_fields, min_new_events, quiet_minutes,
    max_events_per_job, jev_skip_threshold };
}

/**
 * The workspace row is a ceiling. Booleans are workspace AND project, field sets the
 * intersection, the per-job cap the smaller value and the skip threshold only exists
 * when both set it. Timing comes from the project row. No project row means the
 * workspace row; no workspace row means the built-in defaults (everything off).
 */
export async function resolvePolicy(workspace: PolicyValues | null, project: PolicyValues | null): Promise<EffectivePolicy> {
  const ceiling = workspace ? values(workspace) : DEFAULT_POLICY;
  const own = project ? values(project) : ceiling;
  const both = (left: FieldClass[], right: FieldClass[]) => FIELD_CLASSES.filter((item) => left.includes(item) && right.includes(item));
  const summary = both(ceiling.summary_fields, own.summary_fields);
  const effective: PolicyValues = {
    enabled: ceiling.enabled && own.enabled,
    external_allowed: ceiling.external_allowed && own.external_allowed,
    jev_enabled: ceiling.jev_enabled && own.jev_enabled,
    summary_fields: summary,
    external_fields: both(ceiling.external_fields, own.external_fields).filter((item) => summary.includes(item)),
    min_new_events: own.min_new_events, quiet_minutes: own.quiet_minutes,
    max_events_per_job: Math.min(ceiling.max_events_per_job, own.max_events_per_job),
    jev_skip_threshold: ceiling.jev_skip_threshold === null || own.jev_skip_threshold === null ? null
      : Math.min(ceiling.jev_skip_threshold, own.jev_skip_threshold),
  };
  // Identify the policy by what it does, not by per-row versions that can collide.
  return { ...effective, policy_hash: await digest(stableJSON(effective)) };
}

export async function policyRows(env: Env, projectId?: string) {
  const rows = await env.DB.prepare(`SELECT * FROM processing_policies WHERE (scope_type='workspace' AND scope_id='*')
    OR (scope_type='project' AND scope_id=?)`).bind(projectId ?? '').all<StoredRow>();
  const workspace = rows.results.find((row) => row.scope_type === 'workspace');
  const project = rows.results.find((row) => row.scope_type === 'project');
  return { workspace: workspace ? policyRow(workspace) : null, project: project ? policyRow(project) : null };
}

/** Current effective policy for one project, always resolved at the moment of use. */
export async function effectivePolicy(env: Env, projectId: string): Promise<EffectivePolicy> {
  const rows = await policyRows(env, projectId);
  return resolvePolicy(rows.workspace, rows.project);
}

export const DEFAULT_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Operator configuration for the evaluator; an invalid endpoint or model disables it. */
export function jevConfig(env: Env): { endpoint: string | null; model: string | null } {
  const model = (env.JEV_MODEL ?? '').trim() || DEFAULT_JEV_MODEL;
  return { endpoint: externalEndpoint(env.JEV_ENDPOINT, DEFAULT_JEV_ENDPOINT, env.PUBLIC_URL), model: modelPattern.test(model) ? model : null };
}

/**
 * Deploy-time gate for outbound evaluator calls. The operator var must list the
 * project (or `*`), the effective policy must allow external use and Jev, the key
 * must exist and the configured endpoint/model must be valid. A budget reservation
 * is still required before every call.
 */
export function externalGate(env: Env, projectId: string, policy: PolicyValues) {
  const listed = (env.EXTERNAL_PROCESSING_PROJECTS || '').split(',').map((item) => item.trim()).filter(Boolean);
  const deploy_allowed = listed.includes('*') || listed.includes(projectId);
  const key_configured = !!env.JEV_API_KEY;
  const config = jevConfig(env), endpoint_valid = !!config.endpoint && !!config.model;
  const policy_allowed = policy.enabled && policy.external_allowed && policy.jev_enabled;
  return { deploy_allowed, key_configured, endpoint_valid, policy_allowed,
    eligible: deploy_allowed && key_configured && endpoint_valid && policy_allowed };
}

const policyKeys = ['scope_type','scope_id','enabled','external_allowed','jev_enabled','summary_fields','external_fields',
  'min_new_events','quiet_minutes','max_events_per_job','jev_skip_threshold'];
function fieldList(value: unknown, label: string): FieldClass[] {
  if (!Array.isArray(value) || value.length > FIELD_CLASSES.length || new Set(value).size !== value.length
    || value.some((item) => !(FIELD_CLASSES as readonly unknown[]).includes(item)))
    throw new HttpError(400, `${label} must list distinct known field classes`);
  return FIELD_CLASSES.filter((item) => value.includes(item));
}
function bounded(value: unknown, label: keyof typeof POLICY_BOUNDS): number {
  const [min, max] = POLICY_BOUNDS[label];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new HttpError(400, `${label} must be an integer ${min}–${max}`);
  return value;
}
function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be true or false`);
  return value;
}

/** Full replacement of one policy row; every field is required and validated. */
export function parsePolicy(value: unknown): { scope_type: 'workspace' | 'project'; scope_id: string } & PolicyValues {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !policyKeys.includes(key))
    || policyKeys.some((key) => !Object.hasOwn(value, key)))
    throw new HttpError(400, 'Policy must contain exactly the policy fields');
  const input = value as Record<string, unknown>;
  const scope_type = input.scope_type;
  if (scope_type !== 'workspace' && scope_type !== 'project') throw new HttpError(400, 'Invalid policy scope_type');
  if (scope_type === 'workspace' ? input.scope_id !== '*' : typeof input.scope_id !== 'string' || !projectPattern.test(input.scope_id))
    throw new HttpError(400, 'Invalid policy scope_id');
  const summary_fields = fieldList(input.summary_fields, 'summary_fields');
  const external_fields = fieldList(input.external_fields, 'external_fields');
  if (external_fields.some((item) => !summary_fields.includes(item)))
    throw new HttpError(400, 'external_fields must be a subset of summary_fields');
  const threshold = input.jev_skip_threshold;
  if (threshold !== null && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1))
    throw new HttpError(400, 'jev_skip_threshold must be null or 0–1');
  return { scope_type, scope_id: input.scope_id as string, enabled: flag(input.enabled, 'enabled'),
    external_allowed: flag(input.external_allowed, 'external_allowed'), jev_enabled: flag(input.jev_enabled, 'jev_enabled'),
    summary_fields, external_fields, min_new_events: bounded(input.min_new_events, 'min_new_events'),
    quiet_minutes: bounded(input.quiet_minutes, 'quiet_minutes'),
    max_events_per_job: bounded(input.max_events_per_job, 'max_events_per_job'), jev_skip_threshold: threshold as number | null };
}

export async function writePolicy(request: Request, env: Env, actor: string): Promise<Response> {
  const input = parsePolicy(await readJson(request));
  if (input.scope_type === 'project' && !await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(input.scope_id).first())
    throw new HttpError(404, 'Project not found');
  const time = new Date().toISOString();
  const stored = { ...values(input), summary_fields: JSON.stringify(input.summary_fields), external_fields: JSON.stringify(input.external_fields) };
  // Upsert and its audit commit together; the audit captures exactly the stored row.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO processing_policies(scope_type,scope_id,enabled,external_allowed,jev_enabled,summary_fields,
      external_fields,min_new_events,quiet_minutes,max_events_per_job,jev_skip_threshold,version,updated_at,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(scope_type,scope_id) DO UPDATE SET enabled=excluded.enabled,
      external_allowed=excluded.external_allowed,jev_enabled=excluded.jev_enabled,summary_fields=excluded.summary_fields,
      external_fields=excluded.external_fields,min_new_events=excluded.min_new_events,quiet_minutes=excluded.quiet_minutes,
      max_events_per_job=excluded.max_events_per_job,jev_skip_threshold=excluded.jev_skip_threshold,
      version=processing_policies.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(input.scope_type, input.scope_id, +stored.enabled, +stored.external_allowed, +stored.jev_enabled, stored.summary_fields,
        stored.external_fields, stored.min_new_events, stored.quiet_minutes, stored.max_events_per_job, stored.jev_skip_threshold, time, actor),
    env.DB.prepare(`INSERT INTO processing_policy_audit(id,scope_type,scope_id,version,policy,actor,created_at)
      SELECT ?,scope_type,scope_id,version,json_object('enabled',enabled,'external_allowed',external_allowed,'jev_enabled',jev_enabled,
        'summary_fields',json(summary_fields),'external_fields',json(external_fields),'min_new_events',min_new_events,
        'quiet_minutes',quiet_minutes,'max_events_per_job',max_events_per_job,'jev_skip_threshold',jev_skip_threshold),?,?
      FROM processing_policies WHERE scope_type=? AND scope_id=?`).bind(crypto.randomUUID(), actor, time, input.scope_type, input.scope_id),
  ]);
  return json(await policyView(env, input.scope_type === 'project' ? input.scope_id : undefined), 200);
}

export async function policyView(env: Env, projectId?: string) {
  const rows = await policyRows(env, projectId);
  const effective = await resolvePolicy(rows.workspace, rows.project);
  const audit = await env.DB.prepare(`SELECT id,scope_type,scope_id,version,actor,created_at FROM processing_policy_audit
    WHERE (scope_type='workspace' AND scope_id='*') OR (scope_type='project' AND scope_id=?)
    ORDER BY created_at DESC,id DESC LIMIT 20`).bind(projectId ?? '').all();
  return { project_id: projectId ?? null, workspace: rows.workspace, project: rows.project, defaults: DEFAULT_POLICY,
    field_classes: FIELD_CLASSES, effective,
    external_gate: projectId ? externalGate(env, projectId, effective) : null, audit: audit.results };
}

export async function readPolicy(env: Env, params: URLSearchParams) {
  for (const key of params.keys()) if (key !== 'project_id' || params.getAll(key).length !== 1)
    throw new HttpError(400, 'Invalid policy filter');
  if (!params.has('project_id')) {
    const view = await policyView(env);
    const overrides = await env.DB.prepare(`SELECT pp.*,p.name AS project_name FROM processing_policies pp
      JOIN projects p ON p.id=pp.scope_id WHERE pp.scope_type='project' ORDER BY p.name,pp.scope_id LIMIT 1000`)
      .all<StoredRow & { project_name: string }>();
    return { ...view, projects: overrides.results.map((row) => ({ ...policyRow(row), project_name: row.project_name })) };
  }
  const projectId = params.get('project_id')!;
  if (!projectPattern.test(projectId)) throw new HttpError(400, 'Invalid project identifier');
  if (!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(projectId).first()) throw new HttpError(404, 'Project not found');
  return policyView(env, projectId);
}
