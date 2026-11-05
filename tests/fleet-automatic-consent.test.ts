import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  fleetAutomaticConsent,
  fleetDeviceSession,
  fleetSourceAuthority,
  fleetSourceIntent,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  bindPendingFleet,
  claimFleetSourceFetch,
  commitFleetSourceObservation,
  maintainFleetSource,
} from "@/services/fleet-source-observation";
import { controlFleetAutomatic, readFleetAutomatic } from "@/services/fleet-automatic";
import { invalidateTokenIfUnchanged } from "@/services/tokens";
import { readDeviceEligibility } from "@/services/fleet-eligibility";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { sharedAccounts } from "./helpers/fleet-shared-admission";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

/** Explicit automatic source fixture, not discovery acceptance. All claim/bind/
 * commit calls below are the existing real transaction owner. */
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
  await ctx.db.insert(fleetAutomaticConsent).values({
    accountId: owner.id,
    generation: 1,
    revision: 1,
    enabled: true,
    approvingDeviceId: p.device.id,
    approvedAt: NOW,
    nextReconcileAt: NOW,
  });
  const [source] = await ctx.db
    .insert(fleetSourceIntent)
    .values({
      id: randomUUID(),
      accountId: owner.id,
      deviceId: p.device.id,
      bossCharacterId: boss.id,
      bossOwnerHash: boss.ownerHash,
      bossLinkEpoch: boss.fleetLinkEpoch,
      generation: 1,
      state: "active",
      activatedAt: NOW,
      intentCreatedAt: NOW,
      intentExpiresAt: at(60000),
      retainUntil: at(86460000),
      nextFetchAt: NOW,
      fleetId: 123,
      automaticConsentAccountId: owner.id,
      automaticConsentGeneration: 1,
    })
    .returning();
  return { ...p, owner, boss, source };
}

it.each(["absent", "disabled", "generation", "approver"] as const)(
  "automatic source claim refuses current consent %s without using initiating session",
  async (loss) => {
    const p = await setup();
    if (loss === "absent") await ctx.db.delete(fleetAutomaticConsent);
    if (loss === "disabled")
      await ctx.db.update(fleetAutomaticConsent).set({
        enabled: false,
        revision: 2,
        disabledAt: at(500),
        closedReason: "explicit_off",
      });
    if (loss === "generation")
      await ctx.db.update(fleetAutomaticConsent).set({ generation: 2, revision: 2 });
    if (loss === "approver")
      await ctx.db.update(fleetAutomaticConsent).set({ approvingDeviceId: randomUUID() });
    const ticket = await claimFleetSourceFetch(
      ctx.db,
      { sourceId: p.source.id, generation: 1 },
      () => at(1000),
    );
    expect(ticket === null).toBe(true);
    const [source] = await ctx.db.select().from(fleetSourceIntent);
    expect(source.state).toBe("ended");
    expect(source.generation).toBe(2);
  },
);

it("retained grant loss reports authorization required, not a never-authorized wait", async () => {
  const p = await setup();
  expect(
    await invalidateTokenIfUnchanged(ctx.db, p.boss.id, p.boss.refreshTokenEnc!, {
      action: "test.token_invalid",
    }),
  ).toBe(true);
  expect(
    await readFleetAutomatic(ctx.db, {
      sessionId: p.sessionId,
      revision: 1,
      now: at(1000),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      status: {
        readiness: "authorization_required",
        recovery_action: "authorize_fleet_read",
        consent: { enabled: true },
      },
    },
  });
});

it("current automatic approval survives removal of every initiating fleet session", async () => {
  const p = await setup();
  await ctx.db.delete(fleetDeviceSession);
  const ticket = await claimFleetSourceFetch(
    ctx.db,
    { sourceId: p.source.id, generation: 1 },
    () => at(1000),
  );
  expect(ticket !== null).toBe(true);
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
});

it.each(["bind", "commit"] as const)(
  "automatic %s postflight rechecks current enabled approval",
  async (stage) => {
    const p = await setup();
    const claim = await claimFleetSourceFetch(
      ctx.db,
      { sourceId: p.source.id, generation: 1 },
      () => at(1000),
    );
    expect(claim !== null).toBe(true);
    const token = { ...claim!, accessTokenExpiresAt: at(3600000) };
    const bound =
      stage === "commit"
        ? await bindPendingFleet(ctx.db, token, 123, p.boss.refreshTokenEnc!, () =>
            at(1000),
          )
        : null;
    await ctx.db.update(fleetAutomaticConsent).set({
      enabled: false,
      revision: 2,
      disabledAt: at(1500),
      closedReason: "explicit_off",
    });
    if (stage === "bind") {
      expect(
        (await bindPendingFleet(ctx.db, token, 123, p.boss.refreshTokenEnc!, () =>
          at(2000),
        )) === null,
      ).toBe(true);
    } else {
      expect(bound !== null).toBe(true);
      await commitFleetSourceObservation(
        ctx.db,
        bound!,
        p.boss.refreshTokenEnc!,
        {
          kind: "verified",
          memberIds: [p.boss.id],
          evidence: { observedAt: at(1000), expiresAt: at(11000), nextFetchAt: at(6000) },
          nextFetchAt: at(6000),
        },
        () => at(2000),
      );
    }
    expect(
      (await ctx.db.select().from(fleetSourceAuthority)).every(
        (a) => a.sourceId === null,
      ),
    ).toBe(true);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, p.source.id))
      )[0].state,
    ).toBe("ended");
  },
);

it("relay admission rejects withdrawn automatic approval over otherwise worker-verified evidence", async () => {
  const p = await sharedAccounts(ctx.db);
  // Only attach explicit immutable provenance to the test source. Authority was
  // produced by the real worker/JWT/provider stub, never seeded as positive proof.
  await ctx.db.insert(fleetAutomaticConsent).values({
    accountId: p.owner.id,
    generation: 1,
    revision: 2,
    enabled: false,
    approvingDeviceId: p.a.device.id,
    approvedAt: NOW,
    disabledAt: at(2500),
    closedReason: "explicit_off",
    nextReconcileAt: NOW,
  });
  await ctx.db
    .update(fleetSourceIntent)
    .set({
      automaticConsentAccountId: p.owner.id,
      automaticConsentGeneration: 1,
      retainUntil: at(86460000),
    })
    .where(eq(fleetSourceIntent.id, p.source.sourceId));
  const reply = await readDeviceEligibility(ctx.db, {
    sessionId: p.b.sessionId,
    revision: 3,
    now: at(3000),
  });
  expect(reply).toMatchObject({ ok: true, value: { characters: [] } });
});

it.each(["audit_log", "fleet_automatic_receipt"])(
  "Off rolls back %s failure after withdrawal, then fences a bound late callback without stopping OR-selected manual sources",
  async (table) => {
    const p = await sharedAccounts(ctx.db);
    const on = {
      protocol: 2 as const,
      request_id: randomUUID(),
      intent_created_at: at(3000).toISOString(),
      enabled: true,
      expected_generation: 0,
      expected_revision: 0,
    };
    expect(
      (
        await controlFleetAutomatic(
          ctx.db,
          { sessionId: p.a.sessionId, revision: 4, now: at(3000) },
          on,
        )
      ).ok,
    ).toBe(true);
    await ctx.db
      .update(fleetSourceIntent)
      .set({
        automaticConsentAccountId: p.owner.id,
        automaticConsentGeneration: 1,
        retainUntil: at(86460000),
      })
      .where(eq(fleetSourceIntent.id, p.source.sourceId));
    const [original] = await ctx.db.select().from(fleetSourceIntent);
    const [manual] = await ctx.db
      .insert(fleetSourceIntent)
      .values({
        ...original,
        id: randomUUID(),
        fleetId: 456,
        automaticConsentAccountId: null,
        automaticConsentGeneration: null,
      })
      .returning();
    const claim = await claimFleetSourceFetch(
      ctx.db,
      { sourceId: original.id, generation: 1 },
      () => at(8000),
    );
    expect(claim !== null).toBe(true);
    const bound = await bindPendingFleet(
      ctx.db,
      { ...claim!, accessTokenExpiresAt: at(3600000) },
      123,
      claim!.boss.refreshTokenEnc!,
      () => at(8000),
    );
    expect(bound !== null).toBe(true);
    const off = {
      ...on,
      request_id: randomUUID(),
      enabled: false,
      expected_generation: 1,
      expected_revision: 1,
    };
    const call = { sessionId: p.a.sessionId, revision: 5, now: at(9000) };
    const beforeSources = await ctx.db.select().from(fleetSourceIntent);
    const beforeAuthority = await ctx.db.select().from(fleetSourceAuthority);
    expect(
      await withInjectedPgFault(
        ctx.pool,
        { matchSql: new RegExp('insert into "' + table + '"', "i"), code: "40001" },
        () => controlFleetAutomatic(ctx.db, call, off),
      ),
    ).toEqual({ ok: false, code: "service_unavailable" });
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(beforeSources);
    expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(beforeAuthority);
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
    expect(await controlFleetAutomatic(ctx.db, call, off)).toMatchObject({
      ok: true,
      value: { status: { consent: { enabled: false }, sources: [] } },
    });
    await commitFleetSourceObservation(
      ctx.db,
      bound!,
      bound!.boss.refreshTokenEnc!,
      {
        kind: "verified",
        memberIds: [p.boss.id, p.alts[0].id],
        evidence: { observedAt: at(8000), expiresAt: at(18000), nextFetchAt: at(13000) },
        nextFetchAt: at(13000),
      },
      () => at(10000),
    );
    p.source.setNow(10000);
    await p.source.run();
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, manual.id))
      )[0],
    ).toEqual(manual);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, original.id))
      )[0],
    ).toMatchObject({ state: "ended", generation: 2, fetchClaimExpiresAt: null });
  },
);

it("positive authority acquisition reserves its final int4 invalidation slot", async () => {
  const p = await setup();
  await ctx.db
    .insert(fleetSourceAuthority)
    .values({ fleetId: 123, authorityGeneration: 2147483646 });
  const claim = await claimFleetSourceFetch(
    ctx.db,
    { sourceId: p.source.id, generation: 1 },
    () => at(1000),
  );
  expect(claim !== null).toBe(true);
  const bound = await bindPendingFleet(
    ctx.db,
    { ...claim!, accessTokenExpiresAt: at(3600000) },
    123,
    p.boss.refreshTokenEnc!,
    () => at(1000),
  );
  expect(bound !== null).toBe(true);
  await commitFleetSourceObservation(
    ctx.db,
    bound!,
    p.boss.refreshTokenEnc!,
    {
      kind: "verified",
      memberIds: [p.boss.id],
      evidence: { observedAt: at(1000), expiresAt: at(11000), nextFetchAt: at(6000) },
      nextFetchAt: at(6000),
    },
    () => at(2000),
  );
  expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
    sourceId: null,
    authorityGeneration: 2147483646,
  });
  expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("ended");
});
it("expired final fetch claim terminalizes rather than consuming reserve on a paused source", async () => {
  const p = await setup();
  await ctx.db
    .update(fleetSourceIntent)
    .set({ fetchGeneration: 2147483646, fetchClaimExpiresAt: at(1000) });
  expect(await maintainFleetSource(ctx.db, p.source.id, true, () => at(1000))).toBe(0);
  expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
    state: "ended",
    fetchGeneration: 2147483647,
  });
});
it("fetch admission reserves the last int4 increment for terminal invalidation", async () => {
  const p = await setup();
  await ctx.db.update(fleetSourceIntent).set({ fetchGeneration: 2147483646 });
  const ticket = await claimFleetSourceFetch(
    ctx.db,
    { sourceId: p.source.id, generation: 1 },
    () => at(1000),
  );
  expect(ticket === null).toBe(true);
  expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
    state: "ended",
    fetchGeneration: 2147483647,
  });
});
