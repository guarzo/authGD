/**
 * Reads an incoming request body up to `maxBytes`, in two layered checks,
 * shared by every fleet-v1 route (`pairing-requests`, its `.../complete`
 * sibling, `catalogue`, `session`, `snapshot`) rather than each duplicating
 * its own `req.arrayBuffer()` + `byteLength` check. That per-route check ran
 * only AFTER `arrayBuffer()` had already buffered the ENTIRE body into
 * memory — the repo configures no smaller request boundary in front of these
 * routes, so a chunked request (no `Content-Length` header, or one that
 * understates the real body) could allocate arbitrarily far past the
 * route's own bound before that check ever ran.
 *
 * Layer one rejects outright on a declared `Content-Length` already over
 * `maxBytes`, with no read of the body at all. Layer two — the one that
 * actually bounds a request with no (or an understated) `Content-Length` —
 * consumes `req.body` incrementally and cancels the stream, never finishing
 * the buffer, the moment the accumulated byte count crosses `maxBytes`.
 *
 * Returns the exact accepted bytes on success, unmodified and unre-encoded:
 * a fleet-v1 route either verifies a signature over these exact wire bytes
 * (`authenticateFleetRequest`) or `JSON.parse`s them, and either one needs
 * the bytes untouched.
 *
 * Takes a minimal, structurally-typed `{ headers, body }` shape rather than
 * `NextRequest` itself: every real caller passes a live `NextRequest`, which
 * satisfies this trivially, and the looser shape is what lets the unit tests
 * in `tests/fleet-request-body.test.ts` construct a bare `{ headers, body }`
 * object with a synthetic `ReadableStream` — the only way to control
 * exactly what the stream yields and when, which a real request body does
 * not let a test observe.
 */
export async function readBoundedRequestBody(
  req: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false };
    }
  }

  // A request carrying no body at all (every signed GET, and a PUT/POST a
  // caller sent with none) resolves this stream to `null` rather than an
  // empty stream — the same "zero bytes" outcome `arrayBuffer()` gave those
  // requests before.
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop reading immediately rather than draining the rest of the
        // stream — the whole point of reading incrementally instead of
        // `arrayBuffer()`ing first.
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
