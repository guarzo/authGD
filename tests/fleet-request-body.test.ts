import { describe, expect, it } from "vitest";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";

/**
 * `readBoundedRequestBody` in isolation, against synthetic
 * `{ headers, body }` shapes rather than a real `NextRequest` — the two
 * defenses it layers (a declared `Content-Length` rejected before any read,
 * and an incremental abort once the accumulated stream bytes cross the
 * bound) are each provable only by controlling exactly what the stream
 * yields and when, which a real request body does not let a test observe.
 * `tests/fleet-routes.test.ts` covers the same helper wired into each real
 * route, including the existing `Content-Length`-bearing oversize cases
 * those routes already asserted before this helper existed.
 */
describe("readBoundedRequestBody", () => {
  it("rejects on Content-Length alone, without ever touching the body stream", async () => {
    const req = {
      headers: new Headers({ "content-length": "999999" }),
      body: {
        getReader() {
          throw new Error(
            "must not read the body stream when Content-Length already exceeds the bound",
          );
        },
      } as unknown as ReadableStream<Uint8Array>,
    };
    await expect(readBoundedRequestBody(req, 100)).resolves.toEqual({ ok: false });
  });

  it("returns empty bytes for a request with no body at all (a signed GET)", async () => {
    const req = { headers: new Headers(), body: null };
    await expect(readBoundedRequestBody(req, 100)).resolves.toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
  });

  it("reassembles the exact bytes across a multi-chunk stream under the bound", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello "));
        controller.enqueue(encoder.encode("world"));
        controller.close();
      },
    });
    const req = { headers: new Headers(), body: stream };
    const result = await readBoundedRequestBody(req, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextDecoder().decode(result.bytes)).toBe("hello world");
    }
  });

  it("aborts on the chunk that first pushes the running total over the bound, without ever being pulled again", async () => {
    let pulls = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 2) {
          // A third pull would mean the reader kept consuming the stream
          // after it should already have aborted — fail loudly rather than
          // let a silently-passing (or hanging) test hide the regression.
          controller.error(new Error("pulled again after the bound was crossed"));
          return;
        }
        controller.enqueue(encoder.encode("x".repeat(40)));
      },
    });
    const req = { headers: new Headers(), body: stream };
    // Two 40-byte chunks (80 total) cross a 50-byte bound on the second.
    await expect(readBoundedRequestBody(req, 50)).resolves.toEqual({ ok: false });
    expect(pulls).toBe(2);
  });

  it("rejects a body whose Content-Length understates the real stream, via the incremental abort rather than the header check", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(200)));
        controller.close();
      },
    });
    const req = {
      headers: new Headers({ "content-length": "10" }), // lies: real body is 200 bytes
      body: stream,
    };
    await expect(readBoundedRequestBody(req, 100)).resolves.toEqual({ ok: false });
  });
});
