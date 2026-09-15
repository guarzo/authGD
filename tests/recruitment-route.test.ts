import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "./helpers/config";

const { collect, admin } = vi.hoisted(() => ({ collect: vi.fn(), admin: vi.fn() }));
vi.mock("@/config", async (original) => ({
  ...(await original<typeof import("@/config")>()),
  getConfig: () => testConfig({ APP_BASE_URL: "https://auth.example" }),
}));
vi.mock("@/db", () => ({
  getDb: () => ({
    transaction: async (
      work: (tx: { execute: () => Promise<void> }) => Promise<unknown>,
    ) => work({ execute: async () => {} }),
  }),
}));
vi.mock("@/lib/admin-guard", () => ({ resolveAdmin: admin }));
vi.mock("@/services/recruitment", async (original) => ({
  ...(await original<typeof import("@/services/recruitment")>()),
  collectRecruitmentEvidence: collect,
}));
const { POST } = await import("@/app/admin/accounts/[id]/recruitment/route");
const { RecruitmentCollectionError } = await import("@/services/recruitment");
const id = "12345678-1234-4234-8234-123456789012";
const snapshot = {
  format: "authgd-recruitment-evidence",
  version: 1,
  accountId: id,
  manifest: { bundleId: "snapshot-1", datasets: [] },
  records: [],
};
function request(origin: string | null = "https://auth.example") {
  const req = new NextRequest(`https://auth.example/admin/accounts/${id}/recruitment`, {
    method: "POST",
    headers: origin ? { origin } : {},
  });
  req.cookies.set("authgd_session", "session-id");
  return req;
}
const ctx = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.clearAllMocks();
  admin.mockResolvedValue({ ok: true, ctx: { accountId: "actor" } });
  collect.mockResolvedValue(snapshot);
});

describe("recruitment download route", () => {
  it("returns an uncached JSON attachment and server-resolved actor context", async () => {
    const res = await POST(request(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="recruitment-${id}.json"`,
    );
    expect(await res.json()).toEqual(snapshot);
    expect(collect.mock.calls[0][2]).toEqual({
      actorAccountId: "actor",
      sessionId: "session-id",
      targetAccountId: id,
    });
  });
  it.each([null, "https://evil.example"])(
    "rejects missing or foreign Origin (%s)",
    async (origin) => {
      const res = await POST(request(origin), ctx);
      expect(res.status).toBe(403);
      expect(collect).not.toHaveBeenCalled();
    },
  );
  it.each(["cross-site", "same-site", "none"])(
    "rejects a matching Origin with Sec-Fetch-Site %s",
    async (site) => {
      const req = request();
      req.headers.set("sec-fetch-site", site);
      const res = await POST(req, ctx);
      expect(res.status).toBe(403);
      expect(collect).not.toHaveBeenCalled();
    },
  );
  it("does not collect without the session cookie, even if admin resolution succeeds", async () => {
    const req = request();
    req.cookies.delete("authgd_session");
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(collect).not.toHaveBeenCalled();
  });
  it("does not collect for a non-admin", async () => {
    admin.mockResolvedValue({ ok: false, reason: "not-admin" });
    const res = await POST(request(), ctx);
    expect(res.status).toBe(403);
    expect(collect).not.toHaveBeenCalled();
  });
  it("rejects invalid account IDs before collection", async () => {
    const res = await POST(request(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });
  it("returns a conflict, not evidence, on a changed ownership binding", async () => {
    collect.mockRejectedValue(new RecruitmentCollectionError("identity_changed"));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "identity_changed" });
    expect(res.headers.get("content-disposition")).toBeNull();
  });
  it("does not expose upstream error details", async () => {
    collect.mockRejectedValue(new Error("access_token=secret-sentinel"));
    const res = await POST(request(), ctx);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"collection_failed"}');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
