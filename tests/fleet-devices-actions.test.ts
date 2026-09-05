import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fleetDevice, fleetDeviceSession } from "@/db/schema";
import { setupTestDb, TEST_URL } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

/**
 * `revokeFleetDeviceAction` end to end, against a REAL test database rather
 * than a fully mocked one — the thing this action's whole reason to exist
 * hinges on is its ownership pre-check (`services/fleet-pairing.ts`'s
 * `revokeFleetDevice` carries none of its own), and that check IS a
 * database query, not a pure branch a mock could stand in for cheaply.
 * Route modules read `getDb()`/`getConfig()` lazily, so `DATABASE_URL` is set
 * before the action module is ever imported — mirroring
 * `tests/fleet-routes.test.ts`'s identical need to point the app's own
 * `getDb()` singleton at the same database a `setupTestDb()` context uses.
 *
 * `next/headers` and `@/services/session` are mocked so the action reaches
 * its own body at all (real cookie/session plumbing needs a live HTTP
 * request, matching every other `*-actions-validation.test.ts` file's
 * reasoning) — `sessionAccountId` is a mutable closure variable rather than a
 * fixed literal because each test seeds its OWN account and must present
 * that exact account as the signed-in caller.
 *
 * `next/navigation`'s `redirect` is mocked to throw a recognizable error
 * instead of Next's own control-flow throw, the same
 * `actions-guard-before-validation.test.ts` precedent — this action redirects
 * on every path (success and refusal alike), so there is no path that could
 * be asserted on without this.
 *
 * `next/cache`'s `revalidatePath` is mocked because it throws outside a real
 * Next.js request scope ("Invariant: static generation store missing") — see
 * `fleet-pair-actions-validation.test.ts`'s identical note.
 */
process.env.DATABASE_URL = TEST_URL;

let sessionAccountId = "";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "session-id" }) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected:${url}`);
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
vi.mock("@/services/session", () => ({
  getSessionAccount: async () => ({ accountId: sessionAccountId }),
}));

const { revokeFleetDeviceAction } = await import("@/app/account/fleet-devices/actions");
const { getDb } = await import("@/db");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(async () => {
  await ctx.cleanup();
});

/** A bare device+session pair, with no real pairing/crypto behind it — this
 *  action's own logic never reads the key material, only `fleetDevice.id`/
 *  `accountId`/`revokedAt`. */
async function seedDevice(accountId: string, opts: { revokedAt?: Date } = {}) {
  const [device] = await ctx.db
    .insert(fleetDevice)
    .values({
      accountId,
      publicKeySpkiB64: `fake-spki-${randomUUID()}`,
      revokedAt: opts.revokedAt ?? null,
    })
    .returning();
  await ctx.db.insert(fleetDeviceSession).values({
    id: `fake-session-${randomUUID()}`,
    deviceId: device.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return device;
}

describe("revokeFleetDeviceAction", () => {
  it("revokes the caller's own device and redirects to the confirmation", async () => {
    const acc = await seedAccount(getDb(), { tier: "member" });
    const device = await seedDevice(acc.id);
    sessionAccountId = acc.id;

    await expect(revokeFleetDeviceAction(device.id)).rejects.toThrow(
      /^redirected:\/account\/fleet-devices\?done=revoke&at=\d+$/,
    );

    const [revoked] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.id, device.id));
    expect(revoked.revokedAt).not.toBeNull();
    expect(
      await ctx.db
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.deviceId, device.id)),
    ).toHaveLength(0);
  });

  it("refuses to revoke a device belonging to a DIFFERENT account, and mutates nothing", async () => {
    const owner = await seedAccount(getDb(), { tier: "member" });
    const attacker = await seedAccount(getDb(), { tier: "member" });
    const device = await seedDevice(owner.id);
    sessionAccountId = attacker.id;

    await expect(revokeFleetDeviceAction(device.id)).rejects.toThrow(
      "redirected:/account/fleet-devices?error=stale_device",
    );

    const [unchanged] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.id, device.id));
    expect(unchanged.revokedAt).toBeNull();
    expect(
      await ctx.db
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.deviceId, device.id)),
    ).toHaveLength(1);
  });

  it("treats an already-revoked device as stale rather than revoking it again", async () => {
    const acc = await seedAccount(getDb(), { tier: "member" });
    const device = await seedDevice(acc.id, { revokedAt: new Date() });
    sessionAccountId = acc.id;

    await expect(revokeFleetDeviceAction(device.id)).rejects.toThrow(
      "redirected:/account/fleet-devices?error=stale_device",
    );
  });

  it("refuses an unknown device id the same way as one belonging to someone else", async () => {
    const acc = await seedAccount(getDb(), { tier: "member" });
    sessionAccountId = acc.id;

    await expect(
      revokeFleetDeviceAction("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("redirected:/account/fleet-devices?error=stale_device");
  });
});
