import { createHash, sign } from "node:crypto";
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getDb } from "@/db";
import { fleetDevice, fleetDeviceSession } from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
import { withInjectedPgFault } from "./helpers/pg-fault";

process.env.DATABASE_URL = TEST_URL;
const { PUT } = await import("@/app/api/fleet/v1/participation/route");
const { PUT: acknowledge } = await import("@/app/api/fleet/v1/device/route");
const PATH = "/api/fleet/v1/participation";
const NOW = new Date("2026-09-07T12:00:00Z");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
});
afterEach(() => vi.useRealTimers());
afterAll(() => ctx.cleanup());
function request(
  p: Awaited<ReturnType<typeof pairDevice>>,
  body: unknown,
  revision: number,
  path = PATH,
  query = "",
  key = p.privateKey,
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const hash = createHash("sha256").update(text).digest("hex");
  const issued = new Date().toISOString();
  // Independent literal V1 signing, not the production canonical builder.
  const signature = sign(
    null,
    Buffer.from(
      ["fleet-v1", "PUT", path, p.sessionId, issued, String(revision), hash].join("\n"),
    ),
    key,
  ).toString("base64url");
  return new NextRequest(`https://auth.example${path}${query}`, {
    method: "PUT",
    body: text,
    headers: {
      "x-fleet-session": p.sessionId,
      "x-fleet-issued-at": issued,
      "x-fleet-revision": String(revision),
      "x-fleet-body-sha256": hash,
      "x-fleet-signature": signature,
    },
  });
}
async function enrolled() {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  const ack = await acknowledge(
    request(
      p,
      { protocol: 1, capabilities: [SHARED_CAPABILITY] },
      1,
      "/api/fleet/v1/device",
    ),
  );
  expect(ack.status).toBe(200);
  vi.setSystemTime(new Date(NOW.getTime() + 500));
  return p;
}

describe("real signed participation PUT", () => {
  it("requires real acknowledgment, returns only participation, and rejects stale generations without consuming revision", async () => {
    const p = await enrolled();
    const on = await PUT(
      request(p, { protocol: 1, enabled: true, expected_generation: 0 }, 2),
    );
    expect(on.status).toBe(200);
    expect(on.headers.get("cache-control")).toBe("no-store");
    expect(await on.json()).toEqual({
      protocol: 1,
      participation: { enabled: true, generation: 1 },
    });
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const stale = await PUT(
      request(p, { protocol: 1, enabled: false, expected_generation: 0 }, 3),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ protocol: 1, error: "conflict" });
    const off = await PUT(
      request(p, { protocol: 1, enabled: false, expected_generation: 1 }, 3),
    );
    expect(await off.json()).toEqual({
      protocol: 1,
      participation: { enabled: false, generation: 2 },
    });
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
  });
  it("rejects unknown/query selectors, malformed, oversized and future-protocol bodies atomically", async () => {
    const p = await enrolled();
    for (const body of [
      { protocol: 1, enabled: true, expected_generation: 0, source_id: "client-chosen" },
      { protocol: 1, enabled: true, expected_generation: -1 },
      { protocol: 1, enabled: true, expected_generation: 0.1 },
      { protocol: 1, enabled: "yes", expected_generation: 0 },
      { protocol: 1, enabled: true },
      "{",
      " ".repeat(1025),
    ]) {
      const res = await PUT(request(p, body, 2));
      expect(res.status).toBe(400);
    }
    expect(
      (
        await PUT(
          request(
            p,
            { protocol: 1, enabled: true, expected_generation: 0 },
            2,
            PATH,
            "?fleet=123",
          ),
        )
      ).status,
    ).toBe(400);
    const future = await PUT(
      request(p, { protocol: 2, enabled: true, expected_generation: 0 }, 2),
    );
    expect(await future.json()).toEqual({ protocol: 1, error: "update_required" });
    expect((await ctx.db.select().from(fleetDevice))[0].participationGeneration).toBe(0);
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
  });
  it("binds the signed path/body/key and masks database failure without advancing consent", async () => {
    const p = await enrolled();
    const other = await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      NOW,
      [SHARED_CAPABILITY],
    );
    const body = { protocol: 1, enabled: true, expected_generation: 0 };
    expect((await PUT(request(p, body, 2, PATH, "", other.privateKey))).status).toBe(401);
    expect((await PUT(request(p, body, 2, "/api/fleet/v1/device"))).status).toBe(401);
    const res = await withInjectedPgFault(
      getDb().$client,
      { matchSql: /insert into "audit_log"/i, code: "40001" },
      () => PUT(request(p, body, 2)),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ protocol: 1, error: "service_unavailable" });
    expect(
      (await ctx.db.select().from(fleetDeviceSession)).every((s) => s.lastRevision <= 1),
    ).toBe(true);
  });
});
