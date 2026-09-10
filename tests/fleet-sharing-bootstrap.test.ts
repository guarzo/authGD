import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  account,
  auditLog,
  character,
  fleetAccessCheckGate,
  fleetDevice,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
  fleetEligibility,
  fleetPairingRequest,
  fleetPublisherLease,
  fleetRecoveryChallenge,
  fleetSharingGate,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
  session,
} from "@/db/schema";
import {
  readFleetKeyIdentityState,
  lockFleetSharingMode,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";
import * as sharingMode from "@/services/fleet-sharing-mode";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { beginPairing } from "@/services/fleet-pairing";
import {
  claimFleetSourceFetch,
  commitFleetSourceObservation,
} from "@/services/fleet-source-observation";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { setFleetParticipation } from "@/services/fleet-participation";
import { replaceDeviceProjection } from "@/services/fleet-relay";
import { pairDevice, fleetKeyPair, waitUntilBlockedBy } from "./helpers/fleet-sharing";
import {
  seedLifecycleSource,
  seedLifecycleProjection,
} from "./helpers/fleet-source-lifecycle";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { createSession } from "@/services/session";
import { parseModeOptions, runFleetSharingMode } from "../scripts/fleet-sharing-mode";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { withInjectedPgFault } from "./helpers/pg-fault";

const NOW = new Date("2026-09-07T12:00:00Z");
const EXPIRED = new Date("2020-01-01T00:00:00Z");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

function options(apply = true, revision = 0, target = "--enable") {
  return parseModeOptions([
    apply ? "--apply" : "--dry-run",
    target,
    ...(target === "--enable" ? ["--first-use"] : []),
    "--expected-revision",
    String(revision),
    "--compatible-web",
    "--compatible-worker",
    "--old-replicas-drained",
  ]);
}
const initial = {
  enabled: false,
  revision: 0,
  transitionedAt: null,
  keyIdentityPhase: "pending",
  keyIdentityCursor: null,
};
const emptyCounts = {
  fleet_device: 0,
  fleet_pairing_request: 0,
  fleet_device_key_identity: 0,
  fleet_device_session: 0,
  fleet_source_intent: 0,
  fleet_source_authority: 0,
  fleet_recovery_challenge: 0,
  fleet_publisher_lease: 0,
  fleet_telemetry_row: 0,
  fleet_eligibility: 0,
};
async function snapshot() {
  const tables = Object.values(schema).filter((t) => is(t, PgTable));
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (t) => [getTableName(t), await ctx.db.select().from(t)] as const),
    ),
  );
}
async function unrelatedFixture() {
  const owner = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  await createSession(ctx.db, owner.id);
  await ctx.db
    .insert(fleetAccessCheckGate)
    .values({ accountId: owner.id, nextAllowedAt: NOW });
  return { owner, boss };
}

// Breaks caught: omitted inventory entry/expiry filter, implicit enable, state reset,
// a ready write or audit outside the transaction, or enrollment as a side effect.
describe("bounded first-use sharing bootstrap", () => {
  it.each([false, true])(
    "atomically initializes an empty index and enables (explicit initial row=%s) without opting anyone in",
    async (explicit) => {
      await unrelatedFixture();
      if (explicit) await ctx.db.insert(fleetSharingGate).values({ id: 1 });
      const before = await snapshot();
      expect(await runFleetSharingMode(ctx.db, options())).toMatchObject({
        enabled: true,
        revision: 1,
        keyIdentityPhase: "ready",
        keyIdentityCursor: null,
        transitionedAt: expect.any(Date),
      });
      expect(await readFleetKeyIdentityState(ctx.db)).toMatchObject({
        enabled: true,
        revision: 1,
        keyIdentityPhase: "ready",
        keyIdentityCursor: null,
      });
      const after = await snapshot();
      for (const name of Object.keys(before).filter(
        (name) => !["fleet_sharing_gate", "audit_log"].includes(name),
      ))
        expect(after[name], name).toEqual(before[name]);
      expect(
        await ctx.db
          .select({
            actor: auditLog.actor,
            action: auditLog.action,
            target: auditLog.target,
            details: auditLog.details,
          })
          .from(auditLog),
      ).toEqual([
        {
          actor: "system",
          action: "fleet_sharing.key_identity_ready",
          target: "all",
          details: null,
        },
        {
          actor: "system",
          action: "fleet_sharing.mode_transitioned",
          target: "all",
          details: { enabled: true, revision: 1 },
        },
      ]);
    },
  );

  it("dry-run reports the supported empty path and complete inventory without creating a gate or audit", async () => {
    await unrelatedFixture();
    const before = await snapshot();
    const dry = await runFleetSharingMode(ctx.db, options(false));
    expect(dry).toMatchObject({
      dryRun: true,
      releaseReady: true,
      refusal: null,
      current: initial,
      firstUseCounts: emptyCounts,
    });
    const protectedNames = Object.values(schema)
      .filter((t) => is(t, PgTable))
      .map(getTableName)
      .filter(
        (name) =>
          name.startsWith("fleet_") &&
          !["fleet_sharing_gate", "fleet_access_check_gate"].includes(name),
      );
    expect(Object.keys(emptyCounts).sort()).toEqual(protectedNames.sort());
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { revision: 1 },
    { enabled: true },
    { keyIdentityPhase: "ready" as const },
    { keyIdentityPhase: "reconciling" as const },
    { keyIdentityCursor: randomUUID() },
    { transitionedAt: NOW },
  ])("refuses noninitial gate %j without resets", async (change) => {
    await ctx.db.insert(fleetSharingGate).values({ id: 1, ...change });
    const before = await snapshot();
    const opts = options(true, change.revision ?? 0);
    await expect(runFleetSharingMode(ctx.db, opts)).rejects.toThrow(
      "first_use_initial_state_required",
    );
    expect(await runFleetSharingMode(ctx.db, { ...opts, apply: false })).toMatchObject({
      releaseReady: false,
      refusal: "first_use_initial_state_required",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects stale revision, and a repeated invocation cannot reset or replay readiness", async () => {
    await expect(runFleetSharingMode(ctx.db, options(true, 1))).rejects.toThrow(
      "conflict",
    );
    expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
    await runFleetSharingMode(ctx.db, options());
    const before = await snapshot();
    await expect(runFleetSharingMode(ctx.db, options())).rejects.toThrow("conflict");
    await expect(runFleetSharingMode(ctx.db, options(true, 1))).rejects.toThrow(
      "first_use_initial_state_required",
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "fleet_device",
    "fleet_pairing_request",
    "fleet_device_key_identity",
    "conflicted_key",
    "fleet_device_session",
    "fleet_source_intent",
    "fleet_source_authority",
    "fleet_recovery_challenge",
    "fleet_publisher_lease",
    "fleet_telemetry_row",
    "fleet_eligibility",
  ])(
    "refuses retained/stale/orphan data in %s and reports actual counts",
    async (name) => {
      const { owner, boss } = await unrelatedFixture();
      const needsDevice = [
        "fleet_device",
        "fleet_device_session",
        "fleet_publisher_lease",
        "fleet_telemetry_row",
      ].includes(name);
      const needsSession = [
        "fleet_device_session",
        "fleet_publisher_lease",
        "fleet_telemetry_row",
      ].includes(name);
      const deviceId = randomUUID();
      if (needsDevice)
        await ctx.db.insert(fleetDevice).values({
          id: deviceId,
          accountId: owner.id,
          publicKeySpkiB64: "retained-key",
          revokedAt: EXPIRED,
        });
      if (needsSession)
        await ctx.db
          .insert(fleetDeviceSession)
          .values({ id: "expired-session", deviceId, expiresAt: EXPIRED });
      if (name === "fleet_pairing_request")
        await ctx.db.insert(fleetPairingRequest).values({
          publicKeySpkiB64: "pending-key",
          challengeDigest: "digest",
          expiresAt: EXPIRED,
        });
      if (["fleet_device_key_identity", "conflicted_key"].includes(name))
        await ctx.db.insert(fleetDeviceKeyIdentity).values({
          canonicalSpkiB64: "sticky-tombstone",
          deviceId: null,
          conflicted: name === "conflicted_key",
        });
      if (name === "fleet_source_intent")
        await ctx.db.insert(fleetSourceIntent).values({
          id: randomUUID(),
          state: "ended",
          intentCreatedAt: EXPIRED,
          intentExpiresAt: new Date(EXPIRED.getTime() + 60000),
          retainUntil: new Date(EXPIRED.getTime() + 86400000),
          endedAt: EXPIRED,
          terminalReason: "cancelled",
        });
      if (name === "fleet_source_authority")
        await ctx.db
          .insert(fleetSourceAuthority)
          .values({ fleetId: 123, authorityGeneration: 9 });
      if (name === "fleet_recovery_challenge")
        await ctx.db.insert(fleetRecoveryChallenge).values({
          publicKeySpkiB64: "orphan-key",
          nonceDigest: "digest",
          expiresAt: EXPIRED,
          consumedAt: EXPIRED,
        });
      if (name === "fleet_publisher_lease")
        await ctx.db.insert(fleetPublisherLease).values({
          characterId: boss.id,
          deviceId,
          sessionId: "expired-session",
          fleetId: 123,
          leaseExpiresAt: EXPIRED,
        });
      if (name === "fleet_telemetry_row")
        await ctx.db.insert(fleetTelemetryRow).values({
          characterId: boss.id,
          deviceId,
          sessionId: "expired-session",
          fleetId: 123,
          dps: 42,
          receivedAt: EXPIRED,
          staleAt: EXPIRED,
          hardExpiresAt: EXPIRED,
        });
      if (name === "fleet_eligibility")
        await ctx.db.insert(fleetEligibility).values({
          characterId: boss.id,
          accountId: owner.id,
          fleetId: 123,
          verifiedAt: EXPIRED,
          expiresAt: EXPIRED,
          outcomeCode: "ok",
        });
      const before = await snapshot();
      const countedName = name === "conflicted_key" ? "fleet_device_key_identity" : name;
      expect(await runFleetSharingMode(ctx.db, options(false))).toMatchObject({
        releaseReady: false,
        refusal: "first_use_empty_state_required",
        firstUseCounts: {
          ...emptyCounts,
          ...(needsDevice ? { fleet_device: 1 } : {}),
          ...(needsSession ? { fleet_device_session: 1 } : {}),
          [countedName]: 1,
        },
      });
      await expect(runFleetSharingMode(ctx.db, options())).rejects.toThrow(
        "first_use_empty_state_required",
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([false, true])(
    "rolls back gate and audits on final write or audit failure (audit=%s)",
    async (audit) => {
      await unrelatedFixture();
      const before = await snapshot();
      const opts = options();
      await expect(
        withInjectedPgFault(
          ctx.pool,
          {
            matchSql: audit
              ? /insert into "audit_log"/i
              : /insert into "fleet_sharing_gate"/i,
            code: "40001",
          },
          () => runFleetSharingMode(ctx.db, opts),
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await runFleetSharingMode(ctx.db, opts)).toMatchObject({
        enabled: true,
        revision: 1,
      });
    },
  );

  it("requires deployment assertions for both writes, rejects first-use disable and keeps generic enable blocked", async () => {
    expect(() =>
      parseModeOptions([
        "--apply",
        "--disable",
        "--first-use",
        "--expected-revision",
        "0",
      ]),
    ).toThrow("first_use_requires_enable");
    for (const target of ["--enable", "--disable"]) {
      const opts = options(true, 0, target);
      for (const flag of [
        "compatibleWeb",
        "compatibleWorker",
        "oldReplicasDrained",
      ] as const) {
        await expect(
          runFleetSharingMode(ctx.db, { ...opts, [flag]: false }),
        ).rejects.toThrow("compatible_web_worker_and_drained_old_replicas_required");
        expect(
          await runFleetSharingMode(ctx.db, { ...opts, apply: false, [flag]: false }),
        ).toMatchObject({
          releaseReady: false,
          refusal: "compatible_web_worker_and_drained_old_replicas_required",
        });
      }
    }
    const generic = parseModeOptions([
      "--apply",
      "--enable",
      "--expected-revision",
      "0",
      "--compatible-web",
      "--compatible-worker",
      "--old-replicas-drained",
    ]);
    await expect(runFleetSharingMode(ctx.db, generic)).rejects.toThrow(
      "full_source_model_not_release_ready",
    );
    expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
  });
});

describe("operator process boundary", () => {
  const invoke = (args: string[], pgOptions?: string) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "scripts/fleet-sharing-mode.ts", ...args],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: TEST_URL,
          ...(pgOptions ? { PGOPTIONS: pgOptions } : {}),
        },
      },
    );
  const assertions = [
    "--compatible-web",
    "--compatible-worker",
    "--old-replicas-drained",
  ];
  it("runs the exact dry-run, explicit bootstrap and explicit disable CLI without an actor or environment-file interface", async () => {
    const dry = await invoke([
      "--dry-run",
      "--enable",
      "--first-use",
      "--expected-revision",
      "0",
      ...assertions,
    ]);
    expect(dry.stderr).toBe("");
    expect(JSON.parse(dry.stdout)).toMatchObject({
      releaseReady: true,
      refusal: null,
      firstUseCounts: emptyCounts,
    });
    expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
    const apply = await invoke([
      "--apply",
      "--enable",
      "--first-use",
      "--expected-revision",
      "0",
      ...assertions,
    ]);
    expect(apply.stderr).toBe("");
    expect(JSON.parse(apply.stdout)).toMatchObject({
      enabled: true,
      revision: 1,
      keyIdentityPhase: "ready",
    });
    const disable = await invoke([
      "--apply",
      "--disable",
      "--expected-revision",
      "1",
      ...assertions,
    ]);
    expect(disable.stderr).toBe("");
    expect(JSON.parse(disable.stdout)).toMatchObject({ enabled: false, revision: 2 });
    await expect(
      invoke([
        "--apply",
        "--enable",
        "--first-use",
        "--expected-revision",
        "0",
        ...assertions,
      ]),
    ).rejects.toMatchObject({ code: 1, stdout: "", stderr: "conflict\n" });
  });
  it.each(["repeatable\\ read", "serializable"])(
    "refuses CLI disable under inherited isolation %s without draining or auditing",
    async (isolation) => {
      await populatedSharedFixture();
      const before = await snapshot();
      await expect(
        invoke(
          ["--apply", "--disable", "--expected-revision", "1", ...assertions],
          `-c default_transaction_isolation=${isolation}`,
        ),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: "mode_read_committed_required\n",
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("applies operator-local statement and lock bounds without changing connection defaults", async () => {
    const settings =
      "select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock";
    const before = (await ctx.pool.query(settings)).rows;
    // The DB checks the actual settings at the write boundary, not source text.
    // No test timeout increase to wait past the five-second statement budget.
    await ctx.pool.query(
      `create function bootstrap_test_wait_bounds() returns trigger language plpgsql as $$ begin if current_setting('statement_timeout')::interval not between interval '1 millisecond' and interval '5 seconds' or current_setting('lock_timeout')::interval not between interval '1 millisecond' and interval '2 seconds' then raise exception 'operator waits unbounded'; end if; return NEW; end $$`,
    );
    try {
      await ctx.pool.query(
        "create trigger bootstrap_test_wait_bounds before insert on fleet_sharing_gate for each row execute function bootstrap_test_wait_bounds()",
      );
      expect(await runFleetSharingMode(ctx.db, options())).toMatchObject({
        enabled: true,
        revision: 1,
      });
      expect(
        await runFleetSharingMode(ctx.db, options(true, 1, "--disable")),
      ).toMatchObject({ enabled: false, revision: 2 });
      expect((await ctx.pool.query(settings)).rows).toEqual(before);
    } finally {
      await ctx.pool.query(
        "drop trigger if exists bootstrap_test_wait_bounds on fleet_sharing_gate",
      );
      await ctx.pool.query("drop function bootstrap_test_wait_bounds()");
    }
  });
  it("prints no database cause when an operator lock times out", async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      await client.query("lock table fleet_device in row exclusive mode");
      await expect(
        invoke([
          "--apply",
          "--enable",
          "--first-use",
          "--expected-revision",
          "0",
          ...assertions,
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: "fleet_mode_operation_failed\n",
      });
      expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

// Real wait-for edges establish ordering; no sleeps used to guess which won.
describe("first-use serialization", () => {
  it("refuses a transaction whose snapshot can predate its lock wait", async () => {
    await expect(
      ctx.db.transaction((tx) => runFleetSharingMode(tx, options()), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toThrow("first_use_read_committed_required");
    expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
    expect(await ctx.db.select().from(auditLog)).toEqual([]);
  });
  it.each([false, true])(
    "waits for compatible admission, then refuses its committed state (registration=%s)",
    async (registration) => {
      const owner = await seedAccount(ctx.db, { tier: "member" });
      const held = Promise.withResolvers<number>();
      const write = Promise.withResolvers<void>();
      let operation: Promise<unknown> | undefined;
      const writer = ctx.db.transaction(async (tx) => {
        await lockFleetSharingMode(tx);
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        held.resolve(pid.rows[0].pid);
        await write.promise;
        if (registration) await pairDevice(tx, owner.id, NOW);
        else await beginPairing(tx, { ...fleetKeyPair(), now: NOW });
      });
      // A failure before acquiring the hold must fail the test, not strand it.
      void writer.catch(held.reject);
      try {
        const pid = await held.promise;
        operation = Promise.allSettled([runFleetSharingMode(ctx.db, options())]);
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        write.resolve();
        await writer;
        expect(await operation).toMatchObject([
          { status: "rejected", reason: { message: "first_use_empty_state_required" } },
        ]);
        expect(await readFleetKeyIdentityState(ctx.db)).toEqual(initial);
        expect(await ctx.db.select().from(fleetPairingRequest)).toHaveLength(1);
        expect(await ctx.db.select().from(fleetDevice)).toHaveLength(
          registration ? 1 : 0,
        );
      } finally {
        write.resolve();
        await Promise.allSettled([writer, operation]);
      }
    },
  );

  it.each([false, true])(
    "admission queued behind bootstrap sees ready/enabled, never the old pending phase (registration=%s)",
    async (registration) => {
      const owner = await seedAccount(ctx.db, { tier: "member" });
      const held = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const bootstrap = ctx.db.transaction(async (tx) => {
        const result = await runFleetSharingMode(tx, options());
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        held.resolve(pid.rows[0].pid);
        await release.promise;
        return result;
      });
      void bootstrap.catch(held.reject);
      let admission: Promise<unknown> | undefined;
      try {
        const pid = await held.promise;
        // A different connection cannot see an intermediate ready-but-disabled gate.
        expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
        admission = registration
          ? pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY])
          : beginPairing(ctx.db, {
              ...fleetKeyPair(),
              now: NOW,
              requestedCapabilities: [SHARED_CAPABILITY],
            });
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        release.resolve();
        expect(await bootstrap).toMatchObject({
          enabled: true,
          keyIdentityPhase: "ready",
          revision: 1,
        });
        await admission;
        expect(await ctx.db.select().from(fleetPairingRequest)).toHaveLength(1);
        if (registration) {
          const [device] = await ctx.db.select().from(fleetDevice);
          expect(device).toMatchObject({
            participationEnabled: false,
            participationGeneration: 0,
            approvedCapabilities: [SHARED_CAPABILITY],
          });
          expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toEqual([
            {
              canonicalSpkiB64: device.publicKeySpkiB64,
              deviceId: device.id,
              conflicted: false,
            },
          ]);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([bootstrap, admission]);
      }
    },
  );

  it("waits for a mode-free registration writer before counting; a prior dry-run cannot authorize it", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    expect(await runFleetSharingMode(ctx.db, options(false))).toMatchObject({
      releaseReady: true,
    });
    const client = await ctx.pool.connect();
    let operation: Promise<unknown> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query(
        "insert into fleet_device (account_id, public_key_spki_b64) values ($1, 'legacy-key')",
        [owner.id],
      );
      operation = Promise.allSettled([runFleetSharingMode(ctx.db, options())]);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("commit");
      expect(await operation).toMatchObject([
        { status: "rejected", reason: { message: "first_use_empty_state_required" } },
      ]);
      expect(await readFleetKeyIdentityState(ctx.db)).toEqual(initial);
      expect(await ctx.db.select().from(fleetDevice)).toHaveLength(1);
    } finally {
      await client.query("rollback");
      client.release();
      await Promise.allSettled([operation]);
    }
  });

  it.each(["mode", "table"])(
    "bounds %s lock waits and leaves the absent gate absent on failure",
    async (kind) => {
      const client = await ctx.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          kind === "mode"
            ? "select pg_advisory_xact_lock_shared(3, 0)"
            : "lock table fleet_device in row exclusive mode",
        );
        const before = await snapshot();
        await expect(runFleetSharingMode(ctx.db, options())).rejects.toMatchObject({
          cause: { code: "55P03" },
        });
        expect(await snapshot()).toEqual(before);
      } finally {
        await client.query("rollback");
        client.release();
      }
    },
  );

  it("rolls back both readiness and its audit if the last audit fails at the database boundary", async () => {
    // A real trigger faults the SECOND audit, after gate and first audit writes.
    await ctx.pool.query(
      `create function bootstrap_test_audit_fault() returns trigger language plpgsql as $$ begin if NEW.action = 'fleet_sharing.mode_transitioned' then raise exception 'bootstrap injected final audit'; end if; return NEW; end $$`,
    );
    try {
      await ctx.pool.query(
        "create trigger bootstrap_test_audit_fault before insert on audit_log for each row execute function bootstrap_test_audit_fault()",
      );
      const before = await snapshot();
      await expect(runFleetSharingMode(ctx.db, options())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await ctx.pool.query(
        "drop trigger if exists bootstrap_test_audit_fault on audit_log",
      );
      await ctx.pool.query("drop function bootstrap_test_audit_fault()");
    }
  });
});

async function populatedSharedFixture() {
  const { owner, boss } = await unrelatedFixture();
  await runFleetSharingMode(ctx.db, options());
  const paired = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  expect(
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: paired.sessionId,
      revision: 1,
      now: NOW,
      capabilities: [SHARED_CAPABILITY],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await setFleetParticipation(ctx.db, {
      sessionId: paired.sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 500),
      enabled: true,
      expectedGeneration: 0,
    }),
  ).toMatchObject({ ok: true });
  const source = await seedLifecycleSource(ctx.db, {
    boss,
    deviceId: paired.device.id,
    now: NOW,
  });
  await seedLifecycleProjection(ctx.db, {
    participant: boss,
    source,
    deviceId: paired.device.id,
    sessionId: paired.sessionId,
    now: NOW,
  });
  await ctx.db
    .update(fleetSourceIntent)
    .set({ nextFetchAt: NOW })
    .where(eq(fleetSourceIntent.id, source.id));
  const ticket = await claimFleetSourceFetch(
    ctx.db,
    { sourceId: source.id, generation: 1 },
    () => NOW,
  );
  expect(ticket).not.toBeNull();
  await ctx.db.insert(fleetEligibility).values({
    characterId: boss.id,
    accountId: owner.id,
    fleetId: 123,
    verifiedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60000),
    outcomeCode: "ok",
  });
  await ctx.db
    .insert(fleetDeviceKeyIdentity)
    .values({ canonicalSpkiB64: "retained-tombstone", deviceId: null });
  return { owner, boss, paired, source, ticket: ticket! };
}

describe("explicit safe operator disable", () => {
  // Refuse unsafe isolation before the mode SELECT, without waiting for pairing
  // or silently overriding the inherited snapshot, in both service and CLI.
  it.each(["repeatable read", "serializable"] as const)(
    "refuses service disable under inherited isolation %s without draining or auditing",
    async (isolationLevel) => {
      await populatedSharedFixture();
      const before = await snapshot();
      await expect(
        ctx.db.transaction(
          (tx) => transitionFleetSharingMode(tx, { enabled: false, expectedRevision: 1 }),
          { isolationLevel },
        ),
      ).rejects.toThrow("mode_read_committed_required");
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([false, true])(
    "handles pairing completion committed during disable admission (repeatable snapshot=%s)",
    async (repeatable) => {
      const p = await populatedSharedFixture();
      const held = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const pairing = ctx.db.transaction(async (tx) => {
        const paired = await pairDevice(tx, p.owner.id, NOW, [SHARED_CAPABILITY]);
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        held.resolve(pid.rows[0].pid);
        await release.promise;
        return paired;
      });
      void pairing.catch(held.reject);
      let disable: Promise<unknown> | undefined;
      try {
        const pid = await held.promise;
        // The compatible service has created a new device/session but still holds
        // SH mode. Gate revision stays 1, so revision conflict cannot save RR.
        expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
        const transition = () =>
          repeatable
            ? ctx.db.transaction(
                (tx) =>
                  transitionFleetSharingMode(tx, { enabled: false, expectedRevision: 1 }),
                { isolationLevel: "repeatable read" },
              )
            : transitionFleetSharingMode(ctx.db, { enabled: false, expectedRevision: 1 });
        disable = Promise.allSettled([transition()]);
        const blocked = await waitUntilBlockedBy(ctx.pool, pid);
        release.resolve();
        const paired = await pairing;
        const outcome = await disable;
        const gate = await readFleetKeyIdentityState(ctx.db);
        const sessions = await ctx.db.select().from(fleetDeviceSession);
        expect({
          blocked,
          outcome,
          gate,
          sessions,
          sessionCount: sessions.length,
        }).toMatchObject(
          repeatable
            ? {
                blocked: false,
                outcome: [
                  {
                    status: "rejected",
                    reason: { message: "mode_read_committed_required" },
                  },
                ],
                gate: { enabled: true, revision: 1 },
                sessionCount: 2,
                sessions: expect.arrayContaining([
                  expect.objectContaining({ deviceId: paired.device.id }),
                ]),
              }
            : {
                blocked: true,
                outcome: [
                  { status: "fulfilled", value: { enabled: false, revision: 2 } },
                ],
                gate: { enabled: false, revision: 2 },
                sessionCount: 0,
                sessions: [],
              },
        );
        expect(sessions).toHaveLength(repeatable ? 2 : 0);
        expect(await ctx.db.select().from(fleetDevice)).toHaveLength(2);
        for (const table of [fleetPublisherLease, fleetTelemetryRow, fleetEligibility])
          expect(await ctx.db.select().from(table)).toHaveLength(repeatable ? 1 : 0);
        expect(await ctx.db.select().from(fleetSourceIntent)).toMatchObject([
          repeatable
            ? { state: "active", generation: 1 }
            : { state: "ended", generation: 2, terminalReason: "mode_transition" },
        ]);
        expect(await ctx.db.select().from(fleetSourceAuthority)).toMatchObject([
          repeatable
            ? { sourceId: p.source.id, authorityGeneration: 7 }
            : { sourceId: null, authorityGeneration: 8 },
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([pairing, disable]);
      }
    },
  );

  // A pass-through pause, not fabricated database results: the other connection
  // runs the real disable transaction before or after the preview's first read.
  // Autocommit/READ COMMITTED mixes revision 1 with drained counts and fails.
  it.each([false, true])(
    "disable preview is one bounded read-only snapshot around a concurrent writer (writer before first read=%s), and stale apply refuses",
    async (writerFirst) => {
      await populatedSharedFixture();
      const read = sharingMode.readFleetSharingMode;
      let settings: unknown;
      const writer = () => runFleetSharingMode(ctx.db, options(true, 1, "--disable"));
      const probe = vi
        .spyOn(sharingMode, "readFleetSharingMode")
        .mockImplementationOnce(async (db) => {
          if (writerFirst) await writer();
          const current = await read(db);
          settings = (
            await db.execute(
              sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only, current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout`,
            )
          ).rows;
          if (!writerFirst) await writer();
          return current;
        });
      try {
        const dry = await runFleetSharingMode(ctx.db, options(false, 1, "--disable"));
        expect(dry).toMatchObject({
          dryRun: true,
          current: { enabled: !writerFirst, revision: writerFirst ? 2 : 1 },
          sessionsToRetire: writerFirst ? 0 : 1,
          legacyEligibilityToDelete: writerFirst ? 0 : 1,
          telemetryToDelete: writerFirst ? 0 : 1,
          releaseReady: !writerFirst,
          revisionMatches: !writerFirst,
          refusal: writerFirst ? "conflict" : null,
        });
        expect(settings).toEqual([
          {
            isolation: "repeatable read",
            read_only: "on",
            lock_timeout: "2s",
            statement_timeout: "5s",
          },
        ]);
        const afterWriter = await snapshot();
        await expect(
          runFleetSharingMode(ctx.db, options(true, 1, "--disable")),
        ).rejects.toThrow("conflict");
        expect(await snapshot()).toEqual(afterWriter);
        expect(
          await runFleetSharingMode(ctx.db, options(false, 1, "--disable")),
        ).toMatchObject({
          current: { enabled: false, revision: 2 },
          sessionsToRetire: 0,
          legacyEligibilityToDelete: 0,
          telemetryToDelete: 0,
          releaseReady: false,
          refusal: "conflict",
        });
      } finally {
        probe.mockRestore();
      }
    },
  );

  it("drains fleet state, ends consent and fences late observations while preserving registrations/preferences/SSO/browser sessions", async () => {
    const p = await populatedSharedFixture();
    const before = await snapshot();
    expect(
      await runFleetSharingMode(ctx.db, options(false, 1, "--disable")),
    ).toMatchObject({
      dryRun: true,
      releaseReady: true,
      refusal: null,
      sessionsToRetire: 1,
      legacyEligibilityToDelete: 1,
      telemetryToDelete: 1,
    });
    expect(await snapshot()).toEqual(before);
    await expect(
      runFleetSharingMode(ctx.db, options(true, 0, "--disable")),
    ).rejects.toThrow("conflict");
    expect(await snapshot()).toEqual(before);
    expect(
      await runFleetSharingMode(ctx.db, options(true, 1, "--disable")),
    ).toMatchObject({ enabled: false, revision: 2 });
    expect(await readFleetKeyIdentityState(ctx.db)).toMatchObject({
      enabled: false,
      revision: 2,
      keyIdentityPhase: "ready",
      keyIdentityCursor: null,
    });
    for (const table of [
      fleetDeviceSession,
      fleetPublisherLease,
      fleetTelemetryRow,
      fleetEligibility,
    ])
      expect(await ctx.db.select().from(table)).toEqual([]);
    for (const table of [
      account,
      character,
      session,
      fleetAccessCheckGate,
      fleetDevice,
      fleetDeviceKeyIdentity,
      fleetPairingRequest,
    ])
      expect(await ctx.db.select().from(table)).toEqual(before[getTableName(table)]);
    expect(await ctx.db.select().from(fleetSourceIntent)).toMatchObject([
      {
        state: "ended",
        generation: 2,
        fetchGeneration: 2,
        terminalReason: "mode_transition",
      },
    ]);
    expect(await ctx.db.select().from(fleetSourceAuthority)).toMatchObject([
      {
        sourceId: null,
        sourceGeneration: null,
        authorityGeneration: 8,
        linkedCharacters: [],
        verifiedAt: null,
        expiresAt: null,
      },
    ]);
    const drained = await snapshot();
    await commitFleetSourceObservation(
      ctx.db,
      {
        ...p.ticket,
        fleetId: 123,
        expectedAuthorityGeneration: 7,
        accessTokenExpiresAt: new Date(NOW.getTime() + 60000),
        linkedCharacters: [{ characterId: p.boss.id, linkEpoch: p.boss.fleetLinkEpoch }],
      },
      p.boss.refreshTokenEnc!,
      {
        kind: "verified",
        evidence: {
          observedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 5000),
          nextFetchAt: new Date(NOW.getTime() + 5000),
        },
        memberIds: [p.boss.id],
        nextFetchAt: new Date(NOW.getTime() + 5000),
      },
      () => NOW,
    );
    expect(await snapshot()).toEqual(drained);
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.paired.sessionId,
        revision: 3,
        now: new Date(NOW.getTime() + 1000),
        rows: [{ characterId: p.boss.id, dps: 42, ewar: [] }],
      }),
    ).toEqual({ ok: false, code: "invalid_session" });
  });

  it.each(["gate", "audit"])(
    "disable rolls back the complete drain on %s failure",
    async (kind) => {
      await populatedSharedFixture();
      const before = await snapshot();
      await expect(
        withInjectedPgFault(
          ctx.pool,
          {
            matchSql:
              kind === "gate"
                ? /insert into "fleet_sharing_gate"/i
                : /insert into "audit_log"/i,
            code: "40001",
          },
          () => runFleetSharingMode(ctx.db, options(true, 1, "--disable")),
        ),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
});
