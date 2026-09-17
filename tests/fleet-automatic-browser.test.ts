import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  session,
  auditLog,
  account,
  fleetDevice,
  fleetSourceIntent,
} from "@/db/schema";
import type { AutomaticOff } from "@/core/fleet-automatic";
import {
  turnOffFleetAutomaticForBrowser,
  readFleetAutomaticForBrowser,
} from "@/services/fleet-automatic";
import { createSession, endSession } from "@/services/session";
import { getConfig } from "@/config";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  waitUntilBlockedBy,
  pairDevice,
  reconcileFleetKeys,
} from "./helpers/fleet-sharing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";

process.env.DATABASE_URL = TEST_URL;
let cookie = "";
let origin: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }),
  headers: async () => new Headers(origin === null ? {} : { origin }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected:${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { turnOffFleetAutomaticAction, revokeFleetDeviceAction } =
  await import("@/app/account/fleet-devices/actions");
const { revalidatePath } = await import("next/cache");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  cookie = "";
  origin = new URL(getConfig().appBaseUrl).origin;
  vi.mocked(revalidatePath).mockClear();
});
afterAll(() => ctx.cleanup());
async function setup() {
  const owner = await seedAccount(ctx.db, { tier: "alumni" });
  cookie = await createSession(ctx.db, owner.id);
  const now = new Date(Date.now() - 2000);
  await ctx.db.insert(fleetAutomaticConsent).values({
    accountId: owner.id,
    generation: 1,
    revision: 1,
    enabled: true,
    approvingDeviceId: randomUUID(),
    approvedAt: now,
    nextReconcileAt: now,
  });
  const command: AutomaticOff = {
    protocol: 2,
    enabled: false,
    request_id: randomUUID(),
    intent_created_at: "2000-01-01T00:00:00.000Z",
    expected_generation: 1,
    expected_revision: 1,
  };
  return { owner, command, auth: { accountId: owner.id, browserSessionId: cookie } };
}
it("browser Off works with no fleet sessions, non-Member, disabled mode and deleted approver", async () => {
  const p = await setup();
  const result = await turnOffFleetAutomaticAction(p.command);
  expect(result).toMatchObject({
    ok: true,
    request_id: p.command.request_id,
    result: "applied",
    status: {
      approver: "revoked",
      readiness: "off",
      consent: { generation: 1, revision: 2, enabled: false },
    },
  });
  expect((await ctx.db.select().from(fleetAutomaticReceipt))[0].receipt.command).toEqual(
    p.command,
  );
  expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/account/fleet-devices");
  expect(JSON.stringify(await ctx.db.select().from(auditLog))).not.toContain(cookie);
  expect(await turnOffFleetAutomaticAction(p.command)).toMatchObject({
    ok: true,
    result: "replayed",
  });
});
it.each([
  null,
  "null",
  "https://foreign.example",
  "https://authgd.example/path",
  "https://authgd.example, https://foreign.example",
])("Origin %s refuses before service mutation", async (value) => {
  const p = await setup();
  origin = value;
  expect(await turnOffFleetAutomaticAction(p.command)).toMatchObject({
    ok: false,
    status: null,
  });
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
  expect(revalidatePath).not.toHaveBeenCalled();
});
it.each(["enabled", "extra", "proto", "bool", "oversize"])(
  "untrusted %s input is malformed, never selects a receipt",
  async (kind) => {
    const p = await setup();
    const input: Record<string, unknown> = { ...p.command };
    if (kind === "enabled") input.enabled = true;
    if (kind === "extra") input.accountId = p.owner.id;
    if (kind === "proto")
      Object.defineProperty(input, "__proto__", { value: 1, enumerable: true });
    if (kind === "bool") input.expected_generation = true;
    if (kind === "oversize") input.request_id = "x".repeat(2049);
    expect(await turnOffFleetAutomaticAction(input)).toEqual({
      ok: false,
      request_id: null,
      error: "bad_request",
      status: null,
    });
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
  },
);
it("browser conflicting Off returns own current status; future intent returns none", async () => {
  const p = await setup();
  expect(
    await turnOffFleetAutomaticAction({ ...p.command, expected_revision: 0 }),
  ).toMatchObject({
    ok: false,
    error: "conflict",
    status: { consent: { enabled: true, generation: 1 } },
  });
  expect(
    await turnOffFleetAutomaticAction({
      ...p.command,
      intent_created_at: "9999-01-01T00:00:00.000Z",
    }),
  ).toMatchObject({ ok: false, error: "invalid_intent", status: null });
  expect(revalidatePath).not.toHaveBeenCalled();
});
it("browser read is read-only, not a lastSeen writing probe", async () => {
  const p = await setup();
  const before = await ctx.db.select().from(session);
  expect(await readFleetAutomaticForBrowser(ctx.db, p.auth)).toMatchObject({
    consent: { enabled: true },
  });
  expect(await ctx.db.select().from(session)).toEqual(before);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
});
it("browser cookie/account mismatch never reveals foreign status", async () => {
  const p = await setup();
  const other = await seedAccount(ctx.db);
  expect(
    await turnOffFleetAutomaticForBrowser(
      ctx.db,
      { ...p.auth, accountId: other.id },
      p.command,
    ),
  ).toEqual({
    ok: false,
    request_id: p.command.request_id,
    error: "unauthorized",
    status: null,
  });
  await endSession(ctx.db, cookie);
  expect(await turnOffFleetAutomaticForBrowser(ctx.db, p.auth, p.command)).toMatchObject({
    ok: false,
    error: "unauthorized",
    status: null,
  });
});
it("actual revoke action samples DB time after account wait and closes a newer approval", async () => {
  const p = await setup();
  const ready = await reconcileFleetKeys(ctx.db);
  const now = new Date(Date.now() - 1000);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now,
  });
  await ctx.db.update(account).set({ tier: "member" }).where(eq(account.id, p.owner.id));
  const device = await pairDevice(ctx.db, p.owner.id, now, ["shared-source-v1"]);
  await ctx.db.update(fleetAutomaticConsent).set({ approvingDeviceId: device.device.id });
  const holder = await ctx.pool.connect();
  let work: Promise<unknown> | undefined;
  try {
    await holder.query("begin");
    await holder.query("select id from account where id=$1 for update", [p.owner.id]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    // Capture the framework redirect as an outcome, not an unhandled rejection.
    work = revokeFleetDeviceAction(device.device.id).catch((err: unknown) => err);
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    await holder.query("select pg_sleep(0.01)");
    await holder.query(
      "update fleet_automatic_consent set generation=2, revision=2, approved_at=date_trunc('milliseconds', clock_timestamp()) where account_id=$1",
      [p.owner.id],
    );
    await holder.query("commit");
    expect(await work).toBeInstanceOf(Error);
    expect(String(await work)).toContain("done=revoke");
  } finally {
    await holder.query("rollback");
    holder.release();
    if (work) await work;
  }
  const [consent] = await ctx.db.select().from(fleetAutomaticConsent);
  expect(consent).toMatchObject({
    generation: 2,
    revision: 3,
    enabled: false,
    closedReason: "approver_revoked",
  });
  expect(consent.disabledAt!.getTime()).toBeGreaterThanOrEqual(
    consent.approvedAt.getTime(),
  );
  expect((await ctx.db.select().from(fleetDevice))[0].revokedAt).not.toBeNull();
});
it.each(
  ["uppercase", "mixedcase"].flatMap((spelling) =>
    ["zero", "live", "replacement"].map((state) => ({ spelling, state })),
  ),
)(
  "actual revoke action accepts $spelling identity with $state sources",
  async ({ spelling, state }) => {
    const p = await setup();
    const ready = await reconcileFleetKeys(ctx.db);
    const now = new Date(Date.now() - 1000);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now,
    });
    await ctx.db
      .update(account)
      .set({ tier: "member" })
      .where(eq(account.id, p.owner.id));
    const old = await pairDevice(ctx.db, p.owner.id, now, ["shared-source-v1"]);
    const replacement =
      state === "replacement"
        ? await pairDevice(ctx.db, p.owner.id, now, ["shared-source-v1"])
        : null;
    await ctx.db.update(fleetAutomaticConsent).set({
      approvingDeviceId: replacement?.device.id ?? old.device.id,
      generation: replacement ? 2 : 1,
      revision: replacement ? 2 : 1,
    });
    const boss = await seedCharacter(ctx.db, testConfig(), {
      id: 99001,
      accountId: p.owner.id,
      scopes: [FLEET_READ_SCOPE],
    });
    // Explicit source storage only; the action must withdraw it regardless of
    // whether any worker has produced positive authority yet.
    const sources =
      state === "zero"
        ? []
        : await ctx.db
            .insert(fleetSourceIntent)
            .values(
              [
                {
                  id: randomUUID(),
                  accountId: p.owner.id,
                  deviceId: old.device.id,
                  generation: 1,
                  state: "pending" as const,
                  intentCreatedAt: now,
                  intentExpiresAt: new Date(now.getTime() + 60000),
                  retainUntil: new Date(now.getTime() + 86460000),
                },
                {
                  id: randomUUID(),
                  accountId: p.owner.id,
                  deviceId: old.device.id,
                  generation: 1,
                  state: "pending" as const,
                  intentCreatedAt: now,
                  intentExpiresAt: new Date(now.getTime() + 60000),
                  retainUntil: new Date(now.getTime() + 86460000),
                  automaticConsentAccountId: p.owner.id,
                  automaticConsentGeneration: 1,
                },
                ...(replacement
                  ? [
                      {
                        id: randomUUID(),
                        accountId: p.owner.id,
                        deviceId: replacement.device.id,
                        generation: 1,
                        state: "pending" as const,
                        intentCreatedAt: now,
                        intentExpiresAt: new Date(now.getTime() + 60000),
                        retainUntil: new Date(now.getTime() + 86460000),
                        automaticConsentAccountId: p.owner.id,
                        automaticConsentGeneration: 2,
                      },
                    ]
                  : []),
              ].map((source) => ({
                ...source,
                bossCharacterId: boss.id,
                bossOwnerHash: boss.ownerHash,
                bossLinkEpoch: boss.fleetLinkEpoch,
              })),
            )
            .returning();
    const input =
      spelling === "uppercase"
        ? old.device.id.toUpperCase()
        : old.device.id.replace(/[a-f]/, (ch) => ch.toUpperCase());
    expect(input).not.toBe(old.device.id);
    const beforeReceipts = await ctx.db.select().from(fleetAutomaticReceipt);
    await expect(revokeFleetDeviceAction(input)).rejects.toThrow("done=revoke");
    const [consent] = await ctx.db.select().from(fleetAutomaticConsent);
    expect(consent).toMatchObject({
      enabled: !!replacement,
      generation: replacement ? 2 : 1,
      revision: 2,
      approvingDeviceId: replacement?.device.id ?? old.device.id,
      closedReason: replacement ? null : "approver_revoked",
    });
    // R is the durable enabled bit; revocation releases it, never mints an Off receipt.
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toEqual(beforeReceipts);
    expect(beforeReceipts.length + Number(consent.enabled)).toBe(replacement ? 1 : 0);
    const after = await ctx.db.select().from(fleetSourceIntent);
    for (const source of sources) {
      const current = after.find((s) => s.id === source.id);
      if (source.deviceId === old.device.id)
        expect(current).toMatchObject({
          state: "ended",
          generation: 2,
          fetchGeneration: 1,
        });
      else expect(current).toEqual(source);
    }
    expect(
      (
        await ctx.db.select().from(fleetDevice).where(eq(fleetDevice.id, old.device.id))
      )[0].revokedAt,
    ).not.toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/account/fleet-devices");
  },
);

it.each(["logout", "expiry", "rebound"])(
  "browser %s during account wait cannot authorize stale Off",
  async (race) => {
    const p = await setup();
    const other = await seedAccount(ctx.db);
    const holder = await ctx.pool.connect();
    let work: ReturnType<typeof turnOffFleetAutomaticForBrowser> | undefined;
    let now = new Date();
    try {
      await holder.query("begin");
      await holder.query("select id from account where id=$1 for update", [p.owner.id]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      work = turnOffFleetAutomaticForBrowser(ctx.db, p.auth, p.command, () => now);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      const key = createHash("sha256").update(cookie).digest("base64url");
      if (race === "logout") await holder.query("delete from session where id=$1", [key]);
      if (race === "rebound")
        await holder.query("update session set account_id=$1 where id=$2", [
          other.id,
          key,
        ]);
      if (race === "expiry") now = new Date(Date.now() + 31 * 86400000);
      await holder.query("commit");
      expect(await work).toEqual({
        ok: false,
        request_id: p.command.request_id,
        error: "unauthorized",
        status: null,
      });
    } finally {
      await holder.query("rollback");
      holder.release();
      if (work) await work;
    }
    expect(
      (
        await ctx.db
          .select()
          .from(fleetAutomaticConsent)
          .where(eq(fleetAutomaticConsent.accountId, p.owner.id))
      )[0].enabled,
    ).toBe(true);
  },
);
