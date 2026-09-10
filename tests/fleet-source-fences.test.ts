import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { fleetSourceAuthority, fleetSourceIntent } from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { controlFleetSource } from "@/services/fleet-source";
import {
  bindPendingFleet,
  claimFleetSourceFetch,
  commitFleetSourceObservation,
} from "@/services/fleet-source-observation";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
const NOW = new Date("2026-09-07T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
/** TRANSACTION-FENCE fixtures only. Direct observations here isolate independent
 * guards for mutation testing; they are NOT worker/provider/integration proof. */
async function setup() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const p = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: NOW,
    capabilities: [SHARED_CAPABILITY],
  });
  let revision = 1;
  const start = async () => {
    const sourceId = randomUUID();
    expect(
      (
        await controlFleetSource(ctx.db, {
          sessionId: p.sessionId,
          revision: ++revision,
          now: at(revision * 500),
          command: {
            operation: "start",
            sourceId,
            expectedGeneration: 0,
            characterId: boss.id,
            characterLinkEpoch: boss.fleetLinkEpoch,
            intentCreatedAt: NOW,
          },
        })
      ).ok,
    ).toBe(true);
    return sourceId;
  };
  const id = await start();
  const claim = async (sourceId: string, ms = 1000) => {
    const ticket = await claimFleetSourceFetch(ctx.db, { sourceId, generation: 1 }, () =>
      at(ms),
    );
    expect(ticket).not.toBeNull();
    const bound = await bindPendingFleet(
      ctx.db,
      { ...ticket!, accessTokenExpiresAt: at(3600000) },
      123,
      boss.refreshTokenEnc!,
      () => at(ms),
    );
    expect(bound).not.toBeNull();
    return bound!;
  };
  const success = (ms: number) => ({
    kind: "verified" as const,
    evidence: {
      observedAt: at(ms),
      expiresAt: at(ms + 10000),
      nextFetchAt: at(ms + 5000),
    },
    memberIds: [boss.id],
    nextFetchAt: at(ms + 5000),
  });
  return { id, boss, start, claim, success };
}
it.each([null, new Date(NaN)])(
  "terminal commit rejects missing/nonfinite verified expiry %s independently of database consent",
  async (accessTokenExpiresAt) => {
    const p = await setup();
    const ticket = await p.claim(p.id);
    await commitFleetSourceObservation(
      ctx.db,
      { ...ticket, accessTokenExpiresAt },
      p.boss.refreshTokenEnc!,
      {
        kind: "failure",
        reason: "service_unavailable",
        terminal: "identity_changed",
        nextFetchAt: at(6000),
      },
      () => at(1000),
    );
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "paused",
      generation: 1,
      terminalReason: null,
    });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
  },
);
it("an unexpired claim prevents duplicate source fetch admission", async () => {
  const p = await setup();
  await p.claim(p.id);
  const duplicate = await claimFleetSourceFetch(
    ctx.db,
    { sourceId: p.id, generation: 1 },
    () => at(2000),
  );
  // Never dump a private ticket/credential in an assertion failure.
  expect(duplicate === null).toBe(true);
  expect((await ctx.db.select().from(fleetSourceIntent))[0].fetchGeneration).toBe(1);
});
it("newer claim/failure fences older success even when claim-deadline timestamps happen to agree", async () => {
  const p = await setup();
  const old = await p.claim(p.id);
  // Test-only lease expiry normalization isolates fetch order from deadline
  // inequality. The real scheduler/restart test separately covers clock expiry.
  await ctx.db
    .update(fleetSourceIntent)
    .set({ fetchClaimExpiresAt: at(1000) })
    .where(eq(fleetSourceIntent.id, p.id));
  const newer = await p.claim(p.id);
  expect(newer.claimExpiresAt).toEqual(old.claimExpiresAt);
  await commitFleetSourceObservation(
    ctx.db,
    old,
    p.boss.refreshTokenEnc!,
    p.success(1000),
    () => at(1000),
  );
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
  await commitFleetSourceObservation(
    ctx.db,
    newer,
    p.boss.refreshTokenEnc!,
    { kind: "failure", reason: "service_unavailable", nextFetchAt: at(6000) },
    () => at(1000),
  );
  await commitFleetSourceObservation(
    ctx.db,
    old,
    p.boss.refreshTokenEnc!,
    p.success(1000),
    () => at(1000),
  );
  expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
});
it("an equal/older cached candidate cannot displace usable authority merely by arriving later", async () => {
  const p = await setup();
  await commitFleetSourceObservation(
    ctx.db,
    await p.claim(p.id),
    p.boss.refreshTokenEnc!,
    p.success(1000),
    () => at(1000),
  );
  const candidateId = await p.start();
  const candidate = await p.claim(candidateId, 2000);
  await commitFleetSourceObservation(
    ctx.db,
    candidate,
    p.boss.refreshTokenEnc!,
    p.success(0),
    () => at(2000),
  );
  expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
    sourceId: p.id,
    verifiedAt: at(1000),
  });
  expect(
    (
      await ctx.db.select().from(fleetSourceIntent).where(eq(fleetSourceIntent.id, p.id))
    )[0].state,
  ).toBe("active");
});
