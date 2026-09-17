import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/db";
import {
  account,
  character,
  fleetAutomaticCandidate,
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetDevice,
  fleetDeviceSession,
  fleetSourceIntent,
  fleetSourceAuthority,
  outbox,
} from "@/db/schema";
import type { AutomaticTask } from "@/core/fleet-automatic";
import * as automatic from "@/services/fleet-automatic";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  handleEveLogin,
  completeFleetReadGrant,
  linkCharacter,
} from "@/services/accounts";
import { createSession } from "@/services/session";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { fleetLifecycleTransaction } from "@/services/fleet-lifecycle";
import { createEsiClient, FLEET_READ_SCOPE } from "@/lib/esi/client";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import {
  createFleetSourceMemory,
  runFleetSourceJob,
  type FleetSourceDeps,
} from "@/jobs/fleet-source";
import { runTokenHealthJob } from "@/jobs/token-health";
import { attemptClaimedFleetAutomaticDiscovery } from "@/jobs/fleet-automatic";
import { dispatchOutbox } from "@/worker/dispatcher";
import { enqueueSync } from "@/services/outbox";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import { withInjectedPgFault } from "./helpers/pg-fault";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const cfg = testConfig();
const keys = await generateKeyPair("RS256");
const getKey = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keys.publicKey)), alg: "RS256" }],
});
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
});
afterAll(() => ctx.cleanup());

async function enroll(id = 99001, granted = true) {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, cfg, {
    id,
    accountId: owner.id,
    scopes: granted ? [...cfg.eveSso.scopes, FLEET_READ_SCOPE] : [],
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
  let revision = 1;
  let now = at(2000);
  const options = {
    fleetId: 123,
    status: 200,
    scopes: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
  };
  const requests: string[] = [];
  const tokens = new Set<string>();
  async function jwt() {
    return new SignJWT({
      sub: `CHARACTER:EVE:${boss.id}`,
      owner: boss.ownerHash,
      name: boss.name,
      scp: options.scopes,
      exp: Math.max(Date.now(), now.getTime()) / 1000 + 300,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .sign(keys.privateKey);
  }
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = String(raw);
    requests.push(url);
    if (url === "https://login.eveonline.com/v2/oauth/token") {
      const access_token = await jwt();
      tokens.add(access_token);
      return Response.json({
        access_token,
        refresh_token: `rotation-${requests.length}`,
      });
    }
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    expect(tokens.has(bearer.slice(7))).toBe(true);
    const membership =
      url === `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`;
    expect(url).toBe(
      membership
        ? `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`
        : `https://esi.evetech.net/latest/fleets/${options.fleetId}/members/`,
    );
    const response = Response.json(
      membership
        ? { fleet_id: options.fleetId, fleet_boss_id: boss.id }
        : options.status === 200
          ? [{ character_id: boss.id }]
          : { error: "synthetic" },
      {
        status: membership ? 200 : options.status,
        headers: {
          Date: now.toUTCString(),
          "Cache-Control": `max-age=${membership ? 60 : 5}`,
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      },
    );
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const deps: FleetSourceDeps = {
    db: ctx.db,
    cfg,
    fetchImpl,
    getKey,
    now: () => now,
    memory: createFleetSourceMemory(),
    esi: createEsiClient({ now: () => now.getTime() }),
  };
  async function consent(enabled = true) {
    const [old] = await ctx.db
      .select()
      .from(fleetAutomaticConsent)
      .where(eq(fleetAutomaticConsent.accountId, owner.id));
    expect(
      await automatic.controlFleetAutomatic(
        ctx.db,
        { sessionId: device.sessionId, revision: ++revision, now },
        {
          protocol: 2,
          request_id: randomUUID(),
          intent_created_at: now.toISOString(),
          enabled,
          expected_generation: old?.generation ?? 0,
          expected_revision: old?.revision ?? 0,
        },
      ),
    ).toMatchObject({ ok: true });
  }
  async function status() {
    return automatic.readFleetAutomatic(ctx.db, {
      sessionId: device.sessionId,
      revision: ++revision,
      now,
    });
  }
  await consent();
  return {
    owner,
    boss,
    ...device,
    deps,
    requests,
    options,
    consent,
    status,
    jwt,
    now: () => now,
    setNow: (ms: number) => {
      now = at(ms);
    },
  };
}
async function candidates() {
  return ctx.db
    .select()
    .from(fleetAutomaticCandidate)
    .orderBy(fleetAutomaticCandidate.characterId);
}
async function task(id = 99001): Promise<AutomaticTask> {
  const c = (await candidates()).find((c) => c.characterId === id)!;
  expect(c.reservationId).toEqual(expect.any(String));
  return {
    accountId: c.accountId,
    characterId: id,
    consentGeneration: c.consentGeneration,
    candidateGeneration: c.candidateGeneration,
    reservationId: c.reservationId!,
  };
}
async function automaticOutbox() {
  return ctx.db
    .select()
    .from(outbox)
    .where(sql`${outbox.payload}->>'kind' = 'fleet-automatic'`)
    .orderBy(outbox.id);
}
const reserve = (clock: () => Date, db = ctx.db) =>
  automatic.reserveDueFleetAutomatic(db, clock);

it("real due reservation persists one exact 10s outbox atomically, then actual claim/attempt/positive commit creates authority", async () => {
  const p = await enroll();
  const consentBefore = await ctx.db.select().from(fleetAutomaticConsent);
  const receiptsBefore = await ctx.db.select().from(fleetAutomaticReceipt);
  expect(await reserve(p.now)).toBe(1);
  const input = await task();
  expect(input.reservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect((await candidates())[0]).toMatchObject({
    candidateGeneration: 1,
    claimGeneration: 0,
    enqueueUntil: at(12000),
    nextAttemptAt: at(2000),
    sourceId: null,
  });
  expect((await automaticOutbox()).map((r) => r.payload)).toEqual([
    { kind: "fleet-automatic", ...input },
  ]);
  const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, input, p.now);
  expect(claim).not.toBeNull();
  expect(await automatic.claimFleetAutomaticDiscovery(ctx.db, input, p.now)).toBeNull();
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
  const pending = await attemptClaimedFleetAutomaticDiscovery(p.deps, claim!);
  expect(pending.result).toBe("UNCOMMITTED");
  if (pending.result !== "UNCOMMITTED") throw new Error("missing positive continuation");
  const result = await automatic.commitFleetAutomaticDiscovery(
    ctx.db,
    pending.bound,
    pending.verified,
    p.now,
  );
  expect(result).toMatchObject({ result: "created", sourceGeneration: 1 });
  if (!("sourceId" in result)) throw new Error("missing source");
  expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
    sourceId: result.sourceId,
    authorityGeneration: 1,
  });
  expect((await candidates())[0]).toMatchObject({
    sourceId: result.sourceId,
    lastOutcome: "verified",
    claimReservationId: null,
  });
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toEqual(receiptsBefore);
  const [consentAfter] = await ctx.db.select().from(fleetAutomaticConsent);
  expect(consentAfter).toEqual({
    ...consentBefore[0],
    nextReconcileAt: consentAfter.nextReconcileAt,
    candidateCursor: consentAfter.candidateCursor,
  });
  expect(p.requests).toHaveLength(3);
});

it("duplicate and expired reservations use a fresh U; expired claims recover after restart without recycling counters", async () => {
  const p = await enroll();
  expect(await reserve(p.now)).toBe(1);
  const first = await task();
  expect(await reserve(p.now)).toBe(0);
  p.setNow(12000);
  expect(await automatic.claimFleetAutomaticDiscovery(ctx.db, first, p.now)).toBeNull();
  expect(await reserve(p.now)).toBe(1);
  const second = await task();
  expect(second.reservationId).not.toBe(first.reservationId);
  expect(await automatic.claimFleetAutomaticDiscovery(ctx.db, first, p.now)).toBeNull();
  const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, second, p.now);
  expect(claim?.claimGeneration).toBe(1);
  p.setNow(42000);
  const restarted = createDb(TEST_URL);
  try {
    expect(await reserve(p.now, restarted.db)).toBe(1);
  } finally {
    await restarted.pool.end();
  }
  const third = await task();
  expect(third.reservationId).not.toBe(second.reservationId);
  expect(await automatic.claimFleetAutomaticDiscovery(ctx.db, second, p.now)).toBeNull();
  expect(
    (await automatic.claimFleetAutomaticDiscovery(ctx.db, third, p.now))?.claimGeneration,
  ).toBe(2);
  expect(p.requests).toEqual([]);
});

it.each(["outbox", "fleet_automatic_consent"])(
  "%s persistence failure rolls back reservation, cursor and outbox",
  async (table) => {
    const p = await enroll();
    const before = await ctx.db.select().from(fleetAutomaticConsent);
    await expect(
      withInjectedPgFault(
        ctx.pool,
        {
          matchSql: new RegExp(`^(?:insert into|update) "${table}"`, "i"),
          code: "23514",
        },
        async () => reserve(p.now),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await candidates()).toEqual([]);
    expect(await automaticOutbox()).toEqual([]);
    expect(await ctx.db.select().from(fleetAutomaticConsent)).toEqual(before);
  },
);

it("candidate/provider pacing survives due scans and restart until its exact lower bound", async () => {
  const p = await enroll();
  await reserve(p.now);
  const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, await task(), p.now);
  await automatic.settleFleetAutomaticDiscovery(
    ctx.db,
    claim!,
    { outcome: "service_unavailable", nextAttemptAt: at(200000) },
    p.now,
  );
  const before = (await candidates())[0];
  expect(before.nextAttemptAt).toEqual(at(200000));
  p.setNow(12000);
  expect(await reserve(p.now)).toBe(0);
  const restarted = createDb(TEST_URL);
  try {
    p.setNow(199999);
    expect(await reserve(p.now, restarted.db)).toBe(0);
    expect((await candidates())[0]).toEqual(before);
    p.setNow(200000);
    expect(await reserve(p.now, restarted.db)).toBe(1);
  } finally {
    await restarted.pool.end();
  }
  expect(p.requests).toEqual([]);
});

it.each(["off", "reOn", "revoke"] as const)(
  "actual %s fences a previously reserved task before another due scan",
  async (action) => {
    const p = await enroll();
    await reserve(p.now);
    const old = await task();
    p.setNow(4000);
    if (action === "revoke")
      await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, p.now());
    else await p.consent(action === "reOn");
    expect(await automatic.claimFleetAutomaticDiscovery(ctx.db, old, p.now)).toBeNull();
    expect(await reserve(p.now)).toBe(action === "reOn" ? 1 : 0);
    if (action === "reOn") {
      const next = await task();
      expect(next.reservationId).not.toBe(old.reservationId);
      expect(next).toMatchObject({ consentGeneration: 2, candidateGeneration: 2 });
      expect(
        await automatic.claimFleetAutomaticDiscovery(ctx.db, next, p.now),
      ).not.toBeNull();
    } else expect(await automaticOutbox()).toEqual([]);
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
    expect(p.requests).toEqual([]);
  },
);

it("no grant persists a bounded 30s rescan with zero HTTP and no source/receipt allocation", async () => {
  const p = await enroll(99001, false);
  const before = await ctx.db.select().from(fleetAutomaticReceipt);
  expect(await reserve(p.now)).toBe(0);
  expect((await candidates())[0]).toMatchObject({
    lastOutcome: "waiting_for_grant",
    nextAttemptAt: at(32000),
    reservationId: null,
  });
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].nextReconcileAt).toEqual(
    at(32000),
  );
  p.setNow(31999);
  expect(await reserve(p.now)).toBe(0);
  expect((await candidates())[0].nextAttemptAt).toEqual(at(32000));
  p.setNow(32000);
  expect(await reserve(p.now)).toBe(0);
  expect((await candidates())[0].nextAttemptAt).toEqual(at(62000));
  expect(p.requests).toEqual([]);
  expect(await automaticOutbox()).toEqual([]);
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toEqual(before);
});

it.each(["reauth", "grant", "scope"] as const)(
  "actual %s wake feeds due scan, claim, real upstream and positive commit, with no seeded reservation",
  async (writer) => {
    const p = await enroll();
    await reserve(p.now);
    const first = await task();
    const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, first, p.now);
    p.options.scopes = [...cfg.eveSso.scopes];
    expect(await attemptClaimedFleetAutomaticDiscovery(p.deps, claim!)).toMatchObject({
      result: "suspended",
    });
    const old = (await candidates())[0];
    expect(old.lastOutcome).toBe("fleet_read_invalid");
    p.setNow(4000);
    await p.consent();
    p.setNow(5000);
    expect(await p.status()).toMatchObject({
      ok: true,
      value: { status: { readiness: "authorization_required" } },
    });
    p.setNow(180000);
    expect(await reserve(p.now)).toBe(0);
    expect((await candidates())[0]).toMatchObject({
      lastOutcome: "fleet_read_invalid",
      candidateGeneration: 2,
      consentGeneration: 2,
      claimGeneration: 1,
    });
    p.options.scopes = [...cfg.eveSso.scopes, FLEET_READ_SCOPE];
    if (writer === "scope") {
      await ctx.db.update(character).set({ scopes: [...cfg.eveSso.scopes] });
      expect(
        await runTokenHealthJob({
          db: ctx.db,
          cfg,
          jwks: getKey,
          fetchImpl: p.deps.fetchImpl,
        }),
      ).toMatchObject({ status: "ok" });
    } else {
      const input = {
        ...(await verifyEveAccessToken(await p.jwt(), getKey)),
        refreshToken: "accepted",
      };
      const session = await createSession(ctx.db, p.owner.id);
      await fleetLifecycleTransaction(ctx.db, async (tx) =>
        writer === "reauth"
          ? await handleEveLogin(tx, cfg, input)
          : await completeFleetReadGrant(tx, cfg, p.owner.id, p.boss.id, input, session),
      );
    }
    expect((await candidates())[0]).toMatchObject({
      lastOutcome: null,
      candidateGeneration: 2,
      claimGeneration: 1,
    });
    const consent = (await ctx.db.select().from(fleetAutomaticConsent))[0];
    p.setNow(consent.nextReconcileAt.getTime() - NOW.getTime());
    expect(await reserve(p.now)).toBe(1);
    const next = await task();
    expect(next.reservationId).not.toBe(first.reservationId);
    const nextClaim = await automatic.claimFleetAutomaticDiscovery(ctx.db, next, p.now);
    const pending = await attemptClaimedFleetAutomaticDiscovery(
      { ...p.deps, memory: createFleetSourceMemory() },
      nextClaim!,
    );
    expect(pending.result).toBe("UNCOMMITTED");
    if (pending.result !== "UNCOMMITTED") throw new Error("missing positive");
    expect(
      await automatic.commitFleetAutomaticDiscovery(
        ctx.db,
        pending.bound,
        pending.verified,
        p.now,
      ),
    ).toMatchObject({ result: "created" });
    expect((await candidates())[0]).toMatchObject({
      claimGeneration: 2,
      lastOutcome: "verified",
    });
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(1);
  },
);

it.each(["candidate", "claim"] as const)(
  "retains %s exhaustion through reOn/restart and never deletes/recycles the row",
  async (counter) => {
    const p = await enroll();
    await reserve(p.now);
    await ctx.db.update(fleetAutomaticCandidate).set({
      reservationId: null,
      enqueueUntil: null,
      ...(counter === "candidate"
        ? { candidateGeneration: Number.MAX_SAFE_INTEGER - 1 }
        : { claimGeneration: Number.MAX_SAFE_INTEGER - 1 }),
    });
    p.setNow(4000);
    await p.consent();
    expect(await reserve(p.now)).toBe(0);
    const c = (await candidates())[0];
    expect(c.lastOutcome).toBe("capacity_limited");
    expect(counter === "candidate" ? c.candidateGeneration : c.claimGeneration).toBe(
      counter === "candidate" ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER - 1,
    );
    p.setNow(180000);
    expect(await reserve(p.now)).toBe(0);
    expect(await candidates()).toHaveLength(1);
    expect((await candidates())[0].reservationId).toBeNull();
  },
);

it("actual owner/link replacement reconciles without resetting claim counters; consent-only replacement retains a latch", async () => {
  const p = await enroll();
  await reserve(p.now);
  await ctx.db.update(fleetAutomaticCandidate).set({
    reservationId: null,
    enqueueUntil: null,
    lastOutcome: "identity_changed",
    claimGeneration: 3,
    failureCount: 4,
  });
  p.setNow(4000);
  await p.consent();
  expect(await reserve(p.now)).toBe(0);
  expect((await candidates())[0]).toMatchObject({
    lastOutcome: "identity_changed",
    candidateGeneration: 2,
    failureCount: 4,
  });
  const epoch = randomUUID();
  await ctx.db
    .update(character)
    .set({ ownerHash: "replacement-owner", fleetLinkEpoch: epoch });
  p.setNow(34000);
  expect(await reserve(p.now)).toBe(1);
  expect((await candidates())[0]).toMatchObject({
    ownerHash: "replacement-owner",
    linkEpoch: epoch,
    candidateGeneration: 3,
    claimGeneration: 3,
    lastOutcome: null,
    failureCount: 0,
  });
});

it("live active and paused automatic sources suppress discovery; a naturally ended source yields a new future UUID", async () => {
  const p = await enroll();
  await reserve(p.now);
  const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, await task(), p.now);
  const pending = await attemptClaimedFleetAutomaticDiscovery(p.deps, claim!);
  if (pending.result !== "UNCOMMITTED") throw new Error("missing positive");
  const first = await automatic.commitFleetAutomaticDiscovery(
    ctx.db,
    pending.bound,
    pending.verified,
    p.now,
  );
  if (!("sourceId" in first)) throw new Error("missing source");
  p.setNow(7000);
  expect(await reserve(p.now)).toBe(0);
  p.options.status = 503;
  await runFleetSourceJob(p.deps, { sourceId: first.sourceId, generation: 1 });
  expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
  p.setNow(37000);
  expect(await reserve(p.now)).toBe(0);
  p.options.status = 403;
  p.setNow(180000);
  await runFleetSourceJob(p.deps, { sourceId: first.sourceId, generation: 1 });
  const [ended] = await ctx.db.select().from(fleetSourceIntent);
  expect(ended.state).toBe("ended");
  p.options.status = 200;
  p.options.fleetId = 456;
  expect(await reserve(p.now)).toBe(1);
  const next = await automatic.claimFleetAutomaticDiscovery(ctx.db, await task(), p.now);
  const positive = await attemptClaimedFleetAutomaticDiscovery(
    { ...p.deps, memory: createFleetSourceMemory() },
    next!,
  );
  if (positive.result !== "UNCOMMITTED") throw new Error("missing future positive");
  const second = await automatic.commitFleetAutomaticDiscovery(
    ctx.db,
    positive.bound,
    positive.verified,
    p.now,
  );
  expect(second).toMatchObject({ result: "created" });
  if (!("sourceId" in second)) throw new Error("missing future source");
  expect(second.sourceId).not.toBe(first.sourceId);
  expect(
    (
      await ctx.db
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.id, first.sourceId))
    )[0],
  ).toEqual(ended);
});

it("257-character catalogue explicitly refuses rather than allocating a truncated prefix", async () => {
  const p = await enroll();
  await ctx.db.insert(character).values(
    Array.from({ length: 256 }, (_, i) => ({
      id: 100000 + i,
      accountId: p.owner.id,
      ownerHash: `owner-${i}`,
      name: `Pilot ${i}`,
      scopes: [FLEET_READ_SCOPE],
      refreshTokenEnc: p.boss.refreshTokenEnc,
    })),
  );
  expect(await reserve(p.now)).toBe(0);
  expect(await candidates()).toEqual([]);
  expect(await automaticOutbox()).toEqual([]);
  p.setNow(4000);
  expect(await p.status()).toMatchObject({
    ok: true,
    value: { status: { readiness: "capacity_limited" } },
  });
});

it("bounds accounts plus considered candidates to 100 and advances a persisted cursor past old blocked rows", async () => {
  const p = await enroll(99001, false);
  await ctx.db.insert(character).values(
    Array.from({ length: 255 }, (_, i) => ({
      id: 100000 + i,
      accountId: p.owner.id,
      ownerHash: `owner-${i}`,
      name: `Pilot ${i}`,
      scopes: i === 254 ? [FLEET_READ_SCOPE] : [],
      tokenStatus: "valid" as const,
      refreshTokenEnc: p.boss.refreshTokenEnc,
    })),
  );
  expect(await reserve(p.now)).toBe(0);
  expect(await candidates()).toHaveLength(99);
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].candidateCursor).toBe(
    100097,
  );
  p.setNow(2500);
  expect(await reserve(p.now)).toBe(0);
  expect(await candidates()).toHaveLength(198);
  p.setNow(3000);
  expect(await reserve(p.now)).toBe(1);
  expect(
    (await candidates()).find((c) => c.characterId === 100254)?.reservationId,
  ).not.toBeNull();
  expect((await candidates()).filter((c) => c.reservationId !== null)).toHaveLength(1);
  const [finished] = await ctx.db.select().from(fleetAutomaticConsent);
  expect(finished.candidateCursor).toBeNull();
  expect(finished.nextReconcileAt).toEqual(at(13000));
});

it("retained removed-character candidates consume the 256 slots; scan never deletes or recycles them for a new character", async () => {
  const p = await enroll();
  await ctx.db.insert(fleetAutomaticCandidate).values(
    Array.from({ length: 256 }, (_, i) => ({
      accountId: p.owner.id,
      characterId: 200000 + i,
      consentGeneration: 1,
      candidateGeneration: Number.MAX_SAFE_INTEGER,
      claimGeneration: Number.MAX_SAFE_INTEGER,
      ownerHash: `removed-${i}`,
      linkEpoch: randomUUID(),
      nextAttemptAt: NOW,
      lastOutcome: "fleet_read_invalid" as const,
    })),
  );
  const before = await candidates();
  expect(await reserve(p.now)).toBe(0);
  p.setNow(32000);
  expect(await reserve(p.now)).toBe(0);
  expect(await candidates()).toEqual(before);
  expect(await automaticOutbox()).toEqual([]);
  expect(await p.status()).toMatchObject({
    ok: true,
    value: { status: { readiness: "capacity_limited" } },
  });
});

it("a completed bounded no-grant catalogue sweep waits 30s rather than circling forever at 500ms", async () => {
  const p = await enroll(99001, false);
  await ctx.db.insert(character).values(
    Array.from({ length: 199 }, (_, i) => ({
      id: 100000 + i,
      accountId: p.owner.id,
      ownerHash: `owner-${i}`,
      name: `Pilot ${i}`,
    })),
  );
  expect(await reserve(p.now)).toBe(0);
  p.setNow(2500);
  expect(await reserve(p.now)).toBe(0);
  p.setNow(3000);
  expect(await reserve(p.now)).toBe(0);
  const [consent] = await ctx.db.select().from(fleetAutomaticConsent);
  expect(consent.candidateCursor).toBeNull();
  expect(consent.nextReconcileAt).toEqual(at(32000));
  expect(await candidates()).toHaveLength(200);
  p.setNow(31500);
  expect(await reserve(p.now)).toBe(0);
  expect((await candidates())[0].nextAttemptAt).toEqual(at(32000));
  expect(p.requests).toEqual([]);
});

it("old ineligible accounts cannot monopolize the ordered due scan", async () => {
  const p = await enroll();
  const owners = await ctx.db
    .insert(account)
    .values(Array.from({ length: 100 }, () => ({ tier: "associate" as const })))
    .returning();
  await ctx.db.insert(fleetAutomaticConsent).values(
    owners.map((a) => ({
      accountId: a.id,
      generation: 1,
      revision: 1,
      enabled: true,
      approvingDeviceId: p.device.id,
      approvedAt: NOW,
      nextReconcileAt: NOW,
    })),
  );
  expect(await reserve(p.now)).toBe(0);
  expect(
    (await ctx.db.select().from(fleetAutomaticConsent)).filter(
      (c) => c.nextReconcileAt > p.now(),
    ),
  ).toHaveLength(100);
  expect(await reserve(p.now)).toBe(1);
});

it("expired outboxes are bounded while late old deliveries and unrelated manual rows remain harmless", async () => {
  const p = await enroll();
  await reserve(p.now);
  const first = await task();
  for (let i = 1; i <= 8; i++) {
    p.setNow(2000 + i * 10000);
    expect(await reserve(p.now)).toBe(1);
    expect(await automaticOutbox()).toHaveLength(1);
  }
  // Delayed persistence is an isolated external-system boundary input, not a reservation fixture.
  await ctx.db.execute(
    sql`insert into outbox (payload) select ${JSON.stringify({ kind: "fleet-automatic", ...first })}::jsonb from generate_series(1, 130)`,
  );
  await enqueueSync(ctx.db, { kind: "all" });
  expect(await reserve(p.now)).toBe(0);
  expect(await automaticOutbox()).toHaveLength(31);
  expect(await reserve(p.now)).toBe(0);
  expect(await automaticOutbox()).toHaveLength(1);
  expect(await automatic.claimFleetAutomaticDiscovery(ctx.db, first, p.now)).toBeNull();
  expect(
    (await ctx.db.select().from(outbox)).filter((r) => r.payload.kind === "all"),
  ).toHaveLength(1);
});

it("further reOn cannot hide an already-exhausted retained candidate from current status", async () => {
  const p = await enroll();
  await reserve(p.now);
  await ctx.db.update(fleetAutomaticCandidate).set({
    reservationId: null,
    enqueueUntil: null,
    candidateGeneration: Number.MAX_SAFE_INTEGER,
  });
  p.setNow(4000);
  await p.consent();
  expect(await reserve(p.now)).toBe(0);
  p.setNow(5000);
  expect(await p.status()).toMatchObject({
    ok: true,
    value: { status: { readiness: "capacity_limited" } },
  });
  expect((await candidates())[0]).toMatchObject({
    candidateGeneration: Number.MAX_SAFE_INTEGER,
    consentGeneration: 1,
    reservationId: null,
  });
});

it.each(["approval", "revocation", "key", "member", "grant", "off"] as const)(
  "reservation rechecks current %s after a proved PostgreSQL lock wait",
  async (loss) => {
    const p = await enroll();
    const heldTable = ["approval", "revocation", "key"].includes(loss)
      ? fleetDevice
      : loss === "grant"
        ? character
        : account;
    const holder = await ctx.pool.connect();
    await holder.query("begin");
    const {
      rows: [{ pid }],
    } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
    await holder.query(
      heldTable === fleetDevice
        ? "select id from fleet_device where id=$1 for update"
        : heldTable === character
          ? "select id from character where id=$1 for update"
          : "select id from account where id=$1 for update",
      [
        heldTable === fleetDevice
          ? p.device.id
          : heldTable === character
            ? p.boss.id
            : p.owner.id,
      ],
    );
    const work = reserve(p.now);
    try {
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      if (loss === "approval")
        await holder.query(
          "update fleet_device set approved_capabilities='[]'::jsonb where id=$1",
          [p.device.id],
        );
      if (loss === "revocation")
        await holder.query("update fleet_device set revoked_at=$1 where id=$2", [
          p.now(),
          p.device.id,
        ]);
      if (loss === "key")
        await holder.query(
          "update fleet_device_key_identity set conflicted=true, device_id=null where device_id=$1",
          [p.device.id],
        );
      if (loss === "member")
        await holder.query("update account set tier='associate' where id=$1", [
          p.owner.id,
        ]);
      if (loss === "grant")
        await holder.query("update character set scopes='[]'::jsonb where id=$1", [
          p.boss.id,
        ]);
      if (loss === "off")
        await holder.query(
          "update fleet_automatic_consent set enabled=false, revision=2, disabled_at=$1, closed_reason='explicit_off' where account_id=$2",
          [p.now(), p.owner.id],
        );
      await holder.query("commit");
      expect(await work).toBe(0);
      expect(await automaticOutbox()).toEqual([]);
      expect((await candidates()).every((c) => c.reservationId === null)).toBe(true);
      expect(p.requests).toEqual([]);
    } finally {
      await holder.query("rollback");
      holder.release();
      await work;
    }
  },
);

it("reservation deadline uses post-final-device-wait DB time, not selection time", async () => {
  const p = await enroll();
  const holder = await ctx.pool.connect();
  await holder.query("begin");
  const {
    rows: [{ pid }],
  } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
  await holder.query("select id from fleet_device where id=$1 for update", [p.device.id]);
  const work = reserve(p.now);
  try {
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    p.setNow(15000);
    await holder.query("commit");
    expect(await work).toBe(1);
    expect((await candidates())[0]).toMatchObject({
      nextAttemptAt: at(15000),
      enqueueUntil: at(25000),
    });
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

/** Hold an actual writer only at its commit boundary. Its normal selectors and
 * writes already ran; no prepared state, exception or transaction result is faked. */
function holdWriterCommit() {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const transaction: Db["transaction"] = (callback, config) =>
    ctx.db.transaction(async (tx) => {
      const result = await callback(tx);
      ready(
        (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]
          .pid,
      );
      await gate;
      return result;
    }, config);
  const db = new Proxy(ctx.db, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return key === "transaction" ? transaction : value;
    },
  });
  return { db, held, release };
}

async function blockedStatement(holder: number, statement: string) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await ctx.pool.query<{
      pid: number;
      virtualtransaction: string;
      locktype: string;
      classid: number | null;
    }>(
      `select a.pid, l.virtualtransaction, l.locktype, l.classid
      from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.wait_event_type='Lock' and not l.granted
        and $1=any(pg_blocking_pids(a.pid)) and position($2 in a.query)>0`,
      [holder, statement],
    );
    if (rows.length === 1) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

it.each(["catalogue", "approver"] as const)(
  "real %s writer during the initial reserver account wait restarts the whole transaction and admits only current selectors",
  async (change) => {
    const p = await enroll(99001, change !== "catalogue");
    const replacement =
      change === "approver"
        ? await pairDevice(ctx.db, p.owner.id, NOW, ["shared-source-v1"])
        : null;
    if (replacement)
      expect(
        await acknowledgeFleetCapabilities(ctx.db, {
          sessionId: replacement.sessionId,
          revision: 1,
          now: NOW,
          capabilities: ["shared-source-v1"],
        }),
      ).toMatchObject({ ok: true });
    p.setNow(4000);
    const incomingId = 99000; // Earlier than the old boss in identity lock order.
    const grant = await verifyEveAccessToken(
      await new SignJWT({
        sub: `CHARACTER:EVE:${incomingId}`,
        owner: "new-catalogue-owner",
        name: "New catalogue pilot",
        scp: [...cfg.eveSso.scopes, FLEET_READ_SCOPE],
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .setExpirationTime("5m")
        .sign(keys.privateKey),
      getKey,
    );
    const held = holdWriterCommit();
    const writer = replacement
      ? automatic.controlFleetAutomatic(
          held.db,
          {
            sessionId: replacement.sessionId,
            revision: 2,
            now: p.now(),
          },
          {
            protocol: 2,
            request_id: randomUUID(),
            intent_created_at: p.now().toISOString(),
            enabled: true,
            expected_generation: 1,
            expected_revision: 1,
          },
        )
      : fleetLifecycleTransaction(held.db, (tx) =>
          linkCharacter(tx, cfg, p.owner.id, {
            ...grant,
            refreshToken: "new-catalogue-refresh",
          }),
        );
    void writer.catch(() => undefined); // Cleanup owns rejection even before the gate.
    const blocker = await ctx.pool.connect();
    const probe = await ctx.pool.connect();
    const selector = replacement
      ? { level: 5, hash: "hashtext($1)", value: replacement.device.publicKeySpkiB64 }
      : { level: 1, hash: "hashint8($1)", value: incomingId };
    let work: Promise<number> | undefined;
    let block: Promise<unknown> | undefined;
    let unlocked = false;
    try {
      const holderPid = await Promise.race([
        held.held,
        writer.then(() => {
          throw new Error("writer did not reach held commit");
        }),
      ]);
      work = reserve(p.now);
      void work.catch(() => undefined);
      const first = await blockedStatement(holderPid, 'from "account"');
      expect(
        first,
        "reserver must really wait on the writer's account lock",
      ).not.toBeNull();
      expect(
        (
          await probe.query<{ locked: boolean }>(
            "select pg_try_advisory_xact_lock(1, hashint8($1)) as locked",
            [p.boss.id],
          )
        ).rows[0].locked,
      ).toBe(false);
      expect(await candidates()).toEqual([]);
      expect(await automaticOutbox()).toEqual([]);

      // Queue a real external lock waiter BEFORE releasing the writer. It takes
      // the newly committed selector first, keeping the restarted scan observable.
      // These are lock fixtures only; both catalogue and consent writes above are
      // actual production writers, not direct INSERT/UPDATE selector fixtures.
      block = blocker.query(
        `select pg_advisory_lock(${selector.level}, ${selector.hash})`,
        [selector.value],
      );
      expect(await blockedStatement(holderPid, "pg_advisory_lock(")).not.toBeNull();
      held.release();
      expect(await writer).toMatchObject({ ok: true });
      await block;
      const blockerPid = (
        await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0].pid;
      const second = await blockedStatement(blockerPid, "pg_advisory_xact_lock(");
      expect(
        second,
        "successful retry must wait on its new earlier selector",
      ).not.toBeNull();
      expect(second?.locktype).toBe("advisory");
      expect(second?.classid).toBe(selector.level);
      expect(second?.virtualtransaction).not.toBe(first?.virtualtransaction);
      expect(
        (
          await probe.query<{ n: number }>(
            "select count(*)::int as n from pg_locks where virtualtransaction=$1",
            [first!.virtualtransaction],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await probe.query<{ locked: boolean }>(
            "select pg_try_advisory_xact_lock(1, hashint8($1)) as locked",
            [p.boss.id],
          )
        ).rows[0].locked,
      ).toBe(true);
      expect(await candidates()).toEqual([]);
      expect(await automaticOutbox()).toEqual([]);
      if (replacement) {
        expect(
          (
            await probe.query<{ locked: boolean }>(
              "select pg_try_advisory_xact_lock(5, hashtext($1)) as locked",
              [p.device.publicKeySpkiB64],
            )
          ).rows[0].locked,
        ).toBe(true);
        // Old approver loss cannot veto the new, still-current approving key.
        await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, p.now());
      }
      await blocker.query(
        `select pg_advisory_unlock(${selector.level}, ${selector.hash})`,
        [selector.value],
      );
      unlocked = true;
      expect(await work).toBe(1);
      expect(await candidates()).toHaveLength(replacement ? 1 : 2);
      const id = replacement ? p.boss.id : incomingId;
      const input = await task(id);
      expect((await automaticOutbox()).map((row) => row.payload)).toEqual([
        { kind: "fleet-automatic", ...input },
      ]);
      expect(input).toMatchObject({
        consentGeneration: replacement ? 2 : 1,
        candidateGeneration: 1,
      });
      const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, input, p.now);
      expect(claim).toMatchObject({
        approverDeviceId: replacement?.device.id ?? p.device.id,
        consentRevision: replacement ? 2 : 1,
        claimGeneration: 1,
        boss: {
          id,
          accountId: p.owner.id,
          ownerHash: replacement ? p.boss.ownerHash : "new-catalogue-owner",
          scopes: expect.arrayContaining([FLEET_READ_SCOPE]),
        },
      });
      if (!replacement)
        expect(
          (await candidates()).find((c) => c.characterId === p.boss.id),
        ).toMatchObject({
          reservationId: null,
          claimReservationId: null,
          lastOutcome: "waiting_for_grant",
        });
      const before = await candidates();
      expect(
        await automatic.claimFleetAutomaticDiscovery(ctx.db, input, p.now),
      ).toBeNull();
      expect(await reserve(p.now)).toBe(0);
      expect(await candidates()).toEqual(before);
      expect(await automaticOutbox()).toEqual([]); // Already claimed delivery is pruned.
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
      expect(p.requests).toEqual([]);
    } finally {
      held.release();
      await writer.catch(() => undefined);
      await block?.catch(() => undefined);
      if (block && !unlocked)
        await blocker.query(
          `select pg_advisory_unlock(${selector.level}, ${selector.hash})`,
          [selector.value],
        );
      await work?.catch(() => undefined);
      blocker.release();
      probe.release();
    }
  },
  15000,
);

it("ongoing reservation needs neither initiating session nor participation and leaves consent/device/firstUse untouched", async () => {
  const p = await enroll();
  await ctx.db.delete(fleetDeviceSession);
  const before = [
    await ctx.db.select().from(account),
    await ctx.db.select().from(character),
    await ctx.db.select().from(fleetDevice),
    await ctx.db.select().from(fleetAutomaticReceipt),
  ];
  expect(await reserve(p.now)).toBe(1);
  expect(
    await automatic.claimFleetAutomaticDiscovery(ctx.db, await task(), p.now),
  ).not.toBeNull();
  expect([
    await ctx.db.select().from(account),
    await ctx.db.select().from(character),
    await ctx.db.select().from(fleetDevice),
    await ctx.db.select().from(fleetAutomaticReceipt),
  ]).toEqual(before);
});

it("concurrent reservers commit exactly one reservation/outbox for a current candidate", async () => {
  const p = await enroll();
  expect((await Promise.all([reserve(p.now), reserve(p.now)])).sort()).toEqual([0, 1]);
  expect(await candidates()).toHaveLength(1);
  expect(await automaticOutbox()).toHaveLength(1);
  expect(
    await automatic.claimFleetAutomaticDiscovery(ctx.db, await task(), p.now),
  ).not.toBeNull();
});

it("mixed eligible accounts share one total budget including account overhead", async () => {
  const first = await enroll();
  const owners = await ctx.db
    .insert(account)
    .values(Array.from({ length: 59 }, () => ({ tier: "member" as const })))
    .returning();
  // Retained valid bindings are storage inputs for fairness, not positive authority.
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    const device = await pairDevice(ctx.db, owner.id, NOW, ["shared-source-v1"]);
    await ctx.db.insert(character).values({
      id: 100000 + i,
      accountId: owner.id,
      name: `Pilot ${i}`,
      ownerHash: `owner-${i}`,
      scopes: [FLEET_READ_SCOPE],
      refreshTokenEnc: first.boss.refreshTokenEnc,
      tokenStatus: "valid",
    });
    await ctx.db.insert(fleetAutomaticConsent).values({
      accountId: owner.id,
      generation: 1,
      revision: 1,
      enabled: true,
      approvingDeviceId: device.device.id,
      approvedAt: NOW,
      nextReconcileAt: at(2000),
    });
  }
  expect(await reserve(first.now)).toBe(50);
  expect(await candidates()).toHaveLength(50);
  expect(await automaticOutbox()).toHaveLength(50);
  expect(await reserve(first.now)).toBe(10);
  expect(await candidates()).toHaveLength(60);
}, 30000);

it.each(["extra", "fraction", "boolean", "unsafe", "uuid", "zero"] as const)(
  "outbox persistence refuses %s automatic payload without stripping/coercing fields",
  async (bad) => {
    const payload = {
      kind: "fleet-automatic" as const,
      accountId: randomUUID(),
      characterId: 99001,
      consentGeneration: 1,
      candidateGeneration: 1,
      reservationId: randomUUID(),
    };
    const malformed =
      bad === "extra"
        ? { ...payload, accessToken: "must-not-persist" }
        : bad === "uuid"
          ? { ...payload, reservationId: "bad" }
          : {
              ...payload,
              candidateGeneration:
                bad === "fraction"
                  ? 1.5
                  : bad === "boolean"
                    ? true
                    : bad === "zero"
                      ? 0
                      : Number.MAX_SAFE_INTEGER + 1,
            };
    await expect(enqueueSync(ctx.db, malformed as typeof payload)).rejects.toThrow(
      "fleet_automatic_payload_invalid",
    );
    expect(await automaticOutbox()).toEqual([]);
  },
);

it.each(["all", "scheduled", "fleet-source"] as const)(
  "P2 automatic persistence stays unconsumed by existing %s dispatcher while manual work proceeds",
  async (scope) => {
    const p = await enroll();
    await reserve(p.now);
    await enqueueSync(ctx.db, {
      kind: "fleet-source",
      sourceId: randomUUID(),
      generation: 1,
    });
    await enqueueSync(ctx.db, { kind: "all" });
    const send = vi.fn().mockResolvedValue("id");
    expect(await dispatchOutbox(ctx.db, send, scope)).toBe(scope === "all" ? 2 : 1);
    expect(send.mock.calls.every(([queue]) => queue !== "fleet-automatic")).toBe(true);
    expect((await automaticOutbox())[0].dispatchedAt).toBeNull();
  },
);
