import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SCHEMA, apply, checkDestination, loadSyncConfig, preview, renderSnapshot, rollback, stableJSON, status,
  verifySnapshot, versions } from './sync.mjs';

// Every note, identifier, path and credential below is synthetic and local to the test directory.
const TOKEN = 'synthetic-sync-device-token-0000000000000';
const PROJECT = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const HEADER = /^<!-- beacon-sync:v1 project=([a-f0-9]{64}) snapshot=([a-f0-9]{64}) kinds=[a-z,]+ reviewed_through=\S+ entries=\d+ renderer=\S+ -->$/;
let clock = 0;
const note = (kind, title, content, extra = {}) => ({ id: randomUUID(), kind, title, content, task_id: null, supersedes_id: null,
  reviewed_at: new Date(Date.UTC(2026, 9, 1) + 1000 * ++clock).toISOString(), ...extra });

function snapshotOf(projectId, kinds, notes) {
  const entries = notes.filter((entry) => kinds.includes(entry.kind)).sort((a, b) => a.kind.localeCompare(b.kind))
    .map((entry) => ({ ...entry, content_sha256: hash(entry.content), valid_from: entry.reviewed_at }));
  return { schema: SNAPSHOT_SCHEMA, project_id: projectId, kinds, entry_count: entries.length, reviewed_through: null,
    snapshot_sha256: hash(stableJSON({ schema: SNAPSHOT_SCHEMA, project_id: projectId, kinds, entries })), entries };
}

/** A local stand-in for the Worker's device routes; it answers only to the synthetic token. */
async function fakeWorker(t, device = 'synthetic-mbp') {
  const state = { device, projects: new Map(), requests: [], tamper: null, redirect: null };
  const server = createServer((request, response) => {
    request.resume();
    const url = new URL(request.url, 'http://fake.invalid');
    state.requests.push({ path: url.pathname + url.search, authorization: request.headers.authorization });
    const send = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'Invalid device credential' });
    if (state.redirect?.path === url.pathname) { response.writeHead(307, { Location: state.redirect.location }); return response.end(); }
    if (url.pathname === '/v1/ingest/health') return send(200, { status: 'ok', device_id: state.device });
    if (url.pathname === '/v1/sync/subscriptions') {
      return send(200, { device_id: state.device, subscriptions: [...state.projects].map(([project_id, project]) =>
        ({ id: project.subscription, project_id, kinds: project.kinds, created_at: '2026-10-01T00:00:00.000Z' })) });
    }
    if (url.pathname === '/v1/sync/snapshot') {
      const project = state.projects.get(url.searchParams.get('project_id'));
      if (!project || [...url.searchParams.keys()].length !== 1) return send(403, { error: 'synthetic private body must not be echoed' });
      const snapshot = snapshotOf(url.searchParams.get('project_id'), project.kinds, project.notes);
      return send(200, { snapshot: state.tamper ? state.tamper(snapshot) : snapshot });
    }
    return send(404, { error: 'Not found' });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}`, state,
    subscribe(projectId, kinds = ['memory', 'summary']) { state.projects.set(projectId, { subscription: randomUUID(), kinds, notes: [] }); },
    add(projectId, ...notes) { state.projects.get(projectId).notes.push(...notes); } };
}

async function fixture(t, override = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'beacon-sync-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = await fakeWorker(t);
  const tokenFile = join(root, 'device-token');
  await fs.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const syncRoot = join(root, 'BeaconNotes');
  await fs.mkdir(join(syncRoot, 'alpha'), { recursive: true });
  worker.subscribe(PROJECT);
  worker.add(PROJECT, note('memory', '合成部署規則', '只部署到隔離 TEST。'), note('summary', '合成交接', '登入修復待 Mac mini 驗證。'));
  const config = { worker_url: worker.url, allow_local_http: true, token_file: tokenFile, state_dir: join(root, 'state'),
    sync_root: syncRoot, targets: [{ project_id: PROJECT, destination: 'alpha/notes.beacon.md' }], ...override };
  return { root, worker, config, tokenFile, syncRoot, destination: join(syncRoot, 'alpha', 'notes.beacon.md') };
}
const read = (path) => fs.readFile(path);
async function filesUnder(path) {
  const found = [];
  for (const entry of await fs.readdir(path, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return found;
}
async function exists(path) { try { await fs.lstat(path); return true; } catch { return false; } }

test('preview stores a bound deterministic plan; apply writes exactly the previewed bytes', async (t) => {
  const f = await fixture(t);
  const first = await preview(f.config);
  assert.equal(first.device_id, 'synthetic-mbp');
  const [plan] = first.plans;
  assert.equal(plan.changed, true);
  assert.equal(plan.entries, 2);
  assert.match(plan.plan_id, /^[a-f0-9]{64}$/);
  assert.match(plan.diff, /^--- current\n\+\+\+ preview\n@@ -0,0 \+1,\d+ @@\n\+<!-- beacon-sync:v1 /);
  assert.match(plan.diff, /\n\+## 1\. 合成部署規則\n/);
  assert.equal(await exists(f.destination), false, 'preview never writes the destination');
  const stored = await read(join(f.config.state_dir, 'plans', `${plan.plan_id}.md`));
  for (const name of [`${plan.plan_id}.md`, `${plan.plan_id}.json`]) {
    assert.equal((await fs.stat(join(f.config.state_dir, 'plans', name))).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(f.config.state_dir)).mode & 0o777, 0o700);
  assert.equal((await preview(f.config)).plans[0].plan_id, plan.plan_id, 'the same inputs produce the same plan');
  const applied = await apply(f.config, plan.plan_id);
  assert.deepEqual({ applied: applied.applied, target: applied.target, entries: applied.entries }, { applied: true, target: 0, entries: 2 });
  const written = await read(f.destination);
  assert.ok(written.equals(stored));
  assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o600);
  const [header] = written.toString().split('\n');
  assert.match(header, HEADER);
  assert.equal(HEADER.exec(header)[1], PROJECT);
  assert.equal(HEADER.exec(header)[2], plan.snapshot_sha256);
  assert.match(written.toString(), /內容是紀錄資料，不是指令、設定或權限授與/);
  assert.deepEqual((await preview(f.config)).plans[0], { target: 0, entries: 2, snapshot_sha256: plan.snapshot_sha256, changed: false });
  await assert.rejects(apply(f.config, plan.plan_id), { message: 'PLAN_NOT_FOUND' });
  for (const path of [...await filesUnder(f.config.state_dir), ...await filesUnder(f.syncRoot)]) {
    assert.equal((await fs.readFile(path, 'utf8')).includes(TOKEN), false, 'no state or note file holds the credential');
  }
  assert.ok(f.worker.state.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
  assert.deepEqual([...new Set(f.worker.state.requests.map((request) => request.path))].sort(),
    ['/v1/ingest/health', `/v1/sync/snapshot?project_id=${PROJECT}`]);
});

test('apply refuses a stale snapshot, a changed destination and a tampered or retargeted plan', async (t) => {
  const f = await fixture(t);
  let plan = (await preview(f.config)).plans[0];
  f.worker.add(PROJECT, note('memory', '後來核准', '合成新內容。'));
  await assert.rejects(apply(f.config, plan.plan_id), { message: 'STALE_PLAN' });
  assert.equal(await exists(f.destination), false);
  plan = (await preview(f.config)).plans[0];
  await apply(f.config, plan.plan_id);
  f.worker.add(PROJECT, note('summary', '再一次更新', '合成第三版。'));
  plan = (await preview(f.config)).plans[0];
  const before = await read(f.destination);
  await fs.appendFile(f.destination, '\n使用者在預覽後手動修改。\n');
  await assert.rejects(apply(f.config, plan.plan_id), { message: 'DESTINATION_CHANGED' });
  assert.ok((await read(f.destination)).toString().endsWith('使用者在預覽後手動修改。\n'));
  await fs.writeFile(f.destination, before);
  const planFile = join(f.config.state_dir, 'plans', `${plan.plan_id}.json`);
  const original = await fs.readFile(planFile, 'utf8');
  await fs.writeFile(planFile, JSON.stringify({ ...JSON.parse(original), destination: join(f.root, 'elsewhere.beacon.md') }));
  await assert.rejects(apply(f.config, plan.plan_id), { message: 'CORRUPT_PLAN' });
  await fs.writeFile(planFile, original);
  await assert.rejects(apply({ ...f.config, targets: [{ project_id: OTHER, destination: 'alpha/notes.beacon.md' }] }, plan.plan_id),
    { message: 'PLAN_TARGET_MISMATCH' });
  await fs.mkdir(join(f.syncRoot, 'beta'));
  await assert.rejects(apply({ ...f.config, targets: [{ project_id: PROJECT, destination: 'beta/notes.beacon.md' }] }, plan.plan_id),
    { message: 'PLAN_TARGET_MISMATCH' });
  await fs.writeFile(join(f.config.state_dir, 'plans', `${plan.plan_id}.md`), 'tampered bytes');
  await assert.rejects(apply(f.config, plan.plan_id), { message: 'CORRUPT_PLAN' });
  for (const id of ['../../etc/passwd', 'A'.repeat(64), 'abc', `${'a'.repeat(64)}.json`, 'f'.repeat(65)]) {
    await assert.rejects(apply(f.config, id), { message: 'INVALID_PLAN_ID' });
  }
  assert.ok((await read(f.destination)).equals(before), 'no refused apply touched the destination');
});

test('rollback restores recorded versions, refuses user edits and restores absence by deleting', async (t) => {
  const f = await fixture(t);
  await apply(f.config, (await preview(f.config)).plans[0].plan_id);
  const v1 = await read(f.destination);
  f.worker.add(PROJECT, note('memory', '第二版', '合成第二版內容。'));
  const second = await apply(f.config, (await preview(f.config)).plans[0].plan_id);
  const v2 = await read(f.destination);
  assert.ok(!v1.equals(v2));
  const history = await versions(f.config, '0');
  assert.deepEqual(history.versions.map((version) => version.reason), ['previous', 'applied', 'previous', 'applied']);
  assert.equal(history.versions[0].sha256, null, 'the first apply records that no file existed');
  assert.equal(history.current_sha256, hash(v2));
  const restored = await rollback(f.config, '0');
  assert.equal(restored.restored_version_id, second.previous_version_id);
  assert.ok((await read(f.destination)).equals(v1));
  assert.equal((await rollback(f.config, '0')).changed, false);
  await fs.appendFile(f.destination, 'synthetic user edit\n');
  await assert.rejects(rollback(f.config, '0'), { message: 'DESTINATION_CHANGED' });
  await fs.writeFile(f.destination, v1);
  const absent = await rollback(f.config, '0', { version: history.versions[0].id });
  assert.equal(absent.deleted, true);
  assert.equal(await exists(f.destination), false);
  await rollback(f.config, '0', { version: second.applied_version_id });
  assert.ok((await read(f.destination)).equals(v2));
  assert.deepEqual((await versions(f.config, '0')).versions.map((version) => version.reason).slice(-3), ['rollback', 'rollback', 'rollback']);
  for (const version of ['../../x', 'Z'.repeat(32), '']) await assert.rejects(rollback(f.config, '0', { version }), { message: 'INVALID_VERSION_ID' });
  await assert.rejects(rollback(f.config, '0', { version: 'c'.repeat(32) }), { message: 'VERSION_NOT_FOUND' });
  for (const target of ['1', '-1', '../0', 'x']) await assert.rejects(rollback(f.config, target), { message: 'INVALID_TARGET' });
  await fs.rm(f.destination);
  await fs.symlink(join(f.root, 'device-token'), f.destination);
  await assert.rejects(rollback(f.config, '0'), { message: 'DESTINATION_SYMLINK_REFUSED' });
  assert.equal((await fs.readFile(f.tokenFile, 'utf8')).trim(), TOKEN, 'a symlinked destination is never followed');
});

test('an interrupted apply or rollback is reconciled from what the destination actually holds', async (t) => {
  const f = await fixture(t);
  const first = await apply(f.config, (await preview(f.config)).plans[0].plan_id);
  const v1 = await read(f.destination);
  f.worker.add(PROJECT, note('memory', '第二版', '合成第二版內容。'));
  const plan = (await preview(f.config)).plans[0];
  const rendered = await read(join(f.config.state_dir, 'plans', `${plan.plan_id}.md`));
  const [manifestName] = await fs.readdir(join(f.config.state_dir, 'targets'));
  const manifestPath = join(f.config.state_dir, 'targets', manifestName);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const announced = { id: 'e'.repeat(32), reason: 'applied', sha256: hash(rendered), recorded_at: '2026-10-08T00:00:00.000Z', plan_id: plan.plan_id };
  // Interrupted before the rename: the announced write never happened and is dropped.
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, pending: announced }));
  let history = await versions(f.config, '0');
  assert.equal(history.last_applied_sha256, hash(v1));
  assert.ok(!history.versions.some((version) => version.id === announced.id));
  // Interrupted after the rename: the file holds the announced bytes, so the write is kept.
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, pending: announced }));
  await fs.writeFile(f.destination, rendered);
  history = await versions(f.config, '0');
  assert.equal(history.last_applied_sha256, hash(rendered));
  assert.equal(history.versions.at(-1).id, announced.id);
  assert.equal((await status(f.config)).targets[0].matches_last_apply, true);
  await rollback(f.config, '0', { version: first.applied_version_id });
  assert.ok((await read(f.destination)).equals(v1));
  // A malformed announcement is refused rather than trusted.
  await fs.writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await fs.readFile(manifestPath, 'utf8')), pending: { id: '../x', sha256: null } }));
  await assert.rejects(versions(f.config, '0'), { message: 'CORRUPT_STATE' });
});

test('config confines destinations to an allowlisted root and refuses instruction files', async (t) => {
  const f = await fixture(t);
  for (const destination of ['/abs/x.beacon.md', '../x.beacon.md', 'alpha/../x.beacon.md', './x.beacon.md', '.hidden/x.beacon.md',
    'alpha/.x.beacon.md', 'x.md', 'AGENTS.md', 'notes.beacon.MD.txt', '.beacon.md', 'AGENTS.beacon.md', 'claude.BEACON.md',
    'Skills/x.beacon.md', 'project/.claude/x.beacon.md', 'alpha\\x.beacon.md', 'alpha//x.beacon.md', 'a\nb.beacon.md',
    'copilot-instructions.beacon.md', 'rules/x.beacon.md', 'Application Support/x.beacon.md', 'x'.repeat(513) + '.beacon.md',
    'GEMINI.beacon.md', 'agents.override.beacon.md', 'Agents/x.beacon.md', 'SKILLS/x.beacon.md', 'Skill.Beacon.MD', 42, '']) {
    // APFS folds case (and normalization), so the comparisons do too.
    assert.throws(() => checkDestination(destination), { message: 'DESTINATION_REFUSED' }, String(destination));
  }
  assert.equal(checkDestination('notes/project-a.beacon.md'), 'notes/project-a.beacon.md');
  assert.equal(checkDestination('筆記/café.beacon.md'), '筆記/café.beacon.md');
  const refused = async (override, code) => assert.rejects(loadSyncConfig({ ...f.config, ...override }), { message: code });
  await refused({ sync_root: join(f.root, '.claude', 'notes') }, 'SYNC_ROOT_REFUSED');
  await refused({ sync_root: join(f.root, 'Library', 'Application Support', 'Claude') }, 'SYNC_ROOT_REFUSED');
  await refused({ sync_root: '/' }, 'SYNC_ROOT_REFUSED');
  await refused({ sync_root: 'relative/notes' }, 'ABSOLUTE_SYNC_ROOT_REQUIRED');
  await refused({ state_dir: join(f.syncRoot, 'state') }, 'SYNC_ROOT_OVERLAPS_PRIVATE_STATE');
  await refused({ sync_root: join(f.config.state_dir, 'notes') }, 'SYNC_ROOT_OVERLAPS_PRIVATE_STATE');
  await refused({ token_file: join(f.syncRoot, 'device-token') }, 'SYNC_ROOT_OVERLAPS_PRIVATE_STATE');
  await refused({ targets: [{ project_id: PROJECT, destination: 'a.beacon.md' }, { project_id: OTHER, destination: 'A.BEACON.md' }] }, 'DUPLICATE_DESTINATION');
  await refused({ targets: [{ project_id: 'not-a-project', destination: 'a.beacon.md' }] }, 'INVALID_TARGET');
  await refused({ targets: [{ project_id: PROJECT, destination: 'a.beacon.md', path: '/etc' }] }, 'INVALID_TARGET');
  await refused({ targets: [{ project_id: PROJECT, destination: 'a.beacon.md', kinds: ['memory', 'memory'] }] }, 'INVALID_TARGET_KINDS');
  await refused({ targets: [] }, 'INVALID_TARGETS');
  await refused({ token: TOKEN }, 'INVALID_CONFIG');
  await refused({ worker_url: 'http://worker.example.invalid' }, 'HTTPS_REQUIRED');
  await refused({ worker_url: 'https://user:secret@worker.example.invalid' }, 'INVALID_WORKER_URL');
  await refused({ worker_url: 'https://worker.example.invalid/api?x=1' }, 'INVALID_WORKER_URL');
  await refused({ timeout_ms: 5 }, 'INVALID_TIMEOUT');
  await assert.rejects(loadSyncConfig('relative.json'), { message: 'ABSOLUTE_CONFIG_PATH_REQUIRED' });
});

test('every preview, apply and rollback re-checks symlinks, file types and managed headers on disk', async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, 'AGENTS.md');
  await fs.writeFile(outside, 'synthetic agent instructions\n');
  const single = (destination) => ({ ...f.config, targets: [{ project_id: PROJECT, destination }] });
  const codeOf = async (config) => (await preview(config)).plans[0].error;
  await fs.symlink(outside, join(f.syncRoot, 'linked.beacon.md'));
  assert.equal(await codeOf(single('linked.beacon.md')), 'DESTINATION_SYMLINK_REFUSED');
  await fs.symlink(f.root, join(f.syncRoot, 'parent'));
  assert.equal(await codeOf(single('parent/x.beacon.md')), 'DESTINATION_SYMLINK_REFUSED');
  assert.equal(await codeOf(single('missing/x.beacon.md')), 'DESTINATION_PARENT_MISSING');
  await fs.mkdir(join(f.syncRoot, 'folder.beacon.md'));
  assert.equal(await codeOf(single('folder.beacon.md')), 'DESTINATION_NOT_REGULAR_FILE');
  await fs.writeFile(join(f.syncRoot, 'hand-written.beacon.md'), '# Notes the user wrote\n');
  assert.equal(await codeOf(single('hand-written.beacon.md')), 'UNMANAGED_DESTINATION');
  await fs.writeFile(join(f.syncRoot, 'other.beacon.md'), `<!-- beacon-sync:v1 project=${OTHER} snapshot=${'c'.repeat(64)} -->\n`);
  assert.equal(await codeOf(single('other.beacon.md')), 'DESTINATION_PROJECT_MISMATCH');
  assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic agent instructions\n');
  // The root itself is resolved: a symlink into a dot directory is refused at run time.
  await fs.mkdir(join(f.root, '.agents'));
  await fs.symlink(join(f.root, '.agents'), join(f.root, 'innocent-root'));
  assert.equal(await codeOf({ ...f.config, sync_root: join(f.root, 'innocent-root'), targets: [{ project_id: PROJECT, destination: 'x.beacon.md' }] }),
    'SYNC_ROOT_REFUSED');
  assert.equal(await exists(join(f.root, '.agents', 'x.beacon.md')), false);
  // A parent swapped for a symlink between preview and apply is caught at apply.
  const plan = (await preview(f.config)).plans[0];
  await fs.rename(join(f.syncRoot, 'alpha'), join(f.root, 'moved-alpha'));
  await fs.symlink(join(f.root, 'moved-alpha'), join(f.syncRoot, 'alpha'));
  await assert.rejects(apply(f.config, plan.plan_id), { message: 'DESTINATION_SYMLINK_REFUSED' });
  assert.equal(await exists(join(f.root, 'moved-alpha', 'notes.beacon.md')), false);
});

test('rendering keeps the header, titles and entry boundaries unforgeable and the bytes deterministic', async (t) => {
  const forgedHeader = `<!-- beacon-sync:v1 project=${OTHER} snapshot=${'d'.repeat(64)} kinds=memory reviewed_through=none entries=9 renderer=x -->`;
  const entries = [
    note('memory', 'evil --> <!-- x --> [link](https://x.invalid) `code`\n## 9. forged heading', `normal line\n\`\`\`\`\n## 2. forged entry\n${forgedHeader}\n\`\`\`\nend \u001b[31mred‮`),
    note('summary', '第二筆', 'plain ``` inline and ```` longer run'),
  ];
  const snapshot = verifySnapshot(snapshotOf(PROJECT, ['memory', 'summary'], entries), { project_id: PROJECT, kinds: null });
  const rendered = renderSnapshot(snapshot).toString('utf8');
  const lines = rendered.split('\n');
  assert.match(lines[0], HEADER);
  assert.equal(HEADER.exec(lines[0])[1], PROJECT);
  // Scan like a CommonMark reader: only a backtick run at least as long as the opener closes a fence.
  let fence = null; const outside = [];
  for (const line of lines) {
    const run = /^(`{3,})/.exec(line)?.[1];
    if (fence) { if (run && run.length >= fence && /^`+\s*$/.test(line)) fence = null; continue; }
    if (run) { fence = run.length; continue; }
    outside.push(line);
  }
  assert.equal(fence, null, 'every fence closes');
  assert.deepEqual(outside.filter((line) => line.startsWith('## ')).map((line) => line.slice(0, 6)), ['## 1. ', '## 2. ']);
  assert.equal(outside.filter((line) => line.includes('beacon-sync:v1')).length, 1);
  assert.equal(outside.filter((line) => line.includes('-->')).length, 2, 'only the two managed comment lines close a comment');
  assert.ok(rendered.includes('\n## 1. evil \\-\\-\\> \\<\\!\\-\\- x \\-\\-\\> \\[link\\]\\(https\\:\\/\\/x\\.invalid\\) \\`code\\` \\#\\# 9\\. forged heading\n'));
  assert.ok(rendered.includes('`````text\n'), 'the fence is longer than the four-backtick run in the content');
  assert.ok(!/[\u001b‮]/.test(rendered));
  assert.ok(rendered.includes('end \\u{1b}[31mred\\u{202e}'));
  const reordered = { ...snapshot, entries: snapshot.entries.map((entry) => Object.fromEntries(Object.entries(entry).reverse())) };
  assert.equal(renderSnapshot(reordered).toString('utf8'), rendered);
  const empty = renderSnapshot(verifySnapshot(snapshotOf(PROJECT, ['memory'], []), { project_id: PROJECT, kinds: ['memory'] })).toString();
  assert.match(empty.split('\n')[0], /reviewed_through=none entries=0 /);
  assert.match(empty, /目前沒有符合訂閱的已核准筆記/);
});

test('snapshots that do not verify, widen kinds or come from another project are never rendered', async (t) => {
  const f = await fixture(t);
  const cases = [
    [(snapshot) => ({ ...snapshot, entries: snapshot.entries.map((entry, index) => index ? entry : { ...entry, content: entry.content + ' altered' }) }), 'SNAPSHOT_INTEGRITY_FAILED'],
    [(snapshot) => ({ ...snapshot, snapshot_sha256: 'e'.repeat(64) }), 'SNAPSHOT_INTEGRITY_FAILED'],
    [(snapshot) => ({ ...snapshot, project_id: OTHER }), 'INVALID_SNAPSHOT'],
    [(snapshot) => ({ ...snapshot, schema: 'other' }), 'INVALID_SNAPSHOT'],
    [(snapshot) => ({ ...snapshot, kinds: ['summary', 'memory'] }), 'INVALID_SNAPSHOT'],
    [(snapshot) => ({ ...snapshot, entries: [...snapshot.entries, snapshot.entries[0]] }), 'INVALID_SNAPSHOT'],
    [(snapshot) => ({ ...snapshot, entries: snapshot.entries.map((entry) => ({ ...entry, valid_from: '2020-01-01T00:00:00.000Z' })) }), 'INVALID_SNAPSHOT'],
  ];
  for (const [tamper, code] of cases) {
    f.worker.state.tamper = tamper;
    assert.deepEqual((await preview(f.config)).plans[0], { target: 0, error: code });
  }
  f.worker.state.tamper = null;
  const memoryOnly = { ...f.config, targets: [{ ...f.config.targets[0], kinds: ['memory'] }] };
  assert.equal((await preview(memoryOnly)).plans[0].error, 'SUBSCRIPTION_KINDS_MISMATCH');
  f.worker.subscribe(PROJECT, ['memory']);
  f.worker.add(PROJECT, note('memory', '只同步長期記憶', '合成。'), note('summary', '不應出現', '合成。'));
  const plan = (await preview(memoryOnly)).plans[0];
  assert.equal(plan.entries, 1);
  assert.doesNotMatch(plan.diff, /不應出現/);
  f.worker.state.projects.delete(PROJECT);
  assert.deepEqual((await preview(f.config)).plans[0], { target: 0, error: 'HTTP_403' });
  assert.equal(await exists(f.destination), false);
});

test('the Worker and device binding, redirects and private local state are enforced before files change', async (t) => {
  const f = await fixture(t);
  await preview(f.config);
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.config.state_dir, 'state.json'), 'utf8')),
    { version: 1, worker_url: f.config.worker_url, device_id: 'synthetic-mbp' });
  f.worker.state.device = 'synthetic-mini';
  await assert.rejects(preview(f.config), { message: 'DEVICE_NAMESPACE_MISMATCH' });
  f.worker.state.device = 'synthetic-mbp';
  const elsewhere = await fakeWorker(t);
  await assert.rejects(preview({ ...f.config, worker_url: elsewhere.url }), { message: 'WORKER_NAMESPACE_MISMATCH' });
  assert.equal(elsewhere.state.requests.length, 0, 'no credential is sent to a different Worker');
  // A redirect is refused rather than followed with the bearer credential.
  elsewhere.subscribe(PROJECT);
  f.worker.state.redirect = { path: '/v1/sync/snapshot', location: `${elsewhere.url}/v1/sync/snapshot?project_id=${PROJECT}` };
  assert.deepEqual((await preview(f.config)).plans[0], { target: 0, error: 'REDIRECT_REJECTED' });
  f.worker.state.redirect = { path: '/v1/ingest/health', location: `${elsewhere.url}/v1/ingest/health` };
  await assert.rejects(preview(f.config), { message: 'REDIRECT_REJECTED' });
  assert.equal(elsewhere.state.requests.length, 0);
  f.worker.state.redirect = null;
  await assert.rejects(preview(f.config, { fetchImpl: async () => { throw new Error('synthetic offline with private detail'); } }), { message: 'NETWORK_UNAVAILABLE' });
  await assert.rejects(preview(f.config, { fetchImpl: async () => new Response('<html>login</html>', { status: 200 }) }), { message: 'INVALID_SERVER_RESPONSE' });
  await assert.rejects(preview(f.config, { target: '3' }), { message: 'INVALID_TARGET' });
  await fs.writeFile(join(f.config.state_dir, 'sync.lock'), 'held', { mode: 0o600 });
  await assert.rejects(preview(f.config), { message: 'SYNC_LOCKED' });
  await fs.rm(join(f.config.state_dir, 'sync.lock'));
  await fs.chmod(f.config.state_dir, 0o755);
  await assert.rejects(preview(f.config), { message: 'PRIVATE_STATE_DIRECTORY_REQUIRED' });
  await fs.chmod(f.config.state_dir, 0o700);
  const linkedState = join(f.root, 'linked-state');
  await fs.symlink(f.config.state_dir, linkedState);
  await assert.rejects(preview({ ...f.config, state_dir: linkedState }), { message: 'PRIVATE_STATE_DIRECTORY_REQUIRED' });
  await fs.chmod(f.tokenFile, 0o644);
  await assert.rejects(preview(f.config), { message: 'PRIVATE_TOKEN_FILE_REQUIRED' });
  await fs.chmod(f.tokenFile, 0o600);
  const linkedToken = join(f.root, 'token-link');
  await fs.symlink(f.tokenFile, linkedToken);
  await assert.rejects(preview({ ...f.config, token_file: linkedToken }), { message: 'PRIVATE_TOKEN_FILE_REQUIRED' });
  await fs.writeFile(join(f.config.state_dir, 'state.json'), '{"version":1}', { mode: 0o600 });
  await assert.rejects(preview(f.config), { message: 'CORRUPT_STATE' });
  assert.equal(await exists(f.destination), false);
});

test('status and the CLI print only ids, hashes, codes and the requested diff', async (t) => {
  const f = await fixture(t);
  const configPath = join(f.root, 'sync-config.json');
  await fs.writeFile(configPath, JSON.stringify({ ...f.config, targets: [...f.config.targets, { project_id: OTHER, destination: 'other.beacon.md' }] }));
  const report = await status(configPath);
  assert.deepEqual(report, { device_id: 'synthetic-mbp', subscriptions: 1, targets: [
    { target: 0, project_id: PROJECT, subscribed: true, kinds: ['memory', 'summary'], destination: 'absent', matches_last_apply: null },
    { target: 1, project_id: OTHER, subscribed: false, kinds: null, destination: 'absent', matches_last_apply: null }] });
  const script = fileURLToPath(new URL('./sync.mjs', import.meta.url));
  const run = (...args) => new Promise((done) => execFile(process.execPath, [script, ...args], { cwd: f.root },
    (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr })));
  const previewed = await run('--config', configPath, 'preview');
  assert.equal(previewed.code, 2, 'a target that cannot be previewed makes the run fail visibly');
  const summary = JSON.parse(previewed.stdout.trim().split('\n').at(-1));
  assert.deepEqual(summary.plans[1], { target: 1, error: 'HTTP_403' });
  assert.match(previewed.stdout, /^# target 0 plan [a-f0-9]{64}\n--- current\n\+\+\+ preview\n/);
  const applied = await run('--config', configPath, 'apply', summary.plans[0].plan_id);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, true);
  const after = JSON.parse((await run('--config', configPath, 'status')).stdout);
  assert.equal(after.targets[0].destination, 'managed');
  assert.equal(after.targets[0].matches_last_apply, true);
  const listed = JSON.parse((await run('--config', configPath, 'versions', '0')).stdout);
  assert.equal(listed.versions.length, 2);
  const refused = await run('--config', configPath, 'apply', '../../etc/passwd');
  assert.deepEqual({ code: refused.code, stdout: refused.stdout, stderr: refused.stderr }, { code: 1, stdout: '', stderr: 'INVALID_PLAN_ID\n' });
  const usage = await run('preview');
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /^USAGE_SYNC/);
  assert.equal((await run('--config', configPath, 'apply')).code, 1);
  for (const output of [previewed, applied, refused, usage]) assert.equal(`${output.stdout}${output.stderr}`.includes(TOKEN), false);
});
