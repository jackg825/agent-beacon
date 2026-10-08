// The one outbound HTTP path for background processing. Every provider call goes
// through externalFetch with the task's metered ctx.fetch. Results carry short codes
// only: never a response body, an exception message, a header or the request.

/** Whether the provider may have received and acted on the request. */
export type CallUncertainty = 'failed' | 'outcome_unknown';
export type ExternalResult =
  | { ok: true; status: number; text: string }
  | { ok: false; outcome: CallUncertainty; code: string; status?: number };
export interface ExternalLimits { timeoutMs: number; maxBytes: number }

const aborted = (error: unknown, signal: AbortSignal) =>
  signal.aborted || ['AbortError', 'TimeoutError'].includes((error as { name?: unknown })?.name as string);
async function discard(response: Response) {
  try { await response.body?.cancel(); } catch { /* The body is never read. */ }
}

/**
 * POST/GET with `redirect:'manual'` (workerd rejects 'error'): any 3xx or opaque
 * redirect is refused, never followed, so neither the body nor the bearer key can
 * reach another origin. The timeout covers the whole exchange including the body,
 * which is streamed under a byte cap. A thrown fetch or a timeout means the request
 * may have reached the provider, so its outcome is unknown rather than failed.
 */
export async function externalFetch(fetcher: typeof fetch, url: string, init: RequestInit, limits: ExternalLimits): Promise<ExternalResult> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'manual', signal }); }
  catch (error) {
    // The metered ctx.fetch refuses before anything is sent when the task's allotment is used up.
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && /^budget_exhausted:[a-z0-9]+$/.test(code)) return { ok: false, outcome: 'failed', code };
    return { ok: false, outcome: 'outcome_unknown', code: aborted(error, signal) ? 'timeout' : 'network_error' };
  }
  // workerd types omit 'opaqueredirect', but other runtimes (and fakes) can return it.
  if ((response.type as string) === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await discard(response);
    return { ok: false, outcome: 'failed', code: 'redirect_rejected', status: response.status };
  }
  if (response.status < 200 || response.status >= 300) {
    await discard(response);
    return { ok: false, outcome: 'failed', code: 'http_' + (Number.isInteger(response.status) ? response.status : 0), status: response.status };
  }
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limits.maxBytes)) {
    await discard(response);
    return { ok: false, outcome: 'failed', code: 'response_too_large', status: response.status };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Every read races the deadline, whether or not the runtime ties the body to the signal.
  const deadline = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  deadline.catch(() => {});
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        try { await reader.cancel(); } catch { /* Already failed. */ }
        return { ok: false, outcome: 'failed', code: 'response_too_large', status: response.status };
      }
      chunks.push(value);
    }
  } catch (error) {
    reader?.cancel().catch(() => {});
    // The provider answered and then the body stalled or broke: it may have acted.
    return { ok: false, outcome: 'outcome_unknown', code: aborted(error, signal) ? 'timeout' : 'network_error', status: response.status };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { ok: true, status: response.status, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }; }
  catch { return { ok: false, outcome: 'failed', code: 'invalid_response', status: response.status }; }
}

/**
 * Provider endpoints come only from Worker vars. Accept https with a host, without
 * userinfo, query or fragment, and never this Worker's own public host, so a call
 * can never loop back into the service it runs in. Anything else disables the call.
 */
export function externalEndpoint(value: string | undefined, fallback: string, publicUrl?: string): string | null {
  const raw = (value ?? '').trim() || fallback;
  if (raw.length > 512 || /[\s?#@\\]/.test(raw) || !/^https:\/\/[^/]/i.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  if (publicUrl) {
    try { if (new URL(publicUrl).hostname.toLowerCase() === url.hostname.toLowerCase()) return null; }
    catch { return null; }
  }
  return url.toString();
}
