import { HttpError } from './types';

/** Review requests are small structured documents, never unbounded transcripts. */
export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const maximum = 64 * 1024;
  const size = request.headers.get('Content-Length');
  if (size && (!/^\d+$/.test(size) || Number(size) > maximum)) throw new HttpError(413, 'Review document too large');
  if (request.headers.get('Content-Encoding')) throw new HttpError(415, 'Encoded review documents are unsupported');
  if (!request.body) throw new HttpError(400, 'JSON document required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new HttpError(413, 'Review document too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid JSON document'); }
}
