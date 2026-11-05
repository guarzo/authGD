import { randomUUID } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import PgBoss from "pg-boss";
import { createDb } from "@/db";
import {
  character,
  fleetAutomaticCandidate,
  fleetAutomaticReceipt,
  fleetSourceAuthority,
  fleetSourceIntent,
  syncRun,
  outbox,
} from "@/db/schema";
import type { AutomaticTask } from "@/core/fleet-automatic";
import * as automaticJobs from "@/jobs/fleet-automatic";
import { createFleetSourceMemory, type FleetSourceDeps } from "@/jobs/fleet-source";
import { createEsiClient, FLEET_READ_SCOPE } from "@/lib/esi/client";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import * as automatic from "@/services/fleet-automatic";
import { enqueueSync, takeUndispatched, type OutboxPayload } from "@/services/outbox";
import { reserveDueFleetSources } from "@/services/fleet-source-maintenance";
import {
  dispatchOutbox,
  planDispatch,
  RERUNNABLE,
  startDispatcher,
} from "@/worker/dispatcher";
import { buildJobHandlers } from "@/worker/handlers";
import { createQueues, QUEUES } from "@/worker/queues";
import * as scheduler from "@/worker/fleet-source-scheduler";
import { withFleetResources } from "../e2e/fleet-resources";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { seedAccount, seedCharacter } from "./helpers/seed";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

const NOW = new Date("2026-09-07T12:00:00Z");
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => Promise<boolean>, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("runtime condition was not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function enroll(id = 99001) {
  const account = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, cfg, {
    id,
    accountId: account.id,
    scopes: [FLEET_READ_SCOPE],
    refreshToken: `refresh-${id}`,
  });
  const device = await pairDevice(ctx.db, account.id, NOW, ["shared-source-v1"]);
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
      {
        sessionId: device.sessionId,
        revision: 2,
        now: at(2000),
      },
      {
        protocol: 2,
        request_id: randomUUID(),
        intent_created_at: at(2000).toISOString(),
        enabled: true,
        expected_generation: 0,
        expected_revision: 0,
      },
    ),
  ).toMatchObject({ ok: true });
  let now = at(2000);
  const options = {
    membership: 200,
    roster: 200,
    fleetId: id,
    hold: undefined as undefined | ((stage: string) => Promise<void>),
  };
  const requests: string[] = [];
  const issued = new Set<string>();
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = String(raw);
    const stage =
      url === "https://login.eveonline.com/v2/oauth/token"
        ? "token"
        : url.includes("/characters/")
          ? "membership"
          : "roster";
    requests.push(stage);
    if (stage === "token") {
      expect(url).toBe("https://login.eveonline.com/v2/oauth/token");
      const token = await new SignJWT({
        sub: `CHARACTER:EVE:${id}`,
        owner: boss.ownerHash,
        name: boss.name,
        scp: [FLEET_READ_SCOPE],
        exp: at(300000).getTime() / 1000,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .sign(keys.privateKey);
      issued.add(token);
      await options.hold?.(stage);
      return Response.json({
        access_token: token,
        refresh_token: `synthetic-${id}-${requests.length}`,
      });
    }
    expect(
      issued.has((new Headers(init?.headers).get("authorization") ?? "").slice(7)),
    ).toBe(true);
    expect(url).toBe(
      stage === "membership"
        ? `https://esi.evetech.net/latest/characters/${id}/fleet/`
        : `https://esi.evetech.net/latest/fleets/${options.fleetId}/members/`,
    );
    const status = options[stage];
    const response = Response.json(
      status !== 200
        ? { error: "private-provider-marker" }
        : stage === "membership"
          ? { fleet_id: options.fleetId, fleet_boss_id: id }
          : [{ character_id: id }],
      {
        status,
        headers: {
          Date: now.toUTCString(),
          "Cache-Control": `max-age=${stage === "membership" ? 60 : 5}`,
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      },
    );
    Object.defineProperty(response, "url", { value: url });
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
    account,
    boss,
    device,
    options,
    requests,
    deps,
    setNow: (ms: number) => {
      now = at(ms);
    },
  };
}
async function task(id = 99001): Promise<AutomaticTask> {
  const [c] = await ctx.db
    .select()
    .from(fleetAutomaticCandidate)
    .where(eq(fleetAutomaticCandidate.characterId, id));
  expect(c.reservationId).not.toBeNull();
  return {
    accountId: c.accountId,
    characterId: id,
    consentGeneration: c.consentGeneration,
    candidateGeneration: c.candidateGeneration,
    reservationId: c.reservationId!,
  };
}
async function candidate(id = 99001) {
  return (
    await ctx.db
      .select()
      .from(fleetAutomaticCandidate)
      .where(eq(fleetAutomaticCandidate.characterId, id))
  )[0];
}
// Only fleet handlers run; unrelated integration clients are deliberately absent.
function handlers(deps: FleetSourceDeps) {
  return buildJobHandlers({
    db: deps.db,
    cfg,
    fetchImpl: deps.fetchImpl,
    fleetSource: deps,
    esi: {} as Parameters<typeof buildJobHandlers>[0]["esi"],
    wanderer: {} as Parameters<typeof buildJobHandlers>[0]["wanderer"],
    discord: {} as Parameters<typeof buildJobHandlers>[0]["discord"],
  });
}

it("full job consumes real reserve/claim/UNCOMMITTED through guarded commit before resolving", async () => {
  const p = await enroll();
  expect(await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now)).toBe(1);
  const input = await task();
  const receipts = await ctx.db.select().from(fleetAutomaticReceipt);
  const run = automaticJobs.runFleetAutomaticJob;
  await run(p.deps, input);
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([
    expect.objectContaining({
      state: "active",
      generation: 1,
      fetchGeneration: 0,
      automaticConsentAccountId: input.accountId,
    }),
  ]);
  const c = await candidate();
  expect(c).toMatchObject({
    lastOutcome: "verified",
    claimGeneration: 1,
    claimReservationId: null,
    claimExpiresAt: null,
    sourceId: expect.any(String),
  });
  expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
    sourceId: c.sourceId,
    authorityGeneration: 1,
  });
  await run(p.deps, input);
  expect(await candidate()).toEqual(c);
  expect(p.requests).toEqual(["token", "membership", "roster"]);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toEqual(receipts);
  expect(await ctx.db.select().from(syncRun)).toEqual([]);
});

it("dispatch emits exact closed AutomaticJob and singleton, never kind or admin work", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  expect(planDispatch({ kind: "fleet-automatic", ...input })).toEqual([
    {
      queue: "fleet-automatic",
      data: { jobType: "fleet-automatic", ...input },
      singletonKey: `fleet-automatic:${input.accountId}:99001:1:1:${input.reservationId}`,
    },
  ]);
  expect(RERUNNABLE.has("fleet-automatic")).toBe(false);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const bad of [
      { kind: "fleet-automatic", ...input, secret: "private-marker" },
      { kind: "fleet-automatic", ...input, jobType: "fleet-automatic" },
      { kind: "fleet-automatic", ...input, candidateGeneration: 1.5 },
      { kind: "job", jobType: "fleet-automatic" },
    ])
      expect(planDispatch(bad as OutboxPayload, 42)).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-marker");
  } finally {
    log.mockRestore();
  }
});

it("registered automatic handler rejects secrets and malformed discriminants with sanitized errors", async () => {
  const p = await enroll();
  const h = handlers(p.deps)["fleet-automatic"];
  expect(h).toBeTypeOf("function");
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const data = { jobType: "fleet-automatic", ...(await task()) };
  for (const bad of [
    { ...data, kind: "fleet-automatic" },
    { ...data, token: "secret-marker" },
    { ...data, jobType: "fleet-source" },
    { ...data, candidateGeneration: true },
    { ...data, consentGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...data, characterId: 0 },
    { ...data, reservationId: "bad" },
    null,
  ]) {
    await expect(h(bad)).rejects.toThrow(/^fleet_automatic_payload_invalid$/);
  }
  expect(p.requests).toEqual([]);
  expect((await candidate()).claimGeneration).toBe(0);
});

it.each([401, 403, 503])(
  "full registered job settles roster %s without a source, retry history or error leak",
  async (status) => {
    const p = await enroll();
    p.options.roster = status;
    await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
    const input = await task();
    await handlers(p.deps)["fleet-automatic"]({ jobType: "fleet-automatic", ...input });
    expect(await candidate()).toMatchObject({
      claimGeneration: 1,
      claimReservationId: null,
      sourceId: null,
      lastOutcome:
        status === 401
          ? "fleet_read_invalid"
          : status === 403
            ? "not_boss"
            : "service_unavailable",
    });
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
    expect(await ctx.db.select().from(syncRun)).toEqual([]);
    expect(JSON.stringify(await candidate())).not.toContain("private-provider-marker");
  },
);

it("positive queue completion awaits actual commit after a proved final database wait", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  const holder = await ctx.pool.connect();
  let pid = 0;
  p.options.hold = async (stage) => {
    if (stage !== "roster") return;
    await holder.query("begin");
    await holder.query("select id from fleet_device where id=$1 for update", [
      p.device.device.id,
    ]);
    pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
      .pid;
  };
  let done = false;
  const work = handlers(p.deps)
    ["fleet-automatic"]({ jobType: "fleet-automatic", ...input })
    .then(() => {
      done = true;
    });
  try {
    await until(async () => pid !== 0);
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    expect(done).toBe(false);
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
    expect((await candidate()).claimReservationId).toBe(input.reservationId);
    await holder.query("commit");
    await work;
    expect(done).toBe(true);
    expect((await candidate()).sourceId).not.toBeNull();
  } finally {
    await holder.query("rollback");
    holder.release();
    await work;
  }
});

it("original discovery admission refuses a second callback but leaves active capacity untouched", async () => {
  const owner = scheduler.createFleetSourceOwner();
  const held = deferred();
  let originals = 0;
  const run = owner.wrap(
    async () => {
      originals++;
      await held.promise;
    },
    { discovery: true },
  );
  const first = run({});
  const second = run({}).then(
    () => "resolved",
    (error: Error) => error.message,
  );
  try {
    await Promise.resolve();
    expect(originals).toBe(1);
    expect(await second).toBe("fleet_automatic_job_failed");
    let active = false;
    await owner.wrap(async () => {
      active = true;
    })({});
    expect(active).toBe(true);
    expect(originals).toBe(1);
  } finally {
    owner.stopAdmission();
    held.resolve();
    await first;
    await second;
    await owner.drain();
  }
});

it.each(["all", "fleet-source"] as const)(
  "real pg-boss dispatch %s reserves active and fair discovery progress beyond 100 older automatic rows",
  async (scope) => {
    const p = await enroll();
    await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
    const input = await task();
    await ctx.db.delete(outbox);
    for (let i = 0; i < 120; i++)
      await enqueueSync(ctx.db, {
        kind: "fleet-automatic",
        ...input,
        reservationId: randomUUID(),
      });
    const sourceId = randomUUID();
    await enqueueSync(ctx.db, { kind: "fleet-source", sourceId, generation: 1 });
    await enqueueSync(ctx.db, { kind: "job", jobType: "contacts" });
    await withFleetResources(async (own) => {
      const boss = own(new PgBoss({ connectionString: TEST_URL, max: 5 }), (b) =>
        b.stop({ graceful: true, wait: true }),
      );
      const errors: unknown[] = [];
      boss.on("error", (e) => errors.push(e));
      await boss.start();
      await createQueues(boss);
      const names = new Map<string, string>();
      for (const name of ["fleet-source", "fleet-automatic", "contacts"]) {
        const queue = `${name}-p3-${randomUUID()}`;
        own(queue, async (q) => {
          const jobs = await ctx.db.execute<{ id: string }>(
            sql`select id from pgboss.job where name=${q}`,
          );
          if (jobs.rows.length)
            await boss.deleteJob(
              q,
              jobs.rows.map((j) => j.id),
            );
          await boss.deleteQueue(q);
        });
        const policy = await boss.getQueue(name);
        expect(policy).not.toBeNull();
        await boss.createQueue(queue, {
          name: queue,
          policy: policy!.policy,
          retryLimit: policy!.retryLimit ?? 5,
          expireInSeconds: policy!.expireInSeconds ?? 900,
          retentionMinutes: policy!.retentionMinutes ?? 60,
        });
        names.set(name, queue);
      }
      const dispatched: { kind: string; id: string | null }[] = [];
      expect(
        await dispatchOutbox(
          ctx.db,
          async (queue, data, options) => {
            const id = await boss.send(names.get(queue)!, data, options);
            dispatched.push({ kind: queue, id });
            return id;
          },
          scope,
        ),
      ).toBe(100);
      expect(dispatched.filter((d) => d.kind === "fleet-source")).toHaveLength(1);
      expect(
        dispatched.filter((d) => d.kind === "fleet-automatic").length,
      ).toBeGreaterThan(0);
      expect(dispatched.filter((d) => d.kind === "contacts")).toHaveLength(
        scope === "all" ? 1 : 0,
      );
      const active = await boss.fetch(names.get("fleet-source")!);
      expect(active.map((j) => j.data)).toEqual([
        { jobType: "fleet-source", sourceId, generation: 1 },
      ]);
      expect(
        await ctx.db.select().from(outbox).where(isNull(outbox.dispatchedAt)),
      ).toHaveLength(22);
      expect(errors).toEqual([]);
    });
  },
);

it("same scheduler cleans expired proof and reserves active before automatic; backoff and busy only gate discovery admission", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  await automaticJobs.runFleetAutomaticJob(p.deps, await task());
  await ctx.db.delete(outbox);
  const other = await enroll(99002);
  p.setNow(12000);
  other.setNow(12000);
  const tick = scheduler.runFleetSourceTick;
  await tick(p.deps, () => true);
  const rows = await ctx.db.select().from(outbox).orderBy(outbox.id);
  expect(rows.map((r) => r.payload.kind)).toEqual(["fleet-source", "fleet-automatic"]);
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
  expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
  const third = await enroll(99003);
  third.setNow(12000);
  await expect(
    p.deps.esi!.getCharacterFleet(p.boss.id, "fixture", {
      now: () => at(12000).getTime(),
      fetchImpl: async () =>
        Response.json(
          {},
          {
            status: 429,
            headers: {
              "Retry-After": "60",
              "x-esi-error-limit-remain": "0",
              "x-esi-error-limit-reset": "60",
            },
          },
        ),
    }),
  ).rejects.toThrow();
  await tick(p.deps, () => true);
  expect(
    await ctx.db
      .select()
      .from(fleetAutomaticCandidate)
      .where(eq(fleetAutomaticCandidate.characterId, third.boss.id)),
  ).toEqual([]);
  p.setNow(72000);
  await tick(p.deps, () => false);
  expect(
    await ctx.db
      .select()
      .from(fleetAutomaticCandidate)
      .where(eq(fleetAutomaticCandidate.characterId, third.boss.id)),
  ).toEqual([]);
  await tick(p.deps, () => true);
  expect((await candidate(third.boss.id)).reservationId).not.toBeNull();
  expect(third.requests).toEqual([]);
});

async function withRuntime<T>(
  deps: FleetSourceDeps,
  run: (r: Awaited<ReturnType<typeof runtime>>) => Promise<T>,
) {
  return withFleetResources(async (own) => {
    const r = await runtime(deps);
    own(r, (r) => r.close());
    return run(r);
  });
}
async function runtime(deps: FleetSourceDeps) {
  const boss = new PgBoss({ connectionString: TEST_URL, max: 5 });
  const errors: unknown[] = [];
  boss.on("error", (e) => errors.push(e));
  const names = new Map<string, string>();
  const owner = scheduler.createFleetSourceOwner();
  const originals: string[] = [];
  const deliveries: string[] = [];
  const tasks: Promise<void>[] = [];
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= dispose());
  }
  async function dispose() {
    owner.stopAdmission();
    for (const q of names.values()) await boss.offWork(q);
    await owner.drain();
    await Promise.allSettled(tasks);
    try {
      for (const q of names.values()) {
        // manager.complete/fail is not awaited by pg-boss's wrapper. Wait for
        // its SQL transaction too before deleting this queue's rows.
        await until(
          async () =>
            (
              await ctx.db.execute<{ n: number }>(
                sql`select count(*)::int as n from pgboss.job where name=${q} and state='active'`,
              )
            ).rows[0].n === 0,
        );
        const jobs = await ctx.db.execute<{ id: string }>(
          sql`select id from pgboss.job where name=${q}`,
        );
        if (jobs.rows.length)
          await boss.deleteJob(
            q,
            jobs.rows.map((j) => j.id),
          );
        await boss.deleteQueue(q);
      }
    } finally {
      await boss.stop({ graceful: true, wait: true });
      expect(errors).toEqual([]);
    }
  }
  try {
    await boss.start();
    await createQueues(boss);
    const h = handlers({ ...deps, signal: owner.signal });
    for (const name of [QUEUES.fleetSource, QUEUES.fleetAutomatic]) {
      const queue = `${name}-p3-${randomUUID()}`;
      names.set(name, queue);
      const policy = (await boss.getQueue(name))!;
      expect(policy).toMatchObject({
        retryLimit: 0,
        expireInSeconds: 30,
        retentionMinutes: 1,
        deadLetter: null,
      });
      const { deadLetter: _deadLetter, ...options } = policy;
      await boss.createQueue(queue, { ...options, name: queue });
      if (name === QUEUES.fleetAutomatic) {
        await scheduler.startFleetAutomaticWork(
          boss,
          owner,
          async (data) => {
            originals.push(name);
            deliveries.push(name);
            const task = h[name](data);
            tasks.push(task);
            await task;
          },
          queue,
        );
        continue;
      }
      const owned = owner.wrap(async (data) => {
        originals.push(name);
        await h[name](data);
      });
      await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const j of jobs) {
          deliveries.push(name);
          const task = owned(j.data);
          tasks.push(task);
          await task;
        }
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  const sent: { queue: string; id: string | null; data: Record<string, unknown> }[] = [];
  const send = async (
    queue: string,
    data: Record<string, unknown>,
    options: { singletonKey: string },
  ) => {
    const id = await boss.send(names.get(queue)!, data, options);
    sent.push({ queue, id, data });
    return id;
  };
  return { boss, names, owner, originals, deliveries, tasks, sent, send, close, errors };
}

it.each([200, 401, 403])(
  "real queue reserve -> dispatch -> full registered job commits or settles roster %s",
  async (status) => {
    const p = await enroll();
    p.options.roster = status;
    await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
    const input = await task();
    await withRuntime(p.deps, async (r) => {
      expect(await dispatchOutbox(ctx.db, r.send, "fleet-source")).toBe(1);
      expect(r.sent[0]).toMatchObject({
        queue: "fleet-automatic",
        data: { jobType: "fleet-automatic", ...input },
      });
      const id = r.sent[0].id!;
      await until(
        async () =>
          (await r.boss.getJobById(r.names.get("fleet-automatic")!, id))?.state ===
          "completed",
      );
      const c = await candidate();
      expect(c).toMatchObject({
        claimGeneration: 1,
        claimReservationId: null,
        sourceId: status === 200 ? expect.any(String) : null,
        lastOutcome:
          status === 200
            ? "verified"
            : status === 401
              ? "fleet_read_invalid"
              : "not_boss",
      });
      expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(
        status === 200 ? 1 : 0,
      );
      expect(await ctx.db.select().from(syncRun)).toEqual([]);
      // Same old UUID after queue completion cannot claim or create again.
      await r.send(
        "fleet-automatic",
        { jobType: "fleet-automatic", ...input },
        { singletonKey: "duplicate-after-completion" },
      );
      await until(
        async () =>
          (await r.boss.getJobById(r.names.get("fleet-automatic")!, r.sent[1].id!))
            ?.state === "completed",
      );
      expect(await candidate()).toEqual(c);
      expect(p.requests).toEqual(["token", "membership", "roster"]);
      expect(r.errors).toEqual([]);
    });
  },
);

it("real queue saturated discovery backlog keeps healthy active roster progressing using the same memory and ESI", async () => {
  const active = await enroll(99002);
  await automatic.reserveDueFleetAutomatic(ctx.db, active.deps.now);
  await automaticJobs.runFleetAutomaticJob(active.deps, await task(99002));
  const [source] = await ctx.db.select().from(fleetSourceIntent);
  const p = await enroll();
  p.setNow(7000);
  active.setNow(7000);
  const held = deferred();
  p.options.hold = async (stage) => {
    if (stage === "token") await held.promise;
  };
  const shared: FleetSourceDeps = {
    ...p.deps,
    memory: active.deps.memory,
    esi: active.deps.esi,
    fetchImpl: (raw, init) => {
      const tokenBody = String(init?.body ?? "");
      return String(raw).includes("99002") || tokenBody.includes("99002")
        ? active.deps.fetchImpl!(raw, init)
        : p.deps.fetchImpl!(raw, init);
    },
  };
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  await ctx.db.delete(outbox);
  // A real due reservation leads the older backlog; stale tasks do not fake claims.
  await enqueueSync(ctx.db, { kind: "fleet-automatic", ...input });
  for (let i = 0; i < 120; i++)
    await enqueueSync(ctx.db, {
      kind: "fleet-automatic",
      ...input,
      reservationId: randomUUID(),
    });
  await reserveDueFleetSources(ctx.db, p.deps.now);
  await withRuntime(shared, async (r) => {
    try {
      expect(await dispatchOutbox(ctx.db, r.send, "fleet-source")).toBe(100);
      await until(async () => p.requests.includes("token"));
      await until(
        async () =>
          (
            await ctx.db
              .select()
              .from(fleetSourceAuthority)
              .where(eq(fleetSourceAuthority.sourceId, source.id))
          )[0]?.verifiedAt?.getTime() === at(7000).getTime(),
      );
      // UPDATE ... RETURNING does not preserve selection order within a
      // pg-boss batch: stale jobs may precede the held real claim.
      expect(
        r.originals.filter((k) => k === "fleet-automatic").length,
      ).toBeGreaterThanOrEqual(1);
      expect(r.owner.canDiscover()).toBe(false);
      expect(active.requests).toEqual(["token", "membership", "roster", "roster"]);
      expect(p.requests).toEqual(["token"]);
      expect((await candidate()).claimReservationId).toBe(input.reservationId);
      expect(
        (
          await ctx.db
            .select()
            .from(fleetSourceIntent)
            .where(eq(fleetSourceIntent.id, source.id))
        )[0],
      ).toMatchObject({ state: "active", fetchGeneration: 1, nextFetchAt: at(12000) });
      held.resolve();
      await until(async () => (await candidate()).sourceId !== null);
      expect(r.errors).toEqual([]);
    } finally {
      held.resolve();
    }
  });
});

it("actual 30s pg-boss expiry/offWork retains both original token CAS promises, refuses a second discovery, and delays pool close", async () => {
  const active = await enroll(99002);
  await automatic.reserveDueFleetAutomatic(ctx.db, active.deps.now);
  await automaticJobs.runFleetAutomaticJob(active.deps, await task(99002));
  const p = await enroll();
  const other = await enroll(99003);
  p.setNow(7000);
  active.setNow(7000);
  other.setNow(7000);
  const activeTokenBefore = (
    await ctx.db.select().from(character).where(eq(character.id, active.boss.id))
  )[0].refreshTokenEnc;
  const app = createDb(TEST_URL);
  const locks = [await ctx.pool.connect(), await ctx.pool.connect()];
  const pids = [0, 0];
  const shared: FleetSourceDeps = {
    ...p.deps,
    db: app.db,
    memory: createFleetSourceMemory(),
    esi: active.deps.esi,
    fetchImpl: (raw, init) => {
      const body = String(init?.body ?? "");
      return String(raw).includes("99002") || body.includes("99002")
        ? active.deps.fetchImpl!(raw, init)
        : p.deps.fetchImpl!(raw, init);
    },
  };
  for (const [i, pilot] of [p, active].entries())
    pilot.options.hold = async (stage) => {
      if (stage !== "token") return;
      await locks[i].query("begin");
      await locks[i].query("select id from character where id=$1 for update", [
        pilot.boss.id,
      ]);
      pids[i] = (
        await locks[i].query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0].pid;
    };
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const first = await task();
  const second = await task(99003);
  await ctx.db.delete(outbox);
  await enqueueSync(ctx.db, { kind: "fleet-automatic", ...first });
  await reserveDueFleetSources(ctx.db, p.deps.now);
  let poolClosed = false;
  let poolsClosing = false;
  let closing: Promise<void> | undefined;
  try {
    await withRuntime(shared, async (r) => {
      try {
        expect(await dispatchOutbox(ctx.db, r.send, "fleet-source")).toBe(2);
        await until(async () => pids.every(Boolean));
        // Enqueue AFTER the first framework batch is already blocked in CAS.
        await enqueueSync(ctx.db, { kind: "fleet-automatic", ...second });
        expect(await dispatchOutbox(ctx.db, r.send, "fleet-source")).toBe(1);
        const secondJob = r.sent.at(-1)!;
        for (const pid of pids)
          expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        const automaticJob = r.sent.find((s) => s.queue === "fleet-automatic")!;
        const sourceJob = r.sent.find((s) => s.queue === "fleet-source")!;
        for (const job of [automaticJob, sourceJob]) {
          const stored = await r.boss.getJobById(r.names.get(job.queue)!, job.id!);
          expect(stored).toMatchObject({ state: "active", retryLimit: 0 });
          expect(Number(stored?.expireInSeconds)).toBe(30);
        }
        p.setNow(38000);
        active.setNow(38000);
        await until(
          async () =>
            (await r.boss.getJobById(r.names.get("fleet-automatic")!, automaticJob.id!))
              ?.state === "failed",
          35000,
        );
        await until(async () =>
          ["failed", "completed"].includes(
            (await r.boss.getJobById(r.names.get("fleet-automatic")!, secondJob.id!))
              ?.state ?? "",
          ),
        );
        expect(r.originals.filter((k) => k === "fleet-automatic")).toHaveLength(1);
        expect(
          await r.boss.getJobById(r.names.get("fleet-automatic")!, secondJob.id!),
        ).toMatchObject({
          state: "failed",
          output: { message: "fleet_automatic_job_failed" },
        });
        expect((await candidate(99003)).claimGeneration).toBe(0);
        expect(p.requests).toEqual(["token"]);
        expect(other.requests).toEqual([]);
        expect(r.owner.canDiscover()).toBe(false);
        r.owner.stopAdmission();
        await r.boss.offWork(r.names.get("fleet-source")!);
        await r.boss.offWork(r.names.get("fleet-automatic")!);
        closing = r.owner.drain().then(async () => {
          // Assert permission to start closing, not just pool.end resolution:
          // pg itself can wait on a borrowed client and mask a broken drain.
          poolsClosing = true;
          await r.close();
          await app.pool.end();
          poolClosed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(poolsClosing).toBe(false);
        expect(poolClosed).toBe(false);
        expect(await app.db.execute(sql`select 1`)).toBeDefined();
        await locks[0].query("commit");
        await until(
          async () =>
            (await ctx.db.select().from(character).where(eq(character.id, p.boss.id)))[0]
              .refreshTokenEnc !== p.boss.refreshTokenEnc,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(poolsClosing).toBe(false);
        expect(poolClosed).toBe(false);
        await locks[1].query("commit");
        await closing;
        expect(poolClosed).toBe(true);
        expect(
          (
            await ctx.db.select().from(character).where(eq(character.id, active.boss.id))
          )[0].refreshTokenEnc,
        ).not.toBe(activeTokenBefore);
        expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(1);
        expect((await candidate()).sourceId).toBeNull();
        expect(r.errors).toEqual([]);
      } finally {
        for (const lock of locks) await lock.query("rollback");
        await closing;
      }
    });
  } finally {
    for (const lock of locks) {
      await lock.query("rollback");
      lock.release();
    }
    if (!poolClosed) await app.pool.end();
  }
}, 45000);

it("fresh worker owners and pools recover retained reservation/claim/outbox state without pardoning suspension (simulated restart, not OS process)", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const abandoned = await task();
  const firstPool = createDb(TEST_URL);
  try {
    await withRuntime({ ...p.deps, db: firstPool.db }, async (r) => {
      // Persist a dispatched outbox and real abandoned claim. This fixture
      // removes its old queue at teardown; the next test retains queue rows.
      // No pretend OS process is killed: owners are drained and replaced.
      r.owner.stopAdmission();
      for (const q of r.names.values()) await r.boss.offWork(q);
      await dispatchOutbox(firstPool.db, r.send, "fleet-source");
      expect(r.sent).toHaveLength(1);
      expect(
        await automatic.claimFleetAutomaticDiscovery(firstPool.db, abandoned, p.deps.now),
      ).not.toBeNull();
    });
  } finally {
    await firstPool.pool.end();
  }
  const retained = await candidate();
  expect(retained.claimGeneration).toBe(1);
  p.setNow(32000);
  const restarted = createDb(TEST_URL);
  try {
    const fresh = {
      ...p.deps,
      db: restarted.db,
      memory: createFleetSourceMemory(),
      esi: createEsiClient({ now: () => p.deps.now!().getTime() }),
    };
    await withRuntime(fresh, async (r) => {
      await scheduler.runFleetSourceTick(fresh, r.owner.canDiscover);
      const current = await task();
      expect(current.reservationId).not.toBe(abandoned.reservationId);
      await enqueueSync(ctx.db, { kind: "fleet-automatic", ...abandoned });
      await dispatchOutbox(ctx.db, r.send, "fleet-source");
      await until(async () => (await candidate()).sourceId !== null);
      expect(await candidate()).toMatchObject({
        claimGeneration: 2,
        lastOutcome: "verified",
        claimReservationId: null,
      });
      expect(p.requests).toEqual(["token", "membership", "roster"]);
      expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(1);
      expect(r.errors).toEqual([]);
    });
  } finally {
    await restarted.pool.end();
  }
  // A separate real negative path survives a fresh worker's memory as well.
  const suspended = await enroll(99003);
  suspended.options.roster = 401;
  await automatic.reserveDueFleetAutomatic(ctx.db, suspended.deps.now);
  await withRuntime(suspended.deps, async (r) => {
    await dispatchOutbox(ctx.db, r.send, "fleet-source");
    await until(
      async () => (await candidate(99003)).lastOutcome === "fleet_read_invalid",
    );
  });
  const latch = await candidate(99003);
  suspended.setNow(200000);
  const freshPool = createDb(TEST_URL);
  try {
    const fresh = {
      ...suspended.deps,
      db: freshPool.db,
      memory: createFleetSourceMemory(),
      esi: createEsiClient(),
    };
    await withRuntime(fresh, async (r) => {
      await scheduler.runFleetSourceTick(fresh, r.owner.canDiscover);
      expect((await candidate(99003)).lastOutcome).toBe("fleet_read_invalid");
      expect((await candidate(99003)).claimGeneration).toBe(latch.claimGeneration);
      expect((await candidate(99003)).reservationId).toBeNull();
      expect(suspended.requests).toEqual(["token", "membership", "roster"]);
    });
  } finally {
    await freshPool.pool.end();
  }
});

it("real queued positive commit reuses an independently restored real live source without applying its body", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  await automaticJobs.runFleetAutomaticJob(p.deps, await task());
  const [source] = await ctx.db.select().from(fleetSourceIntent);
  const [authority] = await ctx.db.select().from(fleetSourceAuthority);
  // Defensive appearance fixture, not a reachable simultaneous-current-claim
  // story: retain the actual committed source/proof, temporarily remove it so
  // the REAL reserver can admit work, then restore it before the final commit.
  // No placeholder or fabricated positive evidence is used.
  await ctx.db.delete(fleetSourceAuthority);
  await ctx.db.delete(fleetSourceIntent);
  await ctx.db
    .update(fleetAutomaticCandidate)
    .set({ sourceId: null, nextAttemptAt: at(3000) });
  await ctx.db.execute(
    sql`update fleet_automatic_consent set next_reconcile_at=${at(3000)}`,
  );
  p.setNow(3000);
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  p.options.hold = async (stage) => {
    if (stage !== "roster") return;
    await ctx.db.transaction(async (tx) => {
      await tx.insert(fleetSourceIntent).values(source);
      await tx.delete(fleetSourceAuthority);
      await tx.insert(fleetSourceAuthority).values(authority);
    });
  };
  const actualCommit = automatic.commitFleetAutomaticDiscovery;
  const results: string[] = [];
  const spy = vi
    .spyOn(automatic, "commitFleetAutomaticDiscovery")
    .mockImplementation(async (...args) => {
      const result = await actualCommit(...args);
      results.push(result.result);
      return result;
    });
  try {
    await withRuntime(p.deps, async (r) => {
      await dispatchOutbox(ctx.db, r.send, "fleet-source");
      await until(async () => (await candidate()).sourceId !== null);
      expect(results).toEqual(["reused"]);
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([source]);
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual([authority]);
      expect(await candidate()).toMatchObject({
        claimGeneration: 2,
        claimReservationId: null,
        sourceId: source.id,
      });
    });
  } finally {
    spy.mockRestore();
  }
});

it("actual commit storage failure rolls back and the queued failure contains only the approved classification", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  await withInjectedPgFault(
    ctx.pool,
    { matchSql: /^insert into "fleet_source_intent"/i, code: "23514" },
    async () => {
      await withRuntime(p.deps, async (r) => {
        await dispatchOutbox(ctx.db, r.send, "fleet-source");
        const id = r.sent[0].id!;
        await until(
          async () =>
            (await r.boss.getJobById(r.names.get("fleet-automatic")!, id))?.state ===
            "failed",
        );
        const failed = await r.boss.getJobById(r.names.get("fleet-automatic")!, id);
        expect(failed).toMatchObject({
          retryLimit: 0,
          retryCount: 0,
          output: { message: "fleet_automatic_job_failed" },
        });
        expect(JSON.stringify(failed?.output)).not.toMatch(
          /synthetic|23514|insert into|refresh/,
        );
        expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([]);
        expect(await candidate()).toMatchObject({
          claimReservationId: input.reservationId,
          sourceId: null,
        });
      });
    },
  );
});

it("mixed bounded outbox selection reserves every class and concurrent transactions skip exactly the locked rows", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  await ctx.db.delete(outbox);
  for (const kind of ["fleet-source", "fleet-automatic", "other"] as const) {
    for (let i = 0; i < 110; i++)
      await enqueueSync(
        ctx.db,
        kind === "fleet-source"
          ? { kind, sourceId: randomUUID(), generation: 1 }
          : kind === "fleet-automatic"
            ? { kind, ...input, reservationId: randomUUID() }
            : { kind: "job", jobType: "contacts" },
      );
  }
  const held = deferred();
  const entered = deferred();
  let first: Awaited<ReturnType<typeof takeUndispatched>> = [];
  const work = ctx.db.transaction(async (tx) => {
    first = await takeUndispatched(tx, 100);
    entered.resolve();
    await held.promise;
  });
  try {
    await entered.promise;
    const next = await ctx.db.transaction((tx) => takeUndispatched(tx, 100));
    for (const selected of [first, next]) {
      expect(selected).toHaveLength(100);
      for (const kind of ["fleet-source", "fleet-automatic", "job"])
        expect(
          selected.filter((r) => r.payload.kind === kind).length,
        ).toBeGreaterThanOrEqual(33);
    }
    expect(next.some((r) => first.some((f) => f.id === r.id))).toBe(false);
  } finally {
    held.resolve();
    await work;
  }
  expect(await takeUndispatched(ctx.db, 0)).toEqual([]);
});

it("replacing stopped worker owners consumes a retained real pg-boss job with fresh memory and app pool", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  await withFleetResources(async (own) => {
    const first = own(await runtime(p.deps), (r) => r.close());
    first.owner.stopAdmission();
    for (const q of first.names.values()) await first.boss.offWork(q);
    await first.owner.drain();
    await enqueueSync(ctx.db, { kind: "fleet-automatic", ...input });
    await dispatchOutbox(ctx.db, first.send, "fleet-source");
    expect(first.sent).toHaveLength(2);
    expect(first.sent[0].id).not.toBeNull();
    expect(first.sent[1].id).toBeNull();
    const id = first.sent[0].id!;
    expect(
      await first.boss.getJobById(first.names.get("fleet-automatic")!, id),
    ).toMatchObject({ state: "created" });
    expect((await ctx.db.select().from(outbox))[0].dispatchedAt).not.toBeNull();
    const fresh = own(createDb(TEST_URL), ({ pool }) => pool.end());
    const nextBoss = own(new PgBoss({ connectionString: TEST_URL, max: 5 }), (b) =>
      b.stop({ graceful: true, wait: true }),
    );
    const errors: unknown[] = [];
    nextBoss.on("error", (e) => errors.push(e));
    const nextOwner = own(scheduler.createFleetSourceOwner(), (o) => o.drain());
    own(nextBoss, async (b) => {
      for (const q of first.names.values()) await b.offWork(q);
    });
    own(nextOwner, (o) => o.stopAdmission());
    await nextBoss.start();
    const h = handlers({
      ...p.deps,
      db: fresh.db,
      signal: nextOwner.signal,
      memory: createFleetSourceMemory(),
      esi: createEsiClient({ now: () => at(2000).getTime() }),
    });
    for (const [name, queue] of first.names) {
      if (name === "fleet-automatic") {
        await scheduler.startFleetAutomaticWork(nextBoss, nextOwner, h[name], queue);
        continue;
      }
      const owned = nextOwner.wrap(h[name]);
      await nextBoss.work(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const job of jobs) await owned(job.data);
      });
    }
    await until(
      async () =>
        (await nextBoss.getJobById(first.names.get("fleet-automatic")!, id))?.state ===
        "completed",
    );
    expect(await candidate()).toMatchObject({
      claimGeneration: 1,
      claimReservationId: null,
      sourceId: expect.any(String),
    });
    expect(first.originals).toEqual([]);
    expect(p.requests).toEqual(["token", "membership", "roster"]);
    const retained = await candidate();
    await enqueueSync(ctx.db, { kind: "fleet-automatic", ...input });
    await dispatchOutbox(ctx.db, first.send, "fleet-source");
    await until(
      async () =>
        (
          await nextBoss.getJobById(
            first.names.get("fleet-automatic")!,
            first.sent[2].id!,
          )
        )?.state === "completed",
    );
    expect(await candidate()).toEqual(retained);
    expect(errors).toEqual([]);
  });
});

it("continuous finite 50-character discovery cohort actually claims every candidate before stale FIFO renewals can monopolize delivery", async () => {
  const active = await enroll(99002);
  await automatic.reserveDueFleetAutomatic(ctx.db, active.deps.now);
  await automaticJobs.runFleetAutomaticJob(active.deps, await task(99002));
  const [source] = await ctx.db.select().from(fleetSourceIntent);
  const p = await enroll(100001);
  const ids = Array.from({ length: 50 }, (_, i) => 100001 + i);
  for (const id of ids.slice(1))
    await seedCharacter(ctx.db, cfg, {
      id,
      accountId: p.account.id,
      scopes: [FLEET_READ_SCOPE],
      refreshToken: `cohort-${id}`,
    });
  await ctx.db.delete(outbox);
  const began = Date.now();
  const now = () => at(2000 + Date.now() - began);
  active.deps.now = now;
  const tokens: number[] = [];
  const deps: FleetSourceDeps = {
    ...p.deps,
    now,
    memory: active.deps.memory,
    esi: createEsiClient({ now: () => now().getTime() }),
    fetchImpl: async (raw, init) => {
      if (String(raw).includes("99002") || String(init?.body).includes("99002")) {
        active.setNow(now().getTime() - NOW.getTime());
        return active.deps.fetchImpl!(raw, init);
      }
      expect(String(raw)).toBe("https://login.eveonline.com/v2/oauth/token");
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token")!;
      const id = Number(refresh.split("-").at(-1));
      expect(ids).toContain(id);
      tokens.push(id);
      // Fresh cryptographically verified negative: after one actual claim the
      // candidate suspends, so this finite cohort cannot manufacture new demand.
      const token = await new SignJWT({
        sub: `CHARACTER:EVE:${id}`,
        owner: `oh-${id}`,
        name: `Char ${id}`,
        scp: [],
        exp: at(300000).getTime() / 1000,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .sign(keys.privateKey);
      return Response.json({ access_token: token, refresh_token: `cohort-${id}` });
    },
  };
  let runningOriginals = 0;
  let peakOriginals = 0;
  const actualJob = automaticJobs.runFleetAutomaticJob;
  const jobSpy = vi
    .spyOn(automaticJobs, "runFleetAutomaticJob")
    .mockImplementation(async (...args) => {
      runningOriginals++;
      peakOriginals = Math.max(peakOriginals, runningOriginals);
      try {
        await actualJob(...args);
      } finally {
        runningOriginals--;
      }
    });
  const actualClaim = automatic.claimFleetAutomaticDiscovery;
  const admissions: { characterId: number; reservationId: string; admitted: boolean }[] =
    [];
  const spy = vi
    .spyOn(automatic, "claimFleetAutomaticDiscovery")
    .mockImplementation(async (...args) => {
      const claim = await actualClaim(...args);
      admissions.push({
        characterId: args[1].characterId,
        reservationId: args[1].reservationId,
        admitted: claim !== null,
      });
      return claim;
    });
  try {
    await withRuntime(deps, async (r) => {
      const stopScheduler = scheduler.startFleetSourceScheduler(() =>
        scheduler.runFleetSourceTick(deps, r.owner.canDiscover),
      );
      const stopDispatch = startDispatcher(ctx.db, r.send, 500, "fleet-source");
      try {
        await until(
          async () =>
            new Set(admissions.filter((a) => a.admitted).map((a) => a.characterId))
              .size === 50 || admissions.length >= 90,
          65000,
        );
        const candidates = await ctx.db
          .select()
          .from(fleetAutomaticCandidate)
          .where(eq(fleetAutomaticCandidate.accountId, p.account.id));
        const queued = await ctx.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pgboss.job where name=${r.names.get("fleet-automatic")!} and state='created'`,
        );
        const renewals = new Map<number, Set<unknown>>();
        for (const s of r.sent.filter((s) => s.queue === "fleet-automatic")) {
          const id = Number(s.data.characterId);
          if (!renewals.has(id)) renewals.set(id, new Set());
          renewals.get(id)!.add(s.data.reservationId);
        }
        const evidence = {
          deliveries: admissions.length,
          actualClaims: candidates.filter((c) => c.claimGeneration > 0).length,
          suspended: candidates.filter((c) => c.lastOutcome === "fleet_read_invalid")
            .length,
          staleDeliveries: admissions.filter((a) => !a.admitted).length,
          undispatched: (
            await ctx.db.select().from(outbox).where(isNull(outbox.dispatchedAt))
          ).length,
          queued: queued.rows[0].n,
          maxReservationUUIDs: Math.max(...[...renewals.values()].map((s) => s.size)),
        };
        expect(candidates).toHaveLength(50);
        expect(evidence.actualClaims, JSON.stringify(evidence)).toBe(50);
        await until(async () =>
          (
            await ctx.db
              .select()
              .from(fleetAutomaticCandidate)
              .where(eq(fleetAutomaticCandidate.accountId, p.account.id))
          ).every((c) => c.lastOutcome === "fleet_read_invalid"),
        );
        expect(new Set(tokens).size).toBe(50);
        expect(peakOriginals).toBe(1);
        await until(
          async () =>
            (
              await ctx.db
                .select()
                .from(fleetSourceIntent)
                .where(eq(fleetSourceIntent.id, source.id))
            )[0].fetchGeneration > 0,
        );
        const [updated] = await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, source.id));
        expect(updated.state).toBe("active");
        expect(updated.fetchGeneration).toBeGreaterThan(0);
        expect(
          (
            await ctx.db
              .select()
              .from(fleetSourceAuthority)
              .where(eq(fleetSourceAuthority.sourceId, source.id))
          )[0].verifiedAt!.getTime(),
        ).toBeGreaterThan(at(2000).getTime());
      } finally {
        r.owner.stopAdmission();
        await stopScheduler();
        await stopDispatch();
      }
    });
  } finally {
    spy.mockRestore();
    jobSpy.mockRestore();
  }
}, 90000);

it("a first task storage failure cannot complete or fail away an unattempted valid batch suffix", async () => {
  const p = await enroll();
  await automatic.reserveDueFleetAutomatic(ctx.db, p.deps.now);
  const input = await task();
  const held = deferred();
  let rosterHeld = false;
  p.options.hold = async (stage) => {
    if (stage === "roster") {
      rosterHeld = true;
      await held.promise;
    }
  };
  await withFleetResources(async (own) => {
    const boss = own(new PgBoss({ connectionString: TEST_URL, max: 5 }), (b) =>
      b.stop({ graceful: true, wait: true }),
    );
    const errors: unknown[] = [];
    boss.on("error", (e) => errors.push(e));
    await boss.start();
    await createQueues(boss);
    const q = `fleet-automatic-p3-${randomUUID()}`;
    own(q, async () => {
      await until(
        async () =>
          (
            await ctx.db.execute<{ n: number }>(
              sql`select count(*)::int as n from pgboss.job where name=${q} and state='active'`,
            )
          ).rows[0].n === 0,
      );
      const rows = await ctx.db.execute<{ id: string }>(
        sql`select id from pgboss.job where name=${q}`,
      );
      if (rows.rows.length)
        await boss.deleteJob(
          q,
          rows.rows.map((r) => r.id),
        );
      await boss.deleteQueue(q);
    });
    const { deadLetter: _dlq, ...policy } = (await boss.getQueue("fleet-automatic"))!;
    await boss.createQueue(q, { ...policy, name: q });
    const owner = own(scheduler.createFleetSourceOwner(), (o) => o.drain());
    own(boss, (b) => b.offWork(q));
    own(owner, (o) => {
      o.stopAdmission();
      held.resolve();
    });
    const good = planDispatch({ kind: "fleet-automatic", ...input })[0];
    // Duplicate-delivery boundary fixture (not a weakened production singleton).
    // Either framework row can be first: its actual claim write fails once and
    // rolls back; the remaining exact current task must still run.
    const first = await boss.send(q, good.data);
    const second = await boss.send(q, good.data, { singletonKey: good.singletonKey });
    const h = handlers({ ...p.deps, signal: owner.signal });
    const seen: unknown[] = [];
    // Both jobs exist before the real production batch fetch starts.
    await withInjectedPgFault(
      ctx.pool,
      { matchSql: /^update "fleet_automatic_candidate"/i, code: "23514" },
      async () => {
        await scheduler.startFleetAutomaticWork(
          boss,
          owner,
          async (data) => {
            seen.push(data);
            await h["fleet-automatic"](data);
          },
          q,
        );
        await until(
          async () =>
            rosterHeld || (await boss.getJobById(q, first!))?.state === "failed",
        );
        expect(seen).toEqual([good.data, good.data]);
        expect(rosterHeld).toBe(true);
        expect((await boss.getJobById(q, first!))?.state).toBe("active");
        expect((await boss.getJobById(q, second!))?.state).toBe("active");
        expect((await candidate()).claimReservationId).toBe(input.reservationId);
        held.resolve();
        await until(async () => (await boss.getJobById(q, second!))?.state === "failed");
        expect(await candidate()).toMatchObject({
          claimGeneration: 1,
          sourceId: expect.any(String),
          claimReservationId: null,
        });
        expect(p.requests).toEqual(["token", "membership", "roster"]);
        expect(JSON.stringify((await boss.getJobById(q, first!))?.output)).not.toContain(
          "synthetic injected",
        );
        expect(errors).toEqual([]);
      },
    );
  });
});

it("automatic queue startup repairs short retry0 expiry30 retention60 without a DLQ", async () => {
  await withFleetResources(async (own) => {
    const boss = own(new PgBoss({ connectionString: TEST_URL, max: 5 }), (b) =>
      b.stop({ graceful: true, wait: true }),
    );
    const errors: unknown[] = [];
    boss.on("error", (e) => errors.push(e));
    await boss.start();
    await createQueues(boss);
    expect(await boss.getQueue("fleet-automatic")).toMatchObject({
      policy: "short",
      retryLimit: 0,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: 30,
      retentionMinutes: 1,
      deadLetter: null,
    });
    await boss.updateQueue("fleet-automatic", {
      name: "fleet-automatic",
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 300,
      retentionMinutes: 5,
    });
    await createQueues(boss);
    expect(await boss.getQueue("fleet-automatic")).toMatchObject({
      retryLimit: 0,
      expireInSeconds: 30,
      retentionMinutes: 1,
    });
    expect(errors).toEqual([]);
  });
});
