export const MCP_BODY_LIMIT = 256 * 1024;

// Keep this transport-only: no credential parsing, storage, extra provider,
// upstream call or logged request content. Cloudflare owns the burst counters.
export async function guardRequest(request, env) {
  const url = new URL(request.url);
  const simpleHealth = url.pathname === '/health' && url.searchParams.get('probe') !== '1';
  if (env.ABUSE_PROTECTION === 'on' && request.method !== 'OPTIONS' && !simpleHealth) {
    try {
      if (!env.REQUEST_RATE_LIMITER) throw new Error('missing limiter');
      if (!(await env.REQUEST_RATE_LIMITER.limit({ key: `ip:${request.headers.get('cf-connecting-ip') || 'unidentified'}` })).success)
        return { status: 429, event: 'request_rate_limited', message: 'Too many requests. Retry later.' };
    } catch {
      return { status: 503, event: 'request_protection_unavailable', message: 'Request protection is temporarily unavailable' };
    }
  }
  if (!request.body) return request;
  const declared = Number(request.headers.get('content-length'));
  const tooLarge = () => ({ status: 413, event: 'request_body_too_large', message: 'Request body exceeds 256 KiB' });
  if (Number.isFinite(declared) && declared > MCP_BODY_LIMIT) {
    void request.body.cancel().catch(() => {}); return tooLarge();
  }
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_BODY_LIMIT) { void reader.cancel().catch(() => {}); return tooLarge(); }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    return { status: 400, event: 'request_body_unreadable', message: 'Request body could not be read' };
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers); headers.delete('content-length');
  return new Request(request, { headers, body });
}
