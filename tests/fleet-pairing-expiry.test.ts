import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  fleetDevice,
  fleetDeviceSession,
  fleetPairingRequest,
} from "@/db/schema";
import {
  approvePairing,
  beginPairing,
  PairingExpiredError,
} from "@/services/fleet-pairing";
import { readFleetKeyIdentityState } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
import {
  fleetKeyPair,
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

describe.each([
  ["pending", "account"],
  ["ready", "account"],
  ["ready", "device"],
] as const)("%s approval expiry after %s lock", (phase, lock) => {
  it.each([true, false])(
    "rechecks persisted expiry after all locks (expired=%s)",
    async (expire) => {
      if (phase === "ready") await reconcileFleetKeys(ctx.db);
      expect((await readFleetKeyIdentityState(ctx.db)).keyIdentityPhase).toBe(phase);
      const account = await seedAccount(ctx.db, { tier: "member" });
      const keys = fleetKeyPair();
      const paired =
        lock === "device"
          ? await pairDevice(ctx.db, account.id, new Date(), [], keys)
          : undefined;
      const { pairingId } = await beginPairing(ctx.db, {
        publicKeySpki: keys.publicKeySpki,
      });
      const devicesBefore = await ctx.db.select().from(fleetDevice);
      const sessionsBefore = await ctx.db.select().from(fleetDeviceSession);
      const holder = await ctx.pool.connect();
      let pending: Promise<void> | undefined;
      try {
        await holder.query("begin");
        const pid = (
          await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0].pid;
        if (paired)
          await holder.query("select id from fleet_device where id = $1 for update", [
            paired.device.id,
          ]);
        else
          await holder.query("select id from account where id = $1 for update", [
            account.id,
          ]);
        await ctx.db
          .update(fleetPairingRequest)
          .set({
            expiresAt: expire
              ? sql`clock_timestamp() + interval '2 seconds'`
              : sql`clock_timestamp() + interval '60 seconds'`,
          })
          .where(eq(fleetPairingRequest.id, pairingId));
        const [before] = await ctx.db
          .select()
          .from(fleetPairingRequest)
          .where(eq(fleetPairingRequest.id, pairingId));
        const auditBefore = await ctx.db.select().from(auditLog);
        pending = approvePairing(ctx.db, pairingId, account.id);
        void pending.catch(() => {}); // Own the rejection while the real waiter is held.
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        if (expire) {
          // Wait against the persisted deadline, not an app-clock guess. The
          // request row is already locked by approval; nobody rewrites its TTL.
          await holder.query(
            "select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))))",
            [before.expiresAt],
          );
        }
        const afterWait = (
          await holder.query<{ now: Date }>("select clock_timestamp() as now")
        ).rows[0].now;
        expect(afterWait >= before.expiresAt).toBe(expire);
        await holder.query("rollback");
        if (expire) await expect(pending).rejects.toBeInstanceOf(PairingExpiredError);
        else await expect(pending).resolves.toBeUndefined();
        const [after] = await ctx.db
          .select()
          .from(fleetPairingRequest)
          .where(eq(fleetPairingRequest.id, pairingId));
        if (expire) {
          expect(after).toEqual(before);
          expect(await ctx.db.select().from(auditLog)).toEqual(auditBefore);
        } else {
          expect(after.approvedAccountId).toBe(account.id);
          expect(after.approvedAt!.getTime()).toBeGreaterThanOrEqual(afterWait.getTime());
          expect(after.approvedAt!.getTime()).toBeLessThan(before.expiresAt.getTime());
          expect(
            (await ctx.db.select().from(auditLog)).filter(
              (row) =>
                row.action === "fleet_device.pairing_approved" &&
                row.target === pairingId,
            ),
          ).toHaveLength(1);
        }
        expect(await ctx.db.select().from(fleetDevice)).toEqual(devicesBefore);
        expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessionsBefore);
      } finally {
        try {
          await holder.query("rollback");
        } finally {
          holder.release();
          await pending?.catch(() => {});
        }
      }
    },
  );
});
