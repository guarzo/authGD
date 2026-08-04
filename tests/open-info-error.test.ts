import { describe, expect, it } from "vitest";
import { classifyOpenInfoFailure } from "@/core/open-info-error";
import { EsiError } from "@/lib/esi/client";

/** Shaped exactly like the client's own throw site: the body's `error` string
 *  is appended to the message, which is the only place ESI's words survive. */
function esiError(
  status: number,
  kind: "needs_reauth" | "permanent" | "transient",
  body?: string,
) {
  return new EsiError(
    `ESI POST /ui/openwindow/information/ failed (${status}${body ? `: ${body}` : ""})`,
    status,
    kind,
  );
}

describe("classifyOpenInfoFailure", () => {
  it("calls it offline only when ESI's own body says the character is not online", () => {
    expect(
      classifyOpenInfoFailure(esiError(403, "permanent", "Character not online")),
    ).toBe("offline");
  });

  it("does NOT call a bare 403 offline", () => {
    // The official Swagger defines no status meaning "not logged in", so a 403
    // with no such body is exactly the case we must not describe confidently.
    expect(classifyOpenInfoFailure(esiError(403, "permanent"))).toBe("failed");
  });

  it("maps a missing-scope 403 to reauth, not offline", () => {
    expect(
      classifyOpenInfoFailure(esiError(403, "needs_reauth", "insufficient scope")),
    ).toBe("reauth");
  });

  it("maps rate limiting to busy", () => {
    expect(classifyOpenInfoFailure(esiError(420, "transient"))).toBe("busy");
    expect(classifyOpenInfoFailure(esiError(429, "transient"))).toBe("busy");
  });

  it("maps a 5xx to the honest catch-all rather than to offline", () => {
    expect(
      classifyOpenInfoFailure(esiError(503, "transient", "Service unavailable")),
    ).toBe("failed");
  });

  it("maps the client's 30s AbortSignal.timeout rejection to timeout", () => {
    // AbortSignal.timeout rejects with a DOMException, NOT an EsiError. Before
    // this branch existed it escaped the action entirely as a raw 500.
    const err = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    expect(classifyOpenInfoFailure(err)).toBe("timeout");
  });

  it("returns null for anything it cannot describe, so the caller rethrows", () => {
    expect(classifyOpenInfoFailure(new TypeError("fetch failed"))).toBeNull();
    expect(classifyOpenInfoFailure("nope")).toBeNull();
  });
});
