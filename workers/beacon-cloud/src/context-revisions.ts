// Roadmap phase 3: revision history with validity windows, review flags and
// cross-project shares. Nothing here edits, approves, publishes or deletes a note:
// a flag asks a reviewer to look again, a resolution records why, a correction is a
// new revision through the existing supersede flow, and a share is re-checked on
// every read. See CONTEXT-WORKFLOWS.md.
import { z } from 'zod';
import { contextColumns, contextView, ContextRow, flagSelect, FlagRow, flagView, invalidSourceScope, shareSelect, ShareRow,
  shareView } from './context';
import type { ProjectedEvent } from './privacy';
import { CONTRADICTION_SIGNAL, isHighSignal, StageSignal } from './processing-stage';
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';

export const MAX_FLAG_EVIDENCE = 20;
/** Entries returned by one history read (ancestors, the entry and descendants). */
export const MAX_HISTORY = 100;
/** Evaluator flags carry a pipeline identity, which the database never lets resolve one. */
export const JEV_FLAG_ACTOR = 'pipeline:beacon.jev@1';
export type EvidencePair = { event_id: string; payload_hash: string };

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid();
const prose = (max: number) => z.string().min(1).max(max).refine((value) => !!value.trim());
const flagSchema = z.object({ kind: z.enum(['contradiction', 'needs_review']), note: prose(2000).optional(),
  evidence: z.array(z.object({ event_id: hash, payload_hash: hash }).strict()).max(MAX_FLAG_EVIDENCE).optional() }).strict();
const resolveSchema = z.object({ resolution: z.enum(['resolved', 'dismissed']), reason: prose(2000) }).strict();
const shareSchema = z.object({ target_type: z.literal('project'), target_id: hash }).strict();
const emptySchema = z.object({}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Invalid context revision request');
  return result.data;
}
function dbError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/context_flag_evidence/.test(message)) throw new HttpError(400, 'Evidence must name existing event versions, each once');
  if (/context_(?:flag|share)_|UNIQUE/.test(message)) throw new HttpError(409, 'Context changed; reload the current entry');
  throw error;
}

/**
 * The revision chain around one entry: every ancestor through supersedes_id and every
 * descendant (approved, superseded, pending or rejected revisions), oldest first, each
 * with its validity window, authority, open flag count and review audit. Content is left
 * to the entry detail, so a long chain stays small. A chain longer than MAX_HISTORY keeps
 * the entries nearest the requested one (by revision distance, then age), so the entry
 * itself and its neighbours are always there; `truncated` says that farther ones exist.
 */
export async function contextHistory(env: Env, id: string) {
  if (!uuid.safeParse(id).success) throw new HttpError(400, 'Invalid context id');
  if (!await env.DB.prepare('SELECT id FROM context_entries WHERE id=? AND sealed=1').bind(id).first()) throw new HttpError(404, 'Context not found');
  const rows = (await env.DB.prepare(`WITH RECURSIVE
      up(id,depth) AS (SELECT ?,0 UNION SELECT c.supersedes_id,up.depth+1 FROM context_entries c JOIN up ON c.id=up.id
        WHERE c.supersedes_id IS NOT NULL AND up.depth<?),
      down(id,depth) AS (SELECT ?,0 UNION SELECT c.id,down.depth+1 FROM context_entries c JOIN down ON c.supersedes_id=down.id WHERE down.depth<?),
      near(id,distance) AS (SELECT id,MIN(depth) FROM (SELECT id,depth FROM up UNION ALL SELECT id,depth FROM down) GROUP BY id)
    SELECT ${contextColumns},CASE WHEN c.id=? THEN 'self' WHEN c.id IN (SELECT id FROM up) THEN 'ancestor' ELSE 'descendant' END AS relation
    FROM near JOIN context_entries c ON c.id=near.id LEFT JOIN context_generation g ON g.context_id=c.id
    WHERE c.sealed=1 ORDER BY near.distance,c.created_at,c.id LIMIT ?`)
    .bind(id, MAX_HISTORY, id, MAX_HISTORY, id, MAX_HISTORY + 1).all<ContextRow & { relation: string }>()).results;
  // Nearest first decides what is kept; the response is oldest first.
  const kept = rows.slice(0, MAX_HISTORY).sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const audit = (await env.DB.prepare(`SELECT context_id,id,actor,action,reason,created_at FROM context_audit
    WHERE context_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id`).bind(JSON.stringify(kept.map((row) => row.id)))
    .all<{ context_id: string; id: string; actor: string; action: string; reason: string | null; created_at: string }>()).results;
  return { context_id: id, truncated: rows.length > MAX_HISTORY, entries: kept.map(({ relation, ...row }) => {
    const { content: _content, ...entry } = contextView(row);
    return { ...entry, relation, audit: audit.filter((item) => item.context_id === row.id).map(({ context_id: _id, ...item }) => item) };
  }) };
}

export async function getFlag(env: Env, id: string) {
  if (!uuid.safeParse(id).success) throw new HttpError(400, 'Invalid flag id');
  const [row, audit] = await env.DB.batch([env.DB.prepare(`${flagSelect} WHERE f.id=?`).bind(id),
    env.DB.prepare('SELECT id,actor,action,reason,created_at FROM context_flag_audit WHERE flag_id=? ORDER BY created_at,id').bind(id)]);
  const flag = row.results[0] as FlagRow | undefined;
  if (!flag) throw new HttpError(404, 'Flag not found');
  return { ...flagView(flag), audit: audit.results };
}
async function createFlag(request: Request, env: Env, id: string, actor: string) {
  const input = parse(flagSchema, await readJson(request)), evidence = input.evidence ?? [];
  if (new Set(evidence.map((pair) => pair.event_id + ':' + pair.payload_hash)).size !== evidence.length)
    throw new HttpError(400, 'Duplicate evidence versions');
  const entry = await env.DB.prepare('SELECT status FROM context_entries WHERE id=? AND sealed=1').bind(id).first<{ status: string }>();
  if (!entry) throw new HttpError(404, 'Context not found');
  if (entry.status !== 'approved') throw new HttpError(409, 'Only a current approved entry can be flagged');
  const pairs = JSON.stringify(evidence.map(({ event_id, payload_hash }) => ({ event_id, payload_hash })));
  if (evidence.length && (await env.DB.prepare(`SELECT COUNT(*) AS n FROM json_each(?) j JOIN event_versions v
    ON v.event_id=json_extract(j.value,'$.event_id') AND v.payload_hash=json_extract(j.value,'$.payload_hash')`).bind(pairs).first<{ n: number }>())!.n
    !== evidence.length) throw new HttpError(400, 'Evidence event version not found');
  const flagId = crypto.randomUUID();
  // The triggers repeat every check inside the insert, so a concurrent review cannot slip past them.
  try {
    await env.DB.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,job_id,evidence,note,status,created_at,created_by)
      VALUES(?,?,?,'reviewer',NULL,?,?,'open',?,?)`).bind(flagId, id, input.kind, pairs, input.note ?? null, new Date().toISOString(), actor).run();
  } catch (error) { dbError(error); }
  return json({ flag: await getFlag(env, flagId) }, 201);
}
async function resolveFlag(request: Request, env: Env, id: string, actor: string) {
  const input = parse(resolveSchema, await readJson(request));
  let row: { id: string } | null;
  try {
    row = await env.DB.prepare(`UPDATE context_flags SET status=?,resolved_at=?,resolved_by=?,resolution_reason=? WHERE id=? AND status='open'
      RETURNING id`).bind(input.resolution, new Date().toISOString(), actor, input.reason, id).first<{ id: string }>();
  } catch (error) { dbError(error); }
  if (!row!) {
    if (await env.DB.prepare('SELECT id FROM context_flags WHERE id=?').bind(id).first()) throw new HttpError(409, 'Flag already closed');
    throw new HttpError(404, 'Flag not found');
  }
  return json({ flag: await getFlag(env, id) });
}

export async function getShare(env: Env, id: string) {
  const row = await env.DB.prepare(`${shareSelect} WHERE sh.id=?`).bind(id).first<ShareRow>();
  if (!row) throw new HttpError(404, 'Share not found');
  const [entry, audit] = await env.DB.batch([
    env.DB.prepare(`SELECT c.status='approved' AND NOT ${invalidSourceScope} AS authoritative FROM context_entries c WHERE c.id=?`).bind(row.context_id),
    env.DB.prepare('SELECT id,actor,action,created_at FROM context_share_audit WHERE share_id=? ORDER BY created_at,id').bind(id)]);
  return { ...shareView(row, !!(entry.results[0] as { authoritative: number } | undefined)?.authoritative), audit: audit.results };
}
async function createShare(request: Request, env: Env, id: string, actor: string) {
  const input = parse(shareSchema, await readJson(request));
  const entry = await env.DB.prepare(`SELECT c.kind,c.status,c.project_id,NOT ${invalidSourceScope} AS sources_valid FROM context_entries c
    WHERE c.id=? AND c.sealed=1`).bind(id).first<{ kind: string; status: string; project_id: string; sources_valid: number }>();
  if (!entry) throw new HttpError(404, 'Context not found');
  if (!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(input.target_id).first()) throw new HttpError(404, 'Project not found');
  if (entry.project_id === input.target_id) throw new HttpError(400, 'An entry is already visible in its own project');
  if (entry.kind !== 'memory' || entry.status !== 'approved' || !entry.sources_valid)
    throw new HttpError(409, 'Only an approved, authoritative memory can be shared');
  const shareId = crypto.randomUUID();
  let result: D1Result;
  try {
    result = await env.DB.prepare(`INSERT INTO context_shares(id,context_id,target_type,target_id,created_at,created_by) VALUES(?,?,'project',?,?,?)
      ON CONFLICT DO NOTHING`).bind(shareId, id, input.target_id, new Date().toISOString(), actor).run();
  } catch (error) { dbError(error); }
  if (result!.meta.changes) return json({ share: await getShare(env, shareId), created: true }, 201);
  const active = await env.DB.prepare(`SELECT id FROM context_shares WHERE context_id=? AND target_type='project' AND target_id=?
    AND revoked_at IS NULL`).bind(id, input.target_id).first<{ id: string }>();
  if (!active) throw new HttpError(409, 'Context changed; reload the current entry');
  return json({ share: await getShare(env, active.id), created: false });
}
async function revokeShare(request: Request, env: Env, id: string, actor: string) {
  parse(emptySchema, await readJson(request));
  let row: { id: string } | null;
  try {
    row = await env.DB.prepare('UPDATE context_shares SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL RETURNING id')
      .bind(new Date().toISOString(), actor, id).first<{ id: string }>();
  } catch (error) { dbError(error); }
  if (!row!) {
    if (await env.DB.prepare('SELECT id FROM context_shares WHERE id=?').bind(id).first()) throw new HttpError(409, 'Share already revoked');
    throw new HttpError(404, 'Share not found');
  }
  return json({ share: await getShare(env, id) });
}

/**
 * Up to twenty exact versions a job's flag cites: high-signal events (failures, denials,
 * enforcement) first, then the newest, listed in the job's own order. Evaluators do not
 * say which event contradicts a note, so this points the reviewer at the likeliest ones.
 */
export function flagEvidence(events: readonly (ProjectedEvent & EvidencePair)[]): EvidencePair[] {
  return events.map((event, index) => ({ event, index, high: isHighSignal(event) }))
    .sort((a, b) => Number(b.high) - Number(a.high) || b.index - a.index).slice(0, MAX_FLAG_EVIDENCE)
    .sort((a, b) => a.index - b.index).map(({ event }) => ({ event_id: event.event_id, payload_hash: event.payload_hash }));
}

/**
 * One open `contradiction` flag per answer `contradiction:<id>` >= 0.5, on that entry only,
 * and only while it is an approved entry of the job's project. Committed in the same D1
 * batch as the stored answers (after them), idempotent per job and entry, and never able
 * to abort that batch: every condition the triggers check is also a filter here.
 */
export function contradictionFlagStatements(db: D1Database, input: { job_id: string; now: string; evidence: readonly EvidencePair[];
  signals: readonly Pick<StageSignal, 'question_id' | 'probability'>[] }): D1PreparedStatement[] {
  if (!input.evidence.length) return [];
  const evidence = JSON.stringify(input.evidence.slice(0, MAX_FLAG_EVIDENCE).map(({ event_id, payload_hash }) => ({ event_id, payload_hash })));
  return input.signals.filter((signal) => /^contradiction:[0-9a-f-]{36}$/.test(signal.question_id) && signal.probability >= CONTRADICTION_SIGNAL)
    .map((signal) => db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,job_id,evidence,status,created_at,created_by)
      SELECT ?,c.id,'contradiction','jev',j.id,?,'open',?,? FROM processing_jobs j
        JOIN context_entries c ON c.id=? AND c.project_id=j.project_id AND c.status='approved' AND c.sealed=1
      WHERE j.id=? AND EXISTS(SELECT 1 FROM processing_signals s WHERE s.job_id=j.id AND s.question_id='contradiction:'||c.id AND s.probability>=?)
        AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM event_versions v
          WHERE v.event_id=json_extract(e.value,'$.event_id') AND v.payload_hash=json_extract(e.value,'$.payload_hash')))
      ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), evidence, input.now, JEV_FLAG_ACTOR, signal.question_id.slice('contradiction:'.length),
      input.job_id, CONTRADICTION_SIGNAL, evidence));
}

/** Read-authenticated GETs: a revision history and one flag with its audit. */
export async function revisionsRead(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const flag = /^\/api\/context\/flags\/([^/]+)$/.exec(url.pathname), history = /^\/api\/context\/([^/]+)\/history$/.exec(url.pathname);
  if (!flag && !history) return null;
  if (url.search) throw new HttpError(400, 'Context history and flags do not accept filters');
  return flag ? json({ flag: await getFlag(env, flag[1]) }) : json(await contextHistory(env, history![1]));
}

type Write = (request: Request, env: Env, id: string, actor: string) => Promise<Response>;
const writes: [RegExp, Write][] = [
  [/^\/api\/context\/flags\/([^/]+)\/resolve$/, resolveFlag],
  [/^\/api\/context\/shares\/([^/]+)\/revoke$/, revokeShare],
  [/^\/api\/context\/([^/]+)\/flags$/, createFlag],
  [/^\/api\/context\/([^/]+)\/shares$/, createShare],
];
/** Reviewer-authenticated POSTs; the router has already checked origin and review authority. */
export async function revisionsWrite(request: Request, env: Env, actor: string): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url);
  for (const [pattern, write] of writes) {
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new HttpError(500, 'Invalid reviewer identity');
    if (/^pipeline:/i.test(actor)) throw new HttpError(403, 'Background processors cannot review flags or shares');
    if (url.search) throw new HttpError(400, 'Context writes do not accept filters');
    if (!uuid.safeParse(match[1]).success) throw new HttpError(400, 'Invalid context, flag or share id');
    return write(request, env, match[1], actor);
  }
  return null;
}
