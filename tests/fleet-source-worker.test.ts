import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import {
  auditLog,
  character,
  fleetSourceAuthority,
  fleetSourceIntent,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { createEsiClient, FLEET_READ_SCOPE } from "@/lib/esi/client";
import { encryptToken } from "@/lib/crypto";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { controlFleetSource } from "@/services/fleet-source";
import {
  cleanupFleetSources,
  reserveDueFleetSources,
} from "@/services/fleet-source-maintenance";
import { dispatchOutbox } from "@/worker/dispatcher";
import { runFleetSourceJob, createFleetSourceMemory } from "@/jobs/fleet-source";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { createFleetSourceOwner } from "@/worker/fleet-source-scheduler";
import { createQueues, QUEUES } from "@/worker/queues";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
const keys = await generateKeyPair("RS256");
const getKey = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "source-test" }],
});
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
async function setup(id = 99001, fleet = 123, initialize = true) {
  if (initialize) {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
  }
  const owner = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const alt = await seedCharacter(ctx.db, testConfig(), {
    id: id + 1,
    accountId: owner.id,
    scopes: [],
    refreshToken: null,
  });
  const p = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: NOW,
    capabilities: [SHARED_CAPABILITY],
  });
  const sourceId = randomUUID();
  expect(
    (
      await controlFleetSource(ctx.db, {
        sessionId: p.sessionId,
        revision: 2,
        now: at(500),
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
  let now = at(1000);
  let rosterStatus = 200;
  let observation = 1000;
  let expiry = true;
  let membershipFleet = fleet;
  let membershipHold: (() => Promise<void>) | undefined;
  let membershipHeaders: Record<string, string | null> = {};
  let rosterHeaders: Record<string, string | null> = {};
  let rosterIds = [boss.id, alt.id, 777];
  let malformedRoster = false;
  let tokenScopes = [FLEET_READ_SCOPE];
  let tokenOwner = boss.ownerHash;
  let tokenError = false;
  let tokenExpiry = 3600000;
  const requests: string[] = [];
  let hold: (() => Promise<void>) | undefined;
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = String(raw);
    if (url === "https://login.eveonline.com/v2/oauth/token") {
      requests.push("token");
      if (tokenError)
        return Response.json({ error: "private-marker-token-payload" }, { status: 400 });
      const jwt = new SignJWT({ name: boss.name, owner: tokenOwner, scp: tokenScopes })
        .setProtectedHeader({ alg: "RS256", kid: "source-test" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .setSubject(`CHARACTER:EVE:${boss.id}`);
      if (expiry) jwt.setExpirationTime(Math.floor(at(tokenExpiry).getTime() / 1000));
      return Response.json({
        access_token: await jwt.sign(keys.privateKey),
        refresh_token: "synthetic-rotated",
      });
    }
    if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer "))
      throw new Error("missing synthetic bearer");
    if (url === `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`) {
      requests.push("membership");
      const response = Response.json(
        { fleet_id: membershipFleet, fleet_boss_id: 999 },
        {
          headers: {
            Date: now.toUTCString(),
            Expires: new Date(now.getTime() + 60000).toUTCString(),
            "Cache-Control": "max-age=60",
            "x-esi-error-limit-remain": "100",
            "x-esi-error-limit-reset": "60",
          },
        },
      );
      for (const [name, value] of Object.entries(membershipHeaders)) {
        if (value === null) response.headers.delete(name);
        else response.headers.set(name, value);
      }
      await membershipHold?.();
      return response;
    }
    if (url === `https://esi.evetech.net/latest/fleets/${fleet}/members/`) {
      requests.push("roster");
      const response = Response.json(
        rosterStatus === 200
          ? malformedRoster
            ? { invalid: true }
            : rosterIds.map((id) => ({ character_id: id, ship_type_id: 7 }))
          : { error: "private provider path" },
        {
          status: rosterStatus,
          headers: {
            Date: at(observation).toUTCString(),
            Expires: at(observation + 5000).toUTCString(),
            "Cache-Control": "max-age=5",
          },
        },
      );
      for (const [name, value] of Object.entries(rosterHeaders)) {
        if (value === null) response.headers.delete(name);
        else response.headers.set(name, value);
      }
      await hold?.();
      return response;
    }
    throw new Error("unexpected synthetic endpoint");
  };
  const deps = {
    db: ctx.db,
    cfg: testConfig(),
    fetchImpl,
    getKey,
    now: () => now,
    memory: createFleetSourceMemory(),
  };
  return {
    ...p,
    boss,
    alt,
    sourceId,
    requests,
    deps,
    setNow: (ms: number) => {
      now = at(ms);
    },
    setObservation: (ms: number) => {
      observation = ms;
    },
    restoreRoster: () => {
      rosterStatus = 200;
    },
    changeFleet: () => {
      membershipFleet = 456;
    },
    revokeScope: () => {
      tokenScopes = [];
    },
    changeOwner: () => {
      tokenOwner = "different-owner";
    },
    failRoster: () => {
      rosterStatus = 503;
    },
    ordinary: () => {
      rosterStatus = 403;
    },
    noExpiry: () => {
      expiry = false;
    },
    shortToken: (ms = 2000) => {
      tokenExpiry = ms;
    },
    membershipHold: (value: () => Promise<void>) => {
      membershipHold = value;
    },
    membershipHeaders: (value: Record<string, string | null>) => {
      membershipHeaders = value;
    },
    rosterHeaders: (value: Record<string, string | null>) => {
      rosterHeaders = value;
    },
    rosterIds: (value: number[]) => {
      rosterIds = value;
    },
    malformedRoster: () => {
      malformedRoster = true;
    },
    tokenError: () => {
      tokenError = true;
    },
    hold: (value: () => Promise<void>) => {
      hold = value;
    },
  };
}
describe("actual source job and ESI parser (synthetic provider only)", () => {
  it("roster access establishes boss proof even when membership boss hint differs; retains linked ungranted alt only", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests).toEqual(["token", "membership", "roster"]);
    const [authority] = await ctx.db.select().from(fleetSourceAuthority);
    expect(authority).toMatchObject({
      sourceId: p.sourceId,
      fleetId: 123,
      verifiedAt: at(1000),
      expiresAt: at(11000),
      linkedCharacters: [
        { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
        { characterId: p.alt.id, linkEpoch: p.alt.fleetLinkEpoch },
      ],
    });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "active",
      fleetId: 123,
      activatedAt: at(1000),
    });
  });
  it("verified token and separate discovery cache avoid SSO and membership on five-second roster refresh", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    p.setNow(6000);
    p.setObservation(6000);
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests).toEqual(["token", "membership", "roster", "roster"]);
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].expiresAt).toEqual(
      at(16000),
    );
  });
  it("replayed evidence cannot renew authority or create a tight refetch loop", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    p.setNow(6000);
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].expiresAt).toEqual(
      at(11000),
    );
    p.setNow(6500);
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(2);
  });
  it.each([
    ["60", 61000],
    ["86401", 86402000],
    ["bad", 61000],
  ] as const)(
    "shares the worker ESI error budget without capping or guessing reset %s",
    async (reset, next) => {
      const p = await setup();
      const esi = createEsiClient({
        now: () => at(1000).getTime(),
        fetchImpl: async () =>
          Response.json([], {
            headers: {
              "x-esi-error-limit-remain": "0",
              "x-esi-error-limit-reset": reset,
            },
          }),
      });
      await esi.getFleetMembers(999, "synthetic-other-job");
      await runFleetSourceJob(
        { ...p.deps, esi },
        { sourceId: p.sourceId, generation: 1 },
      );
      expect(p.requests).toEqual([]);
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        nextFetchAt: at(next),
      });
    },
  );
  it.each(["credential", "claim", "JWT"])(
    "held mismatched membership cannot terminate after %s fence loss",
    async (loss) => {
      const p = await setup();
      if (loss === "JWT") p.shortToken(62000);
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      const before = (await ctx.db.select().from(fleetSourceAuthority))[0];
      p.setNow(61000);
      p.changeFleet();
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((r) => {
        reached = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      p.membershipHold(async () => {
        reached();
        await held;
      });
      const pending = runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      await arrived;
      try {
        if (loss === "credential")
          await ctx.db
            .update(character)
            .set({
              refreshTokenEnc: encryptToken(
                "newer-context",
                testConfig().tokenEncryptionKey,
              ),
            })
            .where(eq(character.id, p.boss.id));
        else p.setNow(loss === "claim" ? 91000 : 62000);
      } finally {
        release();
        await pending;
      }
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "active",
        generation: 1,
        terminalReason: null,
        activatedAt: at(1000),
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toEqual(before);
      expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(1);
    },
  );
  it.each(["owner", "scope"])(
    "missing JWT expiry cannot authorize terminal %s proof",
    async (loss) => {
      const p = await setup();
      p.noExpiry();
      if (loss === "owner") p.changeOwner();
      else p.revokeScope();
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        generation: 1,
        terminalReason: null,
      });
      expect(p.requests).toEqual(["token"]);
    },
  );
  it.each(["owner", "scope"])(
    "held terminal %s commit rechecks verified JWT expiry after real row-lock wait",
    async (loss) => {
      const p = await setup();
      p.shortToken();
      if (loss === "owner") p.changeOwner();
      else p.revokeScope();
      const holder = await ctx.pool.connect();
      let pid = 0;
      const pending = runFleetSourceJob(
        {
          ...p.deps,
          getKey: async (...args) => {
            const key = await getKey(...args);
            await holder.query("begin");
            pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
              .rows[0].pid;
            await holder.query(
              "select id from fleet_source_intent where id = $1 for update",
              [p.sourceId],
            );
            return key;
          },
        },
        { sourceId: p.sourceId, generation: 1 },
      );
      try {
        for (let i = 0; !pid && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
        expect(pid).not.toBe(0);
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        p.setNow(2000);
      } finally {
        await holder.query("rollback");
        holder.release();
        await pending;
      }
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        terminalReason: null,
        generation: 1,
      });
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual([]);
      expect(p.requests).toEqual(["token"]);
    },
  );
  it.each([
    ["missing Date", { Date: null }],
    [
      "unsupported directive",
      { "Cache-Control": "max-age=5, stale-while-revalidate=30" },
    ],
    [
      "malformed budget",
      { "x-esi-error-limit-remain": "0", "x-esi-error-limit-reset": "bad" },
    ],
  ] as const)(
    "scheduler automatically recovers %s under the same activation without another caller",
    async (_label, headers) => {
      const p = await setup();
      const esi = createEsiClient();
      const tick = async () => {
        await cleanupFleetSources(ctx.db, p.deps.now);
        await reserveDueFleetSources(ctx.db, p.deps.now);
        await dispatchOutbox(ctx.db, async (_queue, data) => {
          await runFleetSourceJob(
            { ...p.deps, esi },
            data as { sourceId: string; generation: number },
          );
        });
      };
      await tick();
      p.setNow(6000);
      p.setObservation(6000);
      p.rosterHeaders(headers);
      await tick();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        nextFetchAt: at(66000),
        activatedAt: at(1000),
        generation: 1,
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: null,
        linkedCharacters: [],
        expiresAt: null,
      });
      const calls = p.requests.length;
      p.setNow(65999);
      await tick();
      expect(p.requests).toHaveLength(calls);
      p.rosterHeaders({
        "x-esi-error-limit-remain": "100",
        "x-esi-error-limit-reset": "60",
      });
      p.setNow(66000);
      p.setObservation(66000);
      await tick();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        id: p.sourceId,
        state: "active",
        activatedAt: at(1000),
        generation: 1,
        nextFetchAt: at(71000),
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        verifiedAt: at(66000),
        expiresAt: at(76000),
      });
      expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(3);
    },
  );
  it("missing membership Date automatically recovers after the independent discovery cache bound", async () => {
    const p = await setup();
    const tick = async () => {
      await cleanupFleetSources(ctx.db, p.deps.now);
      await reserveDueFleetSources(ctx.db, p.deps.now);
      await dispatchOutbox(ctx.db, async (_queue, data) => {
        await runFleetSourceJob(p.deps, data as { sourceId: string; generation: number });
      });
    };
    await tick();
    p.setNow(61000);
    p.membershipHeaders({ Date: null });
    await tick();
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "paused",
      nextFetchAt: at(121000),
      activatedAt: at(1000),
      generation: 1,
    });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: null,
      expiresAt: null,
      linkedCharacters: [],
    });
    expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(1);
    p.setNow(121000);
    p.setObservation(121000);
    p.membershipHeaders({});
    await tick();
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "active",
      nextFetchAt: at(126000),
      activatedAt: at(1000),
      generation: 1,
    });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].expiresAt).toEqual(
      at(131000),
    );
  });
  it("a preactivation metadata pause still expires at its original first-intent deadline", async () => {
    const p = await setup();
    p.rosterHeaders({ Date: null });
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "paused",
      activatedAt: null,
      nextFetchAt: at(61000),
    });
    p.setNow(60000);
    await cleanupFleetSources(ctx.db, p.deps.now);
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "ended",
      activatedAt: null,
      terminalReason: "expired",
    });
  });
  it.each([
    [{ Date: null, "Cache-Control": "max-age=86401" }, 86407000],
    [{ "Cache-Control": "max-age=86401, unsupported=yes" }, 86407000],
    [{ "Retry-After": "86401", "Cache-Control": "bad" }, 86407000],
    [{ "Retry-After": at(86407000).toUTCString(), Date: null }, 86407000],
    [
      { "x-esi-error-limit-remain": "0", "x-esi-error-limit-reset": "86401", Date: null },
      86407000,
    ],
    [
      {
        "x-esi-error-limit-remain": "bad",
        "x-esi-error-limit-reset": "86401",
        Date: null,
      },
      86407000,
    ],
  ] as const)(
    "unknown metadata preserves every long pacing bound %j",
    async (headers, next) => {
      const p = await setup();
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      p.setNow(6000);
      p.setObservation(6000);
      p.rosterHeaders(headers);
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        nextFetchAt: at(next),
        activatedAt: at(1000),
      });
      const calls = p.requests.length;
      p.setNow(66000);
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      expect(p.requests).toHaveLength(calls);
    },
  );
  it("shared unknown-budget source probes coalesce before awaited I/O without unrelated callers", async () => {
    const a = await setup();
    const b = await setup(99003, 124, false);
    const esi = createEsiClient();
    const run = (p: typeof a) =>
      runFleetSourceJob({ ...p.deps, esi }, { sourceId: p.sourceId, generation: 1 });
    await run(a);
    await run(b);
    a.setNow(6000);
    b.setNow(6000);
    a.setObservation(6000);
    a.rosterHeaders({
      "x-esi-error-limit-remain": "0",
      "x-esi-error-limit-reset": "bad",
    });
    await run(a);
    await run(b);
    const calls = a.requests.length + b.requests.length;
    a.setNow(66000);
    b.setNow(66000);
    a.setObservation(66000);
    a.rosterHeaders({
      "x-esi-error-limit-remain": "100",
      "x-esi-error-limit-reset": "60",
    });
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const arrived = new Promise<void>((r) => {
      reached = r;
    });
    a.membershipHold(async () => {
      reached();
      await held;
    });
    const pending = run(a);
    try {
      await Promise.race([arrived, pending]);
      expect(a.requests.length + b.requests.length).toBe(calls + 1);
      await run(b);
      expect(a.requests.length + b.requests.length).toBe(calls + 1);
      expect(
        (
          await ctx.db
            .select()
            .from(fleetSourceIntent)
            .where(eq(fleetSourceIntent.id, b.sourceId))
        )[0],
      ).toMatchObject({ state: "paused", nextFetchAt: at(126000), generation: 1 });
    } finally {
      release();
      await pending;
    }
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, a.sourceId))
      )[0],
    ).toMatchObject({ state: "active", activatedAt: at(1000) });
    b.setNow(126000);
    b.setObservation(126000);
    await run(b);
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, b.sourceId))
      )[0],
    ).toMatchObject({ state: "active", activatedAt: at(1000) });
  });
  it("malformed shared budget never overwrites a previously known uncapped deadline", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    let reset = "86401";
    const esi = createEsiClient({
      now: () => at(6000).getTime(),
      sleep: async () => {},
      fetchImpl: async () =>
        Response.json([], {
          headers: { "x-esi-error-limit-remain": "0", "x-esi-error-limit-reset": reset },
        }),
    });
    await esi.getFleetMembers(999, "synthetic-prime");
    reset = "bad";
    await esi.getFleetMembers(999, "synthetic-malformed");
    p.setNow(6000);
    const calls = p.requests.length;
    await runFleetSourceJob({ ...p.deps, esi }, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "paused",
      nextFetchAt: at(86407000),
    });
    p.setNow(66000);
    await runFleetSourceJob({ ...p.deps, esi }, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests).toHaveLength(calls);
  });
  it.each(["parse", "budget"])(
    "%s failure cannot discard successful HTTP roster cache pacing",
    async (failure) => {
      const p = await setup();
      const esi = createEsiClient();
      await runFleetSourceJob(
        { ...p.deps, esi },
        { sourceId: p.sourceId, generation: 1 },
      );
      p.setNow(6000);
      p.setObservation(6000);
      p.rosterHeaders({
        "Cache-Control": "max-age=86401",
        ...(failure === "budget"
          ? { "x-esi-error-limit-remain": "0", "x-esi-error-limit-reset": "bad" }
          : {}),
      });
      if (failure === "parse") p.malformedRoster();
      await runFleetSourceJob(
        { ...p.deps, esi },
        { sourceId: p.sourceId, generation: 1 },
      );
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        nextFetchAt: at(86407000),
      });
    },
  );
  it("fenced membership retains pacing before requiring a fresh terminal proof", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    p.setNow(61000);
    p.changeFleet();
    p.membershipHold(async () => {
      await ctx.db
        .update(character)
        .set({
          refreshTokenEnc: encryptToken("newer-context", testConfig().tokenEncryptionKey),
        })
        .where(eq(character.id, p.boss.id));
    });
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0].nextFetchAt).toEqual(
      at(121000),
    );
    p.membershipHold(async () => {});
    p.setNow(121000);
    // Expired claim is recovered normally; a fresh response, not cached stale
    // mismatch, may now end consent. Count the second actual membership proof.
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests.filter((stage) => stage === "membership")).toHaveLength(3);
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "ended",
      terminalReason: "not_in_fleet",
    });
  });
  it("snapshot overflow clears evidence before roster I/O and automatically recovers without truncating epochs", async () => {
    const p = await setup();
    const queries: { query: string; params: unknown[] }[] = [];
    const db = drizzle(ctx.pool, {
      schema,
      logger: {
        logQuery(query, params) {
          if (query.startsWith('select "id", "fleet_link_epoch" from "character"'))
            queries.push({ query, params });
        },
      },
    });
    const tick = async () => {
      await cleanupFleetSources(db, p.deps.now);
      await reserveDueFleetSources(db, p.deps.now);
      await dispatchOutbox(db, async (_queue, data) => {
        await runFleetSourceJob(
          { ...p.deps, db },
          data as { sourceId: string; generation: number },
        );
      });
    };
    await tick();
    const lastEpoch = randomUUID();
    // Labelled catalogue-load fixtures only; positive source identity is the real worker flow above.
    for (let start = 0; start < 8191; start += 500)
      await ctx.db.insert(character).values(
        Array.from({ length: Math.min(500, 8191 - start) }, (_, i) => ({
          id: 200000 + start + i,
          name: "snapshot-bound-fixture",
          accountId: p.boss.accountId,
          ownerHash: "catalogue-fixture",
          scopes: [],
          fleetLinkEpoch: start + i === 8189 ? lastEpoch : randomUUID(),
        })),
      );
    p.setNow(6000);
    p.setObservation(6000);
    queries.length = 0;
    await tick();
    expect(queries).toEqual([
      {
        query:
          'select "id", "fleet_link_epoch" from "character" order by "character"."id" limit $1',
        params: [8193],
      },
    ]);
    expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(1);
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: null,
      linkedCharacters: [],
      expiresAt: null,
    });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "paused",
      nextFetchAt: at(66000),
      activatedAt: at(1000),
      terminalReason: null,
    });
    // Exactly 8192 links are admissible, including the final indexed ID.
    await ctx.db.delete(character).where(eq(character.id, 208190));
    p.rosterIds([p.boss.id, p.alt.id, 208189]);
    p.setNow(66000);
    p.setObservation(66000);
    await tick();
    expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(2);
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "active",
      activatedAt: at(1000),
      generation: 1,
    });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      expiresAt: at(76000),
      linkedCharacters: [
        { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
        { characterId: p.alt.id, linkEpoch: p.alt.fleetLinkEpoch },
        { characterId: 208189, linkEpoch: lastEpoch },
      ],
    });
    await ctx.db.delete(character).where(gte(character.id, 200000));
  });
  it("ordinary members cannot create authority", async () => {
    const p = await setup();
    p.ordinary();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests).toContain("roster");
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("ended");
    expect(
      (await ctx.db.select().from(fleetSourceAuthority)).every(
        (a) => a.sourceId === null,
      ),
    ).toBe(true);
  });
  it("requires actual verified JWT expiry, never expires_in or unverified decode", async () => {
    const p = await setup();
    p.noExpiry();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests).toEqual(["token"]);
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
  });
  it("transient failure clears matching evidence and pauses consent; later success resumes after the original pending deadline", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    p.setNow(6000);
    p.failRoster();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: null,
      linkedCharacters: [],
      expiresAt: null,
    });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "paused",
      activatedAt: at(1000),
    });
    p.restoreRoster();
    p.setNow(66000);
    p.setObservation(66000);
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "active",
      activatedAt: at(1000),
    });
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].expiresAt).toEqual(
      at(76000),
    );
  });
  it.each(["scope", "owner"])(
    "verified token %s loss ends source consent",
    async (loss) => {
      const p = await setup();
      if (loss === "scope") p.revokeScope();
      else p.changeOwner();
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("ended");
      expect(p.requests).toEqual(["token"]);
    },
  );
  it("links created or renewed during held roster wait for a subsequent observation", async () => {
    const p = await setup();
    p.hold(async () => {
      await ctx.db
        .update(character)
        .set({ fleetLinkEpoch: randomUUID() })
        .where(eq(character.id, p.alt.id));
      await seedCharacter(ctx.db, testConfig(), {
        id: 777,
        accountId: p.boss.accountId,
        refreshToken: null,
        scopes: [],
      });
    });
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(
      (await ctx.db.select().from(fleetSourceAuthority))[0].linkedCharacters,
    ).toEqual([{ characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch }]);
  });
  it("changed settled credentials prevent reuse, without treating routine rotation as lost consent", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    await ctx.db
      .update(character)
      .set({
        refreshTokenEnc: encryptToken("new-credential", testConfig().tokenEncryptionKey),
      })
      .where(eq(character.id, p.boss.id));
    p.setNow(6000);
    p.setObservation(6000);
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect(p.requests.filter((stage) => stage === "token")).toHaveLength(2);
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
  });
  it("a bound source never follows a changed membership fleet after discovery cache expiry", async () => {
    const p = await setup();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    p.setNow(66000);
    p.changeFleet();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "ended",
      fleetId: 123,
    });
    expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(1);
  });
  it("a late roster refusal from a replaced credential cannot terminate current consent", async () => {
    const p = await setup();
    p.ordinary();
    p.hold(async () => {
      await ctx.db
        .update(character)
        .set({
          refreshTokenEnc: encryptToken(
            "new-credential",
            testConfig().tokenEncryptionKey,
          ),
        })
        .where(eq(character.id, p.boss.id));
    });
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
  });
  it.each([200, 403])(
    "token expiry is rechecked after roster I/O before accepting status %s",
    async (status) => {
      const p = await setup();
      if (status === 403) p.ordinary();
      p.shortToken();
      p.hold(async () => {
        p.setNow(3000);
      });
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
      expect(
        (await ctx.db.select().from(fleetSourceAuthority)).every(
          (a) => a.sourceId === null,
        ),
      ).toBe(true);
    },
  );
  it("source credential settlement keeps fixed classifications, not arbitrary provider error history", async () => {
    const p = await setup();
    p.tokenError();
    await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("ended");
    expect(JSON.stringify(await ctx.db.select().from(auditLog))).not.toContain(
      "private-marker",
    );
  });
  it("actual pg-boss expiry/stop cannot abandon rotated-token settlement or activate an expired first intent", async () => {
    const p = await setup();
    const boss = new PgBoss({ connectionString: TEST_URL });
    const errors: unknown[] = [];
    boss.on("error", (error) => errors.push(error));
    const queue = `fleet-source-expiry-${randomUUID()}`;
    const owner = createFleetSourceOwner();
    const holder = await ctx.pool.connect();
    let pid = 0;
    let currentJobId: string | undefined;
    let tokenJobId: string | undefined;
    const tasks: Promise<void>[] = [];
    const jobIds: string[] = [];
    const upstream = p.deps.fetchImpl;
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await upstream(url, init);
      if (String(url).endsWith("/oauth/token")) {
        tokenJobId = currentJobId;
        await holder.query("begin");
        pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0].pid;
        await holder.query("select id from character where id = $1 for update", [
          p.boss.id,
        ]);
      }
      return response;
    };
    const handler = owner.wrap(async (data) =>
      runFleetSourceJob(
        { ...p.deps, fetchImpl, signal: owner.signal },
        data as { sourceId: string; generation: number },
      ),
    );
    let draining: Promise<void> | undefined;
    try {
      await boss.start();
      await createQueues(boss);
      // App-table truncation leaves pg-boss jobs intact. Keep real source queue
      // policy, but own this queue so another fixture's work cannot satisfy us.
      const sourceQueue = await boss.getQueue(QUEUES.fleetSource);
      expect(sourceQueue).not.toBeNull();
      const { deadLetter, ...sourceOptions } = sourceQueue!;
      expect(deadLetter).toBeNull();
      await boss.createQueue(queue, { ...sourceOptions, name: queue });
      // Regression: old unkeyed work must neither coalesce the intended send
      // nor run this fixture's source through a callback that ignores job.data.
      const residueId = await boss.send(
        queue,
        { jobType: "fleet-source", sourceId: randomUUID(), generation: 1 },
        { priority: 100 },
      );
      if (residueId) jobIds.push(residueId);
      expect(residueId).not.toBeNull();
      const data = { jobType: "fleet-source", sourceId: p.sourceId, generation: 1 };
      const id = await boss.send(queue, data, {
        expireInSeconds: 1,
        singletonKey: `fleet-source:${p.sourceId}:1`,
      });
      if (id) jobIds.push(id);
      expect(
        id,
        "the intended expiry job must be inserted, not coalesced",
      ).not.toBeNull();
      await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const job of jobs) {
          currentJobId = job.id;
          const task = handler(job.data);
          tasks.push(task);
          await task;
        }
      });
      for (let i = 0; !pid && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
      expect(pid).not.toBe(0);
      expect(tokenJobId === id, "credential CAS must belong to the intended job").toBe(
        true,
      );
      expect((await boss.getJobById(queue, residueId!))?.state).toBe("completed");
      const started = await boss.getJobById(queue, id!);
      expect(started?.data).toEqual(data);
      expect(started?.state).toBe("active");
      expect(Number(started?.expireInSeconds)).toBe(1);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      p.setNow(61000);
      for (
        let i = 0;
        i < 100 && (await boss.getJobById(queue, id!))?.state !== "failed";
        i++
      )
        await new Promise((r) => setTimeout(r, 20));
      expect(await boss.getJobById(queue, id!)).toMatchObject({
        state: "failed",
        retryLimit: 0,
        retryCount: 0,
        output: { message: "handler execution exceeded 1000ms" },
      });
      owner.stopAdmission();
      await boss.offWork(queue);
      let drained = false;
      draining = owner.drain().then(() => {
        drained = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(drained).toBe(false);
      await holder.query("commit");
      await draining;
      expect(
        (await ctx.db.select().from(character).where(eq(character.id, p.boss.id)))[0]
          .refreshTokenEnc,
      ).not.toBe(p.boss.refreshTokenEnc);
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "ended",
        terminalReason: "expired",
        activatedAt: null,
      });
      expect(p.requests).toEqual(["token"]);
    } finally {
      owner.stopAdmission();
      await boss.offWork(queue);
      await holder.query("rollback");
      holder.release();
      await owner.drain();
      await draining;
      // Also settle callbacks in teardown if the ownership assertion fails.
      await Promise.allSettled(tasks);
      try {
        if (jobIds.length) await boss.deleteJob(queue, jobIds);
        await boss.deleteQueue(queue);
      } finally {
        await boss.stop({ graceful: true, wait: true });
      }
    }
    expect(errors).toEqual([]);
  }, 15000);
  it("Stop during held roster cannot be undone by late success or token settlement", async () => {
    const p = await setup();
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => {
      reached = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    p.hold(async () => {
      reached();
      await held;
    });
    const pending = runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
    await arrived;
    try {
      expect(
        (
          await controlFleetSource(ctx.db, {
            sessionId: p.sessionId,
            revision: 3,
            now: at(1500),
            command: { operation: "stop", sourceId: p.sourceId, expectedGeneration: 1 },
          })
        ).ok,
      ).toBe(true);
    } finally {
      release();
      await pending;
    }
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("ended");
    expect(
      (await ctx.db.select().from(fleetSourceAuthority)).every(
        (a) => a.sourceId === null,
      ),
    ).toBe(true);
    expect(
      (await ctx.db.select().from(character).where(eq(character.id, p.boss.id)))[0]
        .refreshTokenEnc,
    ).not.toBe(p.boss.refreshTokenEnc);
  });
});
