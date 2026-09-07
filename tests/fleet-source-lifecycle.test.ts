import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  account,
  auditLog,
  character,
  fleetEligibility,
  fleetPairingRequest,
  fleetPublisherLease,
  fleetTelemetryRow,
  fleetSourceIntent,
  fleetSourceAuthority,
  fleetDevice,
  fleetDeviceSession,
  fleetDeviceKeyIdentity,
} from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { getFreshAccessToken, invalidateTokenIfUnchanged } from "@/services/tokens";
import {
  setTierManual,
  returnTierToAuto,
  setAccountStatus,
} from "@/services/admin-accounts";
import { applyTierTransition } from "@/jobs/membership";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
  fleetKeyPair,
} from "./helpers/fleet-sharing";
import {
  seedLifecycleProjection,
  seedLifecycleSource,
} from "./helpers/fleet-source-lifecycle";
import { withInjectedPgFault } from "./helpers/pg-fault";
import {
  fleetLifecycleTransaction,
  lockFleetAuthoritySlots,
  lockFleetSourceIntents,
  purgeExpiredFleetSourceIntents,
  FLEET_AUTHORITY_LOCK_CLASS,
  FLEET_SOURCE_LOCK_CLASS,
  FLEET_SOURCE_INTENT_TTL_MS,
} from "@/services/fleet-lifecycle";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { beginFleetRecovery, completeFleetRecovery } from "@/services/fleet-recovery";
import { recoveryInitiation, recoveryCompletion } from "./helpers/fleet-recovery";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { setFleetParticipation } from "@/services/fleet-participation";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import {
  beginPairing,
  approvePairing,
  renewFleetDeviceSession,
} from "@/services/fleet-pairing";
import { replaceDeviceProjection } from "@/services/fleet-relay";
import {
  handleEveLogin,
  linkCharacter,
  unlinkCharacter,
  reclaimTransferredCharacter,
  setMainCharacter,
  completeFleetReadGrant,
} from "@/services/accounts";
import { createSession } from "@/services/session";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
const cfg = testConfig();
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
const callback = (id: number, ownerHash = `oh-${id}`) => ({
  characterId: id,
  characterName: `Char ${id}`,
  ownerHash,
  refreshToken: "replacement",
  scopes: [...cfg.eveSso.scopes],
});

const NOW = new Date("2026-09-07T12:00:00Z");
async function sourceFixture(
  opts: { main?: boolean; tierLocked?: boolean; shared?: boolean; paused?: boolean } = {},
) {
  if (opts.shared) {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
  }
  const owner = await seedAccount(ctx.db, {
    tier: "member",
    tierLocked: opts.tierLocked,
  });
  const boss = await seedCharacter(ctx.db, cfg, {
    id: 99001,
    accountId: owner.id,
    main: opts.main,
    scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
  });
  const paired = await pairDevice(
    ctx.db,
    owner.id,
    NOW,
    opts.shared ? [SHARED_CAPABILITY] : [],
  );
  let source = await seedLifecycleSource(ctx.db, {
    boss,
    deviceId: paired.device.id,
    now: NOW,
  });
  if (opts.paused) {
    // Lifecycle-only paused fixture; no worker pause/resume implementation.
    await expect(
      ctx.db
        .update(fleetSourceIntent)
        .set({ state: "paused" })
        .where(eq(fleetSourceIntent.id, source.id))
        .returning({ state: fleetSourceIntent.state }),
    ).resolves.toEqual([{ state: "paused" }]);
    [source] = await ctx.db
      .select()
      .from(fleetSourceIntent)
      .where(eq(fleetSourceIntent.id, source.id));
    await ctx.db
      .update(fleetSourceAuthority)
      .set({
        sourceId: null,
        sourceGeneration: null,
        authorityGeneration: 8,
        linkedCharacters: [],
        verifiedAt: null,
        expiresAt: null,
      })
      .where(eq(fleetSourceAuthority.fleetId, source.fleetId!));
  }
  return { owner, boss, paired, source };
}
async function expectEnded(id: string) {
  const [source] = await ctx.db
    .select()
    .from(fleetSourceIntent)
    .where(eq(fleetSourceIntent.id, id));
  expect(source).toMatchObject({
    state: "ended",
    generation: 2,
    fetchGeneration: 1,
    endedAt: expect.any(Date),
    terminalReason: expect.any(String),
  });
  expect(source.retainUntil.getTime()).toBeGreaterThan(source.intentExpiresAt.getTime());
  const [authority] = await ctx.db
    .select()
    .from(fleetSourceAuthority)
    .where(eq(fleetSourceAuthority.fleetId, source.fleetId!));
  expect(authority).toMatchObject({
    sourceId: null,
    sourceGeneration: null,
    authorityGeneration: 8,
    linkedCharacters: [],
    verifiedAt: null,
    expiresAt: null,
  });
}

describe("source grant scope is not participant identity withdrawal", () => {
  async function participantFixture() {
    const p = await sourceFixture({ shared: true });
    const participantOwner = await seedAccount(ctx.db, { tier: "member" });
    const participant = await seedCharacter(ctx.db, cfg, {
      id: 99002,
      accountId: participantOwner.id,
    });
    const device = await pairDevice(ctx.db, participantOwner.id, NOW, [
      SHARED_CAPABILITY,
    ]);
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: device.sessionId,
      revision: 1,
      now: NOW,
      capabilities: [SHARED_CAPABILITY],
    });
    await setFleetParticipation(ctx.db, {
      sessionId: device.sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 500),
      enabled: true,
      expectedGeneration: 0,
    });
    const projection = await seedLifecycleProjection(ctx.db, {
      participant,
      source: p.source,
      deviceId: device.device.id,
      sessionId: device.sessionId,
      now: NOW,
    });
    return { ...p, participantOwner, participant, device, projection };
  }
  it.each(["login", "same-account reauth", "permanent token"])(
    "%s without Fleet Read preserves another boss's participant row AND lease",
    async (entry) => {
      const p = await participantFixture();
      const authority = await ctx.db.select().from(fleetSourceAuthority);
      const beforeDevice = await ctx.db
        .select()
        .from(fleetDevice)
        .where(eq(fleetDevice.id, p.device.device.id));
      if (entry === "login")
        await fleetLifecycleTransaction(ctx.db, (tx) =>
          handleEveLogin(tx, cfg, callback(p.participant.id)),
        );
      else if (entry === "same-account reauth")
        expect(
          await fleetLifecycleTransaction(ctx.db, (tx) =>
            linkCharacter(tx, cfg, p.participantOwner.id, callback(p.participant.id)),
          ),
        ).toEqual({ ok: true });
      else
        expect(
          await invalidateTokenIfUnchanged(
            ctx.db,
            p.participant.id,
            p.participant.refreshTokenEnc!,
            { action: "token.invalidated" },
          ),
        ).toBe(true);
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([p.projection.row]);
      expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([
        p.projection.lease,
      ]);
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([p.source]);
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(authority);
      expect(
        await ctx.db
          .select()
          .from(fleetDevice)
          .where(eq(fleetDevice.id, p.device.device.id)),
      ).toEqual(beforeDevice);
      const [current] = await ctx.db
        .select()
        .from(character)
        .where(eq(character.id, p.participant.id));
      expect(current).toMatchObject({
        id: p.participant.id,
        accountId: p.participant.accountId,
        ownerHash: p.participant.ownerHash,
        fleetLinkEpoch: p.participant.fleetLinkEpoch,
      });
    },
  );
  it("grant-only reauth with no source never locks an unrelated publisher device", async () => {
    const p = await participantFixture();
    // A delete-only fix must not retain broad device/session/relay lock selectors.
    await expect(
      withInjectedPgFault(
        ctx.pool,
        { matchSql: /from "fleet_device".*for update/i, code: "40001" },
        () =>
          fleetLifecycleTransaction(ctx.db, (tx) =>
            handleEveLogin(tx, cfg, callback(p.participant.id)),
          ),
      ),
    ).resolves.toEqual({ accountId: p.participantOwner.id });
  });
  it.each(["unlink", "reclaim", "owner replacement"])(
    "%s still withdraws participant identity without stopping the other boss",
    async (entry) => {
      const p = await participantFixture();
      await seedCharacter(ctx.db, cfg, {
        id: 99003,
        accountId: p.participantOwner.id,
        main: true,
      });
      if (entry === "unlink")
        expect(
          await fleetLifecycleTransaction(ctx.db, (tx) =>
            unlinkCharacter(tx, cfg, p.participantOwner.id, p.participant.id),
          ),
        ).toEqual({ ok: true });
      else if (entry === "reclaim")
        expect(
          await fleetLifecycleTransaction(ctx.db, (tx) =>
            reclaimTransferredCharacter(tx, p.participant.id, {
              accountId: p.participant.accountId,
              ownerHash: p.participant.ownerHash,
            }),
          ),
        ).toEqual({ ok: true });
      else
        expect(
          await fleetLifecycleTransaction(ctx.db, (tx) =>
            linkCharacter(
              tx,
              cfg,
              p.participantOwner.id,
              callback(p.participant.id, "new-owner"),
            ),
          ),
        ).toEqual({ ok: true });
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
      expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([]);
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([p.source]);
    },
  );
  it("own-boss grant loss ends its source and matching provenance but preserves its participation under another boss", async () => {
    const p = await participantFixture();
    await fleetLifecycleTransaction(ctx.db, (tx) =>
      handleEveLogin(tx, cfg, {
        ...callback(p.participant.id),
        scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
      }),
    );
    const [otherBoss] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, p.participant.id));
    const otherSource = await seedLifecycleSource(ctx.db, {
      boss: otherBoss,
      deviceId: p.device.device.id,
      now: NOW,
      fleetId: 456,
    });
    const ownParticipation = await seedLifecycleProjection(ctx.db, {
      participant: p.boss,
      source: otherSource,
      deviceId: p.paired.device.id,
      sessionId: p.paired.sessionId,
      now: NOW,
    });
    await fleetLifecycleTransaction(ctx.db, (tx) =>
      handleEveLogin(tx, cfg, callback(p.boss.id)),
    );
    await expectEnded(p.source.id);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([ownParticipation.row]);
    expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([
      ownParticipation.lease,
    ]);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, otherSource.id))
      )[0],
    ).toEqual(otherSource);
  });
});

describe("paused consent is live intent, not ended consent", () => {
  it.each(["grant", "permanent token", "unlink", "tier", "device", "mode"])(
    "actual %s loss terminates paused consent and clears matching provenance",
    async (entry) => {
      const p = await sourceFixture({ shared: true, paused: true });
      await seedCharacter(ctx.db, cfg, { id: 99002, accountId: p.owner.id, main: true });
      await seedLifecycleProjection(ctx.db, {
        participant: p.boss,
        source: p.source,
        deviceId: p.paired.device.id,
        sessionId: p.paired.sessionId,
        now: NOW,
      });
      if (entry === "grant")
        await fleetLifecycleTransaction(ctx.db, (tx) =>
          handleEveLogin(tx, cfg, callback(p.boss.id)),
        );
      else if (entry === "permanent token")
        await invalidateTokenIfUnchanged(ctx.db, p.boss.id, p.boss.refreshTokenEnc!, {
          action: "token.invalidated",
        });
      else if (entry === "unlink")
        await fleetLifecycleTransaction(ctx.db, (tx) =>
          unlinkCharacter(tx, cfg, p.owner.id, p.boss.id),
        );
      else if (entry === "tier")
        await fleetLifecycleTransaction(ctx.db, (tx) =>
          setTierManual(tx, "system", p.owner.id, "alumni"),
        );
      else if (entry === "device")
        await revokeFleetDevice(ctx.db, p.paired.device.id, p.owner.id, NOW);
      else
        await transitionFleetSharingMode(ctx.db, {
          enabled: false,
          expectedRevision: 3,
          now: NOW,
        });
      await expectEnded(p.source.id);
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
      expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([]);
    },
  );
  it.each(["rotation", "unrelated scopes", "Off"])(
    "%s preserves paused consent without reactivating it",
    async (entry) => {
      const p = await sourceFixture({ shared: true, paused: true });
      const authority = await ctx.db.select().from(fleetSourceAuthority);
      if (entry === "rotation")
        expect(
          (
            await getFreshAccessToken(
              ctx.db,
              cfg,
              p.boss,
              async () =>
                new Response(
                  JSON.stringify({
                    access_token: "synthetic-access",
                    refresh_token: "rotated",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
            )
          ).ok,
        ).toBe(true);
      else if (entry === "unrelated scopes")
        await fleetLifecycleTransaction(ctx.db, (tx) =>
          handleEveLogin(tx, cfg, { ...callback(p.boss.id), scopes: [FLEET_READ_SCOPE] }),
        );
      else {
        await acknowledgeFleetCapabilities(ctx.db, {
          sessionId: p.paired.sessionId,
          revision: 1,
          now: NOW,
          capabilities: [SHARED_CAPABILITY],
        });
        expect(
          (
            await setFleetParticipation(ctx.db, {
              sessionId: p.paired.sessionId,
              revision: 2,
              now: new Date(NOW.getTime() + 500),
              enabled: true,
              expectedGeneration: 0,
            })
          ).ok,
        ).toBe(true);
        expect(
          (
            await setFleetParticipation(ctx.db, {
              sessionId: p.paired.sessionId,
              revision: 3,
              now: new Date(NOW.getTime() + 1000),
              enabled: false,
              expectedGeneration: 1,
            })
          ).ok,
        ).toBe(true);
      }
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([p.source]);
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(authority);
    },
  );
  it("paused rows require complete live identity bindings", async () => {
    const p = await sourceFixture({ paused: true });
    await expect(
      ctx.db
        .update(fleetSourceIntent)
        .set({ bossLinkEpoch: null })
        .where(eq(fleetSourceIntent.id, p.source.id)),
    ).rejects.toThrow();
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toEqual(p.source);
  });
});

describe("source consent contract", () => {
  it("exports the approved 60-second intent TTL, separate from long tombstone retention", async () => {
    expect(FLEET_SOURCE_INTENT_TTL_MS).toBe(60_000);
    const p = await sourceFixture();
    expect(p.source.intentExpiresAt.getTime() - p.source.intentCreatedAt.getTime()).toBe(
      60_000,
    );
    expect(
      p.source.retainUntil.getTime() - p.source.intentExpiresAt.getTime(),
    ).toBeGreaterThan(60_000);
  });
});

describe("source consent termination through real lifecycle writers", () => {
  it("only the winning permanent credential CAS terminates; reauth never revives", async () => {
    const p = await sourceFixture();
    expect(
      await invalidateTokenIfUnchanged(ctx.db, p.boss.id, "old-blob", {
        action: "token.invalidated",
      }),
    ).toBe(false);
    expect((await ctx.db.select().from(fleetSourceIntent))[0].generation).toBe(1);
    expect(
      await invalidateTokenIfUnchanged(ctx.db, p.boss.id, p.boss.refreshTokenEnc!, {
        action: "token.invalidated",
      }),
    ).toBe(true);
    await expectEnded(p.source.id);
    await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, {
        ...callback(p.boss.id),
        scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
      }),
    );
    await expectEnded(p.source.id);
  });
  it("grant-only completion preserves consent on a real superset and cannot remove an existing required grant", async () => {
    const p = await sourceFixture();
    const sid = await createSession(ctx.db, p.owner.id);
    const before = await ctx.db.select().from(fleetSourceIntent);
    expect(
      await fleetLifecycleTransaction(ctx.db, (tx) =>
        completeFleetReadGrant(tx, cfg, p.owner.id, p.boss.id, callback(p.boss.id), sid),
      ),
    ).toEqual({ ok: false, code: "scope_missing" });
    expect(
      await fleetLifecycleTransaction(ctx.db, (tx) =>
        completeFleetReadGrant(
          tx,
          cfg,
          p.owner.id,
          p.boss.id,
          { ...callback(p.boss.id), scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE] },
          sid,
        ),
      ),
    ).toEqual({ ok: true });
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(before);
  });
  it("routine reauth and unrelated scope shortfall preserve usable Fleet Read", async () => {
    const p = await sourceFixture();
    await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, { ...callback(p.boss.id), scopes: [FLEET_READ_SCOPE] }),
    );
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "active",
      generation: 1,
    });
    await ctx.db.transaction((tx) => handleEveLogin(tx, cfg, callback(p.boss.id)));
    await expectEnded(p.source.id);
  });
  it("same-account owner replacement ends the old binding", async () => {
    const p = await sourceFixture();
    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, p.owner.id, {
        ...callback(p.boss.id, "new-owner"),
        scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
      }),
    );
    await expectEnded(p.source.id);
  });
  it("merge preserves the tombstone and does not transfer source consent or device grants", async () => {
    const p = await sourceFixture();
    const target = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 99002, accountId: target.id, main: true });
    expect(
      await ctx.db.transaction((tx) =>
        linkCharacter(tx, cfg, target.id, callback(p.boss.id)),
      ),
    ).toEqual({ ok: true });
    await expectEnded(p.source.id);
    expect(await ctx.db.select().from(account).where(eq(account.id, p.owner.id))).toEqual(
      [],
    );
    expect(await ctx.db.select().from(fleetDevice)).toEqual([]);
    const [boss] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, p.boss.id));
    expect(boss.fleetLinkEpoch).not.toBe(p.boss.fleetLinkEpoch);
  });
  it("cryo, auto unlock and same-tier pin preserve consent; actual manual demotion ends it without revoking devices", async () => {
    const p = await sourceFixture();
    await ctx.db.transaction((tx) => setAccountStatus(tx, "system", p.owner.id, "cryo"));
    await ctx.db.transaction((tx) => setTierManual(tx, "system", p.owner.id, "member"));
    await ctx.db.transaction((tx) => returnTierToAuto(tx, "system", p.owner.id));
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
    await ctx.db.transaction((tx) => setTierManual(tx, "system", p.owner.id, "alumni"));
    await expectEnded(p.source.id);
    expect((await ctx.db.select().from(fleetDevice))[0].revokedAt).toBeNull();
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
  });
  it("membership only ends consent on an applied, unlocked demotion", async () => {
    const p = await sourceFixture({ main: true, tierLocked: true });
    await ctx.db
      .update(character)
      .set({ affiliationCheckedAt: NOW })
      .where(eq(character.id, p.boss.id));
    const input = {
      accountId: p.owner.id,
      mainCharacterId: p.boss.id,
      next: "alumni" as const,
      checkedAt: NOW,
    };
    expect(await applyTierTransition(ctx.db, input)).toBe(false);
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
    await ctx.db.transaction((tx) => returnTierToAuto(tx, "system", p.owner.id));
    expect(await applyTierTransition(ctx.db, input)).toBe(true);
    await expectEnded(p.source.id);
  });
  it("initiating-device revocation ends its source before retiring sessions", async () => {
    const p = await sourceFixture();
    await revokeFleetDevice(ctx.db, p.paired.device.id, p.owner.id, NOW);
    await expectEnded(p.source.id);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
  });
});

describe("source isolation, loss aggregation and rollback", () => {
  it.each([false, true])(
    "no-main loss invalidates other boss sources only on actual Member loss (locked=%s)",
    async (tierLocked) => {
      const p = await sourceFixture({ tierLocked });
      await seedCharacter(ctx.db, cfg, { id: 99002, accountId: p.owner.id, main: true });
      await ctx.db.transaction((tx) => unlinkCharacter(tx, cfg, p.owner.id, 99002));
      if (tierLocked)
        expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
      else await expectEnded(p.source.id);
      expect((await ctx.db.select().from(account))[0]).toMatchObject({
        mainCharacterId: null,
        tier: tierLocked ? "member" : "alumni",
      });
    },
  );
  it("choosing another main alone preserves source consent", async () => {
    const p = await sourceFixture({ main: true });
    const alt = await seedCharacter(ctx.db, cfg, { id: 99002, accountId: p.owner.id });
    await ctx.db.transaction((tx) =>
      setMainCharacter(tx, p.owner.id, p.owner.id, alt.id),
    );
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
  });
  it.each(["login", "link", "background"])(
    "%s reclaim keeps ended tombstones and never transfers consent",
    async (entry) => {
      const p = await sourceFixture({ main: true });
      if (entry === "login")
        await ctx.db.transaction((tx) =>
          handleEveLogin(tx, cfg, callback(p.boss.id, "new-owner")),
        );
      else if (entry === "link") {
        const target = await seedAccount(ctx.db, { tier: "member" });
        await ctx.db.transaction((tx) =>
          linkCharacter(tx, cfg, target.id, callback(p.boss.id, "new-owner")),
        );
      } else
        await ctx.db.transaction((tx) =>
          reclaimTransferredCharacter(tx, p.boss.id, {
            accountId: p.owner.id,
            ownerHash: p.boss.ownerHash,
          }),
        );
      await expectEnded(p.source.id);
      expect(
        (await ctx.db.select().from(account).where(eq(account.id, p.owner.id)))[0],
      ).toMatchObject({ mainCharacterId: null, tier: "alumni" });
      const [boss] = await ctx.db
        .select()
        .from(character)
        .where(eq(character.id, p.boss.id));
      if (entry === "background") expect(boss).toBeUndefined();
      else expect(boss.fleetLinkEpoch).not.toBe(p.boss.fleetLinkEpoch);
    },
  );
  it("ending an old source never clears a competing occupant or its newer generation", async () => {
    const p = await sourceFixture();
    const competingId = randomUUID();
    const otherBoss = await seedCharacter(ctx.db, cfg, {
      id: 99002,
      accountId: p.owner.id,
      scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
    });
    await ctx.db.insert(fleetSourceIntent).values({
      ...p.source,
      id: competingId,
      bossCharacterId: otherBoss.id,
      bossOwnerHash: otherBoss.ownerHash,
      bossLinkEpoch: otherBoss.fleetLinkEpoch,
      generation: 9,
    });
    await ctx.db
      .update(fleetSourceAuthority)
      .set({ sourceId: competingId, sourceGeneration: 9, authorityGeneration: 10 });
    const before = await ctx.db.select().from(fleetSourceAuthority);
    await invalidateTokenIfUnchanged(ctx.db, p.boss.id, p.boss.refreshTokenEnc!, {
      action: "token.invalidated",
    });
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, p.source.id))
      )[0].state,
    ).toBe("ended");
    expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(before);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, competingId))
      )[0].generation,
    ).toBe(9);
  });
  it("source-generation mismatch cannot clear a newer proof in the same slot", async () => {
    const p = await sourceFixture();
    await ctx.db.update(fleetSourceAuthority).set({ sourceGeneration: 2 });
    const before = await ctx.db.select().from(fleetSourceAuthority);
    await invalidateTokenIfUnchanged(ctx.db, p.boss.id, p.boss.refreshTokenEnc!, {
      action: "token.invalidated",
    });
    expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(before);
  });
  it("Off, renewal and key-proven recovery preserve source activation; operator drain terminates it", async () => {
    const p = await sourceFixture({ shared: true });
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: p.paired.sessionId,
      revision: 1,
      now: NOW,
      capabilities: [SHARED_CAPABILITY],
    });
    await setFleetParticipation(ctx.db, {
      sessionId: p.paired.sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 500),
      enabled: true,
      expectedGeneration: 0,
    });
    const before = await ctx.db.select().from(fleetSourceIntent);
    await setFleetParticipation(ctx.db, {
      sessionId: p.paired.sessionId,
      revision: 3,
      now: new Date(NOW.getTime() + 1000),
      enabled: false,
      expectedGeneration: 1,
    });
    await renewFleetDeviceSession(ctx.db, {
      sessionId: p.paired.sessionId,
      revision: 4,
      now: new Date(NOW.getTime() + 1500),
    });
    const challenge = await beginFleetRecovery(ctx.db, recoveryInitiation(p.paired, NOW));
    const recovered = await completeFleetRecovery(
      ctx.db,
      recoveryCompletion(p.paired, challenge, NOW),
    );
    expect(recovered).toMatchObject({
      ok: true,
      value: { result: "reconnected", participation: { enabled: false, generation: 2 } },
    });
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(before);
    await transitionFleetSharingMode(ctx.db, {
      enabled: false,
      expectedRevision: 3,
      now: NOW,
    });
    await expectEnded(p.source.id);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
  });
  it("rolls back credential state, source/authority generations and audit together", async () => {
    const p = await sourceFixture();
    const before = await ctx.db.select().from(fleetSourceIntent);
    const authority = await ctx.db.select().from(fleetSourceAuthority);
    const audit = await ctx.db.select().from(auditLog);
    await expect(
      withInjectedPgFault(
        ctx.pool,
        { matchSql: /insert into "audit_log"/i, code: "40001" },
        () =>
          invalidateTokenIfUnchanged(ctx.db, p.boss.id, p.boss.refreshTokenEnc!, {
            action: "token.invalidated",
          }),
      ),
    ).rejects.toThrow();
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(before);
    expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(authority);
    expect(await ctx.db.select().from(auditLog)).toEqual(audit);
    expect((await ctx.db.select().from(character))[0].tokenStatus).toBe("valid");
  });
  it("source provenance withdrawal is isolated and physical cleanup rolls back with a later unlink failure", async () => {
    const p = await sourceFixture();
    const otherBoss = await seedCharacter(ctx.db, cfg, {
      id: 99003,
      accountId: p.owner.id,
      main: true,
      scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
    });
    const otherSource = await seedLifecycleSource(ctx.db, {
      boss: otherBoss,
      deviceId: p.paired.device.id,
      now: NOW,
      fleetId: 456,
    });
    const remote = await seedAccount(ctx.db, { tier: "member" });
    const publisher = await pairDevice(ctx.db, remote.id, NOW);
    const sessionId = createHash("sha256")
      .update(publisher.sessionId)
      .digest("base64url");
    // Explicit lifecycle/provenance fixtures, NOT worker or shared publication.
    for (const [id, source] of [
      [99002, p.source],
      [99004, otherSource],
    ] as const) {
      const ch = await seedCharacter(ctx.db, cfg, { id, accountId: remote.id });
      const common = {
        characterId: id,
        deviceId: publisher.device.id,
        sessionId,
        fleetId: source.fleetId!,
        sourceId: source.id,
        sourceGeneration: 1,
        authorityGeneration: 7,
        linkEpoch: ch.fleetLinkEpoch,
        participationGeneration: 1,
      };
      await ctx.db.insert(fleetTelemetryRow).values({
        ...common,
        dps: 42,
        receivedAt: NOW,
        staleAt: new Date(NOW.getTime() + 3000),
        hardExpiresAt: new Date(NOW.getTime() + 10000),
      });
      await ctx.db
        .insert(fleetPublisherLease)
        .values({ ...common, leaseExpiresAt: new Date(NOW.getTime() + 10000) });
    }
    const rows = await ctx.db
      .select()
      .from(fleetTelemetryRow)
      .orderBy(fleetTelemetryRow.characterId);
    const leases = await ctx.db
      .select()
      .from(fleetPublisherLease)
      .orderBy(fleetPublisherLease.characterId);
    const audit = await ctx.db.select().from(auditLog).orderBy(auditLog.id);
    await expect(
      withInjectedPgFault(
        ctx.pool,
        { matchSql: /delete from "character"/i, code: "40001" },
        () =>
          fleetLifecycleTransaction(ctx.db, (tx) =>
            unlinkCharacter(tx, cfg, p.owner.id, p.boss.id),
          ),
      ),
    ).rejects.toThrow();
    expect(
      await ctx.db
        .select()
        .from(fleetTelemetryRow)
        .orderBy(fleetTelemetryRow.characterId),
    ).toEqual(rows);
    expect(
      await ctx.db
        .select()
        .from(fleetPublisherLease)
        .orderBy(fleetPublisherLease.characterId),
    ).toEqual(leases);
    expect(await ctx.db.select().from(auditLog).orderBy(auditLog.id)).toEqual(audit);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, p.source.id))
      )[0].state,
    ).toBe("active");
    expect(
      await fleetLifecycleTransaction(ctx.db, (tx) =>
        unlinkCharacter(tx, cfg, p.owner.id, p.boss.id),
      ),
    ).toEqual({ ok: true });
    await expectEnded(p.source.id);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([rows[1]]);
    expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([leases[1]]);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, otherSource.id))
      )[0].state,
    ).toBe("active");
  });
  it("ended cancellation fences may survive without live identities, but incomplete live identities are rejected", async () => {
    const tombstone = {
      id: randomUUID(),
      state: "ended" as const,
      intentCreatedAt: NOW,
      intentExpiresAt: new Date(NOW.getTime() + 60_000),
      endedAt: NOW,
      terminalReason: "cancelled",
      retainUntil: new Date(NOW.getTime() + 86400000),
    };
    await ctx.db.insert(fleetSourceIntent).values(tombstone);
    await expect(
      ctx.db.insert(fleetSourceIntent).values({
        ...tombstone,
        id: randomUUID(),
        state: "pending",
        endedAt: null,
        terminalReason: null,
      }),
    ).rejects.toThrow();
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(1);
  });
  it("bounds tombstone cleanup, never deleting a live or still-retained intent", async () => {
    const p = await sourceFixture();
    const expired = new Date(NOW.getTime() + 86400001);
    await ctx.db.insert(fleetSourceIntent).values(
      Array.from({ length: 101 }, () => ({
        id: randomUUID(),
        state: "ended" as const,
        intentCreatedAt: NOW,
        intentExpiresAt: new Date(NOW.getTime() + 60_000),
        endedAt: NOW,
        terminalReason: "cancelled",
        retainUntil: new Date(NOW.getTime() + 86400000),
      })),
    );
    const retainedId = randomUUID();
    await ctx.db.insert(fleetSourceIntent).values({
      ...p.source,
      id: retainedId,
      state: "ended",
      endedAt: NOW,
      terminalReason: "cancelled",
      retainUntil: new Date(NOW.getTime() + 172800000),
    });
    expect(await purgeExpiredFleetSourceIntents(ctx.db, expired)).toBe(100);
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(3);
    expect(await purgeExpiredFleetSourceIntents(ctx.db, expired)).toBe(1);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, p.source.id))
      )[0].state,
    ).toBe("active");
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, retainedId))
      )[0].state,
    ).toBe("ended");
  });
  it("uses distinct advisory namespaces for absent source and authority serialization", async () => {
    expect(
      new Set([1, 2, 3, 4, 5, FLEET_AUTHORITY_LOCK_CLASS, FLEET_SOURCE_LOCK_CLASS]).size,
    ).toBe(7);
    const client = await ctx.pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query("select pg_advisory_xact_lock(6, hashint8(123))");
      pending = ctx.db.transaction(async (tx) => {
        await lockFleetAuthoritySlots(tx, [123]);
        await lockFleetSourceIntents(tx, [randomUUID()]);
      });
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("commit");
      await pending;
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });
});

describe("PostgreSQL lifecycle overlap (not positive shared admission)", () => {
  it("retries the actual outer merge transaction when an approved request appears after its key probe", async () => {
    const p = await sourceFixture({ shared: true });
    const target = await seedAccount(ctx.db, { tier: "member" });
    const request = await beginPairing(ctx.db, { ...fleetKeyPair(), now: NOW });
    const client = await ctx.pool.connect();
    let pending: Promise<unknown> | undefined;
    let attempts = 0;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query('select id from "character" where id = 99001 for update');
      pending = fleetLifecycleTransaction(ctx.db, async (tx) => {
        attempts++;
        return linkCharacter(tx, cfg, target.id, callback(p.boss.id));
      });
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await approvePairing(ctx.db, request.pairingId, p.owner.id, NOW);
      await client.query("commit");
      expect(await pending).toEqual({ ok: true });
      expect(attempts).toBe(2);
      expect(await ctx.db.select().from(fleetPairingRequest)).toEqual([]);
      expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toMatchObject([
        { deviceId: null, conflicted: false },
      ]);
      await expectEnded(p.source.id);
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });
  it("legacy publication takes character-FK-compatible identity locks before its device; unlink then removes its committed projection", async () => {
    const p = await sourceFixture();
    await seedCharacter(ctx.db, cfg, { id: 99002, accountId: p.owner.id, main: true });
    await ctx.db.insert(fleetEligibility).values({
      characterId: p.boss.id,
      accountId: p.owner.id,
      fleetId: 123,
      rosterCharacterIds: [p.boss.id],
      verifiedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60000),
      outcomeCode: "ok",
    });
    const client = await ctx.pool.connect();
    let publish: ReturnType<typeof replaceDeviceProjection> | undefined;
    let unlink: Promise<unknown> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query("select id from fleet_device where id = $1 for update", [
        p.paired.device.id,
      ]);
      publish = replaceDeviceProjection(ctx.db, {
        sessionId: p.paired.sessionId,
        revision: 1,
        now: NOW,
        rows: [{ characterId: p.boss.id, dps: 42, ewar: [] }],
      });
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      // With the prelude, publish holds character before waiting on device.
      const { rows } = await ctx.pool.query<{ pid: number }>(
        "select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
        [pid],
      );
      unlink = fleetLifecycleTransaction(ctx.db, (tx) =>
        unlinkCharacter(tx, cfg, p.owner.id, p.boss.id),
      );
      expect(await waitUntilBlockedBy(ctx.pool, rows[0].pid)).toBe(true);
      await client.query("commit");
      expect(await publish).toEqual({ ok: true });
      expect(await unlink).toEqual({ ok: true });
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
      expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([]);
      await expectEnded(p.source.id);
    } finally {
      await client.query("rollback");
      client.release();
      await Promise.allSettled([publish, unlink]);
    }
  });
});

// Removing link epoch issuance/replacement must fail these real identity paths.
describe("fleet link identity epochs", () => {
  it("new login issues an epoch; routine reauth preserves it", async () => {
    const ch = callback(99001);
    await ctx.db.transaction((tx) => handleEveLogin(tx, cfg, ch));
    const [before] = await ctx.db.select().from(character);
    expect(before).toHaveProperty("fleetLinkEpoch", expect.any(String));
    await ctx.db.transaction((tx) => handleEveLogin(tx, cfg, ch));
    const [after] = await ctx.db.select().from(character);
    expect(after).toHaveProperty("fleetLinkEpoch", Reflect.get(before, "fleetLinkEpoch"));
  });
  it("unlink/relink to the same account cannot reuse an epoch", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 99001, accountId: owner.id, main: true });
    await ctx.db.transaction((tx) => linkCharacter(tx, cfg, owner.id, callback(99002)));
    const [before] = await ctx.db.select().from(character).where(eq(character.id, 99002));
    expect(
      await ctx.db.transaction((tx) => unlinkCharacter(tx, cfg, owner.id, before.id)),
    ).toEqual({ ok: true });
    expect(
      await ctx.db.transaction((tx) =>
        linkCharacter(tx, cfg, owner.id, callback(before.id)),
      ),
    ).toEqual({ ok: true });
    const [after] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, before.id));
    expect(after).toHaveProperty("fleetLinkEpoch", expect.any(String));
    expect(Reflect.get(after, "fleetLinkEpoch")).not.toBe(
      Reflect.get(before, "fleetLinkEpoch"),
    );
  });
  it("same-account owner replacement is a new identity, not ordinary reauth", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const before = await seedCharacter(ctx.db, cfg, { id: 99001, accountId: owner.id });
    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, owner.id, callback(before.id, "new-owner")),
    );
    const [after] = await ctx.db.select().from(character);
    expect(after.ownerHash).toBe("new-owner");
    expect(Reflect.get(after, "fleetLinkEpoch")).not.toBe(
      Reflect.get(before, "fleetLinkEpoch"),
    );
  });
});
