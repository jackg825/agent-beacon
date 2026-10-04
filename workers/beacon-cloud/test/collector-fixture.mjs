import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDirectory = resolve(packageDirectory, '../../cli/beacon-hooks');
const binaryPath = join(packageDirectory, 'dist', process.platform === 'win32' ? 'beacon-hooks.exe' : 'beacon-hooks');
let built;

export async function buildBeaconHooks() {
  built ??= (async () => {
    await mkdir(dirname(binaryPath), { recursive: true });
    // Build shipping code unchanged. Runtime isolation below is separate from the Go cache.
    await exec('go', ['build', '-o', binaryPath, '.'], { cwd: hooksDirectory, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    return binaryPath;
  })();
  return built;
}

export async function produceBeaconFixture(directory, options = {}) {
  const binary = options.binaryPath ?? await buildBeaconHooks();
  const home = join(directory, 'isolated-home');
  const workspace = join(directory, 'synthetic-workspace');
  const logPath = join(directory, 'runtime.jsonl');
  const configPath = join(directory, 'endpoint-config.json');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(configPath, '{}', { mode: 0o600 });
  // Child-only HOME is intentionally isolated; process.env and real user settings are untouched.
  // No inherited BEACON, cloud credentials, Git config, or agent environment is passed through.
  const environment = {
    PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
    USER: 'synthetic-beacon-test-user', USERNAME: 'synthetic-beacon-test-user',
    BEACON_ORIGIN: 'local', BEACON_ENDPOINT_MODE: '1', BEACON_CONTENT_RETENTION: 'full',
    BEACON_DISABLE_GIT_METADATA: '1', BEACON_CLOUD_USER_ID_HASH: 'synthetic-user-id',
  };
  const sessionId = options.sessionId ?? 'compiled-hook-synthetic-session';
  const canary = 'BEACON_SYNTHETIC_HOOK_CANARY';
  const invoke = async (command, input) => {
    const { spawn } = await import('node:child_process');
    await new Promise((accept, reject) => {
      const child = spawn(binary, ['--platform', 'claude', '--log', logPath, '--config', configPath, command],
        { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('SYNTHETIC_HOOK_TIMEOUT')); }, 30000);
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      // Do not print raw output; even generated events can carry host metadata.
      child.stdout.resume(); child.stderr.resume();
      child.on('close', (code) => { clearTimeout(timeout); code === 0 ? accept() : reject(new Error('SYNTHETIC_HOOK_FAILED')); });
      child.stdin.end(JSON.stringify(input));
    });
  };
  await invoke('session-start', { hook_event_name: 'SessionStart', session_id: sessionId, cwd: workspace, model: 'synthetic-model' });
  await invoke('post-tool', { hook_event_name: 'PostToolUse', session_id: sessionId, cwd: workspace,
    tool_name: 'Bash', tool_use_id: 'synthetic-bash-tool-call', tool_input: { command: `echo ${canary}` },
    tool_response: { stdout: `${canary}\n`, stderr: '', exit_code: 0 } });
  const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  if (events.length !== 2 || !events.some(event => event.event?.action === 'session.started') ||
    !events.some(event => event.event?.action === 'command.executed') || events.some(event => !event.event?.id)) {
    throw new Error('SYNTHETIC_HOOK_CAPTURE_MISMATCH');
  }
  return { logPath, sessionId, workspace, events, canary };
}
