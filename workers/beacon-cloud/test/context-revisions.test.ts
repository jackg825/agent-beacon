import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { contextWrite, getContext, insertCandidate, listContext } from '../src/context';
import { contextHistory, contradictionFlagStatements, flagEvidence, JEV_FLAG_ACTOR, revisionsRead, revisionsWrite } from '../src/context-revisions';
import { stableJSON } from '../src/identity';
import { runMaintenance } from '../src/maintenance';
import type { ProjectedEvent } from '../src/privacy';
import type { SelectionStage, StageSignal } from '../src/processing-stage';
import { SNAPSHOT_SCHEMA, syncDeviceRead, syncRead, syncWrite } from '../src/sync';
import { Env, HttpError } from '../src/types';
import { createEnvFixture, fixtureDevices, syntheticEvent } from './env-fixture';
import { operationsTokens, operationsWorker } from './operations-fixture';
import { command, count, job, later, review, reviewer, run, setBudget, setPolicy, staged, tick, workspace } from './processing-helpers';

// Synthetic notes, events, devices and credentials only; no network and no installed Beacon data.
type Fixture = Awaited<ReturnType<typeof createEnvFixture>>;
type Source = { id: string; payload_hash: string; project_id: string };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const get = (path: string) => new Request('http://localhost' + path);
const post = (path: string, body: unknown) => new Request('http://localhost' + path, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const rejects = (operation: Promise<unknown>, status: number, message?: RegExp) => assert.rejects(operation,
  (error: unknown) => error instanceof HttpError && error.status === status && (!message || message.test(error.message)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(response: Response | null) { assert.ok(response); return response.json() as Promise<any>; }
const write = (env: Env, path: string, body: unknown, actor = reviewer) => revisionsWrite(post(path, body), env, actor);
const list = async (env: Env, query: Record<string, string>) => (await listContext(env, new URLSearchParams(query))).context as any[];
const pair = (event: Source) => ({ event_id: event.id, payload_hash: event.payload_hash });
const source = async (f: Fixture, eventId: string) => (await f.event(eventId)) as Source;

/** A candidate through the real insert path; reviewed through the real route when asked. */
async function note(env: Env, from: Source, options: { title: string; kind?: 'memory' | 'summary'; supersedes?: string },
  decision?: 'approve' | 'reject') {
  const id = await insertCandidate(env, { kind: options.kind ?? 'memory', project_id: from.project_id, title: options.title,
    content: `Synthetic content for ${options.title}.`, sources: [pair(from)], ...(options.supersedes ? { supersedes_id: options.supersedes } : {}) }, reviewer);
  if (decision) assert.equal((await contextWrite(post(`/api/context/${id}/review`, { decision }), env, reviewer))!.status, 200);
  return id;
}

test('validity windows follow supersession, the history shows the whole chain, and as_of answers what was approved at an instant', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('rev-1'));
    const from = await source(f, 'rev-1');
    // Approvals a few milliseconds apart, so each window is non-empty.
    const v1 = await note(f.env, from, { title: 'v1' }, 'approve'); await sleep(5);
    const v2 = await note(f.env, from, { title: 'v2', supersedes: v1 }, 'approve'); await sleep(5);
    const rejected = await note(f.env, from, { title: 'v2 rejected revision', supersedes: v2 }, 'reject'); await sleep(5);
    const v3 = await note(f.env, from, { title: 'v3', supersedes: v2 }, 'approve');
    const pending = await note(f.env, from, { title: 'v4 pending', supersedes: v3 });
    const [d1, d2, d3, dr, dp] = await Promise.all([v1, v2, v3, rejected, pending].map(async (id) => (await getContext(f.env, id)).context as any));
    assert.deepEqual([d1.status, d2.status, d3.status, dr.status, dp.status], ['superseded', 'superseded', 'approved', 'rejected', 'pending']);
    assert.ok(d1.reviewed_at < d2.reviewed_at && d2.reviewed_at < d3.reviewed_at);
    assert.deepEqual([d1.valid_from, d1.valid_until], [d1.reviewed_at, d2.reviewed_at]);
    assert.deepEqual([d2.valid_from, d2.valid_until], [d2.reviewed_at, d3.reviewed_at]);
    assert.deepEqual([d3.valid_from, d3.valid_until, d3.authoritative], [d3.reviewed_at, null, true]);
    assert.deepEqual([dr.valid_from, dr.valid_until, dp.valid_from, dp.valid_until], [null, null, null, null]);
    assert.deepEqual([d3.open_flags, d3.flags, d3.shares, d3.flags_truncated, d3.shares_truncated], [0, [], [], false, false]);

    // From the middle: every ancestor and every later revision, oldest first, without content.
    const middle = await contextHistory(f.env, v2);
    assert.deepEqual(middle.entries.map((entry: any) => [entry.id, entry.relation]),
      [[v1, 'ancestor'], [v2, 'self'], [rejected, 'descendant'], [v3, 'descendant'], [pending, 'descendant']]);
    assert.equal(middle.truncated, false);
    assert.ok(middle.entries.every((entry: any) => !('content' in entry) && 'valid_from' in entry && 'valid_until' in entry));
    const audit = (id: string) => middle.entries.find((entry: any) => entry.id === id)!.audit.map((row: any) => row.action);
    assert.deepEqual([audit(v1), audit(v2), audit(rejected), audit(v3), audit(pending)],
      [['create', 'approve', 'supersede'], ['create', 'approve', 'supersede'], ['create', 'reject'], ['create', 'approve'], ['create']]);
    // From the newest approved version, a rejected sibling branch is not part of its chain.
    assert.deepEqual((await contextHistory(f.env, v3)).entries.map((entry: any) => entry.id), [v1, v2, v3, pending]);
    assert.deepEqual(await json(await revisionsRead(get(`/api/context/${v2}/history`), f.env)), middle);
    for (const path of [`/api/context/${v2}/history?limit=1`, '/api/context/not-a-uuid/history']) await rejects(revisionsRead(get(path), f.env), 400);
    await rejects(revisionsRead(get(`/api/context/${crypto.randomUUID()}/history`), f.env), 404);
    assert.equal(await revisionsRead(get(`/api/context/${v2}`), f.env), null, 'the detail stays with context.ts');

    // as_of: approved at that instant and not yet replaced; a window is [valid_from, valid_until).
    const at = async (time: string) => (await list(f.env, { project_id: from.project_id, as_of: time })).map((entry) => entry.id);
    const before = (time: string) => new Date(Date.parse(time) - 1).toISOString();
    assert.deepEqual(await at(before(d1.reviewed_at)), []);
    assert.deepEqual(await at(d1.reviewed_at), [v1]);
    assert.deepEqual(await at(before(d2.reviewed_at)), [v1]);
    assert.deepEqual(await at(d2.reviewed_at), [v2]);
    assert.deepEqual(await at(before(d3.reviewed_at)), [v2]);
    assert.deepEqual(await at(d3.reviewed_at), [v3]);
    assert.deepEqual(await at('2099-01-01T00:00:00Z'), [v3], 'seconds without milliseconds are accepted');
    const past = (await list(f.env, { as_of: d1.reviewed_at }))[0];
    assert.deepEqual([past.id, past.status, past.authoritative, past.valid_until], [v1, 'superseded', false, d2.reviewed_at]);
    for (const query of [{ as_of: 'yesterday' }, { as_of: '2026-10-08' }, { as_of: '2026-10-08T00:00:00+08:00' }, { as_of: '2026-13-40T00:00:00Z' },
      { as_of: d1.reviewed_at, status: 'approved' }, { flagged: 'yes' }] as Record<string, string>[]) await rejects(listContext(f.env, new URLSearchParams(query)), 400);
  } finally { await f.close(); }
});

test('revision lookups stay on the revision index once statistics exist (EXPLAIN QUERY PLAN after ANALYZE)', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('plan-1'));
    const from = await source(f, 'plan-1');
    const v1 = await note(f.env, from, { title: 'plan v1' }, 'approve');
    // Many entries and no revision yet, the normal state (the pipeline never sets supersedes_id),
    // when someone runs a plain ANALYZE; the statistics stay as they are after the first revision.
    const rows = Array.from({ length: 300 }, (_, index) => ({ id: crypto.randomUUID(), at: new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString() }));
    await f.env.DB.prepare(`INSERT INTO context_entries(id,kind,project_id,title,content,created_at) SELECT json_extract(value,'$.id'),'memory',?,
      'Synthetic plan filler','Synthetic only.',json_extract(value,'$.at') FROM json_each(?)`).bind(from.project_id, JSON.stringify(rows)).run();
    await f.env.DB.prepare('ANALYZE').run();
    const v2 = await note(f.env, from, { title: 'plan v2', supersedes: v1 }, 'approve');
    // Plan exactly the statements the read paths run.
    const captured: { sql: string; args: unknown[] }[] = [];
    const recording = { ...f.env, DB: new Proxy(f.env.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => new Proxy(target.prepare(sql), { get(statement, key) {
        if (key === 'bind') return (...args: unknown[]) => { captured.push({ sql, args }); return statement.bind(...args); };
        const value = (statement as any)[key]; return typeof value === 'function' ? value.bind(statement) : value;
      } });
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    await listContext(recording, new URLSearchParams({ as_of: new Date().toISOString() }));
    await listContext(recording, new URLSearchParams({ project_id: from.project_id }));
    await getContext(recording, v2);
    await contextHistory(recording, v1);
    const steps: string[] = [];
    for (const { sql, args } of captured.filter((item) => /context_entries/.test(item.sql)))
      steps.push(...(await f.env.DB.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...args).all<{ detail: string }>()).results.map((row) => row.detail));
    assert.ok(steps.some((step) => /SEARCH (child|c) USING (COVERING )?INDEX context_entries_supersedes/.test(step)), steps.join('\n'));
    for (const step of steps) assert.doesNotMatch(step, /^SCAN (child|c)$/, 'a full scan of context_entries per row');
  } finally { await f.close(); }
});

test('a history longer than its limit keeps the requested entry and the revisions nearest to it', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('long-1'));
    const from = await source(f, 'long-1');
    const chain = [await note(f.env, from, { title: 'long v0' }, 'approve')];
    // 104 more approved revisions through the real triggers, each superseding the previous, in one D1 batch.
    const db = f.env.DB, statements: D1PreparedStatement[] = [], start = Date.now() + 1000;
    for (let index = 1; index <= 104; index++) {
      const id = crypto.randomUUID(), at = new Date(start + index * 1000).toISOString();
      statements.push(
        db.prepare(`INSERT INTO context_entries(id,kind,project_id,title,content,supersedes_id,created_at) VALUES(?,'memory',?,?,'Synthetic only.',?,?)`)
          .bind(id, from.project_id, 'long v' + index, chain.at(-1), at),
        db.prepare('INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal) VALUES(?,?,?,0)').bind(id, from.id, from.payload_hash),
        db.prepare('UPDATE context_entries SET sealed=1 WHERE id=?').bind(id),
        db.prepare(`UPDATE context_entries SET status='approved',review_id=?,reviewed_at=?,reviewed_by=? WHERE id=?`).bind(crypto.randomUUID(), at, reviewer, id));
      chain.push(id);
    }
    await db.batch(statements);
    const newest = await contextHistory(f.env, chain[104]);
    assert.equal(newest.truncated, true);
    assert.deepEqual(newest.entries.map((entry: any) => entry.id), chain.slice(5), 'the entry itself and its 99 nearest ancestors, oldest first');
    assert.deepEqual([newest.entries.at(-1)!.relation, newest.entries.filter((entry: any) => entry.relation === 'self').length], ['self', 1]);
    // From the middle: the nearest on both sides, the older one first at equal distance.
    const middle = await contextHistory(f.env, chain[50]);
    assert.equal(middle.truncated, true);
    assert.deepEqual(middle.entries.map((entry: any) => entry.id), chain.slice(0, 100));
    assert.equal(middle.entries.find((entry: any) => entry.id === chain[50])!.relation, 'self');
    assert.equal((await contextHistory(f.env, chain[3])).truncated, true);
    assert.equal((await contextHistory(f.env, chain[3])).entries.length, 100);
  } finally { await f.close(); }
});

test('reviewer flags need an approved entry and existing evidence, close once with a reason, and never touch the note', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest([syntheticEvent('flag-1'), syntheticEvent('flag-2')]);
    const a = await source(f, 'flag-1'), b = await source(f, 'flag-2');
    const approved = await note(f.env, a, { title: 'flag target' }, 'approve');
    const pending = await note(f.env, a, { title: 'pending' });
    const create = (id: string, body: unknown) => write(f.env, `/api/context/${id}/flags`, body);
    await rejects(create(pending, { kind: 'needs_review' }), 409, /approved/);
    await rejects(create(crypto.randomUUID(), { kind: 'needs_review' }), 404);
    for (const invalid of [{}, { kind: 'stale' }, { kind: 'needs_review', origin: 'jev' }, { kind: 'needs_review', job_id: 'a'.repeat(64) },
      { kind: 'needs_review', note: '' }, { kind: 'needs_review', note: '  ' }, { kind: 'needs_review', note: 'x'.repeat(2001) },
      { kind: 'needs_review', evidence: [pair(a), pair(a)] }, { kind: 'needs_review', evidence: Array.from({ length: 21 }, () => pair(a)) },
      { kind: 'needs_review', evidence: [{ event_id: a.id }] }, { kind: 'needs_review', evidence: [{ ...pair(a), payload_hash: '0'.repeat(64) }] }, [], null])
      await rejects(create(approved, invalid), 400);
    const before = (await getContext(f.env, approved)).context;
    const created = await create(approved, { kind: 'contradiction', note: 'Synthetic: the later fix contradicts this', evidence: [pair(b), pair(a)] });
    assert.equal(created!.status, 201);
    const flag = (await json(created)).flag;
    assert.deepEqual([flag.kind, flag.origin, flag.status, flag.job_id, flag.created_by, flag.evidence],
      ['contradiction', 'reviewer', 'open', null, reviewer, [pair(b), pair(a)]]);
    assert.deepEqual(flag.audit.map((row: any) => [row.id, row.action, row.actor]), [[flag.id + ':create', 'create', reviewer]]);
    // An open flag changes neither the note, its approval nor its authority.
    const after = (await getContext(f.env, approved)).context;
    assert.deepEqual([after.status, after.authoritative, after.content, after.open_flags, after.flags.map((row: any) => row.id)],
      [before.status, true, before.content, 1, [flag.id]]);
    assert.equal((await list(f.env, {})).find((entry) => entry.id === approved)!.open_flags, 1);
    assert.deepEqual((await list(f.env, { flagged: '1' })).map((entry) => entry.id), [approved]);
    assert.deepEqual((await json(await revisionsRead(get(`/api/context/flags/${flag.id}`), f.env))).flag, flag);
    for (const path of [`/api/context/flags/${flag.id}?x=1`, '/api/context/flags/not-a-uuid']) await rejects(revisionsRead(get(path), f.env), 400);
    await rejects(revisionsRead(get(`/api/context/flags/${crypto.randomUUID()}`), f.env), 404);

    const resolvePath = `/api/context/flags/${flag.id}/resolve`;
    for (const invalid of [{ resolution: 'resolved' }, { resolution: 'resolved', reason: ' ' }, { resolution: 'open', reason: 'x' },
      { resolution: 'resolved', reason: 'x', resolved_by: 'forged' }]) await rejects(write(f.env, resolvePath, invalid), 400);
    await rejects(write(f.env, resolvePath + '?x=1', { resolution: 'resolved', reason: 'x' }), 400);
    await rejects(write(f.env, resolvePath, { resolution: 'resolved', reason: 'x' }, 'pipeline:beacon.jev@1'), 403);
    const closed = (await json(await write(f.env, resolvePath, { resolution: 'resolved', reason: 'Synthetic: covered by a revision' }))).flag;
    assert.deepEqual([closed.status, closed.resolved_by, closed.resolution_reason], ['resolved', reviewer, 'Synthetic: covered by a revision']);
    assert.deepEqual(closed.audit.map((row: any) => [row.id, row.action, row.reason]),
      [[flag.id + ':create', 'create', null], [flag.id + ':resolve', 'resolve', 'Synthetic: covered by a revision']]);
    await rejects(write(f.env, resolvePath, { resolution: 'dismissed', reason: 'again' }), 409, /already closed/);
    await rejects(write(f.env, `/api/context/flags/${crypto.randomUUID()}/resolve`, { resolution: 'resolved', reason: 'x' }), 404);
    assert.deepEqual([(await getContext(f.env, approved)).context.open_flags, (await list(f.env, { flagged: '1' })).length], [0, 0]);

    // The database enforces the same rules for anything that bypasses the routes.
    const second = (await json(await create(approved, { kind: 'needs_review' }))).flag;
    const db = f.env.DB, now = new Date().toISOString();
    for (const [statement, message] of [
      [db.prepare(`UPDATE context_flags SET status='dismissed',resolved_at=?,resolved_by=?,resolution_reason='auto' WHERE id=?`).bind(now, JEV_FLAG_ACTOR, second.id),
        /context_flag_resolution_forbidden/],
      [db.prepare(`UPDATE context_flags SET status='resolved',resolved_at=?,resolved_by=?,resolution_reason='  ' WHERE id=?`).bind(now, reviewer, second.id),
        /context_flag_immutable/],
      [db.prepare(`UPDATE context_flags SET evidence='[]' WHERE id=?`).bind(flag.id), /context_flag_immutable/],
      [db.prepare(`UPDATE context_flags SET note='edited' WHERE id=?`).bind(second.id), /context_flag_immutable/],
      [db.prepare(`UPDATE context_flags SET status='open',resolved_at=NULL,resolved_by=NULL,resolution_reason=NULL WHERE id=?`).bind(flag.id), /context_flag_immutable/],
      [db.prepare('DELETE FROM context_flags WHERE id=?').bind(flag.id), /context_flag_immutable/],
      [db.prepare(`UPDATE context_flag_audit SET actor='forged' WHERE flag_id=?`).bind(flag.id), /context_flag_audit_immutable/],
      [db.prepare('DELETE FROM context_flag_audit WHERE flag_id=?').bind(flag.id), /context_flag_audit_immutable/],
      [db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,evidence,status,created_at,created_by,resolved_at,resolved_by,resolution_reason)
        VALUES(?,?,'needs_review','reviewer','[]','resolved',?,?,?,?,'x')`).bind(crypto.randomUUID(), approved, now, reviewer, now, reviewer), /context_flag_invalid_state/],
      [db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,evidence,created_at,created_by) VALUES(?,?,'needs_review','reviewer','[]',?,?)`)
        .bind(crypto.randomUUID(), pending, now, reviewer), /context_flag_target/],
      [db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,evidence,created_at,created_by) VALUES(?,?,'needs_review','reviewer',?,?,?)`)
        .bind(crypto.randomUUID(), approved, JSON.stringify([{ ...pair(a), extra: 1 }]), now, reviewer), /context_flag_evidence/],
      [db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,evidence,created_at,created_by) VALUES(?,?,'needs_review','reviewer',?,?,?)`)
        .bind(crypto.randomUUID(), approved, JSON.stringify([{ event_id: a.id, payload_hash: '0'.repeat(64) }]), now, reviewer), /context_flag_evidence/],
      [db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,evidence,created_at,created_by) VALUES(?,?,'needs_review','reviewer','[]',?,?)`)
        .bind(crypto.randomUUID(), approved, now, JEV_FLAG_ACTOR), /CHECK/],
      // An evaluator flag needs a job of the entry's project with a stored answer >= 0.5 for that entry.
      [db.prepare(`INSERT INTO context_flags(id,context_id,kind,origin,job_id,evidence,created_at,created_by) VALUES(?,?,'contradiction','jev',?,?,?,?)`)
        .bind(crypto.randomUUID(), approved, 'a'.repeat(64), JSON.stringify([pair(a)]), now, JEV_FLAG_ACTOR), /context_flag_target/],
    ] as const) await assert.rejects(statement.run(), message);

    // A superseded entry keeps its open flag for the record and can no longer be flagged.
    await note(f.env, a, { title: 'revised', supersedes: approved }, 'approve');
    assert.deepEqual([(await getContext(f.env, approved)).context.status, (await getContext(f.env, approved)).context.open_flags], ['superseded', 1]);
    await rejects(create(approved, { kind: 'needs_review' }), 409);
    assert.equal((await write(f.env, `/api/context/flags/${second.id}/resolve`, { resolution: 'dismissed', reason: 'Synthetic: replaced' }))!.status, 200);
  } finally { await f.close(); }
});

test('a fake Jev run through the processing runner flags only the contradicted entry of the scope\'s project, once per job', async () => {
  const f = await createEnvFixture();
  try {
    const fields = ['command_text', 'approved_note_text'];
    await setPolicy(f.env, workspace, { external_allowed: true, jev_enabled: true, summary_fields: fields, external_fields: fields, min_new_events: 1000 });
    await setBudget(f.env, { daily_call_limit: 10 });
    await f.ingest([syntheticEvent('jev-start', { action: 'session.started', session: 'jev-s', timestamp: '2026-10-07T08:00:00Z' }),
      command('jev-fail', 'npm test -- login', 1, { session: 'jev-s', timestamp: '2026-10-07T08:00:01Z' }),
      command('jev-ok', 'npm test -- login', 0, { session: 'jev-s', timestamp: '2026-10-07T08:00:02Z' })]);
    await f.ingest(syntheticEvent('beta-1', { repo: 'beta', session: 'beta-s' }));
    const event = await source(f, 'jev-fail');
    const contradicted = await note(f.env, event, { title: 'Login tests never fail' }, 'approve');
    const consistent = await note(f.env, event, { title: 'CI runs npm test' }, 'approve');
    const foreign = await note(f.env, await source(f, 'beta-1'), { title: 'Another project note' }, 'approve');
    const planned = (await run(f.env, { project_id: event.project_id })).scopes[0];
    const asked: string[][] = [];
    const fetcher = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      asked.push(Object.keys(body.questions));
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) =>
        [id, { noul: id === 'contradiction:' + contradicted ? 0.8 : id.startsWith('contradiction:') ? 0.2 : 0.9 }])) });
    }) as typeof fetch;
    const env = { ...f.env, EXTERNAL_PROCESSING_PROJECTS: '*', JEV_API_KEY: 'synthetic-jev-key-not-real-0000000000' } as Env;
    const report = await tick(env, later(), { fetcher });
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(asked, [['new_information', `contradiction:${consistent}`, `contradiction:${contradicted}`]]);
    const done = await job(f.env, planned.job_id);
    assert.equal(done.status, 'succeeded');
    const flags = (await f.env.DB.prepare('SELECT * FROM context_flags').all<any>()).results;
    assert.deepEqual(flags.map((row) => [row.context_id, row.kind, row.origin, row.job_id, row.status, row.created_by, row.note]),
      [[contradicted, 'contradiction', 'jev', done.id, 'open', JEV_FLAG_ACTOR, null]]);
    // Evidence names the job's exact versions; all three fit, so they keep the job's order.
    const sources = (await f.env.DB.prepare('SELECT event_id,payload_hash FROM processing_job_sources WHERE job_id=? ORDER BY ordinal').bind(done.id).all()).results;
    assert.deepEqual(JSON.parse(flags[0].evidence), sources);
    assert.deepEqual((await f.env.DB.prepare('SELECT id,actor,action FROM context_flag_audit').all()).results,
      [{ id: flags[0].id + ':create', actor: JEV_FLAG_ACTOR, action: 'create' }]);
    // Advisory: every note stays approved and authoritative.
    for (const id of [contradicted, consistent, foreign]) {
      const entry = (await getContext(f.env, id)).context;
      assert.deepEqual([entry.status, entry.authoritative, entry.open_flags], ['approved', true, id === contradicted ? 1 : 0]);
    }
    // Replaying the same job's flag statements adds nothing.
    await f.env.DB.batch(contradictionFlagStatements(f.env.DB, { job_id: done.id, now: new Date().toISOString(), evidence: JSON.parse(flags[0].evidence),
      signals: [{ question_id: 'contradiction:' + contradicted, probability: 0.8 }] }));
    assert.equal(await count(f.env, 'context_flags'), 1);
    // Only a reviewer closes it.
    await assert.rejects(f.env.DB.prepare(`UPDATE context_flags SET status='dismissed',resolved_at=?,resolved_by=?,resolution_reason='auto' WHERE id=?`)
      .bind(new Date().toISOString(), JEV_FLAG_ACTOR, flags[0].id).run(), /context_flag_resolution_forbidden/);
    assert.equal((await write(f.env, `/api/context/flags/${flags[0].id}/resolve`, { resolution: 'resolved', reason: 'Synthetic: revised' }))!.status, 200);
    // One unreviewed pipeline candidate per scope: review it so the scope plans again.
    await review(f.env, done.result_context_id, 'reject');

    // Any stage's answers go through the same filter, on continue and on skip: an entry of another
    // project and an answer below 0.5 never raise a flag, and evidence reaches the stage exactly.
    const signal = (id: string, probability: number): StageSignal => ({ question_id: 'contradiction:' + id, probability, confidence: null,
      evaluator: 'synthetic', model: null });
    const seen: { job: string; evidence: unknown }[] = [];
    const stage: SelectionStage = async (input) => {
      seen.push({ job: input.job_id, evidence: input.evidence });
      const signals = [signal(consistent, 0.7), signal(foreign, 0.95), signal(contradicted, 0.3)];
      return seen.length === 1 ? { decision: 'continue', signals } : { decision: 'skip', skip_reason: 'stage_skip', signals };
    };
    const stagedTick = (minutes: number) => runMaintenance({ ...f.env, MAINTENANCE_TASKS: 'processing' } as Env,
      { now: later(minutes), schedule: 'frequent', tasks: staged(stage) });
    const outcomes: string[] = [];
    for (const [index, minutes] of [[1, 200], [2, 260]]) {
      await f.ingest(command(`jev-later-${index}`, 'npm run lint', 0, { session: 'jev-s', timestamp: `2026-10-07T08:0${index}:00Z` }));
      const next = (await run(f.env, { project_id: event.project_id })).scopes[0];
      assert.equal((await stagedTick(minutes)).processing.ok, true);
      const row = await job(f.env, next.job_id);
      outcomes.push(row.status);
      if (row.result_context_id) await review(f.env, row.result_context_id, 'reject');
      const flagged = (await f.env.DB.prepare('SELECT context_id,evidence FROM context_flags WHERE job_id=?').bind(next.job_id).all<any>()).results;
      const versions = (await f.env.DB.prepare('SELECT event_id,payload_hash FROM processing_job_sources WHERE job_id=?').bind(next.job_id).all()).results;
      assert.deepEqual(flagged.map((item) => [item.context_id, JSON.parse(item.evidence)]), [[consistent, versions]]);
      assert.deepEqual(seen.at(-1), { job: next.job_id, evidence: versions });
    }
    assert.deepEqual(outcomes, ['succeeded', 'skipped']);
    assert.equal(await count(f.env, "context_flags WHERE context_id=? OR context_id=?", foreign, contradicted), 1, 'only the resolved Jev flag');
  } finally { await f.close(); }
});

test('flag evidence ranks high-signal events first, then the newest, and keeps the job order', () => {
  const base: ProjectedEvent = { action: 'command.executed', kind: 'agent_runtime', timestamp: '2026-10-07T08:00:00.000Z', harness: 'codex_cli' };
  const events = Array.from({ length: 30 }, (_, index) => ({ ...base, exit_code: index === 2 || index === 5 ? 1 : 0,
    event_id: sha('event-' + index), payload_hash: sha('payload-' + index) }));
  const picked = flagEvidence(events).map((item) => events.findIndex((event) => event.event_id === item.event_id));
  assert.deepEqual(picked, [2, 5, ...Array.from({ length: 18 }, (_, index) => 12 + index)]);
  assert.deepEqual(flagEvidence(events.slice(0, 3)), events.slice(0, 3).map(({ event_id, payload_hash }) => ({ event_id, payload_hash })));
  assert.deepEqual(flagEvidence([]), []);
});

test('shares need an approved authoritative memory and another project; recall serves them only while that still holds', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('share-a', { repo: 'alpha', session: 'alpha-s' }));
    await f.ingest(syntheticEvent('share-b', { repo: 'beta', session: 'beta-s' }));
    // A device-path session that later reports its repository: its events move project, so a note on them loses authority.
    await f.ingest(syntheticEvent('share-drift', { session: 'drift-s', extra: { repository: undefined } }));
    const a = await source(f, 'share-a'), b = await source(f, 'share-b'), drift = await source(f, 'share-drift');
    assert.notEqual(drift.project_id, a.project_id);
    const memory = await note(f.env, a, { title: 'Shared memory' }, 'approve');
    const summary = await note(f.env, a, { title: 'Summary', kind: 'summary' }, 'approve');
    const pendingMemory = await note(f.env, a, { title: 'Pending memory' });
    const drifting = await note(f.env, drift, { title: 'Drifting memory' }, 'approve');
    const own = await note(f.env, b, { title: 'Beta own memory' }, 'approve');
    const target = { target_type: 'project', target_id: b.project_id };
    const share = (id: string, body: unknown = target) => write(f.env, `/api/context/${id}/shares`, body);
    await rejects(share(summary), 409, /memory/);
    await rejects(share(pendingMemory), 409);
    await rejects(share(memory, { ...target, target_id: a.project_id }), 400, /own project/);
    await rejects(share(memory, { ...target, target_id: 'f'.repeat(64) }), 404, /Project/);
    await rejects(share(crypto.randomUUID()), 404, /Context/);
    for (const invalid of [{ ...target, target_type: 'project_group' }, { ...target, extra: 1 }, { target_id: b.project_id }, { ...target, target_id: 'x' }])
      await rejects(share(memory, invalid), 400);
    await rejects(write(f.env, `/api/context/${memory}/shares`, target, 'pipeline:beacon.extractive@1'), 403);
    const created = await share(memory);
    assert.equal(created!.status, 201);
    const granted = await json(created);
    assert.equal(granted.created, true);
    const active = granted.share;
    assert.deepEqual([active.status, active.target_type, active.target_id, active.created_by], ['active', 'project', b.project_id, reviewer]);
    assert.match(active.target_name, /beta$/);
    assert.deepEqual(active.audit.map((row: any) => [row.id, row.action]), [[active.id + ':create', 'create']]);
    const repeated = await share(memory);
    assert.equal(repeated!.status, 200);
    assert.deepEqual([(await json(repeated)).share.id, await count(f.env, 'context_shares')], [active.id, 1]);
    const driftShare = (await json(await share(drifting))).share;

    const shared = async () => (await list(f.env, { project_id: b.project_id, include_shared: '1' }))
      .map((entry) => [entry.id, entry.share_id, entry.shared_from_project_id]).sort();
    assert.deepEqual((await list(f.env, { project_id: b.project_id })).map((entry) => entry.id), [own], 'default recall never includes shares');
    assert.ok(!('share_id' in (await list(f.env, { project_id: b.project_id }))[0]));
    assert.deepEqual(await shared(), [[memory, active.id, a.project_id], [drifting, driftShare.id, drift.project_id], [own, null, null]].sort());
    assert.deepEqual((await list(f.env, { project_id: b.project_id, include_shared: '1', status: 'approved', kind: 'memory', limit: '1' })).length, 1);
    assert.deepEqual((await list(f.env, { project_id: b.project_id, include_shared: '1', kind: 'summary' })).length, 0);
    // Keyset pages walk the union exactly once.
    const page = await listContext(f.env, new URLSearchParams({ project_id: b.project_id, include_shared: '1', limit: '2' }));
    const rest = await listContext(f.env, new URLSearchParams({ project_id: b.project_id, include_shared: '1', limit: '2', before: page.next_cursor! }));
    assert.deepEqual([...page.context, ...rest.context].map((entry: any) => entry.id).sort(), [memory, drifting, own].sort());
    assert.equal(rest.next_cursor, null);
    for (const query of [{ include_shared: '1' }, { project_id: b.project_id, include_shared: '1', status: 'pending' },
      { project_id: b.project_id, include_shared: '1', task_id: crypto.randomUUID() }, { project_id: b.project_id, include_shared: '1', as_of: '2026-10-08T00:00:00Z' },
      { project_id: b.project_id, include_shared: 'true' }] as Record<string, string>[]) await rejects(listContext(f.env, new URLSearchParams(query)), 400);

    // Read-time authority: the drifting session reports its repository, so that note's sources leave its project.
    await f.ingest(syntheticEvent('share-drift-2', { session: 'drift-s' }));
    assert.deepEqual(await shared(), [[memory, active.id, a.project_id], [own, null, null]].sort());
    assert.deepEqual((await getContext(f.env, drifting)).context.shares.map((row: any) => row.status), ['inactive']);
    // A superseded memory stops being served; its approved revision is a new entry and is not shared by itself.
    const revision = await note(f.env, a, { title: 'Shared memory v2', supersedes: memory }, 'approve');
    assert.deepEqual(await shared(), [[own, null, null]]);
    assert.deepEqual((await getContext(f.env, memory)).context.shares.map((row: any) => row.status), ['inactive']);
    assert.deepEqual((await getContext(f.env, revision)).context.shares, []);
    await rejects(share(memory), 409);

    const revokePath = `/api/context/shares/${active.id}/revoke`;
    for (const invalid of [{ reason: 'x' }, [], null]) await rejects(write(f.env, revokePath, invalid), 400);
    const revoked = (await json(await write(f.env, revokePath, {}))).share;
    assert.deepEqual([revoked.status, revoked.revoked_by], ['revoked', reviewer]);
    assert.deepEqual(revoked.audit.map((row: any) => [row.id, row.action]), [[active.id + ':create', 'create'], [active.id + ':revoke', 'revoke']]);
    await rejects(write(f.env, revokePath, {}), 409, /already revoked/);
    await rejects(write(f.env, `/api/context/shares/${crypto.randomUUID()}/revoke`, {}), 404);
    await rejects(write(f.env, '/api/context/shares/not-a-uuid/revoke', {}), 400);
    assert.equal(await revisionsWrite(post('/api/context/shares', {}), f.env, reviewer), null);

    const db = f.env.DB, now = new Date().toISOString();
    for (const [statement, message] of [
      [db.prepare('UPDATE context_shares SET target_id=? WHERE id=?').bind(drift.project_id, driftShare.id), /context_share_immutable/],
      [db.prepare('UPDATE context_shares SET revoked_at=NULL,revoked_by=NULL WHERE id=?').bind(active.id), /context_share_immutable/],
      [db.prepare('DELETE FROM context_shares WHERE id=?').bind(active.id), /context_share_immutable/],
      [db.prepare(`INSERT INTO context_shares(id,context_id,target_type,target_id,created_at,created_by) VALUES(?,?,'project',?,?,?)`)
        .bind(crypto.randomUUID(), summary, b.project_id, now, reviewer), /context_share_invalid/],
      [db.prepare(`INSERT INTO context_shares(id,context_id,target_type,target_id,created_at,created_by) VALUES(?,?,'project',?,?,?)`)
        .bind(crypto.randomUUID(), drifting, a.project_id, now, reviewer), /context_share_invalid/],
      [db.prepare(`INSERT INTO context_shares(id,context_id,target_type,target_id,created_at,created_by) VALUES(?,?,'project',?,?,?)`)
        .bind(crypto.randomUUID(), revision, b.project_id, now, JEV_FLAG_ACTOR), /CHECK/],
      [db.prepare(`INSERT INTO context_shares(id,context_id,target_type,target_id,created_at,created_by) VALUES(?,?,'project_group',?,?,?)`)
        .bind(crypto.randomUUID(), revision, b.project_id, now, reviewer), /CHECK/],
      [db.prepare(`UPDATE context_share_audit SET actor='forged' WHERE share_id=?`).bind(active.id), /context_share_audit_immutable/],
      [db.prepare('DELETE FROM context_share_audit WHERE share_id=?').bind(active.id), /context_share_audit_immutable/],
    ] as const) await assert.rejects(statement.run(), message);
  } finally { await f.close(); }
});

test('include_shared recall reads one page of the project\'s entries, not all of them, and still pages the union exactly once', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('cost-a', { repo: 'alpha', session: 'alpha-s' }));
    await f.ingest(syntheticEvent('cost-b', { repo: 'beta', session: 'beta-s' }));
    const a = await source(f, 'cost-a'), b = await source(f, 'cost-b');
    const shared = await note(f.env, a, { title: 'Shared into beta' }, 'approve');
    assert.equal((await write(f.env, `/api/context/${shared}/shares`, { target_type: 'project', target_id: b.project_id }))!.status, 201);
    // 300 approved memories of beta through the real triggers, in four statements.
    const ids = Array.from({ length: 300 }, (_, index) => ({ id: crypto.randomUUID(), at: new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString() }));
    const json = JSON.stringify(ids), db = f.env.DB;
    await db.batch([
      db.prepare(`INSERT INTO context_entries(id,kind,project_id,title,content,created_at) SELECT json_extract(value,'$.id'),'memory',?,'Synthetic beta',
        'Synthetic only.',json_extract(value,'$.at') FROM json_each(?)`).bind(b.project_id, json),
      db.prepare(`INSERT INTO context_sources(context_id,event_id,payload_hash,ordinal) SELECT json_extract(value,'$.id'),?,?,0 FROM json_each(?)`)
        .bind(b.id, b.payload_hash, json),
      db.prepare(`UPDATE context_entries SET sealed=1 WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(json),
      db.prepare(`UPDATE context_entries SET status='approved',review_id=id||':review',reviewed_at=created_at,reviewed_by=?
        WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(reviewer, json),
    ]);
    let read = 0;
    const metered = { ...f.env, DB: new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const wrap = (statement: any): any => new Proxy(statement, { get(object, key) {
          if (key === 'bind') return (...args: unknown[]) => wrap(object.bind(...args));
          if (key === 'all') return async () => { const result = await object.all(); read += result.meta.rows_read; return result; };
          const value = object[key]; return typeof value === 'function' ? value.bind(object) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    const rowsRead = async (query: Record<string, string>) => { read = 0; const page = await listContext(metered, new URLSearchParams(query)); return { read, page }; };
    const plain = await rowsRead({ project_id: b.project_id, limit: '5' });
    const withShared = await rowsRead({ project_id: b.project_id, include_shared: '1', limit: '5' });
    assert.equal(withShared.page.context.length, 5);
    // One page of each arm plus the project's active shares, not every approved entry (3,610 rows before).
    assert.ok(withShared.read <= plain.read + 50, `include_shared read ${withShared.read} rows, default recall ${plain.read}`);
    // Pages still walk the whole union once, newest first.
    const seen: string[] = [];
    for (let before: string | null = null, pages = 0; pages < 20; pages++) {
      const page: any = await listContext(f.env, new URLSearchParams({ project_id: b.project_id, include_shared: '1', limit: '40', ...before ? { before } : {} }));
      seen.push(...page.context.map((entry: any) => entry.id));
      if (!(before = page.next_cursor)) break;
    }
    assert.equal(seen.length, 301);
    assert.deepEqual(new Set(seen), new Set([shared, ...ids.map((item) => item.id)]));
    assert.deepEqual(seen.slice(0, 2), [shared, ids.at(-1)!.id], 'the shared note (approved now) is newest');
  } finally { await f.close(); }
});

test('a device snapshot carries shared memories only when its subscription includes them, and include_shared is immutable', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('sync-a', { repo: 'alpha', session: 'alpha-s' }));
    await f.ingest(syntheticEvent('sync-b', { repo: 'beta', session: 'beta-s' }));
    const a = await source(f, 'sync-a'), b = await source(f, 'sync-b');
    const memory = await note(f.env, a, { title: 'Shared from alpha' }, 'approve');
    await sleep(2);
    const own = await note(f.env, b, { title: 'Beta own' }, 'approve');
    const share = (await json(await write(f.env, `/api/context/${memory}/shares`, { target_type: 'project', target_id: b.project_id }))).share;
    const subscribe = (device: string, extra: Record<string, unknown> = {}) => syncWrite(post('/api/sync/subscriptions',
      { device_id: device, project_id: b.project_id, kinds: ['memory'], ...extra }), f.env, reviewer);
    for (const value of ['yes', 1, null]) await rejects(subscribe('mbp', { include_shared: value }), 400);
    const withShared = (await json(await subscribe('mbp', { include_shared: true }))).subscription;
    const plain = (await json(await subscribe('mini', { include_shared: false }))).subscription;
    assert.deepEqual([withShared.include_shared, plain.include_shared], [true, false]);
    assert.equal((await subscribe('mbp', { include_shared: true }))!.status, 200, 'an identical grant is idempotent');
    await rejects(subscribe('mbp'), 409, /revoke it first/);
    const snapshot = async (device: 'mbp' | 'mini') =>
      (await json(await syncDeviceRead(get(`/v1/sync/snapshot?project_id=${b.project_id}`), f.env, fixtureDevices[device]))).snapshot;
    const [mbp, mini] = [await snapshot('mbp'), await snapshot('mini')];
    assert.deepEqual([mini.include_shared, mini.entries.map((entry: any) => entry.id)], [false, [own]]);
    // Own entries keep their exact earlier shape; a snapshot without shares hashes exactly as before.
    assert.deepEqual(Object.keys(mini.entries[0]).sort(), ['content', 'content_sha256', 'id', 'kind', 'reviewed_at', 'supersedes_id', 'task_id', 'title', 'valid_from']);
    assert.equal(mini.snapshot_sha256, sha(stableJSON({ schema: SNAPSHOT_SCHEMA, project_id: b.project_id, kinds: ['memory'], entries: mini.entries })));
    assert.equal(mbp.include_shared, true);
    assert.deepEqual(mbp.entries.map((entry: any) => [entry.id, entry.shared_from_project_id ?? null, entry.share_id ?? null]),
      [[memory, a.project_id, share.id], [own, null, null]]);
    assert.equal(mbp.snapshot_sha256, sha(stableJSON({ schema: SNAPSHOT_SCHEMA, project_id: b.project_id, kinds: ['memory'], entries: mbp.entries })));
    const devices = (await json(await syncDeviceRead(get('/v1/sync/subscriptions'), f.env, fixtureDevices.mbp))).subscriptions;
    assert.deepEqual(devices.map((row: any) => [row.id, row.include_shared]), [[withShared.id, true]]);
    // The reviewer preview asks explicitly.
    const preview = async (query: string) => (await json(await syncRead(get(`/api/context/snapshot?project_id=${b.project_id}${query}`), f.env))).snapshot;
    assert.deepEqual((await preview('&kind=memory&include_shared=1')).snapshot_sha256, mbp.snapshot_sha256);
    assert.deepEqual((await preview('&kind=memory&include_shared=0')).snapshot_sha256, mini.snapshot_sha256);
    assert.equal((await preview('&kind=memory')).snapshot_sha256, mini.snapshot_sha256);
    await rejects(syncRead(get(`/api/context/snapshot?project_id=${b.project_id}&include_shared=yes`), f.env), 400);

    // Read time: once the shared memory is superseded, the device no longer receives it.
    await note(f.env, a, { title: 'Shared from alpha v2', supersedes: memory }, 'approve');
    assert.deepEqual((await snapshot('mbp')).entries.map((entry: any) => entry.id), [own]);
    // The grant is fixed for its lifetime: include_shared changes only through revoke and a new subscription.
    const db = f.env.DB, now = new Date().toISOString();
    for (const statement of [db.prepare('UPDATE device_sync_subscriptions SET include_shared=0 WHERE id=?').bind(withShared.id),
      db.prepare('UPDATE device_sync_subscriptions SET include_shared=1,revoked_at=?,revoked_by=? WHERE id=?').bind(now, reviewer, plain.id)])
      await assert.rejects(statement.run(), /sync_subscription_immutable/);
    const revoked = (await json(await syncWrite(post(`/api/sync/subscriptions/${withShared.id}/revoke`, {}), f.env, reviewer))).subscription;
    assert.deepEqual([revoked.status, revoked.include_shared], ['revoked', true]);
    assert.equal((await subscribe('mbp'))!.status, 201);
  } finally { await f.close(); }
});

test('the bundled Worker reads history and flags with read credentials and writes flags and shares only with REVIEW_TOKEN; MCP stays read-only', async () => {
  const worker = await operationsWorker();
  try {
    assert.equal((await worker.upload([syntheticEvent('worker-a', { session: 'worker-a' }), syntheticEvent('worker-b', { repo: 'beta', session: 'worker-b' })])).status, 200);
    const event = async (id: string) => (await worker.env.DB.prepare('SELECT id,payload_hash,project_id FROM events WHERE event_id=?').bind(id).first<Source>())!;
    const a = await event('worker-a'), b = await event('worker-b');
    const created = await worker.write('/api/context', { kind: 'memory', project_id: a.project_id, title: 'Synthetic worker note',
      content: 'Synthetic worker content.', sources: [pair(a)] });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as any).context.id as string;
    assert.equal((await worker.write(`/api/context/${id}/review`, { decision: 'approve' })).status, 200);
    const others = [operationsTokens.read, operationsTokens.mcp, operationsTokens.mbp];
    const writes = [[`/api/context/${id}/flags`, { kind: 'needs_review', evidence: [pair(a)] }], [`/api/context/${id}/shares`, { target_type: 'project', target_id: b.project_id }]] as const;
    for (const [path, body] of writes) {
      for (const token of others) assert.equal((await worker.write(path, body, token)).status, 403, path);
      assert.equal((await worker.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
      assert.equal((await worker.request(path, { method: 'POST', headers: { Authorization: 'Bearer ' + operationsTokens.review, 'Content-Type': 'application/json',
        Origin: 'https://attacker.example.invalid' }, body: JSON.stringify(body) })).status, 403);
    }
    const flag = ((await (await worker.write(writes[0][0], writes[0][1])).json()) as any).flag;
    const share = ((await (await worker.write(writes[1][0], writes[1][1])).json()) as any).share;
    assert.deepEqual([flag.status, share.status], ['open', 'active']);
    for (const path of [`/api/context/${id}/history`, `/api/context/flags/${flag.id}`, `/api/context/${id}`]) {
      assert.equal((await worker.bearer(path, operationsTokens.read)).status, 200, path);
      for (const token of [operationsTokens.review, operationsTokens.mcp, operationsTokens.mbp]) assert.equal((await worker.bearer(path, token)).status, 401, path);
      assert.equal((await worker.request(path)).status, 401, path);
    }
    const detail = ((await (await worker.bearer(`/api/context/${id}`, operationsTokens.read)).json()) as any).context;
    assert.deepEqual([detail.open_flags, detail.flags[0].id, detail.shares[0].id], [1, flag.id, share.id]);
    const sharedRecall = ((await (await worker.bearer(`/api/context?project_id=${b.project_id}&include_shared=1`, operationsTokens.read)).json()) as any).context;
    assert.deepEqual(sharedRecall.map((entry: any) => [entry.id, entry.share_id]), [[id, share.id]]);

    const client = new Client({ name: 'synthetic-revisions-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + operationsTokens.mcp } },
        fetch: worker.mf.dispatchFetch.bind(worker.mf) as unknown as typeof fetch }));
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 17);
      const history = tools.find((tool) => tool.name === 'beacon_get_context_history')!;
      assert.deepEqual([history.annotations?.readOnlyHint, history.annotations?.destructiveHint], [true, false]);
      assert.ok(!tools.some((tool) => /flag|share|resolve|revoke/.test(tool.name)), 'no write tools');
      const chain = await client.callTool({ name: 'beacon_get_context_history', arguments: { context_id: id } });
      assert.equal(chain.isError, undefined);
      assert.deepEqual((chain.structuredContent as any).entries.map((entry: any) => [entry.id, entry.relation, entry.open_flags]), [[id, 'self', 1]]);
      const calls = [
        { project_id: b.project_id, include_shared: true }, { as_of: '2099-01-01T00:00:00Z' }, { flagged: true }, { project_id: b.project_id, include_shared: false },
      ];
      const results = [];
      for (const args of calls) {
        const value = await client.callTool({ name: 'beacon_list_context', arguments: args });
        assert.equal(value.isError, undefined, JSON.stringify(args));
        results.push((value.structuredContent as any).context.map((entry: any) => entry.id));
      }
      assert.deepEqual(results, [[id], [id], [id], []]);
      assert.equal((await client.callTool({ name: 'beacon_list_context', arguments: { include_shared: true } })).isError, true);
    } finally { await client.close(); }

    assert.equal((await worker.write(`/api/context/flags/${flag.id}/resolve`, { resolution: 'dismissed', reason: 'Synthetic' }, operationsTokens.read)).status, 403);
    assert.equal((await worker.write(`/api/context/flags/${flag.id}/resolve`, { resolution: 'dismissed', reason: 'Synthetic' })).status, 200);
    assert.equal((await worker.write(`/api/context/shares/${share.id}/revoke`, {}, operationsTokens.mbp)).status, 403);
    assert.equal((await worker.write(`/api/context/shares/${share.id}/revoke`, {})).status, 200);
    assert.equal((await worker.bearer(`/api/context/${id}/history`, operationsTokens.read)).status, 200);
  } finally { await worker.close(); }
});
