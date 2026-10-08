import test from 'node:test';
import assert from 'node:assert/strict';
import { assignedValues, cleanLine, cleanText, FIELD_CLASSES, MAX_PROJECTION_CHARS, MAX_PROJECTION_TEXT, projectEvent, projectEvents,
  redact, truncate, workerSecrets } from '../src/privacy';
import type { Env } from '../src/types';

// Every value below is synthetic and shaped only to exercise a pattern.
const a20 = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8';
const cases: { name: string; input: string; secret: string; expected?: string }[] = [
  { name: 'upstream assignment', input: 'api_key=synthetic1234567', secret: 'synthetic1234567', expected: 'api_key=[REDACTED]' },
  { name: 'upstream colon assignment', input: 'token: synthetic1234567', secret: 'synthetic1234567', expected: 'token:[REDACTED]' },
  { name: 'authorization bearer header', input: 'Authorization: Bearer synthetic.header.value', secret: 'synthetic.header', expected: 'Authorization:[REDACTED]' },
  { name: 'bare bearer', input: 'curl -H "X-Auth: Bearer syntheticBearerValue99"', secret: 'syntheticBearerValue99' },
  { name: 'sk- key', input: `use sk-${a20} now`, secret: `sk-${a20}`, expected: 'use [REDACTED] now' },
  { name: 'sk-ant- key', input: `ANTHROPIC sk-ant-api03-${a20}_x-y`, secret: `api03-${a20}` },
  { name: 'sk-proj- key', input: `key sk-proj-${a20}`, secret: `proj-${a20}` },
  { name: 'sk-svcacct- key', input: `sk-svcacct-${a20}`, secret: a20 },
  { name: 'sk-admin- key', input: `sk-admin-${a20}`, secret: a20 },
  { name: 'beacon worker device key', input: `cat token.txt\nbcn_cf_${'Q'.repeat(43)}`, secret: 'Q'.repeat(43) },
  { name: 'beacon device key', input: `bcn_device_${'z'.repeat(32)}`, secret: 'z'.repeat(32) },
  { name: 'AWS access key id', input: 'id AKIAABCDEFGHIJKLMNOP end', secret: 'AKIAABCDEFGHIJKLMNOP', expected: 'id [REDACTED] end' },
  { name: 'AWS temporary key id', input: 'ASIAABCDEFGHIJKLMNOP', secret: 'ASIAABCDEFGHIJKLMNOP' },
  { name: 'GitHub token ghp_', input: `ghp_${'a1'.repeat(18)}`, secret: 'a1'.repeat(18) },
  { name: 'GitHub token gho_', input: `x gho_${'b2'.repeat(18)}`, secret: 'b2'.repeat(18) },
  { name: 'GitHub token ghs_', input: `ghs_${'c3'.repeat(18)}`, secret: 'c3'.repeat(18) },
  { name: 'GitHub fine-grained token', input: `github_pat_${'d4'.repeat(30)}`, secret: 'd4'.repeat(30) },
  { name: 'Slack token', input: 'xoxb-1234567890-abcdefghij', secret: '1234567890-abcdefghij' },
  { name: 'PEM private key block', input: '-----BEGIN RSA PRIVATE KEY-----\nMIISYNTHETIC\nLINE2\n-----END RSA PRIVATE KEY-----\nafter',
    secret: 'MIISYNTHETIC', expected: '[REDACTED]\nafter' },
  { name: 'unterminated PEM block', input: 'key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA', secret: 'b3BlbnNzaC1rZXktdjEAAAA' },
  { name: 'JWT', input: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aCJ9.c2lnbmF0dXJlLXN5bnRo', secret: 'eyJzdWIiOiJzeW50aCJ9' },
  { name: 'Google API key', input: `AIza${'S'.repeat(35)}`, secret: 'S'.repeat(35) },
  { name: 'URL userinfo', input: 'psql postgres://synthuser:synthpass@db.internal/app', secret: 'synthpass', expected: 'psql postgres://[REDACTED]@db.internal/app' },
  { name: 'JSON quoted api_key', input: '{"api_key": "jsonsecret12345"}', secret: 'jsonsecret12345' },
  { name: 'JSON quoted password', input: '{"password":"hunter2hunter2"}', secret: 'hunter2hunter2' },
  { name: 'passwd', input: 'passwd=synthpasswd1', secret: 'synthpasswd1' },
  { name: 'pwd', input: 'PWD: synthpwd12345', secret: 'synthpwd12345' },
  { name: 'credential', input: 'credential=synthcred123', secret: 'synthcred123' },
  { name: 'credentials', input: 'credentials: synthcreds456', secret: 'synthcreds456' },
  { name: 'private_key', input: 'private_key=synthpk7890ab', secret: 'synthpk7890ab' },
  { name: 'access_key', input: 'access_key = synthak7890ab', secret: 'synthak7890ab' },
  { name: 'secret_access_key', input: 'secret_access_key=synthsak7890', secret: 'synthsak7890' },
  { name: 'AWS_SECRET_ACCESS_KEY', input: 'export AWS_SECRET_ACCESS_KEY=wJalrSYNTHETICKEY', secret: 'wJalrSYNTHETICKEY' },
  { name: 'client_secret', input: 'client_secret: synthclient99', secret: 'synthclient99' },
  { name: 'cookie', input: 'Cookie: sid=synthcookie42', secret: 'synthcookie42' },
  { name: 'session', input: 'session=synthsession77', secret: 'synthsession77' },
];

test('redaction table: every credential pattern and key vocabulary is removed', () => {
  for (const item of cases) {
    const output = redact(item.input);
    assert.ok(!output.includes(item.secret), `${item.name}: ${output}`);
    assert.ok(output.includes('[REDACTED]'), item.name);
    if (item.expected) assert.equal(output, item.expected, item.name);
  }
  assert.equal(redact('plain synthetic text, nothing hidden: 12'), 'plain synthetic text, nothing hidden: 12');
  // Like upstream, a label followed by a value is redacted even when the value is harmless.
  assert.equal(redact('secret: 12'), 'secret:[REDACTED]');
});

// A synthetic key body; every 8-character piece of it is checked, so a partial leak shows.
const keyBody = ['SYNTHKEYa1b2c3d4e5f6g7h8i9j0', 'SYNTHKEYk1l2m3n4o5p6q7r8s9t0', 'SYNTHKEYu1v2w3x4y5z6A7B8C9D0='];
const pem = (type = 'PRIVATE KEY', newline = '\n', end = true) =>
  `-----BEGIN ${type}-----${newline}${keyBody.join(newline)}${newline}${end ? `-----END ${type}-----${newline}` : ''}`;
const keyPieces = (output: string) => keyBody.flatMap((line) => Array.from({ length: line.length - 7 }, (_, index) => line.slice(index, index + 8)))
  .filter((piece) => output.includes(piece));
const serviceAccount = { type: 'service_account', private_key: pem(), client_email: 'synthetic@example.invalid' };

test('a private key block is removed whole even when a secret-like label comes before it', () => {
  const forms: [string, string][] = [
    ['service-account JSON (escaped newlines)', JSON.stringify(serviceAccount)],
    ['pretty-printed service-account JSON', JSON.stringify(serviceAccount, null, 2)],
    ['JSON-like text with real newlines', `{"private_key": "${pem()}"}`],
    ['camelCase JSON key', JSON.stringify({ privateKey: pem('RSA PRIVATE KEY') })],
    ['.env assignment', `SSH_PRIVATE_KEY=${pem('OPENSSH PRIVATE KEY')}`],
    ['quoted export', `export SSH_PRIVATE_KEY="${pem('RSA PRIVATE KEY')}"`],
    ['single-quoted assignment', `private_key='${pem('EC PRIVATE KEY')}'`],
    ['YAML block scalar', `private_key: |\n  ${pem('PRIVATE KEY', '\n  ')}`],
    ['encrypted key under a label', `"private_key": "${pem('ENCRYPTED PRIVATE KEY', '\\n')}"`],
    ['unterminated block after a label', `private_key: ${pem('RSA PRIVATE KEY', '\n', false)}`],
    ['unterminated JSON-escaped block', JSON.stringify(serviceAccount).slice(0, JSON.stringify(serviceAccount).indexOf(keyBody[2]) + 12)],
    ['label at the cut boundary', 'x'.repeat(1150) + ' private_key=' + pem()],
  ];
  for (const [name, input] of forms) {
    for (const output of [redact(input), cleanText(input), cleanLine(input, {}, 2000)]) {
      assert.deepEqual(keyPieces(output), [], `${name}: ${output}`);
      assert.ok(!output.includes('BEGIN') && output.includes('[REDACTED]'), name);
    }
    // The block's opening line is never mistaken for an assigned value to hunt elsewhere.
    assert.ok(assignedValues(input).every((value) => !value.startsWith('-----')), name);
  }
  assert.equal(redact(`SSH_PRIVATE_KEY=${pem('OPENSSH PRIVATE KEY')}after`), 'SSH_PRIVATE_KEY=[REDACTED]\nafter');
  assert.equal(redact(JSON.stringify(serviceAccount)),
    '{"type":"service_account","private_key":[REDACTED]","client_email":"synthetic@example.invalid"}');
  // Text between two labelled blocks survives.
  assert.equal(redact(`a_private_key=${pem()}middle text b_private_key=${pem()}`), 'a_private_key=[REDACTED]\nmiddle text b_private_key=[REDACTED]\n');
  // The same holds in every projected class, structured or not.
  const projection = projectEvents([
    { payload: { event: { action: 'tool.invoked' }, tool: { input: serviceAccount }, raw: { env: `SSH_PRIVATE_KEY=${pem()}` } } },
    { payload: { event: { action: 'command.executed' }, command: { command: `echo "private_key=${pem()}"`, output: JSON.stringify(serviceAccount) } } },
  ], ['tool_input', 'raw', 'command_text', 'command_output']);
  assert.deepEqual(keyPieces(JSON.stringify(projection)), []);
});

test('repeated bare copies are removed in one string and across a projection', () => {
  assert.equal(redact('token=bareCopy12345 then later bareCopy12345 again'), 'token=[REDACTED] then later [REDACTED] again');
  // Short assigned values are not hunted as bare copies (upstream threshold of 8).
  assert.equal(redact('token=short then short'), 'token=[REDACTED] then short');
  const projection = projectEvents([
    { payload: { event: { action: 'command.executed' }, command: { command: 'export API_KEY=crossEvent98765' } } },
    { payload: { event: { action: 'command.executed' }, command: { command: 'echo done', output: 'value is crossEvent98765' } } },
  ], ['command_text', 'command_output']);
  assert.ok(!JSON.stringify(projection).includes('crossEvent98765'));
  assert.equal(projection.events[1].command_output, 'value is [REDACTED]');
});

test('the Worker own secrets are removed by exact value when at least 8 characters', () => {
  const env = { READ_TOKEN: 'synthetic-read-0123456789', MCP_TOKEN: 'synthetic-mcp-0123456789', REVIEW_TOKEN: 'synthetic-review-01234',
    JEV_API_KEY: 'synthetic-jev-key-0123', } as Env;
  const secrets = workerSecrets({ ...env, PUBLIC_URL: 'https://x.invalid' });
  assert.equal(secrets.length, 4);
  const output = redact(`a ${env.READ_TOKEN} b ${env.MCP_TOKEN} c ${env.REVIEW_TOKEN} d ${env.JEV_API_KEY}`, { secrets });
  for (const value of secrets) assert.ok(!output.includes(value));
  assert.deepEqual(workerSecrets({ READ_TOKEN: 'short7' } as Env), []);
});

test('redaction runs on the whole string before truncation, and again after the cut', () => {
  const value = 'x'.repeat(1180) + `sk-${a20}${a20}`;
  // Truncating first would keep a recognisable key prefix below the pattern minimum.
  assert.match(truncate(value), /sk-Ab1\.\.\./);
  const cleaned = cleanText(value);
  assert.ok(cleaned.length <= MAX_PROJECTION_TEXT);
  assert.ok(!cleaned.includes('sk-'));
  assert.equal(cleaned, 'x'.repeat(1180) + '[REDACTED]');
  assert.ok(cleanText('x'.repeat(1180) + ' ' + 'y'.repeat(100) + ' token=' + 'v'.repeat(30)).endsWith('...[truncated]'));
  const pem = 'y'.repeat(1150) + '\n-----BEGIN EC PRIVATE KEY-----\nSYNTHETICPEMBODY' + 'z'.repeat(5000);
  assert.ok(!cleanText(pem).includes('SYNTHETICPEM') && !cleanText(pem).includes('BEGIN EC'));
  // Surrogate pairs are never split by a cut.
  assert.ok(!/[\uD800-\uDBFF]$/.test(truncate('字'.repeat(10) + '😀'.repeat(600), 31)));
});

test('home directories become ~/ and paths under the session directory become relative', () => {
  assert.equal(redact('/Users/synthalice/src/app.ts'), '~/src/app.ts');
  assert.equal(redact('cd /home/synthbob/work && ls'), 'cd ~/work && ls');
  assert.equal(redact('C:\\Users\\synthcarol\\proj\\a.ts'), '~/proj\\a.ts');
  assert.equal(redact('owner /Users/synthalice'), 'owner ~');
  const payload = { event: { action: 'file.modified' }, session: { working_directory: '/Users/synthalice/work/repo' },
    file: { path: '/Users/synthalice/work/repo/src/login.ts' } };
  assert.equal(projectEvent(payload, ['file_path']).file_path, 'src/login.ts');
  assert.equal(projectEvent({ ...payload, file: { path: '/Users/synthalice/other/x.md' } }, ['file_path']).file_path, '~/other/x.md');
  assert.equal(projectEvent(payload, ['file_path'], { projectRoot: '/elsewhere' }).file_path, '~/work/repo/src/login.ts');
});

const marker = (name: string) => `MARKER_${name}_CONTENT`;
const rich = {
  vendor: 'beacon', schema_version: '1.0', timestamp: '2026-10-08T01:02:03Z',
  event: { id: 'synthetic-rich', action: 'agent.message', kind: 'agent_runtime' }, harness: { name: 'codex_cli' },
  session: { id: 'synthetic-session', working_directory: '/synthetic/repo' },
  file: { path: `/synthetic/repo/${marker('file_path')}.ts`, diff: marker('file_diff') },
  tool: { name: marker('tool_name'), input: { arg: marker('tool_input') } },
  command: { command: marker('command_text'), output: marker('command_output'), exit_code: 2 },
  prompt: { text: marker('prompt_text') }, message: marker('response_text'),
  gen_ai: { usage: { input_tokens: 12, output_tokens: 5, cost_usd: 0.25 }, output: { messages: [{ text: marker('response_text') }] } },
  approval: { decision: 'denied', reason: marker('raw') }, raw: { anything: marker('raw') },
  repository: 'https://github.com/synthetic/MARKER_repository', user: { name: 'MARKER_user' },
};

test('projection keeps only metadata by default and each content class only when listed', () => {
  const none = projectEvent(rich, []);
  assert.deepEqual(none, { action: 'agent.message', kind: 'agent_runtime', timestamp: '2026-10-08T01:02:03Z', harness: 'codex_cli',
    exit_code: 2, approval_decision: 'denied', usage: { input_tokens: 12, output_tokens: 5, cost_usd: 0.25 }, file_ext: '.ts' });
  assert.ok(!JSON.stringify(none).includes('MARKER'));
  const contentClasses = ['file_path', 'tool_name', 'command_text', 'command_output', 'prompt_text', 'response_text', 'file_diff', 'tool_input', 'raw'] as const;
  for (const name of contentClasses) {
    const projected = projectEvent(rich, [name]) as unknown as Record<string, unknown>;
    const text = JSON.stringify(projected);
    assert.ok(text.includes(marker(name)), name);
    for (const other of contentClasses) if (other !== name) assert.ok(!text.includes(marker(other)), `${name} leaked ${other}`);
    assert.ok(!text.includes('MARKER_repository') && !text.includes('MARKER_user'));
    assert.equal(projected.file_ext, name === 'file_path' ? undefined : '.ts');
  }
  // Titles and approved note text have no payload source; they only gate scope labels and evaluator state.
  assert.deepEqual(projectEvent(rich, ['titles', 'approved_note_text']), none);
  const all = projectEvent(rich, [...FIELD_CLASSES]);
  for (const name of contentClasses) assert.ok(JSON.stringify(all).includes(marker(name)), name);
  // Non-agent messages are raw, not response text.
  const hook = projectEvent({ ...rich, event: { action: 'command.executed' }, gen_ai: undefined }, ['response_text']);
  assert.equal(hook.response_text, undefined);
});

test('projections are bounded per string and in total', () => {
  const big = projectEvent({ event: { action: 'command.executed' }, command: { output: 'o'.repeat(50_000) } }, ['command_output']);
  assert.equal(big.command_output!.length, MAX_PROJECTION_TEXT);
  const many = projectEvents(Array.from({ length: 200 }, (_, index) => ({ payload: { event: { action: 'command.executed' },
    command: { command: 'c'.repeat(2000) + index, output: 'p'.repeat(2000) } } })), ['command_text', 'command_output']);
  const total = many.events.reduce((sum, event) => sum + (event.command_text?.length ?? 0) + (event.command_output?.length ?? 0), 0);
  assert.ok(total <= MAX_PROJECTION_CHARS);
  assert.equal(many.truncated, true);
  assert.equal(many.events.length, 200);
  assert.ok(many.events.every((event) => event.action === 'command.executed'));
});
