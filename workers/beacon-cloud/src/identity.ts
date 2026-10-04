import { digest } from './auth';
import { HttpError, RecordData } from './types';

export function field(record: unknown, ...path: string[]): string {
  let value = record;
  for (const part of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    value = (value as RecordData)[part];
  }
  return typeof value === 'string' ? value.trim() : '';
}
export function canonicalRemote(raw: string): string | null {
  let value = raw.trim();
  if (/^[^/@:]+@[^/:]+:.+/.test(value)) value = value.replace(/^[^@]+@([^:]+):(.+)$/, 'ssh://$1/$2');
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
    let path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!path || path.split('/').some(p => !p || p === '.' || p === '..') || /[\s?#\\]/.test(path)) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'github.com') path = path.toLowerCase();
    const defaultPort = ({'ssh:':'22','http:':'80','https:':'443','git:':'9418'} as Record<string,string>)[url.protocol];
    const port = url.port && url.port !== defaultPort ? `:${url.port}` : '';
    return `${host}${port}/${path}`;
  } catch { return null; }
}
export async function projectIdentity(record: RecordData, device: string) {
  const candidates = [field(record, 'project', 'remote'), field(record, 'vcs', 'repository', 'url', 'full'),
    field(record, 'repository'), field(record, 'run', 'repository')];
  let remote: string | null = null;
  for (const candidate of candidates) { remote = canonicalRemote(candidate); if (remote) break; }
  const cwd = field(record, 'session', 'working_directory').replace(/\/+$/g, '') || '/';
  const kind = remote ? 'remote' : field(record, 'session', 'working_directory') ? 'device_path' : 'unknown';
  const identity = remote ? `repo:${remote}` : `${kind}:${device}:${kind === 'device_path' ? cwd : 'unresolved'}`;
  return { id: await digest(identity), identity, name: remote || (kind === 'device_path' ? cwd.split('/').pop() || cwd : '未辨識專案'), kind };
}
export function required(record: RecordData, ...path: string[]): string {
  const value = field(record, ...path);
  if (!value || value.length > 512) throw new HttpError(400, `Invalid ${path.join('.')}`);
  return value;
}
export function stableJSON(value: unknown, depth=0): string {
  if (depth>64) throw new HttpError(400,'Event nesting exceeds 64 levels');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item=>stableJSON(item,depth+1)).join(',')}]`;
  return `{${Object.keys(value as RecordData).sort().map(key => `${JSON.stringify(key)}:${stableJSON((value as RecordData)[key],depth+1)}`).join(',')}}`;
}
