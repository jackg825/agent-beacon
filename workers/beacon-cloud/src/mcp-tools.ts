import * as z from 'zod/v4';

// Shared by every module that registers MCP tools. All tools are read-only.
export const pageLimit = z.number().int().min(1).max(40).optional();
export const identifier = z.string().min(1).max(512);
export const cursor = z.string().min(1).max(2048).optional();
export const workflowId = z.string().uuid();
export const hashId = z.string().regex(/^[a-f0-9]{64}$/);
export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function queryParams(values: Record<string, string | number | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

export async function result(query: () => Promise<unknown>) {
  try {
    const data = await query();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch {
    // Do not expose database errors, event content, or credentials through protocol errors.
    return { content: [{ type: 'text' as const, text: 'Query failed. Check identifiers and pagination cursor.' }], isError: true };
  }
}
