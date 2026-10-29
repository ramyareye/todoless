// Bound actual bytes before JSON parsing, including chunked requests and a
// misleading Content-Length. Never log the body or wait for a rejected stream.
export async function boundedBody(request: Request, maximum: number): Promise<Request | 400 | 413> {
  if (!request.body) return request;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    void request.body.cancel().catch(() => {});
    return 413;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => {});
        return 413;
      }
      chunks.push(value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    return 400;
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request, { headers, body });
}
