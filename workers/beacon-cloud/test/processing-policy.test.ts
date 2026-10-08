import test from 'node:test';
import assert from 'node:assert/strict';
import { processingRead, processingWrite } from '../src/processing';
import { DEFAULT_POLICY, effectivePolicy, externalGate, parsePolicy, resolvePolicy, PolicyValues } from '../src/processing-policy';
import { Env, HttpError } from '../src/types';
import { createEnvFixture, syntheticEvent } from './env-fixture';
import { openPolicy, post, reviewer, setPolicy, workspace } from './processing-helpers';

const rejects = (operation: Promise<unknown>, status: number) =>
  assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status);
const values = (overrides: Partial<PolicyValues>): PolicyValues => ({ ...DEFAULT_POLICY, ...overrides } as PolicyValues);

test('policy bodies are validated field by field: known classes, subsets, bounds and exact keys', () => {
  const project = { scope_type: 'project', scope_id: 'a'.repeat(64) };
  assert.deepEqual(parsePolicy({ ...openPolicy, ...workspace, summary_fields: ['titles', 'command_text'], external_fields: ['command_text'] }).summary_fields,
    ['command_text', 'titles']);
  for (const invalid of [
    { ...openPolicy, ...workspace, summary_fields: ['unknown_class'] },
    { ...openPolicy, ...workspace, summary_fields: ['raw', 'raw'] },
    { ...openPolicy, ...workspace, summary_fields: 'raw' },
    { ...openPolicy, ...workspace, summary_fields: ['command_text'], external_fields: ['prompt_text'] },
    { ...openPolicy, ...workspace, min_new_events: 0 }, { ...openPolicy, ...workspace, min_new_events: 1001 },
    { ...openPolicy, ...workspace, min_new_events: 2.5 }, { ...openPolicy, ...workspace, quiet_minutes: -1 },
    { ...openPolicy, ...workspace, quiet_minutes: 1441 }, { ...openPolicy, ...workspace, max_events_per_job: 0 },
    { ...openPolicy, ...workspace, max_events_per_job: 201 }, { ...openPolicy, ...workspace, jev_skip_threshold: 1.5 },
    { ...openPolicy, ...workspace, jev_skip_threshold: '0.5' }, { ...openPolicy, ...workspace, enabled: 1 },
    { ...openPolicy, scope_type: 'workspace', scope_id: 'a'.repeat(64) }, { ...openPolicy, scope_type: 'project', scope_id: '*' },
    { ...openPolicy, scope_type: 'task', scope_id: '*' }, { ...openPolicy, ...project, scope_id: 'A'.repeat(64) },
    { ...openPolicy, ...workspace, actor: 'forged' }, (({ enabled, ...rest }) => ({ ...rest, ...workspace }))(openPolicy),
    null, [], 'policy',
  ]) assert.throws(() => parsePolicy(invalid), (error: unknown) => error instanceof HttpError && error.status === 400, JSON.stringify(invalid));
});

test('the workspace row is a ceiling: AND for flags, intersection for fields, min cap, both thresholds', async () => {
  const none = await resolvePolicy(null, null);
  assert.deepEqual({ ...none, policy_hash: undefined }, { ...DEFAULT_POLICY, policy_hash: undefined });
  // Without a workspace row nothing is enabled, whatever a project row says.
  assert.equal((await resolvePolicy(null, values({ enabled: true, external_allowed: true, jev_enabled: true }))).enabled, false);
  const ceiling = values({ enabled: true, external_allowed: false, jev_enabled: true, summary_fields: ['file_path', 'command_text', 'titles'],
    external_fields: ['command_text', 'titles'], max_events_per_job: 50, jev_skip_threshold: 0.2 });
  const project = values({ enabled: true, external_allowed: true, jev_enabled: true, summary_fields: ['command_text', 'prompt_text', 'titles'],
    external_fields: ['command_text', 'prompt_text'], min_new_events: 7, quiet_minutes: 5, max_events_per_job: 200, jev_skip_threshold: 0.4 });
  const effective = await resolvePolicy(ceiling, project);
  assert.equal(effective.enabled, true);
  assert.equal(effective.external_allowed, false);
  assert.deepEqual(effective.summary_fields, ['command_text', 'titles']);
  assert.deepEqual(effective.external_fields, ['command_text']);
  assert.equal(effective.min_new_events, 7);
  assert.equal(effective.quiet_minutes, 5);
  assert.equal(effective.max_events_per_job, 50);
  assert.equal(effective.jev_skip_threshold, 0.2);
  assert.equal((await resolvePolicy(ceiling, { ...project, jev_skip_threshold: null })).jev_skip_threshold, null);
  assert.equal((await resolvePolicy({ ...ceiling, enabled: false }, project)).enabled, false);
  // No project row means the workspace row; the hash identifies behaviour, not row versions.
  const inherited = await resolvePolicy(ceiling, null);
  assert.deepEqual(inherited.summary_fields, ['file_path', 'command_text', 'titles']);
  assert.equal(inherited.policy_hash, (await resolvePolicy(ceiling, ceiling)).policy_hash);
  assert.notEqual(inherited.policy_hash, effective.policy_hash);
  assert.match(effective.policy_hash, /^[a-f0-9]{64}$/);
});

test('the deploy-time gate needs the operator var, the effective policy, the key and a valid endpoint; budget comes later', () => {
  const project = 'a'.repeat(64), allowed = values({ enabled: true, external_allowed: true, jev_enabled: true });
  assert.equal(externalGate({} as Env, project, allowed).eligible, false);
  assert.equal(externalGate({ EXTERNAL_PROCESSING_PROJECTS: '*' } as Env, project, allowed).eligible, false);
  assert.deepEqual(externalGate({ EXTERNAL_PROCESSING_PROJECTS: ` ${'b'.repeat(64)}, ${project} `, JEV_API_KEY: 'synthetic-key-0000' } as Env, project, allowed),
    { deploy_allowed: true, key_configured: true, endpoint_valid: true, policy_allowed: true, eligible: true });
  // An endpoint or model the operator mistyped disables the evaluator instead of guessing.
  const configured = { EXTERNAL_PROCESSING_PROJECTS: '*', JEV_API_KEY: 'k'.repeat(16), PUBLIC_URL: 'https://beacon.example.invalid' };
  for (const bad of [{ JEV_ENDPOINT: 'http://jev.example.invalid/v1' }, { JEV_ENDPOINT: 'https://beacon.example.invalid/v1/systemone' },
    { JEV_MODEL: 'jev latest' }, { JEV_ENDPOINT: 'https://user:pass@jev.example.invalid/' }])
    assert.equal(externalGate({ ...configured, ...bad } as Env, project, allowed).endpoint_valid, false, JSON.stringify(bad));
  assert.equal(externalGate({ ...configured, JEV_ENDPOINT: 'https://jev.example.invalid/v1/systemone', JEV_MODEL: 'jev-2026.10' } as Env,
    project, allowed).eligible, true);
  assert.equal(externalGate({ EXTERNAL_PROCESSING_PROJECTS: 'b'.repeat(64), JEV_API_KEY: 'k'.repeat(16) } as Env, project, allowed).eligible, false);
  for (const flag of ['enabled', 'external_allowed', 'jev_enabled'] as const)
    assert.equal(externalGate({ EXTERNAL_PROCESSING_PROJECTS: '*', JEV_API_KEY: 'k'.repeat(16) } as Env, project, { ...allowed, [flag]: false }).eligible, false);
});

test('policy writes are full replacements, versioned and audited; reads show rows, effective policy and gate', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest(syntheticEvent('policy-event'));
    const project = (await f.event('policy-event'))!.project_id;
    const read = async (query = '') => (await processingRead(new Request('http://localhost/api/processing/policy' + query), f.env))!.json() as Promise<any>;
    const before = await read('?project_id=' + project);
    assert.equal(before.workspace, null); assert.equal(before.project, null);
    assert.equal(before.effective.enabled, false);
    assert.equal(before.external_gate.eligible, false);
    await rejects(processingWrite(post('/api/processing/policies', { ...openPolicy, scope_type: 'project', scope_id: 'c'.repeat(64) }), f.env, reviewer), 404);
    await rejects(processingWrite(post('/api/processing/policies?x=1', { ...openPolicy, ...workspace }), f.env, reviewer), 400);
    await rejects(processingWrite(new Request('http://localhost/api/processing/policies', { method: 'POST', body: '{}' }), f.env, reviewer), 415);
    const first = await setPolicy(f.env, workspace, { summary_fields: ['command_text', 'titles'], external_fields: ['titles'] });
    assert.equal(first.workspace.version, 1); assert.equal(first.workspace.updated_by, reviewer);
    const second = await setPolicy(f.env, workspace, { summary_fields: ['command_text'] });
    assert.equal(second.workspace.version, 2); assert.deepEqual(second.workspace.external_fields, []);
    const own = await setPolicy(f.env, { scope_type: 'project', scope_id: project }, { enabled: false, summary_fields: ['command_text', 'raw'] });
    assert.equal(own.project.version, 1);
    assert.equal(own.effective.enabled, false);
    assert.deepEqual(own.effective.summary_fields, ['command_text']);
    assert.equal((await effectivePolicy(f.env, project)).policy_hash, own.effective.policy_hash);
    const overview = await read();
    assert.equal(overview.projects.length, 1); assert.equal(overview.projects[0].scope_id, project);
    assert.equal(overview.workspace.version, 2);
    const detail = await read('?project_id=' + project);
    // Writes in the same millisecond have no defined order, so compare the set.
    assert.deepEqual(detail.audit.map((row: any) => row.scope_type + ':' + row.version).sort(), ['project:1', 'workspace:1', 'workspace:2']);
    assert.ok(detail.audit.every((row: any) => row.actor === reviewer && !('policy' in row)));
    for (const query of ['?project_id=bad', '?project_id=' + project + '&project_id=' + project, '?status=x'])
      await rejects(processingRead(new Request('http://localhost/api/processing/policy' + query), f.env), 400);
    await rejects(processingRead(new Request('http://localhost/api/processing/policy?project_id=' + 'd'.repeat(64)), f.env), 404);
    const stored = await f.env.DB.prepare('SELECT policy FROM processing_policy_audit WHERE scope_type=? AND version=1')
      .bind('workspace').first<{ policy: string }>();
    assert.deepEqual(JSON.parse(stored!.policy).summary_fields, ['command_text', 'titles']);
    await assert.rejects(f.env.DB.prepare('UPDATE processing_policy_audit SET actor=?').bind('forged').run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare('DELETE FROM processing_policy_audit').run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare('DELETE FROM processing_policies').run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare(`INSERT INTO processing_policies(scope_type,scope_id,enabled,external_allowed,jev_enabled,
      summary_fields,external_fields,min_new_events,quiet_minutes,max_events_per_job,version,updated_at,updated_by)
      VALUES('project',?,1,0,0,'[]','[]',1,0,1,1,'t','x')`).bind('e'.repeat(64)).run(), /processing_policy_project/);
  } finally { await f.close(); }
});
