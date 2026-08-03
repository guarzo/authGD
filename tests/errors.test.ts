import { describe, expect, it } from "vitest";
import { classifyEsiError, classifyOAuthError } from "@/core/errors";

describe("classifyOAuthError", () => {
  it("marks invalid_grant permanent", () => {
    expect(classifyOAuthError("invalid_grant", 400)).toBe("permanent");
  });
  it("keeps temporarily_unavailable/server_error transient even at 400", () => {
    expect(classifyOAuthError("temporarily_unavailable", 400)).toBe("transient");
    expect(classifyOAuthError("server_error", 400)).toBe("transient");
  });
  it("marks unknown 400-error bodies permanent", () => {
    expect(classifyOAuthError("weird_new_error", 400)).toBe("permanent");
  });
  it("marks rate limiting transient", () => {
    expect(classifyOAuthError(undefined, 429)).toBe("transient");
  });
  it("marks server errors transient", () => {
    expect(classifyOAuthError(undefined, 502)).toBe("transient");
  });
  it("marks network failure (no status) transient", () => {
    expect(classifyOAuthError(undefined, undefined)).toBe("transient");
  });
});

describe("classifyEsiError", () => {
  it("maps 403 missing-scope to needs_reauth", () => {
    expect(
      classifyEsiError(403, { error: "token is not valid for scope" }),
    ).toBe("needs_reauth");
  });
  it("maps other 403 to permanent", () => {
    expect(classifyEsiError(403, { error: "forbidden" })).toBe("permanent");
  });
  it.each([
    [400, "permanent"],
    [404, "permanent"],
    [420, "transient"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
  ])("status %d → %s", (status, expected) => {
    expect(classifyEsiError(status)).toBe(expected);
  });
});
