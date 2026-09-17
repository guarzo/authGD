import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import {
  account,
  auditLog,
  character,
  contactSyncState,
  fleetAutomaticCandidate,
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetDevice,
  fleetDeviceSession,
  fleetSourceIntent,
  fleetSourceAuthority,
  fleetPublisherLease,
  fleetTelemetryRow,
  outbox,
  syncRun,
} from "@/db/schema";
import type { AutomaticAuthLossProof, AutomaticTask } from "@/core/fleet-automatic";
import { automaticCandidateAdmissible } from "@/core/fleet-automatic";
import { runTokenHealthJob } from "@/jobs/token-health";
import { attemptClaimedFleetAutomaticDiscovery } from "@/jobs/fleet-automatic";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { decryptToken } from "@/lib/crypto";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import {
  completeFleetReadGrant,
  handleEveLogin,
  linkCharacter,
  type EveCallbackCharacter,
} from "@/services/accounts";
import * as lifecycle from "@/services/fleet-lifecycle";
import * as databaseTime from "@/services/fleet-key-identity";
import * as automatic from "@/services/fleet-automatic";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { createSession } from "@/services/session";
import { JobRetryError } from "@/services/sync-run";
import { getFreshAccessToken, invalidateTokenIfUnchanged } from "@/services/tokens";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

const cfg = testConfig();
const SCOPES = [...cfg.eveSso.scopes, FLEET_READ_SCOPE];
const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  ctx = await setupTestDb();
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256" }],
  });
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

async function setup() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, cfg, {
    id: 99001,
    accountId: owner.id,
    scopes: SCOPES,
  });
  const device = await pairDevice(ctx.db, owner.id, NOW, ["shared-source-v1"]);
  expect(
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: device.sessionId,
      revision: 1,
      now: NOW,
      capabilities: ["shared-source-v1"],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await automatic.controlFleetAutomatic(
      ctx.db,
      { sessionId: device.sessionId, revision: 2, now: at(1000) },
      {
        protocol: 2,
        request_id: randomUUID(),
        intent_created_at: NOW.toISOString(),
        enabled: true,
        expected_generation: 0,
        expected_revision: 0,
      },
    ),
  ).toMatchObject({ ok: true });
  // Reservation INPUT only. Claim and negative settlement are S1's real owners;
  // the detached witness exercises their trusted port, not S3's upstream proof.
  const [candidate] = await ctx.db
    .insert(fleetAutomaticCandidate)
    .values({
      accountId: owner.id,
      characterId: boss.id,
      consentGeneration: 1,
      candidateGeneration: 1,
      ownerHash: boss.ownerHash,
      linkEpoch: boss.fleetLinkEpoch,
      nextAttemptAt: at(1000),
      reservationId: randomUUID(),
      enqueueUntil: at(11000),
      failureCount: 3,
    })
    .returning();
  const task: AutomaticTask = {
    accountId: owner.id,
    characterId: boss.id,
    consentGeneration: 1,
    candidateGeneration: 1,
    reservationId: candidate.reservationId!,
  };
  const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () =>
    at(2000),
  );
  expect(claim).not.toBeNull();
  const proof: AutomaticAuthLossProof = {
    cause: "verified_scope_missing",
    rejected: {
      admission: "rejected",
      claim: claim!,
      settledTokenEnc: boss.refreshTokenEnc!,
      accessTokenExpiresAt: at(60000),
    },
  };
  return { owner, boss, ...device, candidate, task, claim: claim!, proof };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function candidate() {
  return (
    await ctx.db
      .select()
      .from(fleetAutomaticCandidate)
      .where(eq(fleetAutomaticCandidate.characterId, 99001))
  )[0];
}
async function bossRow() {
  return (await ctx.db.select().from(character).where(eq(character.id, 99001)))[0];
}
async function outside() {
  return Promise.all([
    ctx.db.select().from(account),
    ctx.db.select().from(fleetAutomaticConsent),
    ctx.db.select().from(fleetAutomaticReceipt),
    ctx.db.select().from(fleetDevice),
    ctx.db.select().from(fleetDeviceSession),
    ctx.db.select().from(fleetSourceIntent),
    ctx.db.select().from(fleetSourceAuthority),
    ctx.db.select().from(fleetPublisherLease),
    ctx.db.select().from(fleetTelemetryRow),
  ]);
}
async function suspend(
  p: Fixture,
  cause: "verified_scope_missing" | "verified_owner_mismatch" = "verified_scope_missing",
) {
  expect(
    await automatic.settleFleetAutomaticAuthorizationLoss(
      ctx.db,
      { ...p.proof, cause },
      at(120000),
      () => at(3000),
    ),
  ).toBe("suspended");
  return candidate();
}
async function sign(scopes = SCOPES, ownerHash = "oh-99001", characterId = 99001) {
  return new SignJWT({ name: "Pilot", owner: ownerHash, scp: scopes })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://login.eveonline.com")
    .setAudience("EVE Online")
    .setSubject(`CHARACTER:EVE:${characterId}`)
    .setExpirationTime("5m")
    .sign(privateKey);
}
async function accepted(scopes = SCOPES): Promise<EveCallbackCharacter> {
  const verified = await verifyEveAccessToken(await sign(scopes), jwks);
  return { ...verified, refreshToken: "accepted-reauth" };
}
function refreshFetch(accessToken: string): typeof fetch {
  return async (input, init) => {
    expect(String(input)).toBe("https://login.eveonline.com/v2/oauth/token");
    expect(init?.method).toBe("POST");
    expect(new URLSearchParams(init?.body as string).get("grant_type")).toBe(
      "refresh_token",
    );
    return Response.json({
      access_token: accessToken,
      refresh_token: "ordinary-rotation",
    });
  };
}
async function health(scopes = SCOPES, getKey: JWTVerifyGetKey = jwks) {
  return runTokenHealthJob({
    db: ctx.db,
    cfg,
    jwks: getKey,
    fetchImpl: refreshFetch(await sign(scopes)),
  });
}
function woken(old: typeof fleetAutomaticCandidate.$inferSelect) {
  return {
    ...old,
    lastOutcome: null,
    failureCount: 0,
    reservationId: null,
    enqueueUntil: null,
    claimReservationId: null,
    claimExpiresAt: null,
    sourceId: null,
  };
}

it.each(["login", "link", "grant"] as const)(
  "accepted %s with unchanged scopes/link wakes only the candidate, keeping existing contact/audit/account outbox effects",
  async (kind) => {
    const p = await setup();
    const old = await suspend(p);
    const session = await createSession(ctx.db, p.owner.id);
    await ctx.db.insert(contactSyncState).values({
      characterId: p.boss.id,
      lastResult: "token_invalid",
      lastDetail: "old fault",
    });
    const before = await outside();
    const auditBefore = await ctx.db.select().from(auditLog);
    const outboxBefore = await ctx.db.select().from(outbox);
    const input = await accepted();
    const result = await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) =>
      kind === "login"
        ? handleEveLogin(tx, cfg, input)
        : kind === "link"
          ? linkCharacter(tx, cfg, p.owner.id, input)
          : completeFleetReadGrant(tx, cfg, p.owner.id, p.boss.id, input, session),
    );
    expect(result).toEqual(kind === "login" ? { accountId: p.owner.id } : { ok: true });
    expect(await candidate()).toEqual(woken(old));
    expect(await outside()).toEqual(before);
    expect(await bossRow()).toMatchObject({
      scopes: SCOPES,
      fleetLinkEpoch: p.boss.fleetLinkEpoch,
      tokenStatus: "valid",
    });
    expect(decryptToken((await bossRow()).refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
      "accepted-reauth",
    );
    expect((await ctx.db.select().from(contactSyncState))[0]).toMatchObject({
      lastResult: null,
      lastDetail: null,
    });
    expect(
      (await ctx.db.select().from(auditLog)).slice(auditBefore.length),
    ).toMatchObject([
      { action: "character.reauthed", actor: p.owner.id, target: String(p.boss.id) },
    ]);
    expect(
      (await ctx.db.select().from(outbox))
        .slice(outboxBefore.length)
        .map((r) => r.payload),
    ).toEqual([{ kind: "account", accountId: p.owner.id }]);
  },
);

it.each(["verified_scope_missing", "verified_owner_mismatch"] as const)(
  "token health absent-to-present scope CAS wakes %s, without automatic work or unrelated side effects",
  async (cause) => {
    const p = await setup();
    const old = await suspend(p, cause);
    await ctx.db
      .update(character)
      .set({ scopes: [...cfg.eveSso.scopes] })
      .where(eq(character.id, p.boss.id));
    const before = [
      await outside(),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ];
    expect(await health()).toEqual({
      status: "ok",
      counts: { refreshed: 1, invalid: 0, needsReauth: 0, unlinked: 0, skipped: 0 },
    });
    expect(await candidate()).toEqual(woken(old));
    expect(await bossRow()).toMatchObject({ scopes: SCOPES, tokenStatus: "valid" });
    expect([
      await outside(),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ]).toEqual(before);
  },
);

it.each(["valid", "needs_reauth"] as const)(
  "ordinary token health with already-present Fleet Read and resulting %s cannot wake",
  async (status) => {
    const p = await setup();
    const old = await suspend(p);
    expect(await health(status === "valid" ? SCOPES : [FLEET_READ_SCOPE])).toMatchObject({
      status: "ok",
      counts: { refreshed: 1, needsReauth: status === "valid" ? 0 : 1 },
    });
    expect(await candidate()).toEqual(old);
    expect((await bossRow()).tokenStatus).toBe(status);
  },
);

it("already-present scope health does not enter the new grant-wake DB-time path", async () => {
  const p = await setup();
  const old = await suspend(p);
  expect(
    await withInjectedPgFault(
      ctx.pool,
      { matchSql: /select clock_timestamp\(\) as now/i, code: "23514" },
      () => health(),
    ),
  ).toMatchObject({ status: "ok", counts: { refreshed: 1 } });
  expect(await candidate()).toEqual(old);
});

it("ordinary generic token rotation and global invalid-to-valid rewrite never wake an existing-scope latch", async () => {
  const p = await setup();
  const old = await suspend(p);
  const rotated = await getFreshAccessToken(
    ctx.db,
    cfg,
    p.boss,
    refreshFetch(await sign()),
  );
  expect(rotated.ok).toBe(true);
  expect(await candidate()).toEqual(old);
  await health(SCOPES, async (...args) => {
    expect(
      await invalidateTokenIfUnchanged(
        ctx.db,
        p.boss.id,
        (await bossRow()).refreshTokenEnc!,
        { action: "test.existing_invalidation" },
      ),
    ).toBe(true);
    return jwks(...args);
  });
  expect((await bossRow()).tokenStatus).toBe("valid");
  expect(await candidate()).toEqual(old);
});

it("an accepted grant while Off clears bookkeeping but neither turns On nor creates work, even at exhausted counters", async () => {
  const p = await setup();
  await suspend(p);
  expect(
    await automatic.controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision: 3, now: at(4000) },
      {
        protocol: 2,
        request_id: randomUUID(),
        intent_created_at: at(4000).toISOString(),
        enabled: false,
        expected_generation: 1,
        expected_revision: 1,
      },
    ),
  ).toMatchObject({ ok: true });
  await ctx.db.update(fleetAutomaticCandidate).set({
    candidateGeneration: Number.MAX_SAFE_INTEGER,
    claimGeneration: Number.MAX_SAFE_INTEGER,
  });
  const old = await candidate();
  const before = await outside();
  await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) =>
    handleEveLogin(tx, cfg, await accepted()),
  );
  expect(await candidate()).toEqual(woken(old));
  expect(await outside()).toEqual(before);
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(false);
  expect(
    automaticCandidateAdmissible(await candidate(), await bossRow(), 1, at(999999)),
  ).toBe(false);
});

it("reauthorization does not hide a latch behind a newer consent generation or shorten pacing", async () => {
  const p = await setup();
  const old = await suspend(p);
  expect(
    await automatic.controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision: 3, now: at(4000) },
      {
        protocol: 2,
        request_id: randomUUID(),
        intent_created_at: at(4000).toISOString(),
        enabled: true,
        expected_generation: 1,
        expected_revision: 1,
      },
    ),
  ).toMatchObject({ ok: true });
  const before = await outside();
  await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) =>
    handleEveLogin(tx, cfg, await accepted()),
  );
  expect(await candidate()).toEqual(woken(old));
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].generation).toBe(2);
  expect(await outside()).toEqual(before);
});

it("accepted unusable grant leaves latch and non-token contact findings intact", async () => {
  const p = await setup();
  const old = await suspend(p);
  await ctx.db.insert(contactSyncState).values({
    characterId: p.boss.id,
    lastResult: "label_mismatch",
    lastDetail: "actual labels",
  });
  await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) =>
    handleEveLogin(tx, cfg, await accepted([...cfg.eveSso.scopes])),
  );
  expect(await candidate()).toEqual(old);
  expect((await ctx.db.select().from(contactSyncState))[0]).toMatchObject({
    lastResult: "label_mismatch",
    lastDetail: "actual labels",
  });
});

it.each(["audit_log", "fleet_automatic_candidate"])(
  "reauth %s failure rolls back credentials, contact state, wake, audit and outbox together",
  async (table) => {
    const p = await setup();
    await suspend(p);
    await ctx.db.insert(contactSyncState).values({
      characterId: p.boss.id,
      lastResult: "token_invalid",
      lastDetail: "old fault",
    });
    const snapshot = async () => [
      await candidate(),
      await bossRow(),
      await outside(),
      await ctx.db.select().from(contactSyncState),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ];
    const before = await snapshot();
    const input = await accepted();
    await expect(
      withInjectedPgFault(
        ctx.pool,
        {
          matchSql: new RegExp(`^(?:insert into|update) "${table}"`, "i"),
          code: "23514",
        },
        () =>
          lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
            handleEveLogin(tx, cfg, input),
          ),
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  },
);

it("token health audit failure rolls back scope/status/wake but retains its already-settled ordinary refresh", async () => {
  const p = await setup();
  const old = await suspend(p);
  await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
  const before = await bossRow();
  const auditBefore = await ctx.db.select().from(auditLog);
  await expect(
    withInjectedPgFault(
      ctx.pool,
      { matchSql: /insert into "audit_log"/i, code: "23514" },
      () => health([FLEET_READ_SCOPE]),
    ),
  ).rejects.toThrow();
  expect(await candidate()).toEqual(old);
  const after = await bossRow();
  expect(after).toEqual({ ...before, refreshTokenEnc: after.refreshTokenEnc });
  expect(decryptToken(after.refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
    "ordinary-rotation",
  );
  expect(await ctx.db.select().from(auditLog)).toEqual(auditBefore);
});

it("a real newer reauth during JWT verification defeats the old scope CAS and cannot wake from its claimed restoration", async () => {
  const p = await setup();
  const old = await suspend(p);
  await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
  const input = await accepted([...cfg.eveSso.scopes]);
  await expect(
    health(SCOPES, async (...args) => {
      await lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
        handleEveLogin(tx, cfg, input),
      );
      return jwks(...args);
    }),
  ).rejects.toBeInstanceOf(JobRetryError);
  expect(await candidate()).toEqual(old);
  expect((await bossRow()).scopes).not.toContain(FLEET_READ_SCOPE);
  expect(decryptToken((await bossRow()).refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
    "accepted-reauth",
  );
  expect((await ctx.db.select().from(syncRun))[0]).toMatchObject({
    status: "partial",
    counts: { refreshed: 0 },
  });
});

it.each(["absent", "present"] as const)(
  "token health uses the locked actual %s scope state, not its initial catalogue snapshot",
  async (current) => {
    const p = await setup();
    const old = await suspend(p);
    if (current === "present")
      await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
    await health(SCOPES, async (...args) => {
      // Boundary fixture: labels change after the job's initial SELECT/rotation,
      // but the settled blob still matches. No synthetic CAS result is supplied.
      await ctx.db
        .update(character)
        .set({ scopes: current === "present" ? SCOPES : [...cfg.eveSso.scopes] });
      return jwks(...args);
    });
    expect(await candidate()).toEqual(current === "absent" ? woken(old) : old);
  },
);

it("a scope CAS with a matching old snapshot but unverified current owner cannot wake or change existing token-health accounting", async () => {
  const p = await setup();
  await suspend(p);
  let before: Awaited<ReturnType<typeof candidate>> | undefined;
  const result = await health(SCOPES, async (...args) => {
    await ctx.db
      .update(character)
      .set({ ownerHash: "current-other-owner", scopes: [...cfg.eveSso.scopes] });
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ ownerHash: "current-other-owner" });
    before = await candidate();
    return jwks(...args);
  });
  expect(result).toEqual({
    status: "ok",
    counts: { refreshed: 1, invalid: 0, needsReauth: 0, unlinked: 0, skipped: 0 },
  });
  expect(await candidate()).toEqual(before);
  expect(await bossRow()).toMatchObject({
    ownerHash: "current-other-owner",
    scopes: SCOPES,
    tokenStatus: "valid",
  });
});

it.each(["subject", "owner"] as const)(
  "token health verified %s mismatch keeps its existing global invalidation/reclaim behavior, not a grant wake",
  async (mismatch) => {
    const p = await setup();
    const old = await suspend(p);
    await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetch(
        await sign(
          SCOPES,
          mismatch === "owner" ? "other-owner" : p.boss.ownerHash,
          mismatch === "subject" ? 99002 : p.boss.id,
        ),
      ),
    });
    expect(result).toMatchObject({
      status: "ok",
      counts: {
        invalid: mismatch === "subject" ? 1 : 0,
        unlinked: mismatch === "owner" ? 1 : 0,
        refreshed: 0,
      },
    });
    if (mismatch === "subject") {
      expect(await candidate()).toEqual(old);
      expect((await bossRow()).tokenStatus).toBe("invalid");
    } else {
      expect(await bossRow()).toBeUndefined();
      // Existing account/link lifecycle governs retained rows; it is not a wake.
      expect(await candidate()).toEqual(old);
    }
  },
);

it.each(["accepted_reauthorization", "verified_fleet_read_restored"] as const)(
  "%s helper clears callbacks/source but preserves all generations, pacing, consent timing and sibling state",
  async (reason) => {
    const p = await setup();
    await suspend(p);
    const sibling = await seedCharacter(ctx.db, cfg, {
      id: 99002,
      accountId: p.owner.id,
      scopes: SCOPES,
    });
    const [siblingCandidate] = await ctx.db
      .insert(fleetAutomaticCandidate)
      .values({
        ...(await candidate()),
        characterId: sibling.id,
        ownerHash: sibling.ownerHash,
        linkEpoch: sibling.fleetLinkEpoch,
      })
      .returning();
    // Retained callback/source-pointer INPUT only, not a created or admitted source.
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({
        ...(reason === "accepted_reauthorization"
          ? { reservationId: randomUUID(), enqueueUntil: at(32000) }
          : { claimReservationId: randomUUID(), claimExpiresAt: at(32000) }),
        sourceId: randomUUID(),
      })
      .where(eq(fleetAutomaticCandidate.characterId, p.boss.id));
    if (reason === "verified_fleet_read_restored")
      await ctx.db
        .update(character)
        .set({ scopes: [...cfg.eveSso.scopes] })
        .where(eq(character.id, p.boss.id));
    const old = await candidate();
    const before = [
      await outside(),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ];
    await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) => {
      const { existing } = await lifecycle.prepareFleetCharacterMutation(tx, p.boss.id);
      const [after] = await tx
        .update(character)
        .set({ scopes: SCOPES })
        .where(eq(character.id, p.boss.id))
        .returning();
      await lifecycle.wakeFleetAutomaticGrantCandidate(
        tx,
        existing!,
        after,
        reason,
        await databaseTime.fleetDatabaseNow(tx),
      );
    });
    expect(await candidate()).toEqual(woken(old));
    expect(
      (
        await ctx.db
          .select()
          .from(fleetAutomaticCandidate)
          .where(eq(fleetAutomaticCandidate.characterId, sibling.id))
      )[0],
    ).toEqual(siblingCandidate);
    expect([
      await outside(),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ]).toEqual(before);
  },
);

it.each([
  "id",
  "accountId",
  "ownerHash",
  "fleetLinkEpoch",
  "invalid",
  "missing",
  "no-token",
  "no-scope",
  "already-present",
  "bad-time",
  "bad-reason",
] as const)(
  "trusted wake refuses %s rather than clearing the retained latch",
  async (kind) => {
    const p = await setup();
    const old = await suspend(p);
    await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) => {
      const { existing } = await lifecycle.prepareFleetCharacterMutation(tx, p.boss.id);
      const before = { ...existing! };
      const after = { ...existing! };
      // Keep after matched to the retained latch: otherwise the SQL predicate
      // masks a missing before/after identity-transition guard.
      if (kind === "id") before.id++;
      if (kind === "accountId") before.accountId = randomUUID();
      if (kind === "ownerHash") before.ownerHash = "different";
      if (kind === "fleetLinkEpoch") before.fleetLinkEpoch = randomUUID();
      if (kind === "invalid" || kind === "missing") after.tokenStatus = kind;
      if (kind === "no-token") after.refreshTokenEnc = null;
      if (kind === "no-scope") after.scopes = [];
      // Deliberately malformed trusted-port inputs, not a fabricated SSO writer.
      const reason =
        kind === "already-present"
          ? "verified_fleet_read_restored"
          : kind === "bad-reason"
            ? ("ordinary_rotation" as lifecycle.AutomaticGrantWakeReason)
            : "accepted_reauthorization";
      await lifecycle.wakeFleetAutomaticGrantCandidate(
        tx,
        before,
        after,
        reason,
        kind === "bad-time" ? new Date(NaN) : await databaseTime.fleetDatabaseNow(tx),
      );
    });
    expect(await candidate()).toEqual(old);
  },
);

it.each([
  "ownerHash",
  "linkEpoch",
  "accountId",
  "characterId",
  "not-latched",
  "absent",
] as const)("accepted reauth does not wake a %s candidate binding", async (kind) => {
  const p = await setup();
  await suspend(p);
  if (kind === "absent") await ctx.db.delete(fleetAutomaticCandidate);
  else if (kind === "accountId") {
    const other = await seedAccount(ctx.db);
    await ctx.db.update(fleetAutomaticCandidate).set({ accountId: other.id });
  } else if (kind === "characterId")
    await ctx.db.update(fleetAutomaticCandidate).set({ characterId: 99002 });
  else if (kind === "not-latched")
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ lastOutcome: "service_unavailable" });
  else
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set(kind === "ownerHash" ? { ownerHash: "other" } : { linkEpoch: randomUUID() });
  const before = await ctx.db.select().from(fleetAutomaticCandidate);
  await lifecycle.fleetLifecycleTransaction(ctx.db, async (tx) =>
    handleEveLogin(tx, cfg, await accepted()),
  );
  expect(await ctx.db.select().from(fleetAutomaticCandidate)).toEqual(before);
});

it("a verified absent-to-present Fleet Read grant may wake while unrelated baseline scopes still need reauth", async () => {
  const p = await setup();
  const old = await suspend(p);
  await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
  await ctx.db.insert(contactSyncState).values({
    characterId: p.boss.id,
    lastResult: "token_invalid",
    lastDetail: "contact fault",
  });
  const contacts = await ctx.db.select().from(contactSyncState);
  const before = await outside();
  expect(await health([FLEET_READ_SCOPE])).toEqual({
    status: "ok",
    counts: { refreshed: 1, invalid: 0, needsReauth: 1, unlinked: 0, skipped: 0 },
  });
  expect(await candidate()).toEqual(woken(old));
  expect(await bossRow()).toMatchObject({
    tokenStatus: "needs_reauth",
    scopes: [FLEET_READ_SCOPE],
  });
  expect(await ctx.db.select().from(contactSyncState)).toEqual(contacts);
  expect(await outside()).toEqual(before);
  expect(
    (await ctx.db.select().from(auditLog)).filter(
      (r) => r.action === "token.needs_reauth",
    ),
  ).toMatchObject([{ details: { missingScopes: cfg.eveSso.scopes } }]);
});

it("reauth before refresh persistence defeats the actual token CAS, so no scope writer or wake runs", async () => {
  const p = await setup();
  const old = await suspend(p);
  await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
  const input = await accepted([...cfg.eveSso.scopes]);
  const access = await sign();
  await expect(
    runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: async (...args) => {
        await lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
          handleEveLogin(tx, cfg, input),
        );
        return refreshFetch(access)(...args);
      },
    }),
  ).rejects.toBeInstanceOf(JobRetryError);
  expect(await candidate()).toEqual(old);
  expect((await bossRow()).scopes).not.toContain(FLEET_READ_SCOPE);
  expect(decryptToken((await bossRow()).refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
    "accepted-reauth",
  );
  expect((await ctx.db.select().from(syncRun))[0]).toMatchObject({
    status: "partial",
    counts: { refreshed: 0, invalid: 0, needsReauth: 0 },
  });
});

it.each(["wrong_character", "identity_changed", "scope_missing"] as const)(
  "rejected optional grant (%s) cannot wake",
  async (reason) => {
    const p = await setup();
    const old = await suspend(p);
    const session = await createSession(ctx.db, p.owner.id);
    const input = await accepted();
    if (reason === "wrong_character") input.characterId++;
    if (reason === "identity_changed") input.ownerHash = "different";
    if (reason === "scope_missing") input.scopes = [...cfg.eveSso.scopes];
    const before = [
      await outside(),
      await bossRow(),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ];
    expect(
      await lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
        completeFleetReadGrant(tx, cfg, p.owner.id, p.boss.id, input, session),
      ),
    ).toEqual({ ok: false, code: reason });
    expect(await candidate()).toEqual(old);
    expect([
      await outside(),
      await bossRow(),
      await ctx.db.select().from(auditLog),
      await ctx.db.select().from(outbox),
    ]).toEqual(before);
  },
);

it("same-owner accepted account merge keeps its existing replacement/cascade effects without creating a candidate", async () => {
  const p = await setup();
  await suspend(p);
  const target = await seedAccount(ctx.db, { tier: "member" });
  const input = await accepted();
  expect(
    await lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
      linkCharacter(tx, cfg, target.id, input),
    ),
  ).toEqual({ ok: true });
  expect(await ctx.db.select().from(fleetAutomaticCandidate)).toEqual([]);
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toEqual([]);
  expect((await bossRow()).accountId).toBe(target.id);
  expect((await bossRow()).fleetLinkEpoch).not.toBe(p.boss.fleetLinkEpoch);
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
  expect(
    (await ctx.db.select().from(outbox)).every((row) => row.payload.kind === "account"),
  ).toBe(true);
});

it("same-account accepted owner change rotates the link and follows replacement rather than same-binding wake", async () => {
  const p = await setup();
  const old = await suspend(p);
  const input = { ...(await accepted()), ownerHash: "new-owner" };
  expect(
    await lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
      linkCharacter(tx, cfg, p.owner.id, input),
    ),
  ).toEqual({ ok: true });
  expect(await candidate()).toEqual(old);
  expect((await bossRow()).fleetLinkEpoch).not.toBe(p.boss.fleetLinkEpoch);
  expect((await bossRow()).ownerHash).toBe("new-owner");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** In-memory transaction wrapper only: every production read/write still runs on
 * PostgreSQL. Pause AFTER the real operation and BEFORE its outer commit. */
function holdCommit(db: Db) {
  const ready = deferred<number>();
  const release = deferred<void>();
  const transaction: Db["transaction"] = (work, config) =>
    db.transaction(async (tx) => {
      const result = await work(tx);
      ready.resolve(
        (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]
          .pid,
      );
      await release.promise;
      return result;
    }, config);
  const held = new Proxy(db, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return prop === "transaction" ? transaction : value;
    },
  });
  return { db: held, ready: ready.promise, release: () => release.resolve() };
}

it.each(["failure", "reauth"] as const)(
  "actual %s commits first under a real PostgreSQL wait; accepted reauth wins over the old failure in both orders",
  async (first) => {
    const p = await setup();
    const old = await candidate();
    const input = await accepted();
    const before = await outside();
    const held = holdCommit(ctx.db);
    const tokenReady = deferred<void>();
    const verify = deferred<void>();
    // Real refresh CAS and crypto verification construct the rejection. Pause
    // only JWK delivery so both commit orders use the same actual old token.
    const failure = attemptClaimedFleetAutomaticDiscovery(
      {
        db: first === "failure" ? held.db : ctx.db,
        cfg,
        now: () => at(3000),
        fetchImpl: refreshFetch(await sign([])),
        getKey: async (...args) => {
          tokenReady.resolve();
          await verify.promise;
          return jwks(...args);
        },
      },
      p.claim,
    );
    let reauth: Promise<unknown> | undefined;
    try {
      await tokenReady.promise;
      if (first === "failure") verify.resolve();
      else
        reauth = lifecycle.fleetLifecycleTransaction(held.db, (tx) =>
          handleEveLogin(tx, cfg, input),
        );
      const pid = await held.ready;
      if (first === "failure")
        reauth = lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
          handleEveLogin(tx, cfg, input),
        );
      else verify.resolve();
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      expect(await candidate()).toEqual(old);
      held.release();
      expect(await failure).toEqual({
        result: first === "failure" ? "suspended" : "fenced",
      });
      await reauth;
      if (first === "failure") {
        const after = await candidate();
        expect(after).toEqual({ ...woken(old), nextAttemptAt: after.nextAttemptAt });
        expect(after.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(at(33000).getTime());
        expect(after.nextAttemptAt.getTime()).toBeLessThanOrEqual(at(36000).getTime());
      } else expect(await candidate()).toEqual(old);
      expect(
        decryptToken((await bossRow()).refreshTokenEnc!, cfg.tokenEncryptionKey),
      ).toBe("accepted-reauth");
      expect(await outside()).toEqual(before);
    } finally {
      verify.resolve();
      held.release();
      await Promise.allSettled([failure, ...(reauth ? [reauth] : [])]);
    }
  },
);

it.each(["reauth", "token-health"] as const)(
  "%s supplies actual locked before/full returning after and samples DB time after the final account wait",
  async (writer) => {
    const p = await setup();
    const old = await suspend(p);
    if (writer === "token-health")
      await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
    const observed: {
      before: typeof character.$inferSelect;
      after: typeof character.$inferSelect;
      now: Date;
    }[] = [];
    const realWake = lifecycle.wakeFleetAutomaticGrantCandidate;
    const spy = vi
      .spyOn(lifecycle, "wakeFleetAutomaticGrantCandidate")
      .mockImplementation(async (tx, before, after, reason, now) => {
        expect(
          (await tx.select().from(character).where(eq(character.id, p.boss.id)))[0],
        ).toEqual(after);
        observed.push({ before, after, now });
        await realWake(tx, before, after, reason, now);
      });
    const holder = await ctx.pool.connect();
    let work: Promise<unknown> | undefined;
    const rotated = deferred<void>();
    const proceed = deferred<void>();
    try {
      const input = await accepted();
      if (writer === "token-health") {
        work = health(SCOPES, async (...args) => {
          rotated.resolve();
          await proceed.promise;
          return jwks(...args);
        });
        await rotated.promise;
      }
      await holder.query("begin");
      await holder.query("select id from account where id=$1 for update", [p.owner.id]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      const lockedBefore = await bossRow();
      if (writer === "reauth")
        work = lifecycle.fleetLifecycleTransaction(ctx.db, (tx) =>
          handleEveLogin(tx, cfg, input),
        );
      else proceed.resolve();
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      expect(observed).toEqual([]);
      const releasedAt = new Date(
        (await holder.query<{ now: string }>("select clock_timestamp() as now")).rows[0]
          .now,
      );
      await holder.query("commit");
      await work;
      expect(observed).toHaveLength(1);
      expect(observed[0].before).toEqual(lockedBefore);
      expect(observed[0].after).toEqual(await bossRow());
      expect(observed[0].now.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
      expect(await candidate()).toEqual(woken(old));
    } finally {
      proceed.resolve();
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(work ? [work] : []);
      spy.mockRestore();
    }
  },
);
