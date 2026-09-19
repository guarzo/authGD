import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  character,
  fleetAutomaticCandidate,
  fleetAutomaticConsent,
  fleetSourceIntent,
  fleetSourceAuthority,
  fleetAutomaticReceipt,
  fleetSharingGate,
  auditLog,
  outbox,
} from "@/db/schema";
import type { Db } from "@/db";
import { fleetLifecycleTransaction } from "@/services/fleet-lifecycle";
import { linkCharacter, unlinkCharacter } from "@/services/accounts";
import { setTierManual } from "@/services/admin-accounts";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { getFreshAccessToken } from "@/services/tokens";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import type { AutomaticTask, AutomaticToken } from "@/core/fleet-automatic";
import * as automatic from "@/services/fleet-automatic";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { createEsiClient, EsiError, FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  createFleetSourceMemory,
  runFleetSourceJob,
  type FleetSourceDeps,
} from "@/jobs/fleet-source";
import { controlFleetSource } from "@/services/fleet-source";
import { attemptClaimedFleetAutomaticDiscovery } from "@/jobs/fleet-automatic";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import { createFleetSourceOwner } from "@/worker/fleet-source-scheduler";
import { decryptToken } from "@/lib/crypto";
import { remember } from "@/jobs/fleet-upstream";

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
  const task: AutomaticTask = {
    accountId: owner.id,
    characterId: boss.id,
    consentGeneration: 1,
    candidateGeneration: 1,
    reservationId: randomUUID(),
  };
  // Reservation input only; actual claim/bind/settle remain production owners.
  await ctx.db.insert(fleetAutomaticCandidate).values({
    ...task,
    ownerHash: boss.ownerHash,
    linkEpoch: boss.fleetLinkEpoch,
    nextAttemptAt: at(1000),
    enqueueUntil: at(11000),
    failureCount: 3,
  });
  const claim = await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () =>
    at(2000),
  );
  expect(claim).not.toBeNull();
  let now = at(2000);
  const options = {
    membership: 200,
    roster: 200,
    responseUrl: "expected",
    redirected: false,
    claims: {
      name: boss.name,
      owner: boss.ownerHash,
      scp: [FLEET_READ_SCOPE],
      sub: `CHARACTER:EVE:${boss.id}`,
      exp: at(120000).getTime() / 1000,
    } as JWTPayload,
    badSignature: false,
    malformed: false,
    lateBody: false,
    hold: undefined as undefined | ((stage: string) => Promise<void>),
  };
  const requests: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = String(raw);
    requests.push({ url, redirect: init?.redirect });
    if (url === "https://login.eveonline.com/v2/oauth/token") {
      await options.hold?.("token");
      const signed = await new SignJWT(options.claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .sign(
          options.badSignature
            ? (await generateKeyPair("RS256")).privateKey
            : keys.privateKey,
        );
      return Response.json({ access_token: signed, refresh_token: "synthetic-rotation" });
    }
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
    const stage =
      url === `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`
        ? "membership"
        : "roster";
    expect(url).toBe(
      stage === "membership"
        ? `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`
        : "https://esi.evetech.net/latest/fleets/123/members/",
    );
    const status = options[stage];
    const body =
      status !== 200
        ? { error: "private-provider-error" }
        : options.malformed
          ? { invalid: true }
          : stage === "membership"
            ? { fleet_id: 123, fleet_boss_id: 12345 }
            : [{ character_id: boss.id }];
    const response = Response.json(body, {
      status,
      headers: {
        Date: now.toUTCString(),
        Expires: new Date(
          now.getTime() + (stage === "membership" ? 60000 : 5000),
        ).toUTCString(),
        "Cache-Control": `max-age=${stage === "membership" ? 60 : 5}`,
        "x-esi-error-limit-remain": "100",
        "x-esi-error-limit-reset": "60",
      },
    });
    Object.defineProperties(response, {
      url: { value: options.responseUrl === "expected" ? url : options.responseUrl },
      redirected: { value: options.redirected },
    });
    if (options.lateBody) {
      const json = response.json.bind(response);
      response.json = async () => {
        now = at(18000);
        const body: unknown = await json();
        return body;
      };
    }
    await options.hold?.(stage);
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
  return {
    owner,
    boss,
    ...device,
    task,
    claim: claim!,
    options,
    requests,
    deps,
    setNow: (ms: number) => {
      now = at(ms);
    },
  };
}
async function candidate() {
  return (await ctx.db.select().from(fleetAutomaticCandidate))[0];
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function holdCommit(db: Db) {
  const ready = deferred<number>();
  const release = deferred();
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
async function noOwners() {
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
  expect(
    (await ctx.db.select().from(fleetSourceAuthority)).every(
      (a) =>
        a.sourceId === null &&
        a.sourceGeneration === null &&
        a.linkedCharacters.length === 0,
    ),
  ).toBe(true);
  expect(await ctx.db.select().from(outbox)).toEqual([]);
}

it("real bind captures all linked epochs and an empty generation-zero fence, without allocating a source", async () => {
  const p = await setup();
  const token: AutomaticToken = {
    admission: "admitted",
    claim: p.claim,
    settledTokenEnc: p.boss.refreshTokenEnc!,
    accessTokenExpiresAt: at(60000),
  };
  // This detached token exercises bind admission, not JWT provenance (the worker tests do that).
  const bound = await automatic.bindFleetAutomaticDiscovery(
    ctx.db,
    token,
    123,
    at(62000),
    () => at(3000),
  );
  expect(bound).toEqual({
    token,
    fleetId: 123,
    membershipRetryAt: at(62000),
    expectedAuthorityGeneration: 0,
    linkedCharacters: [{ characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch }],
  });
  await noOwners();
});

it.each([
  ["membership", 401, "fleet_read_invalid"],
  ["roster", 401, "fleet_read_invalid"],
  ["membership", 404, "not_in_fleet"],
  ["roster", 403, "not_boss"],
  ["membership", 403, "service_unavailable"],
  ["roster", 404, "service_unavailable"],
  ["membership", 429, "service_unavailable"],
  ["roster", 503, "service_unavailable"],
] as const)(
  "actual direct %s %s settles %s without creating authority",
  async (stage, status, outcome) => {
    const p = await setup();
    p.options[stage] = status;
    const before = [
      await ctx.db.select().from(fleetAutomaticConsent),
      await ctx.db.select().from(fleetAutomaticReceipt),
      await ctx.db.select().from(auditLog),
    ];
    const result = await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
    expect(result.result).toBe(status === 401 ? "suspended" : "settled");
    expect(await candidate()).toMatchObject({
      lastOutcome: outcome,
      failureCount:
        status === 401 ? 3 : outcome === "not_in_fleet" || outcome === "not_boss" ? 0 : 4,
      claimReservationId: null,
      claimExpiresAt: null,
      sourceId: null,
    });
    expect((await candidate()).nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      at(62000).getTime(),
    );
    expect(
      p.requests
        .filter((r) => r.url.includes("esi.evetech.net"))
        .every((r) => r.redirect === "error"),
    ).toBe(true);
    expect((await ctx.db.select().from(character))[0]).toMatchObject({
      ownerHash: p.boss.ownerHash,
      fleetLinkEpoch: p.boss.fleetLinkEpoch,
      tokenStatus: "valid",
      scopes: [FLEET_READ_SCOPE],
    });
    expect([
      await ctx.db.select().from(fleetAutomaticConsent),
      await ctx.db.select().from(fleetAutomaticReceipt),
      await ctx.db.select().from(auditLog),
    ]).toEqual(before);
    await noOwners();
  },
);

it.each(["scope", "subject", "owner"] as const)(
  "cryptographically verified %s loss creates only the precedence-correct rejected witness",
  async (loss) => {
    const p = await setup();
    p.options.claims.scp = [];
    if (loss !== "scope") p.options.claims.owner = "wrong-owner";
    if (loss === "subject") p.options.claims.sub = "CHARACTER:EVE:99009";
    const real = automatic.settleFleetAutomaticAuthorizationLoss;
    const spy = vi
      .spyOn(automatic, "settleFleetAutomaticAuthorizationLoss")
      .mockImplementation(async (...args) => real(...args));
    try {
      expect(await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim)).toEqual({
        result: "suspended",
      });
      expect(spy.mock.calls[0][1]).toMatchObject({
        cause: `verified_${loss === "scope" ? "scope_missing" : loss + "_mismatch"}`,
        rejected: {
          admission: "rejected",
          claim: p.claim,
          accessTokenExpiresAt: at(120000),
        },
      });
      expect(await candidate()).toMatchObject({
        lastOutcome: loss === "scope" ? "fleet_read_invalid" : "identity_changed",
        failureCount: 3,
        sourceId: null,
      });
      expect(p.requests).toHaveLength(1);
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual([]);
      await noOwners();
    } finally {
      spy.mockRestore();
    }
  },
);

it.each([
  "missing-exp",
  "expired",
  "bad-signature",
  "bad-subject",
  "unsafe-subject",
  "malformed-scope",
  "malformed-owner",
  "jwks",
] as const)("%s is never an authorization witness", async (kind) => {
  const p = await setup();
  p.options.claims.scp = [];
  if (kind === "missing-exp") delete p.options.claims.exp;
  if (kind === "expired") p.options.claims.exp = at(2000).getTime() / 1000;
  if (kind === "bad-signature") p.options.badSignature = true;
  if (kind === "bad-subject") p.options.claims.sub = "not-a-character";
  if (kind === "unsafe-subject") p.options.claims.sub = "CHARACTER:EVE:9007199254740992";
  if (kind === "malformed-scope") p.options.claims.scp = [23];
  if (kind === "malformed-owner") p.options.claims.owner = 23;
  if (kind === "jwks")
    p.deps.getKey = async () => {
      throw new EsiError("unknown-phase401", 401, "permanent");
    };
  expect((await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim)).result).toBe(
    "settled",
  );
  expect(await candidate()).toMatchObject({
    lastOutcome: "service_unavailable",
    failureCount: 4,
  });
  expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual([]);
  await noOwners();
});

it.each([
  "redirected",
  "foreign",
  "wrong-path",
  "empty-url",
  "injected",
  "injected-roster",
  "wrong-request",
  "wrong-bearer",
  "throw-fetch",
] as const)("%s 401 lacks direct provenance and cannot latch", async (kind) => {
  const p = await setup();
  p.options.membership = 401;
  if (kind === "redirected") p.options.redirected = true;
  if (kind === "foreign") p.options.responseUrl = "https://elsewhere.invalid/";
  if (kind === "wrong-path")
    p.options.responseUrl = "https://esi.evetech.net/latest/characters/99009/fleet/";
  if (kind === "injected-roster") {
    p.options.membership = 200;
    p.deps.esi = {
      ...p.deps.esi!,
      getFleetMembers: async () => {
        throw new EsiError("arbitrary", 401, "permanent");
      },
    };
  }
  if (kind === "wrong-request" || kind === "wrong-bearer")
    p.deps.esi = {
      ...p.deps.esi!,
      getCharacterFleet: async (id, token, request) => {
        await request!.fetchImpl!(
          kind === "wrong-request"
            ? "http://esi.evetech.net/latest/characters/99001/fleet/"
            : `https://esi.evetech.net/latest/characters/${id}/fleet/`,
          {
            headers: {
              authorization: `Bearer ${kind === "wrong-bearer" ? "wrong" : token}`,
            },
          },
        );
        throw new EsiError("arbitrary", 401, "permanent");
      },
    };
  if (kind === "empty-url") p.options.responseUrl = "";
  if (kind === "injected")
    p.deps.esi = {
      ...p.deps.esi!,
      getCharacterFleet: async () => {
        throw new EsiError("arbitrary", 401, "permanent");
      },
    };
  if (kind === "throw-fetch")
    p.options.hold = async (stage) => {
      if (stage === "membership") throw new EsiError("arbitrary", 401, "permanent");
    };
  expect((await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim)).result).toBe(
    "settled",
  );
  expect(await candidate()).toMatchObject({
    lastOutcome: "service_unavailable",
    failureCount: 4,
  });
  await noOwners();
});

it("positive evidence returns an explicit UNCOMMITTED continuation with the real bound snapshot and no source", async () => {
  const p = await setup();
  const result = await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
  expect(result).toMatchObject({
    result: "UNCOMMITTED",
    bound: {
      token: { admission: "admitted", claim: p.claim },
      fleetId: 123,
      expectedAuthorityGeneration: 0,
      membershipRetryAt: at(62000),
      linkedCharacters: [{ characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch }],
    },
    verified: { memberIds: [p.boss.id], nextFetchAt: at(7000) },
  });
  expect(await candidate()).toMatchObject({
    lastOutcome: null,
    failureCount: 3,
    claimReservationId: p.task.reservationId,
    sourceId: null,
  });
  await noOwners();
});

it.each([
  "rejected",
  "missing",
  "token",
  "consent",
  "revision",
  "claim",
  "reservation",
  "owner",
  "link",
  "jwt-expiry",
  "claim-expiry",
] as const)("real bind refuses %s with no writes", async (loss) => {
  const p = await setup();
  const token = {
    admission: "admitted",
    claim: p.claim,
    settledTokenEnc: p.boss.refreshTokenEnc!,
    accessTokenExpiresAt: at(60000),
  } as AutomaticToken;
  if (loss === "rejected") Object.assign(token, { admission: "rejected" });
  if (loss === "missing") Reflect.deleteProperty(token, "admission");
  if (loss === "token") await ctx.db.update(character).set({ refreshTokenEnc: "new" });
  if (loss === "consent")
    await ctx.db.update(fleetAutomaticConsent).set({ generation: 2, revision: 2 });
  if (loss === "revision")
    await ctx.db.update(fleetAutomaticConsent).set({ revision: 2 });
  if (loss === "claim")
    await ctx.db.update(fleetAutomaticCandidate).set({ claimGeneration: 2 });
  if (loss === "reservation")
    await ctx.db
      .update(fleetAutomaticCandidate)
      .set({ claimReservationId: randomUUID() });
  if (loss === "owner") await ctx.db.update(character).set({ ownerHash: "new" });
  if (loss === "link")
    await ctx.db.update(character).set({ fleetLinkEpoch: randomUUID() });
  if (loss === "jwt-expiry") Object.assign(token, { accessTokenExpiresAt: at(3000) });
  const before = await candidate();
  expect(
    await automatic.bindFleetAutomaticDiscovery(ctx.db, token, 123, at(62000), () =>
      at(loss === "claim-expiry" ? 32000 : 3000),
    ),
  ).toBeNull();
  expect(await candidate()).toEqual(before);
  expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual([]);
});

it.each([
  ["membership", "jwt"],
  ["roster", "jwt"],
  ["jwt", "jwt"],
  ["membership", "claim"],
  ["roster", "claim"],
  ["jwt", "claim"],
] as const)(
  "real %s authorization failure checks %s expiry strictly after the last approver wait",
  async (phase, expiry) => {
    const p = await setup();
    if (expiry === "jwt") p.options.claims.exp = at(4000).getTime() / 1000;
    if (phase === "jwt") p.options.claims.scp = [];
    else p.options[phase] = 401;
    const holder = await ctx.pool.connect();
    const real = automatic.settleFleetAutomaticAuthorizationLoss;
    let work: Promise<unknown> | undefined;
    let pid = 0;
    const spy = vi
      .spyOn(automatic, "settleFleetAutomaticAuthorizationLoss")
      .mockImplementation(async (...args) => {
        await holder.query("begin");
        await holder.query("select id from fleet_device where id=$1 for update", [
          p.device.id,
        ]);
        pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0].pid;
        return real(...args);
      });
    try {
      work = attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
      for (let i = 0; !pid && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
      expect(pid).not.toBe(0);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      p.setNow(expiry === "jwt" ? 4000 : 32000);
      await holder.query("commit");
      expect(await work).toEqual({ result: "fenced" });
      expect(await candidate()).toMatchObject({
        lastOutcome: null,
        claimReservationId: p.task.reservationId,
      });
      await noOwners();
    } finally {
      await holder.query("rollback");
      holder.release();
      await work;
      spy.mockRestore();
    }
  },
);

it.each(["jwt", "claim"] as const)(
  "real bind samples strict %s expiry after the final device lock",
  async (expiry) => {
    const p = await setup();
    if (expiry === "jwt") p.options.claims.exp = at(4000).getTime() / 1000;
    const holder = await ctx.pool.connect();
    let pid = 0;
    p.options.hold = async (stage) => {
      if (stage !== "membership") return;
      await holder.query("begin");
      await holder.query("select id from fleet_device where id=$1 for update", [
        p.device.id,
      ]);
      pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
    };
    const work = attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
    try {
      for (let i = 0; !pid && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
      expect(pid).not.toBe(0);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      p.setNow(expiry === "jwt" ? 4000 : 32000);
      await holder.query("commit");
      expect(await work).toEqual({ result: "fenced" });
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual([]);
      expect(p.requests.some((r) => r.url.includes("/members/"))).toBe(false);
    } finally {
      await holder.query("rollback");
      holder.release();
      await work;
    }
  },
);

it("bounded link capture accepts 8192, refuses 8193 without truncation or source allocation", async () => {
  const p = await setup();
  for (let start = 0; start < 8191; start += 500)
    await ctx.db.insert(character).values(
      Array.from({ length: Math.min(500, 8191 - start) }, (_, i) => ({
        id: 200000 + start + i,
        accountId: p.owner.id,
        name: "catalogue-fixture",
        ownerHash: "fixture",
        scopes: [],
      })),
    );
  const result = await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
  expect(result.result).toBe("UNCOMMITTED");
  if (result.result !== "UNCOMMITTED") throw new Error("missing continuation");
  expect(result.bound.linkedCharacters).toHaveLength(8192);
  const before = await ctx.db.select().from(fleetSourceAuthority);
  await seedCharacter(ctx.db, cfg, { id: 300000, accountId: p.owner.id });
  await expect(
    automatic.bindFleetAutomaticDiscovery(
      ctx.db,
      result.bound.token,
      456,
      at(62000),
      () => at(3000),
    ),
  ).rejects.toThrow("fleet_link_snapshot_overflow");
  expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(before);
  await noOwners();
});

it("shared bounded memory evicts beyond 1024 and refreshing a key does not evict another entry", () => {
  const map = new Map<number, string>();
  for (let i = 0; i < 1024; i++) remember(map, i, String(i));
  remember(map, 0, "updated");
  expect(map.size).toBe(1024);
  expect(map.get(1)).toBe("1");
  remember(map, 1024, "next");
  expect(map.size).toBe(1024);
  expect(map.has(1)).toBe(false);
  expect(map.get(0)).toBe("updated");
});

it("shared ESI backoff prevents even token HTTP and remains candidate-only pacing", async () => {
  const p = await setup();
  await expect(
    p.deps.esi!.getCharacterFleet(p.boss.id, "untrusted-fixture", {
      now: () => at(2000).getTime(),
      fetchImpl: async () =>
        Response.json(
          {},
          {
            status: 429,
            headers: {
              "Retry-After": "600",
              "x-esi-error-limit-remain": "0",
              "x-esi-error-limit-reset": "600",
            },
          },
        ),
    }),
  ).rejects.toThrow();
  expect(await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim)).toEqual({
    result: "settled",
  });
  expect(p.requests).toEqual([]);
  expect(await candidate()).toMatchObject({
    lastOutcome: "service_unavailable",
    nextAttemptAt: at(602000),
  });
  await noOwners();
});

async function predecessor(p: Awaited<ReturnType<typeof setup>>, paused = false) {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, cfg, {
    id: 88001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const device = await pairDevice(ctx.db, owner.id, NOW, ["shared-source-v1"]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: device.sessionId,
    revision: 1,
    now: NOW,
    capabilities: ["shared-source-v1"],
  });
  const sourceId = randomUUID();
  expect(
    await controlFleetSource(ctx.db, {
      sessionId: device.sessionId,
      revision: 2,
      now: at(1000),
      command: {
        protocol: 2,
        operation: "start",
        source_id: sourceId,
        expected_generation: 0,
        character_id: boss.id,
        character_link_epoch: boss.fleetLinkEpoch,
        intent_created_at: NOW.toISOString(),
      },
    }),
  ).toMatchObject({ ok: true });
  let now = at(2000);
  let failed = false;
  const fetchImpl: typeof fetch = async (raw) => {
    const url = String(raw);
    if (url === "https://login.eveonline.com/v2/oauth/token")
      return Response.json({
        access_token: await new SignJWT({
          name: boss.name,
          owner: boss.ownerHash,
          scp: [FLEET_READ_SCOPE],
        })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer("https://login.eveonline.com")
          .setAudience("EVE Online")
          .setSubject(`CHARACTER:EVE:${boss.id}`)
          .setExpirationTime(at(120000).getTime() / 1000)
          .sign(keys.privateKey),
        refresh_token: "manual-rotated",
      });
    const membership =
      url === `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`;
    expect(url).toBe(
      membership
        ? `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`
        : "https://esi.evetech.net/latest/fleets/123/members/",
    );
    return Response.json(
      membership
        ? { fleet_id: 123, fleet_boss_id: boss.id }
        : failed
          ? {}
          : [{ character_id: boss.id }],
      {
        status: failed ? 503 : 200,
        headers: {
          Date: now.toUTCString(),
          "Cache-Control": `max-age=${membership ? 60 : 5}`,
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      },
    );
  };
  const deps = { ...p.deps, now: () => now, fetchImpl };
  await runFleetSourceJob(deps, { sourceId, generation: 1 });
  expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
    state: "active",
    activatedAt: at(2000),
  });
  if (paused) {
    now = at(7000);
    failed = true;
    await runFleetSourceJob(deps, { sourceId, generation: 1 });
  }
  return { owner, boss, device, sourceId };
}

it.each([false, true])(
  "bind includes an actual activated predecessor (paused=%s) and captures its authority generation without replacing it",
  async (paused) => {
    const p = await setup();
    const pred = await predecessor(p, paused);
    const before = [
      await ctx.db.select().from(fleetSourceIntent),
      await ctx.db.select().from(fleetSourceAuthority),
    ];
    const holder = await ctx.pool.connect();
    const token: AutomaticToken = {
      admission: "admitted",
      claim: p.claim,
      settledTokenEnc: p.boss.refreshTokenEnc!,
      accessTokenExpiresAt: at(120000),
    };
    let work: ReturnType<typeof automatic.bindFleetAutomaticDiscovery> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from character where id=$1 for update", [
        pred.boss.id,
      ]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      work = automatic.bindFleetAutomaticDiscovery(ctx.db, token, 123, at(62000), () =>
        at(8000),
      );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await holder.query("commit");
      expect(await work).toMatchObject({
        expectedAuthorityGeneration: paused ? 2 : 1,
        linkedCharacters: [
          { characterId: pred.boss.id, linkEpoch: pred.boss.fleetLinkEpoch },
          { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
        ],
      });
      expect([
        await ctx.db.select().from(fleetSourceIntent),
        await ctx.db.select().from(fleetSourceAuthority),
      ]).toEqual(before);
    } finally {
      await holder.query("rollback");
      holder.release();
      await work;
    }
  },
);

it("a new predecessor during account wait causes a whole outer bind retry with the expanded selectors", async () => {
  const p = await setup();
  const holder = await ctx.pool.connect();
  let attempts = 0;
  const transaction: Db["transaction"] = (work, config) => {
    attempts++;
    return ctx.db.transaction(work, config);
  };
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return prop === "transaction" ? transaction : value;
    },
  });
  let work: ReturnType<typeof automatic.bindFleetAutomaticDiscovery> | undefined;
  try {
    await holder.query("begin");
    await holder.query("select id from account where id=$1 for update", [p.owner.id]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    work = automatic.bindFleetAutomaticDiscovery(
      db,
      {
        admission: "admitted",
        claim: p.claim,
        settledTokenEnc: p.boss.refreshTokenEnc!,
        accessTokenExpiresAt: at(120000),
      },
      123,
      at(62000),
      () => at(3000),
    );
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    const pred = await predecessor(p);
    await holder.query("commit");
    expect(await work).toMatchObject({
      expectedAuthorityGeneration: 1,
      linkedCharacters: [
        { characterId: pred.boss.id, linkEpoch: pred.boss.fleetLinkEpoch },
        { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
      ],
    });
    expect(attempts).toBe(2);
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBe(
      pred.sourceId,
    );
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(1);
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

it.each(["failure", "writer"] as const)(
  "actual lifecycle race, %s commits first",
  async (first) => {
    // One matrix test owns the DB serially; each cell uses real HTTP/JWT/bind,
    // actual lifecycle writers and a PostgreSQL-observed blocking edge.
    for (const change of [
      "Off",
      "reOn",
      "revoke",
      "Member",
      "mode",
      "unlink-relink",
    ] as const) {
      await truncateAll(ctx.db);
      const p = await setup();
      await seedCharacter(ctx.db, cfg, { id: 99002, accountId: p.owner.id });
      p.options.roster = 401;
      const arrived = deferred();
      const deliver = deferred();
      p.options.hold = async (stage) => {
        if (stage === "roster") {
          arrived.resolve();
          await deliver.promise;
        }
      };
      const input = {
        ...(await verifyEveAccessToken(
          await new SignJWT({
            name: p.boss.name,
            owner: p.boss.ownerHash,
            scp: [FLEET_READ_SCOPE],
          })
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer("https://login.eveonline.com")
            .setAudience("EVE Online")
            .setSubject(`CHARACTER:EVE:${p.boss.id}`)
            .setExpirationTime(at(120000).getTime() / 1000)
            .sign(keys.privateKey),
          getKey,
          { currentDate: at(2000) },
        )),
        refreshToken: "accepted-relink",
      };
      const held = holdCommit(ctx.db);
      const real = automatic.settleFleetAutomaticAuthorizationLoss;
      const spy = vi
        .spyOn(automatic, "settleFleetAutomaticAuthorizationLoss")
        .mockImplementation((db, ...args) =>
          real(first === "failure" ? held.db : db, ...args),
        );
      const mutate = async (db: Db) => {
        if (change === "Off" || change === "reOn")
          expect(
            await automatic.controlFleetAutomatic(
              db,
              { sessionId: p.sessionId, revision: 3, now: at(3000) },
              {
                protocol: 2,
                request_id: randomUUID(),
                intent_created_at: at(3000).toISOString(),
                enabled: change === "reOn",
                expected_generation: 1,
                expected_revision: 1,
              },
            ),
          ).toMatchObject({ ok: true });
        if (change === "revoke")
          await revokeFleetDevice(db, p.device.id, p.owner.id, at(3000));
        if (change === "Member")
          expect(
            await fleetLifecycleTransaction(db, (tx) =>
              setTierManual(tx, "system", p.owner.id, "alumni"),
            ),
          ).toMatchObject({ ok: true });
        if (change === "mode")
          await transitionFleetSharingMode(db, {
            enabled: false,
            expectedRevision: (await ctx.db.select().from(fleetSharingGate))[0].revision,
            now: at(3000),
          });
        if (change === "unlink-relink")
          expect(
            await fleetLifecycleTransaction(db, (tx) =>
              unlinkCharacter(tx, cfg, p.owner.id, p.boss.id),
            ),
          ).toEqual({ ok: true });
      };
      const failure = attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
      let writer: Promise<unknown> | undefined;
      try {
        await arrived.promise;
        if (first === "failure") deliver.resolve();
        else writer = mutate(held.db);
        const pid = await held.ready;
        if (first === "failure") writer = mutate(ctx.db);
        else deliver.resolve();
        expect(await waitUntilBlockedBy(ctx.pool, pid), change).toBe(true);
        held.release();
        expect(await failure, change).toEqual({
          result: first === "failure" ? "suspended" : "fenced",
        });
        await writer;
        if (change === "Member")
          await fleetLifecycleTransaction(ctx.db, (tx) =>
            setTierManual(tx, "system", p.owner.id, "member"),
          );
        if (change === "mode")
          await transitionFleetSharingMode(ctx.db, {
            enabled: true,
            expectedRevision: (await ctx.db.select().from(fleetSharingGate))[0].revision,
            now: at(4000),
          });
        if (change === "unlink-relink") {
          expect(
            await fleetLifecycleTransaction(ctx.db, (tx) =>
              linkCharacter(tx, cfg, p.owner.id, input),
            ),
          ).toEqual({ ok: true });
          // Candidate has an account FK, not a character FK: retain its old-link
          // counters/latch for the future binding reconciliation owner.
          expect(await candidate()).toMatchObject({
            linkEpoch: p.boss.fleetLinkEpoch,
            claimGeneration: 1,
            claimReservationId: null,
            lastOutcome: first === "failure" ? "fleet_read_invalid" : null,
          });
          expect(
            (await ctx.db.select().from(character).where(eq(character.id, p.boss.id)))[0]
              .fleetLinkEpoch,
          ).not.toBe(p.boss.fleetLinkEpoch);
        } else
          expect(await candidate(), change).toMatchObject({
            lastOutcome: first === "failure" ? "fleet_read_invalid" : null,
            claimReservationId: null,
            sourceId: null,
          });
        expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
        expect(
          (await ctx.db.select().from(fleetSourceAuthority)).every(
            (a) => a.sourceId === null,
          ),
        ).toBe(true);
        expect(
          (await ctx.db.select().from(outbox)).every((r) => r.payload.kind === "account"),
        ).toBe(true);
      } finally {
        deliver.resolve();
        held.release();
        await Promise.allSettled([failure, ...(writer ? [writer] : [])]);
        spy.mockRestore();
      }
    }
  },
  30000,
);

it.each([
  {
    first: "failure",
    label: "failure-first rejects a stale/unreserved delivery before due",
  },
  { first: "claim", label: "replacement claim first fences the old failure callback" },
] as const)("$label", async ({ first }) => {
  const p = await setup();
  p.options.roster = 401;
  const arrived = deferred();
  const deliver = deferred();
  p.options.hold = async (stage) => {
    if (stage === "roster") {
      arrived.resolve();
      await deliver.promise;
    }
  };
  const held = holdCommit(ctx.db);
  const real = automatic.settleFleetAutomaticAuthorizationLoss;
  const spy = vi
    .spyOn(automatic, "settleFleetAutomaticAuthorizationLoss")
    .mockImplementation((db, ...args) =>
      real(first === "failure" ? held.db : db, ...args),
    );
  const failure = attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
  let replacement: ReturnType<typeof automatic.claimFleetAutomaticDiscovery> | undefined;
  const task = { ...p.task, reservationId: randomUUID() };
  try {
    await arrived.promise;
    if (first === "claim") {
      // A retained replacement reservation is fixture INPUT, not a new reserver.
      await ctx.db.update(fleetAutomaticCandidate).set({
        claimReservationId: null,
        claimExpiresAt: null,
        reservationId: task.reservationId,
        enqueueUntil: at(11000),
      });
      replacement = automatic.claimFleetAutomaticDiscovery(held.db, task, () => at(3000));
    } else deliver.resolve();
    const pid = await held.ready;
    if (first === "claim") deliver.resolve();
    else
      replacement = automatic.claimFleetAutomaticDiscovery(ctx.db, task, () => at(3000));
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    held.release();
    expect(await failure).toEqual({
      result: first === "failure" ? "suspended" : "fenced",
    });
    const next = await replacement;
    if (first === "failure") {
      expect(next).toBeNull();
      expect(await candidate()).toMatchObject({
        lastOutcome: "fleet_read_invalid",
        claimGeneration: 1,
      });
    } else {
      expect(next).toMatchObject({ task, claimGeneration: 2 });
      expect(await candidate()).toMatchObject({
        lastOutcome: null,
        claimGeneration: 2,
        claimReservationId: task.reservationId,
      });
    }
    await noOwners();
  } finally {
    deliver.resolve();
    held.release();
    await Promise.allSettled([failure, ...(replacement ? [replacement] : [])]);
    spy.mockRestore();
  }
});

it("failure-first suspension alone refuses a due retained replacement reservation; the identical unsuspended control claims", async () => {
  const p = await setup();
  p.options.roster = 401;
  const held = holdCommit(ctx.db);
  const real = automatic.settleFleetAutomaticAuthorizationLoss;
  const spy = vi
    .spyOn(automatic, "settleFleetAutomaticAuthorizationLoss")
    .mockImplementation((_db, ...args) => real(held.db, ...args));
  const failure = attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
  const task = { ...p.task, reservationId: randomUUID() };
  let reservation: Promise<unknown> | undefined;
  try {
    const pid = await held.ready;
    // Retained reservation INPUT, not a scheduler: only these two fields change.
    // In particular, the failed binding, latch, counters and pacing survive.
    reservation = ctx.db.transaction(async (tx) => {
      // Read the post-failure row before constructing the replacement input;
      // an UPDATE against the old live-claim tuple would violate its CHECK.
      const [current] = await tx.select().from(fleetAutomaticCandidate).for("update");
      expect(current).toMatchObject({
        lastOutcome: "fleet_read_invalid",
        nextAttemptAt: at(62000),
      });
      p.setNow(62000);
      await tx.update(fleetAutomaticCandidate).set({
        reservationId: task.reservationId,
        enqueueUntil: at(72000),
      });
    });
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    held.release();
    expect(await failure).toEqual({ result: "suspended" });
    await reservation;
    const suspended = await candidate();
    expect(suspended).toMatchObject({
      accountId: task.accountId,
      characterId: task.characterId,
      consentGeneration: task.consentGeneration,
      candidateGeneration: task.candidateGeneration,
      ownerHash: p.boss.ownerHash,
      linkEpoch: p.boss.fleetLinkEpoch,
      reservationId: task.reservationId,
      enqueueUntil: at(72000),
      nextAttemptAt: at(62000),
      claimReservationId: null,
      claimExpiresAt: null,
      sourceId: null,
      lastOutcome: "fleet_read_invalid",
      claimGeneration: 1,
    });
    const due = at(62000);
    expect(
      await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () => due),
    ).toBeNull();
    expect(await candidate()).toEqual(suspended);
    // Counterfactual input control, NOT a grant-wake implementation. The same
    // row/task/clock must claim when only the suspension outcome is absent.
    await ctx.db.update(fleetAutomaticCandidate).set({ lastOutcome: null });
    expect(await candidate()).toEqual({ ...suspended, lastOutcome: null });
    expect(
      await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () => due),
    ).toMatchObject({ task, claimGeneration: 2, claimExpiresAt: at(92000) });
    expect(await candidate()).toMatchObject({
      lastOutcome: null,
      claimGeneration: 2,
      claimReservationId: task.reservationId,
      reservationId: null,
      enqueueUntil: null,
      claimExpiresAt: at(92000),
    });
    await noOwners();
  } finally {
    held.release();
    await Promise.allSettled([failure, ...(reservation ? [reservation] : [])]);
    spy.mockRestore();
  }
});

it("manual and automatic attempts share actual token/membership memory while negative pacing does not delay healthy active roster", async () => {
  const p = await setup();
  expect((await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim)).result).toBe(
    "UNCOMMITTED",
  );
  const sourceId = randomUUID();
  expect(
    await controlFleetSource(ctx.db, {
      sessionId: p.sessionId,
      revision: 3,
      now: at(3000),
      command: {
        protocol: 2,
        operation: "start",
        source_id: sourceId,
        expected_generation: 0,
        character_id: p.boss.id,
        character_link_epoch: p.boss.fleetLinkEpoch,
        intent_created_at: at(3000).toISOString(),
      },
    }),
  ).toMatchObject({ ok: true });
  p.setNow(3000);
  await runFleetSourceJob(p.deps, { sourceId, generation: 1 });
  const before = await ctx.db.select().from(fleetSourceIntent);
  expect(before[0]).toMatchObject({ state: "active", nextFetchAt: at(8000) });
  p.setNow(4000);
  p.options.roster = 403;
  // A subsequent real claim captures the settled blob. Re-running the original
  // claim snapshot would correctly miss cache/CAS after its first rotation.
  const task = { ...p.task, reservationId: randomUUID() };
  await ctx.db.update(fleetAutomaticCandidate).set({
    claimReservationId: null,
    claimExpiresAt: null,
    reservationId: task.reservationId,
    enqueueUntil: at(14000),
  });
  const nextClaim = await automatic.claimFleetAutomaticDiscovery(ctx.db, task, () =>
    at(4000),
  );
  expect(nextClaim).not.toBeNull();
  await attemptClaimedFleetAutomaticDiscovery(p.deps, nextClaim!);
  expect(p.requests.map((r) => r.url)).toEqual([
    "https://login.eveonline.com/v2/oauth/token",
    `https://esi.evetech.net/latest/characters/${p.boss.id}/fleet/`,
    ...Array(3).fill("https://esi.evetech.net/latest/fleets/123/members/"),
  ]);
  expect(await candidate()).toMatchObject({
    lastOutcome: "not_boss",
    nextAttemptAt: at(62000),
    failureCount: 0,
  });
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(before);
  p.setNow(8000);
  p.options.roster = 200;
  await runFleetSourceJob(p.deps, { sourceId, generation: 1 });
  expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
    state: "active",
    nextFetchAt: at(13000),
  });
  expect(p.requests.filter((r) => r.url.includes("/oauth/token"))).toHaveLength(1);
  expect(p.requests.filter((r) => r.url.includes("/characters/"))).toHaveLength(1);
});

type RotationWait = {
  pid: number;
  blockers: number[];
  waitEventType: string | null;
  tokenCas: boolean;
  characterLock: boolean;
};
async function rotationWaits(pids: number[]) {
  return (
    await ctx.pool.query<RotationWait>(
      `
    select pid, pg_blocking_pids(pid) as blockers,
      wait_event_type as "waitEventType",
      query like 'update "character" set "refresh_token_enc"%' as "tokenCas",
      query like 'select %from "character"%for update%' as "characterLock"
    from pg_stat_activity where pid = any($1::int[]) order by pid
  `,
      [pids],
    )
  ).rows;
}
async function requireRotationDiscoveryWait(
  holderPid: number,
  rotationPid: number,
  discoveryPid: () => number | undefined,
) {
  let rows: RotationWait[] = [];
  const deadline = Date.now() + 1000;
  do {
    const discovery = discoveryPid();
    rows = await rotationWaits([rotationPid, ...(discovery ? [discovery] : [])]);
    const rotation = rows.find((r) => r.pid === rotationPid);
    const failure = rows.find((r) => r.pid === discovery);
    if (
      rotation?.tokenCas &&
      rotation.waitEventType === "Lock" &&
      rotation.blockers.includes(holderPid) &&
      failure?.characterLock &&
      failure.waitEventType === "Lock" &&
      failure.pid !== rotationPid &&
      failure.pid !== holderPid &&
      failure.blockers.some((pid) => pid === holderPid || pid === rotationPid)
    )
      return rows;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < deadline);
  throw new Error(
    `rotation/discovery lock proof missing before holder release: ${JSON.stringify({ holderPid, rotationPid, discoveryPid: discoveryPid(), rows })}`,
  );
}

it.each(["failure", "rotation"] as const)(
  "actual token CAS race, %s first, cannot erase a prior latch or authorize stale refusal",
  async (first) => {
    const p = await setup();
    p.options.roster = 401;
    const arrived = deferred();
    const deliver = deferred();
    p.options.hold = async (stage) => {
      if (stage === "roster") {
        arrived.resolve();
        await deliver.promise;
      }
    };
    const held = holdCommit(ctx.db);
    const real = automatic.settleFleetAutomaticAuthorizationLoss;
    const spy = vi
      .spyOn(automatic, "settleFleetAutomaticAuthorizationLoss")
      .mockImplementation((db, ...args) =>
        real(first === "failure" ? held.db : db, ...args),
      );
    let discoveryPid: number | undefined;
    const transaction: Db["transaction"] = (work, config) =>
      ctx.db.transaction(async (tx) => {
        discoveryPid = (
          await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        ).rows[0].pid;
        return work(tx);
      }, config);
    const observedDiscoveryDb = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        return prop === "transaction" ? transaction : value;
      },
    });
    if (first === "rotation")
      spy.mockImplementation((_db, ...args) => real(observedDiscoveryDb, ...args));
    const holder = await ctx.pool.connect();
    const failure = attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
    let rotation: Promise<unknown> | undefined;
    try {
      await arrived.promise;
      const row = (await ctx.db.select().from(character))[0];
      const rotate = () =>
        getFreshAccessToken(ctx.db, cfg, row, async (url) => {
          expect(String(url)).toBe("https://login.eveonline.com/v2/oauth/token");
          return Response.json({
            access_token: "not-used-as-proof",
            refresh_token: "other-consumer-rotation",
          });
        });
      if (first === "failure") {
        deliver.resolve();
        const pid = await held.ready;
        rotation = rotate();
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        held.release();
      } else {
        // Queue the REAL auto-commit CAS behind a row lock first, then queue
        // discovery's final row lock behind it; no transaction spans HTTP.
        await holder.query("begin");
        await holder.query("select id from character where id=$1 for update", [
          p.boss.id,
        ]);
        const pid = (
          await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0].pid;
        rotation = rotate();
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        const rotationRows = (
          await ctx.pool.query<RotationWait>(
            `
          select pid, pg_blocking_pids(pid) as blockers,
            wait_event_type as "waitEventType",
            query like 'update "character" set "refresh_token_enc"%' as "tokenCas",
            false as "characterLock"
          from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
        `,
            [pid],
          )
        ).rows;
        expect(rotationRows).toHaveLength(1);
        expect(rotationRows[0]).toMatchObject({
          blockers: [pid],
          waitEventType: "Lock",
          tokenCas: true,
        });
        const rotationPid = rotationRows[0].pid;
        // Delivery enters the real settlement transaction, whose actual backend
        // PID is observed above, not inferred from an anonymous waiter count.
        deliver.resolve();
        const waiting = await requireRotationDiscoveryWait(
          pid,
          rotationPid,
          () => discoveryPid,
        );
        expect(waiting).toHaveLength(2);
        expect(waiting.find((r) => r.pid === discoveryPid)).toMatchObject({
          waitEventType: "Lock",
          characterLock: true,
        });
        expect(
          waiting
            .find((r) => r.pid === discoveryPid)!
            .blockers.some((blocker) => blocker === pid || blocker === rotationPid),
        ).toBe(true);
        await holder.query("commit");
      }
      expect(await rotation).toMatchObject({ ok: true });
      expect(await failure).toEqual({
        result: first === "failure" ? "suspended" : "fenced",
      });
      expect(await candidate()).toMatchObject({
        lastOutcome: first === "failure" ? "fleet_read_invalid" : null,
      });
      expect(
        decryptToken(
          (await ctx.db.select().from(character))[0].refreshTokenEnc!,
          cfg.tokenEncryptionKey,
        ),
      ).toBe("other-consumer-rotation");
      await noOwners();
    } finally {
      deliver.resolve();
      held.release();
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled([failure, ...(rotation ? [rotation] : [])]);
      spy.mockRestore();
    }
  },
);

it.each(["membership", "roster"] as const)(
  "%s HTTP401 delivered after the shared 15s deadline cannot latch",
  async (stage) => {
    const p = await setup();
    p.options[stage] = 401;
    p.options.hold = async (phase) => {
      if (phase === stage) p.setNow(18000);
    };
    await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
    expect(await candidate()).toMatchObject({
      lastOutcome: "timed_out",
      failureCount: 4,
    });
    await noOwners();
  },
);

it("a direct 401 whose body completes beyond the HTTP budget is a timeout, not a latch", async () => {
  const p = await setup();
  p.options.membership = 401;
  p.options.lateBody = true;
  await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
  expect(await candidate()).toMatchObject({ lastOutcome: "timed_out", failureCount: 4 });
  await noOwners();
});

it.each(["membership", "roster"] as const)(
  "malformed %s HTTP200 retries without authorization loss",
  async (stage) => {
    const p = await setup();
    p.options.malformed = stage === "membership";
    if (stage === "roster")
      p.options.hold = async (phase) => {
        if (phase === "membership") p.options.malformed = true;
      };
    await attemptClaimedFleetAutomaticDiscovery(p.deps, p.claim);
    expect(await candidate()).toMatchObject({
      lastOutcome: "service_unavailable",
      failureCount: 4,
      claimReservationId: null,
    });
    await noOwners();
  },
);

it.each(["deadline", "shutdown"] as const)(
  "the original token CAS promise remains owned past %s until settlement",
  async (kind) => {
    const p = await setup();
    const owner = createFleetSourceOwner();
    const holder = await ctx.pool.connect();
    let pid = 0;
    p.options.hold = async (stage) => {
      if (stage !== "token") return;
      await holder.query("begin");
      await holder.query("select id from character where id=$1 for update", [p.boss.id]);
      pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
    };
    let finished = false;
    const handler = owner.wrap(async () => {
      await attemptClaimedFleetAutomaticDiscovery(
        { ...p.deps, signal: owner.signal },
        p.claim,
      );
      finished = true;
    });
    const work = handler({});
    let draining: Promise<void> | undefined;
    try {
      for (let i = 0; !pid && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
      expect(pid).not.toBe(0);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      if (kind === "deadline") p.setNow(18000);
      else owner.stopAdmission();
      let drained = false;
      draining = owner.drain().then(() => {
        drained = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(finished).toBe(false);
      expect(drained).toBe(false);
      await holder.query("commit");
      await work;
      await draining;
      expect(
        decryptToken(
          (await ctx.db.select().from(character))[0].refreshTokenEnc!,
          cfg.tokenEncryptionKey,
        ),
      ).toBe("synthetic-rotation");
      expect(p.requests).toHaveLength(1);
      expect(await candidate()).toMatchObject({
        lastOutcome: "timed_out",
        sourceId: null,
      });
      await noOwners();
    } finally {
      owner.stopAdmission();
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled([work, ...(draining ? [draining] : [])]);
      await owner.drain();
    }
  },
);
