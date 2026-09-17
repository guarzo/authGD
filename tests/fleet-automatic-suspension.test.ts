import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb } from "@/db";
import {
  account,
  character,
  fleetAutomaticCandidate,
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetDevice,
  fleetDeviceSession,
  fleetDeviceKeyIdentity,
  fleetSharingGate,
  fleetSourceIntent,
  fleetSourceAuthority,
  fleetPublisherLease,
  fleetTelemetryRow,
  auditLog,
  outbox,
} from "@/db/schema";
import type {
  AutomaticClaim,
  AutomaticToken,
  AutomaticAuthLossProof,
  AutomaticRetryFailure,
  AutomaticTask,
} from "@/core/fleet-automatic";
import {
  reconcileAutomaticCandidateBinding,
  automaticCandidateAdmissible,
  automaticRetrySchedule,
} from "@/core/fleet-automatic";
import * as automatic from "@/services/fleet-automatic";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

it("opposite admission discriminants enforce all three negative assertions in an isolated compiler copy", () => {
  const config = ts.readConfigFile(resolve("tsconfig.json"), (path) =>
    ts.sys.readFile(path),
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const corePath = resolve("src/core/fleet-automatic.ts");
  const proofPath = resolve("tests/helpers/fleet-automatic-typeproof.ts");
  const source = readFileSync(corePath, "utf8");
  function compile(text: string) {
    const options = { ...parsed.options, incremental: false, noEmit: true };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, language, onError, fresh) =>
      resolve(file) === corePath
        ? ts.createSourceFile(file, text, language, true)
        : getSourceFile(file, language, onError, fresh);
    const program = ts.createProgram([proofPath], options, host);
    return ts.getPreEmitDiagnostics(program);
  }
  expect(
    compile(source).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  ).toEqual([]);
  const mutant = source
    .replace('admission: "admitted";', "")
    .replace('admission: "rejected";', "");
  const diagnostics = compile(mutant);
  expect(diagnostics.map((d) => ({ code: d.code, file: d.file?.fileName }))).toEqual([
    { code: 2578, file: proofPath },
    { code: 2578, file: proofPath },
    { code: 2578, file: proofPath },
  ]);
}, 30000);

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
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
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
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
  // Retained queue reservation INPUT only. No source, token verification, bind,
  // authority or positive commit is fabricated by this fixture.
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
  return { owner, boss, ...device, candidate, task };
}
async function row() {
  return (
    await ctx.db
      .select()
      .from(fleetAutomaticCandidate)
      .where(eq(fleetAutomaticCandidate.characterId, 99001))
  )[0];
}
async function outside() {
  return Promise.all([
    ctx.db.select().from(character),
    ctx.db.select().from(account),
    ctx.db.select().from(fleetAutomaticConsent),
    ctx.db.select().from(fleetAutomaticReceipt),
    ctx.db.select().from(fleetDevice),
    ctx.db.select().from(fleetDeviceSession),
    ctx.db.select().from(fleetSourceIntent),
    ctx.db.select().from(fleetSourceAuthority),
    ctx.db.select().from(fleetPublisherLease),
    ctx.db.select().from(fleetTelemetryRow),
    ctx.db.select().from(auditLog),
    ctx.db.select().from(outbox),
  ]);
}
async function claim(p: Awaited<ReturnType<typeof setup>>) {
  const value = await automatic.claimFleetAutomaticDiscovery(ctx.db, p.task, () =>
    at(2000),
  );
  expect(value).not.toBeNull();
  return value!;
}
// Detached stage witnesses test the settlement port, NOT cryptographic proof or
// real HTTP provenance. S3 owns their trusted construction and real bind.
function token(claim: AutomaticClaim): AutomaticToken {
  return {
    admission: "admitted",
    claim,
    settledTokenEnc: claim.boss.refreshTokenEnc!,
    accessTokenExpiresAt: at(60000),
  };
}
function proof(claim: AutomaticClaim): AutomaticAuthLossProof {
  return {
    cause: "verified_scope_missing",
    rejected: { ...token(claim), admission: "rejected" },
  };
}

it.each(["fleet_read_invalid", "identity_changed"] as const)(
  "status honors %s before old-consent reconciliation, across reOn and ordinary rotation",
  async (lastOutcome) => {
    const p = await setup();
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ lastOutcome, reservationId: null, enqueueUntil: null });
    expect(
      await automatic.controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 3, now: at(2000) },
        {
          protocol: 2,
          request_id: randomUUID(),
          intent_created_at: at(2000).toISOString(),
          enabled: true,
          expected_generation: 1,
          expected_revision: 1,
        },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        status: {
          readiness: "authorization_required",
          recovery_action: "authorize_fleet_read",
        },
      },
    });
    expect((await row()).consentGeneration).toBe(1);
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: "ordinary-rotation", tokenStatus: "needs_reauth" });
    vi.resetModules();
    const restarted = await import("@/services/fleet-automatic");
    const freshConnection = createDb(TEST_URL);
    try {
      expect(
        await restarted.readFleetAutomatic(freshConnection.db, {
          sessionId: p.sessionId,
          revision: 4,
          now: at(100000),
        }),
      ).toMatchObject({
        ok: true,
        value: { status: { readiness: "authorization_required" } },
      });
    } finally {
      await freshConnection.pool.end();
    }
    expect((await ctx.db.select().from(character))[0].scopes).toEqual([FLEET_READ_SCOPE]);
    await seedCharacter(ctx.db, testConfig(), {
      id: 99002,
      accountId: p.owner.id,
      scopes: [FLEET_READ_SCOPE],
    });
    expect(
      await automatic.readFleetAutomatic(ctx.db, {
        sessionId: p.sessionId,
        revision: 5,
        now: at(101000),
      }),
    ).toMatchObject({ ok: true, value: { status: { readiness: "waiting_for_fleet" } } });
  },
);

it("consumes a reservation once into a strict 30-second source-free claim without session dependence", async () => {
  const p = await setup();
  await ctx.db.delete(fleetDeviceSession);
  const before = await outside();
  const c = await claim(p);
  expect(c).toEqual({
    task: p.task,
    consentRevision: 1,
    approverDeviceId: p.device.id,
    boss: p.boss,
    claimGeneration: 1,
    claimExpiresAt: at(32000),
  });
  expect(await row()).toMatchObject({
    reservationId: null,
    enqueueUntil: null,
    claimReservationId: p.task.reservationId,
    claimGeneration: 1,
    claimExpiresAt: at(32000),
    sourceId: null,
  });
  expect(
    await automatic.claimFleetAutomaticDiscovery(ctx.db, p.task, () => at(3000)),
  ).toBeNull();
  expect(await outside()).toEqual(before);
});

it.each([
  "verified_scope_missing",
  "verified_subject_mismatch",
  "verified_owner_mismatch",
  "esi_membership_unauthorized",
] as const)(
  "%s latches only the current candidate and preserves counters, failure count and later pacing",
  async (cause) => {
    const p = await setup();
    const c = await claim(p);
    const before = await outside();
    const witness: AutomaticAuthLossProof =
      cause === "esi_membership_unauthorized"
        ? { cause, token: token(c) }
        : { cause, rejected: { ...token(c), admission: "rejected" } };
    expect(
      await automatic.settleFleetAutomaticAuthorizationLoss(
        ctx.db,
        witness,
        at(120000),
        () => at(3000),
      ),
    ).toBe("suspended");
    expect(await row()).toEqual({
      ...p.candidate,
      reservationId: null,
      enqueueUntil: null,
      claimReservationId: null,
      claimExpiresAt: null,
      claimGeneration: 1,
      nextAttemptAt: at(120000),
      lastOutcome: cause.includes("mismatch") ? "identity_changed" : "fleet_read_invalid",
    });
    expect(await outside()).toEqual(before);
    const suspended = await row();
    await automatic.settleFleetAutomaticDiscovery(
      ctx.db,
      c,
      { outcome: "service_unavailable", nextAttemptAt: at(200000) },
      () => at(4000),
    );
    expect(await row()).toEqual(suspended);
  },
);

it.each([
  "task",
  "claim",
  "reservation",
  "new-reservation",
  "consent",
  "revision",
  "approver",
  "token",
  "expiry",
  "jwt-expiry",
  "member",
  "mode",
  "key",
  "revoke",
  "approval",
  "device-account",
  "owner",
  "link",
  "account",
  "grant",
  "source",
  "stored-expiry",
] as const)(
  "stale %s authorization proof is fenced with every row unchanged",
  async (loss) => {
    const p = await setup();
    const c = await claim(p);
    let w = proof(c);
    if (loss === "task") w = proof({ ...c, task: { ...c.task, candidateGeneration: 2 } });
    if (loss === "claim") w = proof({ ...c, claimGeneration: 2 });
    if (loss === "reservation")
      w = proof({ ...c, task: { ...c.task, reservationId: randomUUID() } });
    if (loss === "new-reservation")
      await ctx.db.update(fleetAutomaticCandidate).set({
        reservationId: randomUUID(),
        enqueueUntil: at(20000),
        claimReservationId: null,
        claimExpiresAt: null,
      });
    if (loss === "consent")
      await ctx.db.update(fleetAutomaticConsent).set({ generation: 2, revision: 2 });
    if (loss === "revision")
      await ctx.db.update(fleetAutomaticConsent).set({ revision: 2 });
    if (loss === "approver")
      await ctx.db.update(fleetAutomaticConsent).set({ approvingDeviceId: randomUUID() });
    if (loss === "token")
      await ctx.db.update(character).set({ refreshTokenEnc: "rotated" });
    if (loss === "jwt-expiry")
      w = {
        cause: "verified_scope_missing",
        rejected: { ...token(c), admission: "rejected", accessTokenExpiresAt: at(3000) },
      };
    if (loss === "member") await ctx.db.update(account).set({ tier: "alumni" });
    if (loss === "mode") await ctx.db.update(fleetSharingGate).set({ enabled: false });
    if (loss === "key")
      await ctx.db
        .update(fleetDeviceKeyIdentity)
        .set({ conflicted: true, deviceId: null });
    if (loss === "revoke") await ctx.db.update(fleetDevice).set({ revokedAt: at(3000) });
    if (loss === "approval")
      await ctx.db.update(fleetDevice).set({ approvedCapabilities: [] });
    if (loss === "device-account") {
      const other = await seedAccount(ctx.db);
      await ctx.db.update(fleetDevice).set({ accountId: other.id });
    }
    if (loss === "owner") await ctx.db.update(character).set({ ownerHash: "changed" });
    if (loss === "link")
      await ctx.db.update(character).set({ fleetLinkEpoch: randomUUID() });
    if (loss === "account") {
      const other = await seedAccount(ctx.db);
      await ctx.db.update(character).set({ accountId: other.id });
    }
    if (loss === "grant") await ctx.db.update(character).set({ scopes: [] });
    if (loss === "source")
      await ctx.db.update(fleetAutomaticCandidate).set({ sourceId: randomUUID() });
    if (loss === "stored-expiry")
      await ctx.db.update(fleetAutomaticCandidate).set({ claimExpiresAt: at(31000) });
    const before = [await row(), await outside()];
    expect(
      await automatic.settleFleetAutomaticAuthorizationLoss(ctx.db, w, at(200000), () =>
        at(loss === "expiry" ? 32000 : 3000),
      ),
    ).toBe("fenced");
    expect([await row(), await outside()]).toEqual(before);
  },
);

it("uses the current settled blob, not the pre-refresh claim snapshot", async () => {
  const p = await setup();
  const c = await claim(p);
  await ctx.db.update(character).set({ refreshTokenEnc: "settled-rotation" });
  const w: AutomaticAuthLossProof = {
    cause: "verified_scope_missing",
    rejected: { ...token(c), admission: "rejected", settledTokenEnc: "settled-rotation" },
  };
  expect(
    await automatic.settleFleetAutomaticAuthorizationLoss(ctx.db, w, null, () =>
      at(3000),
    ),
  ).toBe("suspended");
});

it.each([
  "positive-rejected",
  "negative-admitted",
  "bound-rejected",
  "wrong-stage",
  "malformed-expiry",
  "missing-claim",
] as const)("rejects malformed/wrong branch %s before any write", async (kind) => {
  const p = await setup();
  const c = await claim(p);
  const t = token(c);
  const bad: unknown =
    kind === "positive-rejected"
      ? { cause: "esi_membership_unauthorized", token: { ...t, admission: "rejected" } }
      : kind === "negative-admitted"
        ? { cause: "verified_scope_missing", rejected: t }
        : kind === "bound-rejected"
          ? {
              cause: "esi_roster_unauthorized",
              bound: {
                token: { ...t, admission: "rejected" },
                fleetId: 123,
                linkedCharacters: [],
                expectedAuthorityGeneration: 0,
                membershipRetryAt: at(10000),
              },
            }
          : kind === "wrong-stage"
            ? { cause: "esi_roster_unauthorized", token: t }
            : kind === "missing-claim"
              ? { cause: "verified_scope_missing", rejected: { admission: "rejected" } }
              : {
                  cause: "verified_scope_missing",
                  rejected: {
                    ...t,
                    admission: "rejected",
                    accessTokenExpiresAt: new Date(NaN),
                  },
                };
  const before = [await row(), await outside()];
  expect(
    await automatic.settleFleetAutomaticAuthorizationLoss(
      ctx.db,
      bad as AutomaticAuthLossProof,
      null,
      () => at(3000),
    ),
  ).toBe("fenced");
  expect([await row(), await outside()]).toEqual(before);
});

it.each(["fleet_read_invalid", "identity_changed", "not_in_fleet", "not_boss"] as const)(
  "claim-only generic settlement cannot assert %s",
  async (outcome) => {
    const p = await setup();
    const c = await claim(p);
    const before = [await row(), await outside()];
    await automatic.settleFleetAutomaticDiscovery(
      ctx.db,
      c,
      { outcome, nextAttemptAt: null } as AutomaticRetryFailure,
      () => at(3000),
    );
    expect([await row(), await outside()]).toEqual(before);
  },
);

it("healthy membership404 needs an admitted token and resets failures, while claim-only transient backs off", async () => {
  const p = await setup();
  const c = await claim(p);
  await automatic.settleFleetAutomaticDiscovery(
    ctx.db,
    token(c),
    { outcome: "not_in_fleet", nextAttemptAt: at(100000) },
    () => at(3000),
  );
  expect(await row()).toMatchObject({
    lastOutcome: "not_in_fleet",
    failureCount: 0,
    nextAttemptAt: at(100000),
    claimReservationId: null,
  });
  await ctx.db.update(fleetAutomaticCandidate).set({
    reservationId: randomUUID(),
    enqueueUntil: at(120000),
    nextAttemptAt: at(100000),
  });
  const next = await row();
  const c2 = await automatic.claimFleetAutomaticDiscovery(
    ctx.db,
    { ...p.task, reservationId: next.reservationId! },
    () => at(100000),
  );
  expect(c2).not.toBeNull();
  await automatic.settleFleetAutomaticDiscovery(
    ctx.db,
    c2!,
    { outcome: "service_unavailable", nextAttemptAt: null },
    () => at(101000),
  );
  const settled = await row();
  expect(settled).toMatchObject({
    lastOutcome: "service_unavailable",
    failureCount: 1,
    claimGeneration: 2,
    claimReservationId: null,
  });
  expect(settled.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(at(131000).getTime());
  expect(settled.nextAttemptAt.getTime()).toBeLessThanOrEqual(at(134000).getTime());
});

it.each([
  "suspended",
  "due",
  "enqueue-expiry",
  "source",
  "candidate-max",
  "claim-max",
  "task-uuid",
] as const)("claim admission refuses %s without reviving work", async (loss) => {
  const p = await setup();
  if (loss === "suspended")
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ lastOutcome: "fleet_read_invalid" });
  if (loss === "due")
    await ctx.db.update(fleetAutomaticCandidate).set({ nextAttemptAt: at(3000) });
  if (loss === "source")
    await ctx.db.update(fleetAutomaticCandidate).set({ sourceId: randomUUID() });
  if (loss === "candidate-max")
    await ctx.db.update(fleetAutomaticCandidate).set({
      candidateGeneration: Number.MAX_SAFE_INTEGER,
      reservationId: null,
      enqueueUntil: null,
    });
  if (loss === "claim-max")
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ claimGeneration: Number.MAX_SAFE_INTEGER - 1 });
  const before = await outside();
  expect(
    await automatic.claimFleetAutomaticDiscovery(
      ctx.db,
      loss === "task-uuid" ? { ...p.task, reservationId: randomUUID() } : p.task,
      () => at(loss === "enqueue-expiry" ? 11000 : 2000),
    ),
  ).toBeNull();
  expect((await row()).claimReservationId).toBeNull();
  if (loss === "claim-max")
    expect(await row()).toMatchObject({
      lastOutcome: "capacity_limited",
      reservationId: null,
      enqueueUntil: null,
      claimGeneration: Number.MAX_SAFE_INTEGER - 1,
    });
  expect(await outside()).toEqual(before);
});

it.each(["claim", "jwt"] as const)(
  "samples strict %s expiry after the final approver lock wait",
  async (expiry) => {
    const p = await setup();
    const c = await claim(p);
    const w = proof(c);
    const holder = await ctx.pool.connect();
    let work: Promise<unknown> | undefined;
    let now = at(3000);
    try {
      await holder.query("begin");
      await holder.query("select id from fleet_device where id=$1 for update", [
        p.device.id,
      ]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      const witness =
        expiry === "jwt"
          ? {
              cause: "verified_scope_missing" as const,
              rejected: {
                ...token(c),
                admission: "rejected" as const,
                accessTokenExpiresAt: at(4000),
              },
            }
          : w;
      const before = await row();
      work = automatic.settleFleetAutomaticAuthorizationLoss(
        ctx.db,
        witness,
        null,
        () => now,
      );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      now = at(expiry === "claim" ? 32000 : 4000);
      await holder.query("commit");
      expect(await work).toBe("fenced");
      expect(await row()).toEqual(before);
    } finally {
      await holder.query("rollback");
      holder.release();
      await work;
    }
  },
);

it("same-binding reconciliation preserves latch/pacing/exhaustion and changes only callback binding", async () => {
  const p = await setup();
  const old = {
    ...p.candidate,
    lastOutcome: "identity_changed" as const,
    nextAttemptAt: at(200000),
    claimGeneration: Number.MAX_SAFE_INTEGER,
    reservationId: null,
    enqueueUntil: null,
  };
  const reconciled = reconcileAutomaticCandidateBinding(old, p.boss, 2);
  expect(reconciled).toEqual({ ...old, consentGeneration: 2, candidateGeneration: 2 });
  expect(automaticCandidateAdmissible(reconciled!, p.boss, 2, at(300000))).toBe(false);
  const exhausted = { ...old, candidateGeneration: Number.MAX_SAFE_INTEGER };
  expect(reconcileAutomaticCandidateBinding(exhausted, p.boss, 2)).toEqual(exhausted);
  const changed = reconcileAutomaticCandidateBinding(
    p.candidate,
    { ...p.boss, fleetLinkEpoch: randomUUID() },
    2,
  )!;
  expect(changed).toMatchObject({
    candidateGeneration: 2,
    claimGeneration: 0,
    lastOutcome: null,
    reservationId: null,
    sourceId: null,
  });
  expect(changed.nextAttemptAt).toEqual(p.candidate.nextAttemptAt);
});

it("cadence has exact domain jitter, negative reset, capped transient backoff and invalid-timing fallback", () => {
  const task = {
    accountId: "11111111-1111-4111-8111-111111111111",
    characterId: 99001,
    consentGeneration: 1,
  };
  // SHA-256 independently calculated from the contract's five UTF-8 lines.
  const input = { ...task, claimGeneration: 1, failureCount: 6, nextAttemptAt: at(0) };
  const negative = automaticRetrySchedule(input, "not_in_fleet", at(1000), at(0));
  expect(negative.failureCount).toBe(0);
  expect(negative.nextAttemptAt).toEqual(at(30000 + 935));
  const transient = automaticRetrySchedule(input, "service_unavailable", null, at(0));
  expect(transient).toEqual({ failureCount: 6, nextAttemptAt: at(900000 + 935) });
  expect(
    automaticRetrySchedule(
      { ...input, failureCount: 0 },
      "untrustworthy_evidence",
      new Date(NaN),
      at(0),
    ).nextAttemptAt,
  ).toEqual(at(60000));
  expect(
    automaticRetrySchedule(input, "not_boss", at(2000000), at(0)).nextAttemptAt,
  ).toEqual(at(2000000));
  expect(
    automaticRetrySchedule(
      { ...input, failureCount: 0 },
      "service_unavailable",
      new Date("+010000-01-01T00:00:00.000Z"),
      at(0),
    ).nextAttemptAt,
  ).toEqual(at(60000));
});

it("the final healthy-settled claim reports capacity without another reservation", async () => {
  const p = await setup();
  await ctx.db
    .update(fleetAutomaticCandidate)
    .set({ claimGeneration: Number.MAX_SAFE_INTEGER - 2 });
  const c = await claim(p);
  expect(c.claimGeneration).toBe(Number.MAX_SAFE_INTEGER - 1);
  expect(
    await automatic.readFleetAutomatic(ctx.db, {
      sessionId: p.sessionId,
      revision: 3,
      now: at(2500),
    }),
  ).toMatchObject({ ok: true, value: { status: { readiness: "verifying" } } });
  const before = await outside();
  await automatic.settleFleetAutomaticDiscovery(
    ctx.db,
    token(c),
    {
      outcome: "not_in_fleet",
      nextAttemptAt: at(100000),
    },
    () => at(3000),
  );
  const settled = await row();
  expect(settled).toMatchObject({
    candidateGeneration: 1,
    claimGeneration: Number.MAX_SAFE_INTEGER - 1,
    lastOutcome: "not_in_fleet",
    failureCount: 0,
    reservationId: null,
    enqueueUntil: null,
    claimReservationId: null,
    claimExpiresAt: null,
    nextAttemptAt: at(100000),
    sourceId: null,
  });
  expect(await outside()).toEqual(before);
  expect(automaticCandidateAdmissible(settled, p.boss, 1, at(100000))).toBe(false);
  expect(
    await automatic.readFleetAutomatic(ctx.db, {
      sessionId: p.sessionId,
      revision: 4,
      now: at(100000),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      status: {
        readiness: "capacity_limited",
        recovery_action: "wait",
      },
    },
  });
  expect(await row()).toEqual(settled);
});

it("exhaustion is reported as capacity rather than retaining an unclaimable reservation", async () => {
  const p = await setup();
  await ctx.db
    .update(fleetAutomaticCandidate)
    .set({ claimGeneration: Number.MAX_SAFE_INTEGER - 1 });
  expect(
    await automatic.claimFleetAutomaticDiscovery(ctx.db, p.task, () => at(2000)),
  ).toBeNull();
  expect(
    await automatic.readFleetAutomatic(ctx.db, {
      sessionId: p.sessionId,
      revision: 3,
      now: at(3000),
    }),
  ).toMatchObject({ ok: true, value: { status: { readiness: "capacity_limited" } } });
});

it.each(["fleet_read_invalid", "identity_changed"] as const)(
  "reconciled same-binding %s still blocks a later due claim after Off/On",
  async (lastOutcome) => {
    const p = await setup();
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ lastOutcome, reservationId: null, enqueueUntil: null });
    expect(
      await automatic.controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 3, now: at(2000) },
        {
          protocol: 2,
          request_id: randomUUID(),
          intent_created_at: at(2000).toISOString(),
          enabled: false,
          expected_generation: 1,
          expected_revision: 1,
        },
      ),
    ).toMatchObject({ ok: true, value: { status: { readiness: "off" } } });
    expect(
      await automatic.controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 4, now: at(3000) },
        {
          protocol: 2,
          request_id: randomUUID(),
          intent_created_at: at(3000).toISOString(),
          enabled: true,
          expected_generation: 1,
          expected_revision: 2,
        },
      ),
    ).toMatchObject({ ok: true });
    const reconciled = reconcileAutomaticCandidateBinding(await row(), p.boss, 2)!;
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ ...reconciled, reservationId: randomUUID(), enqueueUntil: at(301000) });
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: "ordinary-rotation", tokenStatus: "valid" });
    const pending = await row();
    const before = await outside();
    expect(
      await automatic.claimFleetAutomaticDiscovery(
        ctx.db,
        {
          ...p.task,
          consentGeneration: 2,
          candidateGeneration: pending.candidateGeneration,
          reservationId: pending.reservationId!,
        },
        () => at(300000),
      ),
    ).toBeNull();
    expect(await row()).toEqual(pending);
    expect(await outside()).toEqual(before);
  },
);

it.each([
  "off",
  "consent-generation",
  "member",
  "mode",
  "key-unready",
  "key-unbound",
  "approver-missing",
  "revoke",
  "approval",
  "owner",
  "link",
  "grant",
  "candidate-generation",
  "task-character",
  "malformed-task",
] as const)("claim refuses %s admission with every row unchanged", async (loss) => {
  const p = await setup();
  let task = p.task;
  if (loss === "off")
    await ctx.db.update(fleetAutomaticConsent).set({
      enabled: false,
      revision: 2,
      disabledAt: at(2000),
      closedReason: "explicit_off",
    });
  if (loss === "consent-generation") task = { ...task, consentGeneration: 2 };
  if (loss === "member") await ctx.db.update(account).set({ tier: "alumni" });
  if (loss === "mode") await ctx.db.update(fleetSharingGate).set({ enabled: false });
  if (loss === "key-unready")
    await ctx.db
      .update(fleetSharingGate)
      .set({ enabled: false, keyIdentityPhase: "pending" });
  if (loss === "key-unbound") await ctx.db.delete(fleetDeviceKeyIdentity);
  if (loss === "approver-missing")
    await ctx.db.update(fleetAutomaticConsent).set({ approvingDeviceId: randomUUID() });
  if (loss === "revoke") await ctx.db.update(fleetDevice).set({ revokedAt: at(2000) });
  if (loss === "approval")
    await ctx.db.update(fleetDevice).set({ approvedCapabilities: [] });
  if (loss === "owner") await ctx.db.update(character).set({ ownerHash: "changed" });
  if (loss === "link")
    await ctx.db.update(character).set({ fleetLinkEpoch: randomUUID() });
  if (loss === "grant") await ctx.db.update(character).set({ tokenStatus: "invalid" });
  if (loss === "candidate-generation") task = { ...task, candidateGeneration: 2 };
  if (loss === "task-character") task = { ...task, characterId: 99002 };
  if (loss === "malformed-task")
    task = { ...task, candidateGeneration: true as unknown as number };
  const before = [await row(), await outside()];
  expect(
    await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () => at(2000)),
  ).toBeNull();
  expect([await row(), await outside()]).toEqual(before);
});

it("claim deadline starts after the final wait; a reservation expired during that wait is not consumed", async () => {
  const p = await setup();
  const holder = await ctx.pool.connect();
  let work: Promise<unknown> | undefined;
  let now = at(2000);
  try {
    await holder.query("begin");
    await holder.query("select id from fleet_device where id=$1 for update", [
      p.device.id,
    ]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    work = automatic.claimFleetAutomaticDiscovery(ctx.db, p.task, () => now);
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    now = at(10000);
    await holder.query("commit");
    expect(await work).toMatchObject({ claimExpiresAt: at(40000) });
    await ctx.db.update(fleetAutomaticCandidate).set({
      claimReservationId: null,
      claimExpiresAt: null,
      reservationId: p.task.reservationId,
      enqueueUntil: at(11000),
    });
    await holder.query("begin");
    await holder.query("select id from fleet_device where id=$1 for update", [
      p.device.id,
    ]);
    work = automatic.claimFleetAutomaticDiscovery(ctx.db, p.task, () => now);
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    now = at(11000);
    await holder.query("commit");
    expect(await work).toBeNull();
    expect((await row()).claimGeneration).toBe(1);
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

it("selector expansion restarts the whole claim transaction instead of retaining earlier locks", async () => {
  const p = await setup();
  const holder = await ctx.pool.connect();
  let work: Promise<unknown> | undefined;
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(1, hashint8($1))", [p.boss.id]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    work = automatic.claimFleetAutomaticDiscovery(ctx.db, p.task, () => at(2000));
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    // The legitimate earlier-level identity writer changes a selector while the
    // claim is parked. Its old probe must roll back, not take new earlier locks.
    await holder.query("update character set fleet_link_epoch=$1 where id=$2", [
      randomUUID(),
      p.boss.id,
    ]);
    await holder.query("commit");
    expect(await work).toBeNull();
    expect(await row()).toEqual(p.candidate);
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

it("candidate storage failure rolls back without credential or authority side effects", async () => {
  const p = await setup();
  const c = await claim(p);
  const before = [await row(), await outside()];
  await expect(
    withInjectedPgFault(
      ctx.pool,
      { matchSql: /^update "fleet_automatic_candidate"/i, code: "23514" },
      () =>
        automatic.settleFleetAutomaticAuthorizationLoss(ctx.db, proof(c), null, () =>
          at(3000),
        ),
    ),
  ).rejects.toThrow();
  expect([await row(), await outside()]).toEqual(before);
});

it("mode and Member restoration cannot wake a retained same-binding suspension", async () => {
  const p = await setup();
  const c = await claim(p);
  expect(
    await automatic.settleFleetAutomaticAuthorizationLoss(ctx.db, proof(c), null, () =>
      at(3000),
    ),
  ).toBe("suspended");
  const suspended = await row();
  const [gate] = await ctx.db.select().from(fleetSharingGate);
  const off = await transitionFleetSharingMode(ctx.db, {
    enabled: false,
    expectedRevision: gate.revision,
    now: at(4000),
  });
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: off.revision,
    now: at(5000),
  });
  await ctx.db.update(account).set({ tier: "alumni" }).where(eq(account.id, p.owner.id));
  await ctx.db.update(account).set({ tier: "member" }).where(eq(account.id, p.owner.id));
  expect(await row()).toEqual(suspended);
  await ctx.db
    .update(fleetAutomaticCandidate)
    .set({ reservationId: randomUUID(), enqueueUntil: at(110000) });
  const pending = await row();
  expect(
    await automatic.claimFleetAutomaticDiscovery(
      ctx.db,
      { ...p.task, reservationId: pending.reservationId! },
      () => at(100000),
    ),
  ).toBeNull();
  expect(await row()).toEqual(pending);
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
});

it("a loss preserves later retained pacing and every sibling candidate", async () => {
  const p = await setup();
  const c = await claim(p);
  const siblingBoss = await seedCharacter(ctx.db, testConfig(), {
    id: 99002,
    accountId: p.owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const [sibling] = await ctx.db
    .insert(fleetAutomaticCandidate)
    .values({
      ...p.candidate,
      characterId: siblingBoss.id,
      ownerHash: siblingBoss.ownerHash,
      linkEpoch: siblingBoss.fleetLinkEpoch,
      reservationId: randomUUID(),
    })
    .returning();
  await ctx.db
    .update(fleetAutomaticCandidate)
    .set({ nextAttemptAt: at(250000) })
    .where(eq(fleetAutomaticCandidate.characterId, p.boss.id));
  const before = await outside();
  expect(
    await automatic.settleFleetAutomaticAuthorizationLoss(
      ctx.db,
      proof(c),
      at(120000),
      () => at(3000),
    ),
  ).toBe("suspended");
  expect((await row()).nextAttemptAt).toEqual(at(250000));
  expect(
    (
      await ctx.db
        .select()
        .from(fleetAutomaticCandidate)
        .where(eq(fleetAutomaticCandidate.characterId, siblingBoss.id))
    )[0],
  ).toEqual(sibling);
  expect(await outside()).toEqual(before);
});

it.each(["not_boss", "fleet_read_invalid", "identity_changed"] as const)(
  "generic admitted-token settlement refuses forbidden/wrong-stage %s",
  async (outcome) => {
    const p = await setup();
    const c = await claim(p);
    const before = [await row(), await outside()];
    await automatic.settleFleetAutomaticDiscovery(
      ctx.db,
      token(c),
      { outcome, nextAttemptAt: null } as AutomaticRetryFailure,
      () => at(3000),
    );
    await automatic.settleFleetAutomaticDiscovery(
      ctx.db,
      { ...token(c), admission: "rejected" } as unknown as AutomaticToken,
      { outcome: "not_in_fleet", nextAttemptAt: null },
      () => at(3000),
    );
    expect([await row(), await outside()]).toEqual(before);
  },
);
