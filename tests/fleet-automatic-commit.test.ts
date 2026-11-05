import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Db, DbTx } from "@/db";
import * as audit from "@/services/audit";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import {
  account,
  character,
  fleetAutomaticCandidate,
  fleetAutomaticConsent,
  fleetDevice,
  fleetSourceIntent,
  fleetSourceAuthority,
  auditLog,
  outbox,
} from "@/db/schema";
import type { AutomaticTask } from "@/core/fleet-automatic";
import * as automatic from "@/services/fleet-automatic";
import * as observation from "@/services/fleet-source-observation";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { controlFleetSource } from "@/services/fleet-source";
import { createEsiClient, FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  createFleetSourceMemory,
  runFleetSourceJob,
  type FleetSourceDeps,
} from "@/jobs/fleet-source";
import { attemptClaimedFleetAutomaticDiscovery } from "@/jobs/fleet-automatic";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

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

async function enroll(id = 99001) {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, cfg, {
    id,
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
  let revision = 1;
  let now = at(2000);
  const options = {
    fleetId: 123,
    roster: [id],
    status: 200,
    jwtExpiresAt: at(120000),
    observedAt: null as Date | null,
    hold: undefined as undefined | (() => Promise<void>),
  };
  const requests: string[] = [];
  const issuedTokens = new Set<string>();
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = String(raw);
    requests.push(url);
    if (url === "https://login.eveonline.com/v2/oauth/token") {
      const jwt = await new SignJWT({
        sub: `CHARACTER:EVE:${boss.id}`,
        owner: boss.ownerHash,
        name: boss.name,
        scp: [FLEET_READ_SCOPE],
        exp: options.jwtExpiresAt.getTime() / 1000,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .sign(keys.privateKey);
      issuedTokens.add(jwt);
      return Response.json({ access_token: jwt, refresh_token: `rotation-${boss.id}` });
    }
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    expect(bearer.startsWith("Bearer ") && issuedTokens.has(bearer.slice(7))).toBe(true);
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
          ? options.roster.map((character_id) => ({ character_id }))
          : { error: "synthetic" },
      {
        status: membership ? 200 : options.status,
        headers: {
          Date: (options.observedAt ?? now).toUTCString(),
          "Cache-Control": `max-age=${membership ? 60 : 5}`,
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      },
    );
    Object.defineProperty(response, "url", { value: url });
    if (!membership) await options.hold?.();
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
  async function claim() {
    const [saved] = await ctx.db
      .select()
      .from(fleetAutomaticConsent)
      .where(eq(fleetAutomaticConsent.accountId, owner.id));
    const task: AutomaticTask = {
      accountId: owner.id,
      characterId: boss.id,
      consentGeneration: saved.generation,
      candidateGeneration: 1,
      reservationId: randomUUID(),
    };
    // P2 is not implemented: supply only its retained reservation input. All
    // positive authority below comes from real claim/JWT/provider/bind/commit.
    await ctx.db
      .insert(fleetAutomaticCandidate)
      .values({
        ...task,
        ownerHash: boss.ownerHash,
        linkEpoch: boss.fleetLinkEpoch,
        nextAttemptAt: now,
        enqueueUntil: new Date(now.getTime() + 10000),
      })
      .onConflictDoUpdate({
        target: [fleetAutomaticCandidate.accountId, fleetAutomaticCandidate.characterId],
        set: {
          reservationId: task.reservationId,
          enqueueUntil: new Date(now.getTime() + 10000),
          nextAttemptAt: now,
          claimReservationId: null,
          claimExpiresAt: null,
          sourceId: null,
        },
      });
    const result = await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () => now);
    expect(result).not.toBeNull();
    return result!;
  }
  async function pending() {
    const result = await attemptClaimedFleetAutomaticDiscovery(deps, await claim());
    expect(result.result).toBe("UNCOMMITTED");
    if (result.result !== "UNCOMMITTED")
      throw new Error("expected real positive continuation");
    return result;
  }
  async function manual() {
    const id = randomUUID();
    expect(
      await controlFleetSource(ctx.db, {
        sessionId: device.sessionId,
        revision: ++revision,
        now,
        command: {
          protocol: 2,
          operation: "start",
          source_id: id,
          expected_generation: 0,
          character_id: boss.id,
          character_link_epoch: boss.fleetLinkEpoch,
          intent_created_at: now.toISOString(),
        },
      }),
    ).toMatchObject({ ok: true });
    await runFleetSourceJob(deps, { sourceId: id, generation: 1 });
    expect((await sources()).find((s) => s.id === id)?.state).toBe("active");
    return id;
  }
  return {
    owner,
    boss,
    ...device,
    options,
    deps,
    requests,
    consent,
    pending,
    manual,
    setNow: (ms: number) => {
      now = at(ms);
    },
    now: () => now,
  };
}
async function sources() {
  return ctx.db.select().from(fleetSourceIntent).orderBy(fleetSourceIntent.id);
}
async function slots() {
  return ctx.db.select().from(fleetSourceAuthority).orderBy(fleetSourceAuthority.fleetId);
}
async function candidate(id = 99001) {
  return (
    await ctx.db
      .select()
      .from(fleetAutomaticCandidate)
      .where(eq(fleetAutomaticCandidate.characterId, id))
  )[0];
}
async function commit(
  p: Awaited<ReturnType<typeof enroll>>,
  pending: Awaited<ReturnType<Awaited<ReturnType<typeof enroll>>["pending"]>>,
  db = ctx.db,
) {
  return automatic.commitFleetAutomaticDiscovery(
    db,
    pending.bound,
    pending.verified,
    p.now,
  );
}

it("consumes real UNCOMMITTED into one complete atomic source/proof and releases the exact claim", async () => {
  const p = await enroll();
  await p.consent();
  const pending = await p.pending();
  expect(await sources()).toEqual([]);
  p.setNow(3000);
  const result = await commit(p, pending);
  expect(result).toMatchObject({ result: "created", sourceGeneration: 1 });
  if (!result || result.result !== "created") throw new Error("missing commit");
  expect(await sources()).toEqual([
    {
      id: result.sourceId,
      accountId: p.owner.id,
      deviceId: p.device.id,
      bossCharacterId: p.boss.id,
      bossOwnerHash: p.boss.ownerHash,
      bossLinkEpoch: p.boss.fleetLinkEpoch,
      automaticConsentAccountId: p.owner.id,
      automaticConsentGeneration: 1,
      generation: 1,
      fetchGeneration: 0,
      state: "active",
      latestOutcome: "verified",
      fleetId: 123,
      intentCreatedAt: at(3000),
      intentExpiresAt: at(63000),
      activatedAt: at(3000),
      lastAttemptAt: at(3000),
      nextFetchAt: at(7000),
      fetchClaimExpiresAt: null,
      enqueueUntil: null,
      endedAt: null,
      terminalReason: null,
      retainUntil: at(86463000),
      stopReceipt: null,
      explicitlyStopped: false,
    },
  ]);
  expect(await slots()).toEqual([
    {
      fleetId: 123,
      sourceId: result.sourceId,
      sourceGeneration: 1,
      authorityGeneration: 1,
      linkedCharacters: [{ characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch }],
      verifiedAt: at(2000),
      expiresAt: at(12000),
    },
  ]);
  expect(await candidate()).toMatchObject({
    sourceId: result.sourceId,
    claimGeneration: 1,
    claimReservationId: null,
    claimExpiresAt: null,
    reservationId: null,
    enqueueUntil: null,
    failureCount: 0,
    lastOutcome: "verified",
  });
  expect(await ctx.db.select().from(outbox)).toEqual([]);
  const snapshot = [await sources(), await slots(), await candidate()];
  expect(await commit(p, pending)).toEqual({ result: "fenced" });
  expect([await sources(), await slots(), await candidate()]).toEqual(snapshot);
});

it.each([
  "token",
  "revision",
  "reservation",
  "claim",
  "candidate",
  "owner",
  "link",
  "member",
  "approval",
  "suspension",
  "jwt",
  "claim-expiry",
  "evidence-expiry",
  "future-evidence",
] as const)(
  "fences %s after real upstream proof without allocating authority",
  async (loss) => {
    const p = await enroll();
    if (loss === "jwt") p.options.jwtExpiresAt = at(5000);
    await p.consent();
    const pending = await p.pending();
    if (loss === "token")
      await ctx.db.update(character).set({ refreshTokenEnc: "rotated" });
    if (loss === "revision")
      await ctx.db.update(fleetAutomaticConsent).set({ revision: 2 });
    if (loss === "reservation")
      await ctx.db
        .update(fleetAutomaticCandidate)
        .set({ claimReservationId: randomUUID() });
    if (loss === "claim")
      await ctx.db.update(fleetAutomaticCandidate).set({ claimGeneration: 2 });
    if (loss === "candidate")
      await ctx.db.update(fleetAutomaticCandidate).set({ candidateGeneration: 2 });
    if (loss === "owner") await ctx.db.update(character).set({ ownerHash: "changed" });
    if (loss === "link")
      await ctx.db.update(character).set({ fleetLinkEpoch: randomUUID() });
    if (loss === "member") await ctx.db.update(account).set({ tier: "associate" });
    if (loss === "approval")
      await ctx.db.update(fleetDevice).set({ approvedCapabilities: [] });
    if (loss === "suspension")
      await ctx.db
        .update(fleetAutomaticCandidate)
        .set({ lastOutcome: "fleet_read_invalid" });
    p.setNow(
      loss === "jwt"
        ? 5000
        : loss === "claim-expiry"
          ? 32000
          : loss === "evidence-expiry"
            ? 12000
            : loss === "future-evidence"
              ? 1000
              : 3000,
    );
    const before = await candidate();
    expect(await commit(p, pending)).toEqual({ result: "fenced" });
    expect(await sources()).toEqual([]);
    expect((await slots())[0]).toMatchObject({ sourceId: null, authorityGeneration: 0 });
    if (["reservation", "claim", "candidate"].includes(loss))
      expect(await candidate()).toEqual(before);
    else
      expect(await candidate()).toMatchObject({
        claimReservationId: null,
        claimExpiresAt: null,
        lastOutcome: before.lastOutcome,
        nextAttemptAt: before.nextAttemptAt,
      });
  },
);

it.each([false, true])(
  "cross-account manual predecessor paused=%s is closed by the shared authority writer",
  async (paused) => {
    const a = await enroll(99002);
    const b = await enroll();
    a.setNow(1000);
    const old = await a.manual();
    if (paused) {
      a.setNow(6000);
      a.options.status = 503;
      await runFleetSourceJob(a.deps, { sourceId: old, generation: 1 });
      expect((await sources()).find((s) => s.id === old)?.state).toBe("paused");
    }
    b.setNow(paused ? 7000 : 3000);
    await b.consent();
    const pending = await b.pending();
    const result = await commit(b, pending);
    expect(result).toMatchObject({ result: "created" });
    expect((await sources()).find((s) => s.id === old)).toMatchObject({
      state: "ended",
      terminalReason: "superseded",
      generation: 2,
      automaticConsentAccountId: null,
    });
    expect((await slots())[0]).toMatchObject({
      sourceId: result && "sourceId" in result ? result.sourceId : null,
      authorityGeneration: paused ? 3 : 2,
    });
  },
);

it("an intervening real manual commit fences even a newer automatic observation captured at the unchanged old slot", async () => {
  const a = await enroll(99002);
  const b = await enroll();
  await b.consent();
  let release!: () => void;
  let ready!: () => void;
  const waiting = new Promise<void>((r) => {
    ready = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  b.options.hold = async () => {
    ready();
    await gate;
  };
  b.setNow(4000);
  const work = b.pending();
  await waiting;
  try {
    a.setNow(2000);
    await a.manual();
    const before = [await sources(), await slots()];
    release();
    const pending = await work;
    expect(pending.bound.expectedAuthorityGeneration).toBe(0);
    b.setNow(5000);
    expect(await commit(b, pending)).toEqual({ result: "authority_changed" });
    expect([await sources(), await slots()]).toEqual(before);
    expect(await candidate()).toMatchObject({
      claimReservationId: null,
      nextAttemptAt: at(10000),
    });
  } finally {
    release();
    await work;
  }
});

it.each([false, true])(
  "reuses a real matching live source paused=%s without changing its body/cadence/generations",
  async (paused) => {
    const p = await enroll();
    await p.consent();
    const first = await commit(p, await p.pending());
    expect(first.result).toBe("created");
    if (!("sourceId" in first)) throw new Error("missing source");
    if (paused) {
      p.setNow(7000);
      p.options.status = 503;
      await runFleetSourceJob(p.deps, { sourceId: first.sourceId, generation: 1 });
      expect((await sources())[0].state).toBe("paused");
      p.options.status = 200;
    }
    p.setNow(paused ? 8000 : 3000);
    p.options.observedAt = at(2000);
    const pending = await p.pending();
    const before = [await sources(), await slots()];
    expect(await commit(p, pending)).toEqual({ ...first, result: "reused" });
    expect([await sources(), await slots()]).toEqual(before);
    expect(await candidate()).toMatchObject({
      sourceId: first.sourceId,
      claimGeneration: 2,
      claimReservationId: null,
    });
  },
);

it("natural end followed by a future fleet creates a fresh UUID, never revives its tombstone", async () => {
  const p = await enroll();
  await p.consent();
  const first = await commit(p, await p.pending());
  if (!("sourceId" in first)) throw new Error("missing source");
  p.setNow(7000);
  p.options.status = 403;
  await runFleetSourceJob(p.deps, { sourceId: first.sourceId, generation: 1 });
  const tombstone = (await sources())[0];
  expect(tombstone).toMatchObject({
    state: "ended",
    generation: 2,
    terminalReason: "boss_lost",
    automaticConsentGeneration: 1,
  });
  p.setNow(64000);
  p.options.status = 200;
  p.options.fleetId = 456;
  const next = await commit(p, await p.pending());
  expect(next.result).toBe("created");
  if (!("sourceId" in next)) throw new Error("missing future source");
  expect(next.sourceId).not.toBe(first.sourceId);
  expect((await sources()).find((s) => s.id === first.sourceId)).toEqual(tombstone);
  expect((await sources()).find((s) => s.id === next.sourceId)).toMatchObject({
    fleetId: 456,
    automaticConsentGeneration: 1,
    generation: 1,
    fetchGeneration: 0,
  });
});

it("a still-live different-fleet binding is never reused or relabelled by discovery", async () => {
  const p = await enroll();
  await p.consent();
  const first = await commit(p, await p.pending());
  expect(first.result).toBe("created");
  p.setNow(64000);
  p.options.fleetId = 456;
  // Deliberate late-delivery input: P2 will suppress reservations while this
  // binding is live. Commit still cannot bypass the retained live uniqueness fence.
  const pending = await p.pending();
  const before = [await sources(), await slots()];
  expect(await commit(p, pending)).toEqual({ result: "fenced" });
  expect([await sources(), await slots()]).toEqual(before);
  expect(await candidate()).toMatchObject({ sourceId: null, claimReservationId: null });
});

it("concurrent duplicate positive callbacks commit once and never reapply proof", async () => {
  const p = await enroll();
  await p.consent();
  const pending = await p.pending();
  const results = await Promise.all([commit(p, pending), commit(p, pending)]);
  expect(results.map((r) => r.result).sort()).toEqual(["created", "fenced"]);
  expect(await sources()).toHaveLength(1);
  expect((await slots())[0].authorityGeneration).toBe(1);
  expect(await candidate()).toMatchObject({
    claimReservationId: null,
    sourceId: (await sources())[0].id,
  });
});

it.each(["authority_changed", "untrustworthy_evidence"] as const)(
  "typed %s after tentative proof rolls back source/proof/audit before separate current-claim settlement",
  async (reason) => {
    const a = await enroll(99002);
    const b = await enroll();
    a.setNow(1000);
    await a.manual();
    b.setNow(3000);
    await b.consent();
    const pending = await b.pending();
    const before = [await sources(), await slots(), await ctx.db.select().from(auditLog)];
    const real = observation.applyFleetAuthorityProof;
    const spy = vi
      .spyOn(observation, "applyFleetAuthorityProof")
      .mockImplementation(async (...args) => {
        await real(...args);
        throw new observation.FleetAuthorityProofRefusal(reason);
      });
    try {
      expect(await commit(b, pending)).toEqual({
        result: reason === "authority_changed" ? reason : "fenced",
      });
      expect([
        await sources(),
        await slots(),
        await ctx.db.select().from(auditLog),
      ]).toEqual(before);
      expect(await candidate()).toMatchObject({
        claimReservationId: null,
        sourceId: null,
      });
    } finally {
      spy.mockRestore();
    }
  },
);

function withTransaction(transaction: Db["transaction"]): Db {
  return new Proxy(ctx.db, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return key === "transaction" ? transaction : value;
    },
  });
}
function transactionView(work: (tx: DbTx) => DbTx): Db {
  return withTransaction((callback, config) =>
    ctx.db.transaction((tx) => callback(work(tx)), config),
  );
}
it.each(["audit", "candidate"] as const)(
  "%s storage failure rolls back tentative source and all predecessor/proof changes",
  async (failure) => {
    const a = await enroll(99002);
    const b = await enroll();
    a.setNow(1000);
    await a.manual();
    b.setNow(3000);
    await b.consent();
    const pending = await b.pending();
    const before = [
      await sources(),
      await slots(),
      await candidate(),
      await ctx.db.select().from(auditLog),
    ];
    const realAudit = audit.logAudit;
    const spy = vi.spyOn(audit, "logAudit").mockImplementation(async (...args) => {
      await realAudit(...args);
      if (failure === "audit") throw new Error("injected_audit_failure");
    });
    let candidateWrites = 0;
    const db =
      failure === "candidate"
        ? transactionView(
            (tx) =>
              new Proxy(tx, {
                get(target, key, receiver) {
                  const value: unknown = Reflect.get(target, key, receiver);
                  if (key !== "update") return value;
                  return ((table) => {
                    // First update belongs to predecessor withdrawal. Fail the
                    // final candidate pointer write only AFTER proof application.
                    if (
                      Object.is(table, fleetAutomaticCandidate) &&
                      ++candidateWrites === 2
                    )
                      throw new Error("injected_candidate_failure");
                    return tx.update(table);
                  }) as DbTx["update"];
                },
              }),
          )
        : ctx.db;
    try {
      await expect(commit(b, pending, db)).rejects.toThrow(`injected_${failure}_failure`);
      expect([
        await sources(),
        await slots(),
        await candidate(),
        await ctx.db.select().from(auditLog),
      ]).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(["identity", "source", "device"] as const)(
  "missing prepared %s selector retries the entire transaction with no leaked tentative source",
  async (missing) => {
    const p = await enroll();
    await p.consent();
    const pending = await p.pending();
    const real = observation.applyFleetAuthorityProof;
    let calls = 0;
    const spy = vi
      .spyOn(observation, "applyFleetAuthorityProof")
      .mockImplementation(async (tx, prepared, proof, now) => {
        calls++;
        return real(
          tx,
          calls === 1
            ? {
                ...prepared,
                ...(missing === "identity"
                  ? { identities: new Map() }
                  : {
                      locked: {
                        ...prepared.locked,
                        ...(missing === "source" ? { sources: [] } : { deviceIds: [] }),
                      },
                    }),
              }
            : prepared,
          proof,
          now,
        );
      });
    try {
      expect((await commit(p, pending)).result).toBe("created");
      expect(calls).toBe(2);
      expect(await sources()).toHaveLength(1);
      expect((await slots())[0].authorityGeneration).toBe(1);
    } finally {
      spy.mockRestore();
    }
  },
);

it.each(["jwt", "claim", "evidence"] as const)(
  "strict %s expiry after a proved final device-lock wait refuses and releases the claim",
  async (expiry) => {
    const p = await enroll();
    if (expiry === "jwt") p.options.jwtExpiresAt = at(5000);
    await p.consent();
    const pending = await p.pending();
    const holder = await ctx.pool.connect();
    await holder.query("begin");
    await holder.query("select id from fleet_device where id=$1 for update", [
      p.device.id,
    ]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    const work = commit(p, pending);
    try {
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      p.setNow(expiry === "jwt" ? 5000 : expiry === "claim" ? 32000 : 12000);
      await holder.query("commit");
      expect(await work).toEqual({ result: "fenced" });
      expect(await sources()).toEqual([]);
      expect((await slots())[0].sourceId).toBeNull();
      expect(await candidate()).toMatchObject({
        claimReservationId: null,
        claimExpiresAt: null,
      });
    } finally {
      await holder.query("rollback");
      holder.release();
      await work;
    }
  },
);

it.each(["off", "reon", "revoke"] as const)(
  "%s commits first behind a real lock and fences the held positive callback",
  async (change) => {
    const p = await enroll();
    await p.consent();
    const pending = await p.pending();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<number>((r) => {
      ready = r;
    });
    const transaction: Db["transaction"] = (callback, config) =>
      ctx.db.transaction(async (tx) => {
        const result = await callback(tx);
        ready(
          (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]
            .pid,
        );
        await held;
        return result;
      }, config);
    const db = withTransaction(transaction);
    p.setNow(3000);
    const control =
      change === "revoke"
        ? revokeFleetDevice(db, p.device.id, p.owner.id, p.now())
        : automatic.controlFleetAutomatic(
            db,
            { sessionId: p.sessionId, revision: 3, now: p.now() },
            {
              protocol: 2,
              request_id: randomUUID(),
              intent_created_at: p.now().toISOString(),
              enabled: change === "reon",
              expected_generation: 1,
              expected_revision: 1,
            },
          );
    const pid = await Promise.race([
      waiting,
      control.then(() => {
        throw new Error("control did not reach held transaction");
      }),
    ]);
    const work = commit(p, pending);
    try {
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      release();
      await control;
      const retained = await candidate();
      expect(await work).toEqual({ result: "fenced" });
      expect(await candidate()).toEqual(retained);
      expect(await sources()).toEqual([]);
    } finally {
      release();
      await Promise.all([control, work]);
    }
  },
);

it.each([16, 256])(
  "source cap %s refuses before insertion, releases claim and schedules 30s+jitter",
  async (count) => {
    const p = await enroll();
    await p.consent();
    const pending = await p.pending();
    await ctx.db.insert(fleetSourceIntent).values(
      Array.from({ length: count }, () => ({
        id: randomUUID(),
        accountId: p.owner.id,
        deviceId: p.device.id,
        bossCharacterId: p.boss.id,
        bossOwnerHash: p.boss.ownerHash,
        bossLinkEpoch: p.boss.fleetLinkEpoch,
        state: count === 16 ? ("pending" as const) : ("ended" as const),
        intentCreatedAt: NOW,
        intentExpiresAt: at(60000),
        retainUntil: at(86460000),
        ...(count === 256 ? { endedAt: at(1000), terminalReason: "ended" } : {}),
      })),
    );
    const before = [await sources(), await slots()];
    p.setNow(3000);
    expect(await commit(p, pending)).toEqual({ result: "capacity_limited" });
    expect([await sources(), await slots()]).toEqual(before);
    expect(await candidate()).toMatchObject({
      claimReservationId: null,
      sourceId: null,
      lastOutcome: "capacity_limited",
      failureCount: 1,
    });
    expect((await candidate()).nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      at(33000).getTime(),
    );
    expect((await candidate()).nextAttemptAt.getTime()).toBeLessThanOrEqual(
      at(36000).getTime(),
    );
  },
);

it("exhausted independently captured empty authority counter refuses without insertion or overflow", async () => {
  const p = await enroll();
  await p.consent();
  // Empty fence only, not fabricated authority; bind captures its actual counter.
  await ctx.db
    .insert(fleetSourceAuthority)
    .values({ fleetId: 123, authorityGeneration: 2147483646 });
  const pending = await p.pending();
  expect(pending.bound.expectedAuthorityGeneration).toBe(2147483646);
  expect(await commit(p, pending)).toEqual({ result: "capacity_limited" });
  expect(await sources()).toEqual([]);
  expect((await slots())[0]).toMatchObject({
    sourceId: null,
    authorityGeneration: 2147483646,
  });
});

it("retains only the captured epoch intersection, including other accounts, and never adds a newly linked row", async () => {
  const p = await enroll();
  const other = await seedAccount(ctx.db);
  const retained = await seedCharacter(ctx.db, cfg, { id: 99002, accountId: other.id });
  const changed = await seedCharacter(ctx.db, cfg, { id: 99003, accountId: other.id });
  p.options.roster = [99001, 99002, 99003, 99004];
  await p.consent();
  const pending = await p.pending();
  await ctx.db
    .update(character)
    .set({ fleetLinkEpoch: randomUUID() })
    .where(eq(character.id, changed.id));
  await seedCharacter(ctx.db, cfg, { id: 99004, accountId: other.id });
  expect((await commit(p, pending)).result).toBe("created");
  expect((await slots())[0].linkedCharacters).toEqual([
    { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
    { characterId: retained.id, linkEpoch: retained.fleetLinkEpoch },
  ]);
});

it.each([256, 257])(
  "complete provider roster with %s captured linked members is retained whole or refused, never truncated",
  async (count) => {
    const p = await enroll();
    const values = Array.from({ length: count - 1 }, (_, i) => ({
      id: 100000 + i,
      accountId: p.owner.id,
      name: `Linked ${i}`,
      ownerHash: `owner-${i}`,
    }));
    await ctx.db.insert(character).values(values);
    p.options.roster = [p.boss.id, ...values.map((c) => c.id)];
    await p.consent();
    if (count === 256) {
      const pending = await p.pending();
      expect((await commit(p, pending)).result).toBe("created");
      expect((await slots())[0].linkedCharacters.map((c) => c.characterId)).toEqual(
        p.options.roster,
      );
    } else {
      // The actual upstream refuses >256 before exposing a continuation.
      const [consent] = await ctx.db.select().from(fleetAutomaticConsent);
      const task: AutomaticTask = {
        accountId: p.owner.id,
        characterId: p.boss.id,
        consentGeneration: consent.generation,
        candidateGeneration: 1,
        reservationId: randomUUID(),
      };
      await ctx.db.insert(fleetAutomaticCandidate).values({
        ...task,
        ownerHash: p.boss.ownerHash,
        linkEpoch: p.boss.fleetLinkEpoch,
        nextAttemptAt: p.now(),
        enqueueUntil: at(12000),
      });
      const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, task, p.now);
      expect(claim).not.toBeNull();
      expect(await attemptClaimedFleetAutomaticDiscovery(p.deps, claim!)).toEqual({
        result: "settled",
      });
      expect(await sources()).toEqual([]);
      expect((await slots())[0].sourceId).toBeNull();
      expect(await candidate()).toMatchObject({
        lastOutcome: "untrustworthy_evidence",
        claimReservationId: null,
      });
    }
  },
);

it.each(["rejected", "missing", "boss", "retained-cap", "invalid-date"] as const)(
  "commit independently refuses altered %s evidence after a real positive continuation",
  async (kind) => {
    const p = await enroll();
    await p.consent();
    const real = await p.pending();
    const pending = structuredClone(real);
    if (kind === "rejected")
      Object.assign(pending.bound.token, { admission: "rejected" });
    if (kind === "missing") Reflect.deleteProperty(pending.bound.token, "admission");
    if (kind === "boss") Object.assign(pending.verified, { memberIds: [] });
    if (kind === "invalid-date")
      Object.assign(pending.verified.evidence, { expiresAt: new Date(NaN) });
    if (kind === "retained-cap")
      Object.assign(pending.bound, {
        linkedCharacters: Array.from({ length: 257 }, () => ({
          characterId: p.boss.id,
          linkEpoch: p.boss.fleetLinkEpoch,
        })),
      });
    expect(await commit(p, pending)).toEqual({ result: "fenced" });
    expect(await sources()).toEqual([]);
    expect((await slots())[0].sourceId).toBeNull();
    expect(await candidate()).toMatchObject({
      claimReservationId: null,
      claimExpiresAt: null,
    });
  },
);

it("same captured slot still requires strictly newer evidence than a real incumbent", async () => {
  const a = await enroll(99002);
  const b = await enroll();
  await a.manual();
  b.setNow(3000);
  await b.consent();
  b.options.observedAt = at(2000);
  const pending = await b.pending();
  expect(pending.bound.expectedAuthorityGeneration).toBe(1);
  const before = [await sources(), await slots()];
  expect(await commit(b, pending)).toEqual({ result: "authority_changed" });
  expect([await sources(), await slots()]).toEqual(before);
  expect(await candidate()).toMatchObject({
    claimReservationId: null,
    nextAttemptAt: at(8000),
  });
});

it.each(["automatic", "manual"] as const)(
  "a real %s successor can replace automatic authority through the shared proof writer",
  async (successor) => {
    const a = await enroll(99002);
    const b = await enroll();
    await a.consent();
    const first = await commit(a, await a.pending());
    if (!("sourceId" in first)) throw new Error("missing initial source");
    b.setNow(4000);
    let id: string;
    if (successor === "automatic") {
      await b.consent();
      const next = await commit(b, await b.pending());
      if (!("sourceId" in next)) throw new Error("missing successor");
      id = next.sourceId;
    } else id = await b.manual();
    expect((await sources()).find((s) => s.id === first.sourceId)).toMatchObject({
      state: "ended",
      terminalReason: "superseded",
      generation: 2,
      automaticConsentGeneration: 1,
    });
    expect((await slots())[0]).toMatchObject({
      sourceId: id,
      authorityGeneration: 2,
      verifiedAt: at(4000),
    });
    expect(await candidate(99002)).toMatchObject({
      sourceId: null,
      claimReservationId: null,
    });
  },
);

it("prospective absent-source advisory is already owned when commit waits for its final device", async () => {
  const p = await enroll();
  await p.consent();
  const pending = await p.pending();
  let pid!: number;
  const db = transactionView((tx) => {
    // Observe the actual transaction backend without replacing any production operation.
    const execute = tx.execute.bind(tx);
    return new Proxy(tx, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key !== "execute") return value;
        return (async (...args: Parameters<DbTx["execute"]>) => {
          pid ??= (await execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))
            .rows[0].pid;
          return execute(...args);
        }) as DbTx["execute"];
      },
    });
  });
  const holder = await ctx.pool.connect();
  await holder.query("begin");
  await holder.query("select id from fleet_device where id=$1 for update", [p.device.id]);
  const holderPid = (
    await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
  ).rows[0].pid;
  const work = commit(p, pending, db);
  try {
    expect(await waitUntilBlockedBy(ctx.pool, holderPid)).toBe(true);
    expect(await sources()).toEqual([]);
    const locks = await ctx.pool.query<{ classid: number }>(
      "select classid::int from pg_locks where pid=$1 and locktype='advisory' and granted and classid=7",
      [pid],
    );
    expect(locks.rows).toEqual([{ classid: 7 }]);
    await holder.query("commit");
    expect((await work).result).toBe("created");
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

it("a captured cross-account roster identity is locked before account/device waits and rechecked after relink", async () => {
  const p = await enroll();
  const other = await seedAccount(ctx.db);
  const member = await seedCharacter(ctx.db, cfg, { id: 99002, accountId: other.id });
  p.options.roster.push(member.id);
  await p.consent();
  const pending = await p.pending();
  const holder = await ctx.pool.connect();
  await holder.query("begin");
  await holder.query("select id from character where id=$1 for update", [member.id]);
  const holderPid = (
    await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
  ).rows[0].pid;
  const work = commit(p, pending);
  try {
    expect(await waitUntilBlockedBy(ctx.pool, holderPid)).toBe(true);
    await holder.query("update character set fleet_link_epoch=$1 where id=$2", [
      randomUUID(),
      member.id,
    ]);
    await holder.query("commit");
    expect((await work).result).toBe("created");
    expect((await slots())[0].linkedCharacters).toEqual([
      { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
    ]);
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

it.each(["off", "reon", "revoke"] as const)(
  "positive commit first is atomic and subsequent %s closes its authority and callbacks",
  async (change) => {
    const p = await enroll();
    await p.consent();
    const pending = await p.pending();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<number>((r) => {
      ready = r;
    });
    const transaction: Db["transaction"] = (callback, config) =>
      ctx.db.transaction(async (tx) => {
        const result = await callback(tx);
        ready(
          (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]
            .pid,
        );
        await held;
        return result;
      }, config);
    const db = withTransaction(transaction);
    const work = commit(p, pending, db);
    const pid = await Promise.race([
      waiting,
      work.then(() => {
        throw new Error("positive transaction was not held");
      }),
    ]);
    p.setNow(3000);
    const control =
      change === "revoke"
        ? revokeFleetDevice(ctx.db, p.device.id, p.owner.id, p.now())
        : automatic.controlFleetAutomatic(
            ctx.db,
            { sessionId: p.sessionId, revision: 3, now: p.now() },
            {
              protocol: 2,
              request_id: randomUUID(),
              intent_created_at: p.now().toISOString(),
              enabled: change === "reon",
              expected_generation: 1,
              expected_revision: 1,
            },
          );
    try {
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      expect(await sources()).toEqual([]);
      release();
      expect((await work).result).toBe("created");
      await control;
      expect((await sources())[0]).toMatchObject({
        state: "ended",
        generation: 2,
        automaticConsentGeneration: 1,
      });
      expect((await slots())[0]).toMatchObject({
        sourceId: null,
        authorityGeneration: 2,
        linkedCharacters: [],
      });
      expect(await candidate()).toMatchObject({
        sourceId: null,
        claimReservationId: null,
      });
    } finally {
      release();
      await Promise.all([work, control]);
    }
  },
);
