import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import PgBoss from "pg-boss";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { withFleetResources } from "../e2e/fleet-resources";
import { createFleetQueueErrorOwner } from "../e2e/fleet-source-errors";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const modernFleetHeaders = {
  "x-esi-error-limit-remain": null,
  "x-esi-error-limit-reset": null,
  "x-ratelimit-group": "fleet",
  "x-ratelimit-limit": "1800/15m",
  "x-ratelimit-remaining": "1797",
  "x-ratelimit-used": "2",
};
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
  let membershipStatus = 200;
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
        membershipStatus === 200
          ? { fleet_id: membershipFleet, fleet_boss_id: 999 }
          : { error: "synthetic refusal" },
        {
          status: membershipStatus,
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
            "x-esi-error-limit-remain": "100",
            "x-esi-error-limit-reset": "60",
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
    httpStatus: (stage: "membership" | "roster", status: number) => {
      if (stage === "membership") membershipStatus = status;
      else rosterStatus = status;
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
  it("modern-only Fleet responses activate through the real client within the original 60-second intent", async () => {
    const p = await setup();
    const headers = {
      ...modernFleetHeaders,
      "Cache-Control": "private",
      Date: at(1000).toUTCString(),
      Expires: at(61000).toUTCString(),
      "Last-Modified": at(1000).toUTCString(),
      ETag: '"synthetic-modern-fleet"',
      Age: null,
    };
    p.membershipHeaders(headers);
    p.rosterHeaders(headers);
    const esi = createEsiClient({ now: () => p.deps.now().getTime() });
    await runFleetSourceJob({ ...p.deps, esi }, { sourceId: p.sourceId, generation: 1 });
    expect.soft((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "active",
      generation: 1,
      fleetId: 123,
      activatedAt: at(1000),
      intentExpiresAt: at(60000),
      latestOutcome: "verified",
      nextFetchAt: at(61000),
    });
    expect.soft(p.requests).toEqual(["token", "membership", "roster"]);
    expect.soft(esi.getFleetRetryAt()).toBeNull();
    expect.soft((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: p.sourceId,
      sourceGeneration: 1,
      verifiedAt: at(1000),
      expiresAt: at(11000),
      linkedCharacters: [
        { characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch },
        { characterId: p.alt.id, linkEpoch: p.alt.fleetLinkEpoch },
      ],
    });
    const [current] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, p.boss.id));
    expect(current.refreshTokenEnc).not.toBe(p.boss.refreshTokenEnc);
    expect(current.tokenStatus).toBe("valid");
    expect(current.ownerHash).toBe(p.boss.ownerHash);
    expect(current.fleetLinkEpoch).toBe(p.boss.fleetLinkEpoch);
    expect(p.deps.memory.tokens.get(p.boss.id)).toMatchObject({
      tokenEnc: current.refreshTokenEnc,
      ownerHash: current.ownerHash,
      expiresAt: at(3600000),
    });
  });
  it.each([
    ["low", { "x-ratelimit-remaining": "5" }, 901000],
    ["exhausted", { "x-ratelimit-remaining": "0", "Retry-After": "120" }, 901000],
    ["long retry", { "Retry-After": "86401" }, 86402000],
    [
      "ambiguous",
      { "x-esi-error-limit-remain": "100", "x-esi-error-limit-reset": "60" },
      61000,
    ],
    ["malformed", { "x-ratelimit-used": "bad" }, 61000],
  ] as const)(
    "modern %s membership preserves pacing and cannot resurrect an expired first intent",
    async (_label, patch, next) => {
      const p = await setup();
      p.membershipHeaders({
        ...modernFleetHeaders,
        "Cache-Control": "private",
        ...patch,
      });
      const esi = createEsiClient({ now: () => p.deps.now().getTime() });
      const run = () =>
        runFleetSourceJob({ ...p.deps, esi }, { sourceId: p.sourceId, generation: 1 });
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        activatedAt: null,
        nextFetchAt: at(next),
        intentExpiresAt: at(60000),
      });
      expect(p.requests).toEqual(["token", "membership"]);
      expect(
        (await ctx.db.select().from(fleetSourceAuthority)).every(
          (a) => a.sourceId === null,
        ),
      ).toBe(true);
      p.setNow(59999);
      await run();
      expect(p.requests).toEqual(["token", "membership"]);
      p.setNow(60000);
      await cleanupFleetSources(ctx.db, p.deps.now);
      p.membershipHeaders(modernFleetHeaders);
      p.setNow(next);
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "ended",
        activatedAt: null,
        generation: 2,
        terminalReason: "expired",
      });
      expect(p.requests).toEqual(["token", "membership"]);
    },
  );
  it.each([
    ["missing used", { "x-ratelimit-used": null }, 66000],
    ["unknown remaining", { "x-ratelimit-remaining": "bad" }, 906000],
    [
      "low long window",
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-limit": "1800/25h",
        "x-ratelimit-used": "bad",
      },
      90006000,
    ],
  ] as const)(
    "modern %s roster clears authority and recovers the same activation only after its bound",
    async (_label, patch, next) => {
      const p = await setup();
      p.shortToken(172800000);
      p.membershipHeaders(modernFleetHeaders);
      p.rosterHeaders(modernFleetHeaders);
      const esi = createEsiClient({ now: () => p.deps.now().getTime() });
      const run = () =>
        runFleetSourceJob({ ...p.deps, esi }, { sourceId: p.sourceId, generation: 1 });
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
      p.setNow(6000);
      p.setObservation(6000);
      p.rosterHeaders({ ...modernFleetHeaders, ...patch });
      p.rosterIds([p.alt.id]); // Invalid budget must not become terminal absent-boss proof.
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "paused",
        activatedAt: at(1000),
        generation: 1,
        terminalReason: null,
        nextFetchAt: at(next),
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: null,
        linkedCharacters: [],
        expiresAt: null,
      });
      const calls = p.requests.length;
      p.setNow(next - 1);
      await run();
      expect(p.requests).toHaveLength(calls);
      p.setNow(next);
      p.setObservation(next);
      p.rosterHeaders(modernFleetHeaders);
      p.rosterIds([p.boss.id, p.alt.id]);
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "active",
        activatedAt: at(1000),
        generation: 1,
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: p.sourceId,
        verifiedAt: at(next),
        expiresAt: at(next + 10000),
      });
      expect(p.requests.filter((r) => r === "roster")).toHaveLength(3);
    },
  );
  it.each([
    ["membership", 404, "not_in_fleet"],
    ["membership", 401, "fleet_read_invalid"],
    ["roster", 401, "fleet_read_invalid"],
    ["roster", 403, "boss_lost"],
    ["membership", 403, null],
    ["roster", 404, null],
    ["roster", 429, null],
    ["roster", 503, null],
  ] as const)(
    "modern %s HTTP %s retains the stage-specific refusal (%s) and uncapped wait",
    async (stage, status, terminal) => {
      const p = await setup();
      p.membershipHeaders(modernFleetHeaders);
      p.rosterHeaders(modernFleetHeaders);
      p.httpStatus(stage, status);
      const headers = {
        ...modernFleetHeaders,
        "x-ratelimit-remaining": "1794",
        "x-ratelimit-used": status === 429 || status >= 500 ? "0" : "5",
        "Retry-After": "86401",
      };
      if (stage === "membership") p.membershipHeaders(headers);
      else p.rosterHeaders(headers);
      const esi = createEsiClient({ now: () => p.deps.now().getTime() });
      await runFleetSourceJob(
        { ...p.deps, esi },
        { sourceId: p.sourceId, generation: 1 },
      );
      expect(p.requests).toEqual(
        stage === "membership"
          ? ["token", "membership"]
          : ["token", "membership", "roster"],
      );
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: terminal ? "ended" : "paused",
        terminalReason: terminal,
        activatedAt: null,
        ...(terminal ? {} : { nextFetchAt: at(86402000) }),
      });
      expect(esi.getFleetRetryAt()).toBe(at(86402000).getTime());
      expect((await ctx.db.select().from(schema.fleetDevice))[0].revokedAt).toBeNull();
      expect(
        (await ctx.db.select().from(character).where(eq(character.id, p.boss.id)))[0]
          .tokenStatus,
      ).toBe("valid");
      expect(
        (await ctx.db.select().from(fleetSourceAuthority)).every(
          (a) => a.sourceId === null,
        ),
      ).toBe(true);
    },
  );
  it.each(["credential", "claim", "JWT", "Stop", "mode"])(
    "modern success cannot activate after the %s fence is lost during roster I/O",
    async (loss) => {
      const p = await setup();
      p.membershipHeaders(modernFleetHeaders);
      p.rosterHeaders(modernFleetHeaders);
      if (loss === "JWT") p.shortToken();
      p.hold(async () => {
        if (loss === "credential")
          await ctx.db
            .update(character)
            .set({
              refreshTokenEnc: encryptToken(
                "newer-synthetic-credential",
                testConfig().tokenEncryptionKey,
              ),
            })
            .where(eq(character.id, p.boss.id));
        else if (loss === "claim") p.setNow(31000);
        else if (loss === "JWT") p.setNow(2000);
        else if (loss === "mode") {
          const [gate] = await ctx.db.select().from(schema.fleetSharingGate);
          await transitionFleetSharingMode(ctx.db, {
            enabled: false,
            expectedRevision: gate.revision,
            now: at(1500),
          });
        } else
          expect(
            (
              await controlFleetSource(ctx.db, {
                sessionId: p.sessionId,
                revision: 3,
                now: at(1500),
                command: {
                  operation: "stop",
                  sourceId: p.sourceId,
                  expectedGeneration: 1,
                },
              })
            ).ok,
          ).toBe(true);
      });
      await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      expect(p.requests).toEqual(["token", "membership", "roster"]);
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        activatedAt: null,
        state: loss === "Stop" || loss === "mode" ? "ended" : "paused",
      });
      expect(
        (await ctx.db.select().from(fleetSourceAuthority)).every(
          (a) => a.sourceId === null && a.expiresAt === null,
        ),
      ).toBe(true);
      expect((await ctx.db.select().from(schema.fleetDevice))[0].revokedAt).toBeNull();
    },
  );
  it.each([false, true])(
    "eventual actual source activation cannot hide a recovered queue fetch error (fault=%s)",
    async (fault) => {
      const p = await setup();
      let injected = false;
      let observedError = false;
      let active = false;
      const queue = `fleet-source-error-${randomUUID()}`;
      const result = withFleetResources(async (own) => {
        const errors = own(createFleetQueueErrorOwner(), (errors) => errors.close());
        // Fault the fetch promise consumed by the real worker loop. The installed
        // manager swallows SQL rejections itself; faulting executeSql would never
        // reach the error event this regression is intended to own.
        const Manager = createRequire(import.meta.url)("pg-boss/src/manager.js") as {
          prototype: { fetch(name: string, options: object): Promise<unknown[]> };
        };
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper below explicitly restores the real manager receiver with call(this).
        const fetch = Manager.prototype.fetch;
        own(
          vi.spyOn(Manager.prototype, "fetch").mockImplementation(async function (
            this: typeof Manager.prototype,
            name,
            options,
          ) {
            if (fault && !injected && name === queue) {
              injected = true;
              throw new Error("synthetic private fetch detail");
            }
            return fetch.call(this, name, options);
          }),
          (spy) => spy.mockRestore(),
        );
        const boss = own(new PgBoss({ connectionString: TEST_URL }), (boss) =>
          boss.stop({ graceful: true, wait: true }),
        );
        boss.on("error", () => {
          observedError = true;
          errors.record();
        });
        let jobId: string | null = null;
        own(queue, async (queue) => {
          if (jobId) await boss.deleteJob(queue, jobId);
          await boss.deleteQueue(queue);
        });
        const owner = own(createFleetSourceOwner(), (owner) => owner.drain());
        own(boss, (boss) => boss.offWork(queue));
        own(owner, (owner) => owner.stopAdmission());
        await boss.start();
        await boss.createQueue(queue);
        const id = (jobId = await boss.send(queue, {
          sourceId: p.sourceId,
          generation: 1,
        }));
        expect(id).not.toBeNull();
        const handler = owner.wrap(async (data) =>
          runFleetSourceJob(
            { ...p.deps, signal: owner.signal },
            data as { sourceId: string; generation: number },
          ),
        );
        await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
          for (const job of jobs) await handler(job.data);
        });
        for (
          let i = 0;
          i < 100 && (await boss.getJobById(queue, id!))?.state !== "completed";
          i++
        )
          await new Promise((r) => setTimeout(r, 20));
        expect((await boss.getJobById(queue, id!))?.state).toBe("completed");
        expect(injected).toBe(fault);
        expect(observedError).toBe(fault);
        expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
          state: "active",
          activatedAt: at(1000),
        });
        expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBe(
          p.sourceId,
        );
        active = true;
      });
      if (fault) {
        const failure = await result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          new Error("[fleet-e2e] unexpected queue error event"),
        ]);
      } else await expect(result).resolves.toBeUndefined();
      expect(active).toBe(true);
    },
  );
  describe.each(["absent", "malformed"])("HTTP with %s budget", (budget) => {
    const headers = {
      "x-esi-error-limit-remain": budget === "absent" ? null : "bad",
      "x-esi-error-limit-reset": budget === "absent" ? null : "bad",
    };
    it.each([
      ["membership", 404, "not_in_fleet"],
      ["membership", 401, "fleet_read_invalid"],
      ["roster", 401, "fleet_read_invalid"],
      ["roster", 403, "boss_lost"],
      ["membership", 403, null],
      ["roster", 404, null],
      ["roster", 429, null],
      ["roster", 503, null],
    ] as const)(
      "%s %s keeps its stage-specific refusal (%s)",
      async (stage, status, terminal) => {
        const p = await setup();
        p.httpStatus(stage, status);
        if (stage === "membership") p.membershipHeaders(headers);
        else p.rosterHeaders(headers);
        const esi = createEsiClient({ now: () => p.deps.now().getTime() });
        await runFleetSourceJob(
          { ...p.deps, esi },
          { sourceId: p.sourceId, generation: 1 },
        );
        expect(p.requests).toEqual(
          stage === "membership"
            ? ["token", "membership"]
            : ["token", "membership", "roster"],
        );
        expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
          state: terminal ? "ended" : "paused",
          terminalReason: terminal,
          generation: terminal ? 2 : 1,
          ...(terminal ? {} : { nextFetchAt: at(61000) }),
        });
        expect(esi.getFleetRetryAt()).toBe(at(61000).getTime());
        // A source HTTP refusal never infers device-key revocation.
        expect((await ctx.db.select().from(schema.fleetDevice))[0].revokedAt).toBeNull();
        expect(
          (await ctx.db.select().from(character).where(eq(character.id, p.boss.id)))[0]
            .tokenStatus,
        ).toBe("valid");
      },
    );
    it.each(["credential", "claim", "Stop"])(
      "HTTP 401 still requires current %s proof",
      async (loss) => {
        const p = await setup();
        await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
        p.setNow(6000);
        p.httpStatus("roster", 401);
        p.rosterHeaders(headers);
        p.hold(async () => {
          if (loss === "credential")
            await ctx.db
              .update(character)
              .set({
                refreshTokenEnc: encryptToken(
                  "newer-synthetic-credential",
                  testConfig().tokenEncryptionKey,
                ),
              })
              .where(eq(character.id, p.boss.id));
          else if (loss === "claim") p.setNow(36000);
          else
            expect(
              (
                await controlFleetSource(ctx.db, {
                  sessionId: p.sessionId,
                  revision: 3,
                  now: at(6500),
                  command: {
                    operation: "stop",
                    sourceId: p.sourceId,
                    expectedGeneration: 1,
                  },
                })
              ).ok,
            ).toBe(true);
        });
        await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
        expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
          state: loss === "Stop" ? "ended" : "paused",
          terminalReason: loss === "Stop" ? "stopped" : null,
          generation: loss === "Stop" ? 2 : 1,
          activatedAt: at(1000),
        });
        expect((await ctx.db.select().from(schema.fleetDevice))[0].revokedAt).toBeNull();
      },
    );
    it.each([
      ["membership", 404],
      ["membership", 401],
      ["roster", 401],
      ["roster", 403],
    ] as const)(
      "%s %s cannot terminate with JWT expired after final row-lock wait",
      async (stage, status) => {
        const p = await setup();
        p.shortToken();
        p.httpStatus(stage, status);
        if (stage === "membership") p.membershipHeaders(headers);
        else p.rosterHeaders(headers);
        const holder = await ctx.pool.connect();
        let pid = 0;
        const lock = async () => {
          await holder.query("begin");
          pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
            .rows[0].pid;
          await holder.query(
            "select id from fleet_source_intent where id = $1 for update",
            [p.sourceId],
          );
        };
        if (stage === "membership") p.membershipHold(lock);
        else p.hold(lock);
        const pending = runFleetSourceJob(p.deps, {
          sourceId: p.sourceId,
          generation: 1,
        });
        void pending.catch(() => {});
        try {
          for (let i = 0; !pid && i < 100; i++)
            await new Promise((r) => setTimeout(r, 10));
          expect(pid).not.toBe(0);
          expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
          p.setNow(2000);
        } finally {
          try {
            await holder.query("rollback");
          } finally {
            holder.release();
            await pending;
          }
        }
        expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
          state: "paused",
          terminalReason: null,
          generation: 1,
        });
        expect((await ctx.db.select().from(schema.fleetDevice))[0].revokedAt).toBeNull();
        expect(
          (await ctx.db.select().from(fleetSourceAuthority)).every(
            (row) => row.sourceId === null,
          ),
        ).toBe(true);
      },
    );
  });
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
  it.each([
    ["missing Date", { Date: null }, 66000],
    ["invalid Date", { Date: "bad" }, 66000],
    ["invalid Expires", { Expires: "bad" }, 66000],
    ["missing timing", { Date: null, Expires: null, "Cache-Control": null }, 66000],
    [
      "stale Date",
      { Date: at(-5000).toUTCString(), Expires: at(0).toUTCString() },
      11000,
    ],
    ["unsupported cache", { "Cache-Control": "max-age=5, unsupported=yes" }, 66000],
    ["long Retry-After", { Date: null, "Retry-After": "86401" }, 86407000],
    [
      "long retry date",
      { Date: null, "Retry-After": at(86407000).toUTCString() },
      86407000,
    ],
    [
      "long reset",
      { Date: null, "x-esi-error-limit-remain": "0", "x-esi-error-limit-reset": "86401" },
      86407000,
    ],
  ] as const)(
    "rejected roster with absent boss (%s) pauses and recovers the same activation",
    async (_label, headers, next) => {
      const p = await setup();
      p.shortToken(172800000);
      const run = () =>
        runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "active",
        activatedAt: at(1000),
      });
      p.setNow(6000);
      p.setObservation(6000);
      p.rosterIds([p.alt.id]);
      p.rosterHeaders(headers);
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        id: p.sourceId,
        state: "paused",
        generation: 1,
        activatedAt: at(1000),
        terminalReason: null,
        latestOutcome: "untrustworthy_evidence",
        nextFetchAt: at(next),
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: null,
        linkedCharacters: [],
        expiresAt: null,
      });
      const calls = p.requests.length;
      p.setNow(next - 1);
      await run();
      expect(p.requests).toHaveLength(calls);
      p.setNow(next);
      p.setObservation(next);
      p.rosterIds([p.boss.id, p.alt.id]);
      p.rosterHeaders({});
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        id: p.sourceId,
        state: "active",
        generation: 1,
        activatedAt: at(1000),
        terminalReason: null,
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: p.sourceId,
        sourceGeneration: 1,
        expiresAt: at(next + 10000),
      });
      expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(3);
    },
  );
  it.each([
    [15999, "ended"],
    [16000, "paused"],
  ] as const)(
    "absent boss verdict uses freshness after final row-lock wait at %s (%s)",
    async (completedAt, state) => {
      const p = await setup();
      const run = () =>
        runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "active",
        generation: 1,
        activatedAt: at(1000),
      });
      p.setNow(6000);
      p.setObservation(6000);
      p.rosterIds([p.alt.id]);
      const holder = await ctx.pool.connect();
      let pid = 0;
      p.hold(async () => {
        await holder.query("begin");
        pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
          .rows[0].pid;
        await holder.query(
          "select id from fleet_source_intent where id = $1 for update",
          [p.sourceId],
        );
      });
      const pending = run();
      void pending.catch(() => {}); // Observe immediately; await the original in cleanup.
      try {
        for (let i = 0; !pid && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
        expect(pid).not.toBe(0);
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        expect(p.requests.filter((stage) => stage === "roster")).toHaveLength(2);
        p.setNow(completedAt);
      } finally {
        try {
          await holder.query("rollback");
        } finally {
          holder.release();
          await pending;
        }
      }
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state,
        activatedAt: at(1000),
        generation: state === "paused" ? 1 : 2,
        terminalReason: state === "paused" ? null : "boss_lost",
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: null,
        linkedCharacters: [],
        expiresAt: null,
      });
      if (state === "ended") return;
      p.hold(async () => {});
      p.setNow(21000);
      p.setObservation(21000);
      p.rosterIds([p.boss.id, p.alt.id]);
      await run();
      expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
        state: "active",
        generation: 1,
        activatedAt: at(1000),
        terminalReason: null,
      });
      expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
        sourceId: p.sourceId,
        expiresAt: at(31000),
      });
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
  it.each(["absent", "network"])(
    "FIRST %s budget failure shares pacing and one held probe across activated sources",
    async (failure) => {
      const a = await setup();
      const b = await setup(99003, 124, false);
      for (const p of [a, b]) {
        await runFleetSourceJob(p.deps, { sourceId: p.sourceId, generation: 1 });
        p.setNow(6000);
        p.setObservation(6000);
      }
      const esi = createEsiClient();
      let failing = true;
      if (failure === "absent")
        a.rosterHeaders({
          "x-esi-error-limit-remain": null,
          "x-esi-error-limit-reset": null,
        });
      const run = (p: typeof a) =>
        runFleetSourceJob(
          {
            ...p.deps,
            esi,
            fetchImpl: async (url, init) => {
              const response = await p.deps.fetchImpl(url, init);
              if (p === a && failing && failure === "network")
                throw new Error("synthetic transport failure");
              return response;
            },
          },
          { sourceId: p.sourceId, generation: 1 },
        );
      const sources = () =>
        ctx.db
          .select()
          .from(fleetSourceIntent)
          .orderBy(fleetSourceIntent.bossCharacterId);
      const calls = () => a.requests.length + b.requests.length;
      expect((await sources()).map((s) => s.state)).toEqual(["active", "active"]);
      const before = calls();
      await run(a);
      await run(b);
      expect(calls()).toBe(before + 1);
      expect(esi.getFleetRetryAt(at(6000).getTime())).toBe(at(66000).getTime());
      expect(
        (await sources()).map((s) => ({
          state: s.state,
          generation: s.generation,
          activatedAt: s.activatedAt,
          nextFetchAt: s.nextFetchAt,
        })),
      ).toEqual(
        [a, b].map(() => ({
          state: "paused",
          generation: 1,
          activatedAt: at(1000),
          nextFetchAt: at(66000),
        })),
      );
      expect(
        (await ctx.db.select().from(fleetSourceAuthority)).map((s) => s.linkedCharacters),
      ).toEqual([[], []]);
      for (const p of [a, b]) {
        p.setNow(65999);
        await run(p);
        p.setNow(66000);
        p.setObservation(66000);
      }
      expect(calls()).toBe(before + 1);
      failing = false;
      a.rosterHeaders({});
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
      void pending.catch(() => {}); // Retain the original job through settlement.
      try {
        await Promise.race([arrived, pending]);
        expect(calls()).toBe(before + 2);
        await run(b);
        expect(calls()).toBe(before + 2);
        expect((await sources())[1]).toMatchObject({
          state: "paused",
          nextFetchAt: at(126000),
        });
      } finally {
        release();
        await pending;
      }
      expect((await sources())[0]).toMatchObject({
        state: "active",
        generation: 1,
        activatedAt: at(1000),
      });
      expect(esi.getFleetRetryAt(at(66000).getTime())).toBeNull();
      b.setNow(126000);
      b.setObservation(126000);
      await run(b);
      expect((await sources())[1]).toMatchObject({
        state: "active",
        generation: 1,
        activatedAt: at(1000),
      });
      expect(calls()).toBe(before + 5);
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
