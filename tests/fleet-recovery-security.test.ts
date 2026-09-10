import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  fleetDevice,
  fleetRecoveryChallenge,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
} from "@/db/schema";
import {
  beginFleetRecovery,
  completeFleetRecovery,
  purgeExpiredFleetRecovery,
} from "@/services/fleet-recovery";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
import {
  fleetKeyPair,
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import { recoveryCompletion, recoveryInitiation } from "./helpers/fleet-recovery";

async function enableReady() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
}
const NOW = new Date("2026-09-07T12:00:00.000Z");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await truncateAll(ctx.db);
});

it("recovers the original alias-only legacy binding with independently canonical proof", async () => {
  const keys = fleetKeyPair();
  const alias = {
    ...keys,
    publicKeySpki: Buffer.concat([Buffer.from(keys.publicKeySpki), Buffer.from([0])]),
  };
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW, [], alias);
  await enableReady();
  for (const spelling of [keys, alias]) {
    const c = await beginFleetRecovery(ctx.db, recoveryInitiation(spelling, NOW));
    expect(
      await completeFleetRecovery(ctx.db, recoveryCompletion(spelling, c, NOW)),
    ).toMatchObject({
      ok: true,
      value: { result: "reconnected", deviceId: paired.device.id },
    });
  }
  expect(await ctx.db.select().from(fleetDevice)).toEqual([paired.device]);
});

it("public-key-only and signed unregistered-key floods allocate zero; rightful signer remains usable", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  for (let i = 0; i < 8; i++) {
    await expect(
      beginFleetRecovery(ctx.db, {
        ...recoveryInitiation(paired, NOW),
        initiationSignature: "A".repeat(86),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      beginFleetRecovery(ctx.db, recoveryInitiation(fleetKeyPair(), NOW)),
    ).rejects.toMatchObject({ code: "unauthorized" });
  }
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
  const c = await beginFleetRecovery(ctx.db, recoveryInitiation(paired, NOW));
  expect(
    await completeFleetRecovery(ctx.db, recoveryCompletion(paired, c, NOW)),
  ).toMatchObject({
    ok: true,
    value: { result: "reconnected", deviceId: paired.device.id },
  });
});

it("invalid completion floods leave every challenge field unchanged and cannot exhaust the signer", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  const c = await beginFleetRecovery(ctx.db, recoveryInitiation(paired, NOW));
  const before = await ctx.db.select().from(fleetRecoveryChallenge);
  for (let i = 0; i < 8; i++)
    expect(
      await completeFleetRecovery(ctx.db, {
        ...recoveryCompletion(paired, c, NOW),
        recoverySignature: "A".repeat(86),
      }),
    ).toEqual({ ok: false, code: "unauthorized" });
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual(before);
  expect(
    await completeFleetRecovery(ctx.db, recoveryCompletion(paired, c, NOW)),
  ).toMatchObject({ ok: true, value: { result: "reconnected" } });
});

it("legacy null initiation fields cannot authorize completion or change the challenge", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const keys = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  const c = await beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW));
  await ctx.db
    .update(fleetRecoveryChallenge)
    .set({ requestId: null, requestIssuedAt: null })
    .where(eq(fleetRecoveryChallenge.id, c.challengeId));
  const before = await ctx.db.select().from(fleetRecoveryChallenge);
  expect(await completeFleetRecovery(ctx.db, recoveryCompletion(keys, c, NOW))).toEqual({
    ok: false,
    code: "unauthorized",
  });
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual(before);
});

it("requires expired recovery backlog cleanup before enabling, without draining new legacy sessions", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const keys = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  await beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW));
  await transitionFleetSharingMode(ctx.db, {
    enabled: false,
    expectedRevision: 3,
    now: NOW,
  });
  await pairDevice(ctx.db, owner.id, NOW, [], keys);
  const sessions = await ctx.db.select().from(fleetDeviceSession);
  const expired = new Date(NOW.getTime() + 120000);
  await expect(
    transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: 4,
      now: expired,
    }),
  ).rejects.toThrow("recovery_cleanup_required");
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessions);
  expect(await purgeExpiredFleetRecovery(ctx.db, expired)).toBe(1);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: 4,
    now: expired,
  });
});

it("returns the identical usable challenge at full per-key quota; consumed and expired initiation never resets", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  const init = recoveryInitiation(paired, NOW);
  const c = await beginFleetRecovery(ctx.db, init);
  for (let i = 0; i < 3; i++)
    await beginFleetRecovery(ctx.db, recoveryInitiation(paired, NOW));
  const rows = await ctx.db.select().from(fleetRecoveryChallenge);
  expect(await beginFleetRecovery(ctx.db, init)).toEqual(c);
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual(rows);
  await expect(
    beginFleetRecovery(
      ctx.db,
      recoveryInitiation(paired, new Date(NOW.getTime() + 1), init.requestId),
    ),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(
    await completeFleetRecovery(ctx.db, recoveryCompletion(paired, c, NOW)),
  ).toMatchObject({ ok: true, value: { result: "reconnected" } });
  await expect(beginFleetRecovery(ctx.db, init)).rejects.toMatchObject({
    code: "unauthorized",
  });
  await expect(
    beginFleetRecovery(ctx.db, { ...init, now: new Date(NOW.getTime() + 60000) }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(await purgeExpiredFleetRecovery(ctx.db, new Date(NOW.getTime() + 120000))).toBe(
    4,
  );
  await expect(
    beginFleetRecovery(ctx.db, { ...init, now: new Date(NOW.getTime() + 120000) }),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
});

it.each([
  "origin",
  "purpose",
  "request-id",
  "timestamp",
  "future",
  "deadline",
  "noncanonical-id",
  "noncanonical-signature",
])(
  "invalid initiation %s is uniformly unauthorized without any index or capacity writes",
  async (kind) => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, owner.id, NOW);
    await enableReady();
    const index = await ctx.db.select().from(fleetDeviceKeyIdentity);
    for (const keys of [paired, fleetKeyPair()]) {
      const args = recoveryInitiation(
        keys,
        NOW,
        undefined,
        kind === "origin" ? "https://attacker.example" : undefined,
      );
      if (kind === "purpose")
        args.initiationSignature = recoveryCompletion(
          keys,
          { challengeId: args.requestId, nonce: args.requestId },
          NOW,
        ).recoverySignature;
      if (kind === "request-id") args.requestId = "A".repeat(43);
      if (kind === "timestamp") args.issuedAt = "2026-09-07T12:00:00Z";
      if (kind === "future") args.now = new Date(NOW.getTime() - 60001);
      if (kind === "deadline") args.now = new Date(NOW.getTime() + 60000);
      if (kind === "noncanonical-id") args.requestId = "A".repeat(42) + "B";
      if (kind === "noncanonical-signature")
        args.initiationSignature = args.initiationSignature.slice(0, 85) + "B";
      await expect(beginFleetRecovery(ctx.db, args)).rejects.toMatchObject({
        code: "unauthorized",
      });
    }
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
    expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toEqual(index);
  },
);

it("verifies before canonical-key locks and registered admission; invalid callers cannot wait there", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  const client = await ctx.pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(5, hashtext($1))", [
      Buffer.from(paired.publicKeySpki).toString("base64"),
    ]);
    await client.query("select pg_advisory_xact_lock(4, 0)");
    await expect(
      beginFleetRecovery(ctx.db, {
        ...recoveryInitiation(paired, NOW),
        initiationSignature: "A".repeat(86),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      beginFleetRecovery(ctx.db, recoveryInitiation(fleetKeyPair(), NOW)),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
  } finally {
    await client.query("rollback");
    client.release();
  }
});

it("rechecks exclusive initiation freshness after global admission wait using DB time", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW);
  await enableReady();
  const client = await ctx.pool.connect();
  let pending: ReturnType<typeof beginFleetRecovery> | undefined;
  try {
    await client.query("begin");
    const {
      rows: [{ pid }],
    } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    await client.query("select pg_advisory_xact_lock(4, 0)");
    const init = recoveryInitiation(paired, new Date(Date.now() - 59000));
    pending = beginFleetRecovery(ctx.db, { ...init, now: undefined });
    // Attach rejection handling before intentionally holding the database wait.
    const outcome = pending.then(
      () => "allocated",
      (err: unknown) => err,
    );
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    await client.query("select pg_sleep(1.1)");
    await client.query("commit");
    expect(await outcome).toMatchObject({ code: "unauthorized" });
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
  } finally {
    await client.query("rollback");
    client.release();
    await pending?.catch(() => {});
  }
});
