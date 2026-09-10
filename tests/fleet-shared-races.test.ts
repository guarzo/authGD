import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { character, fleetTelemetryRow } from "@/db/schema";
import { readDeviceEligibility } from "@/services/fleet-eligibility";
import { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay";
import { controlFleetSource } from "@/services/fleet-source";
import { setFleetParticipation } from "@/services/fleet-participation";
import { setTierManual } from "@/services/admin-accounts";
import { fleetLifecycleTransaction } from "@/services/fleet-lifecycle";
import { unlinkCharacter, linkCharacter } from "@/services/accounts";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { cleanupFleetSources } from "@/services/fleet-source-maintenance";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { waitUntilBlockedBy } from "./helpers/fleet-sharing";
import {
  at,
  participatingDevice,
  realSource,
  sharedAccounts,
} from "./helpers/fleet-shared-admission";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
type Fixture = Awaited<ReturnType<typeof sharedAccounts>>;
const losses = [
  "Off",
  "Stop",
  "Member",
  "source Member",
  "unlink",
  "participant revoke",
  "initiator revoke",
  "expiry",
] as const;
type Loss = (typeof losses)[number];
async function invalidate(p: Fixture, loss: Loss) {
  if (loss === "Off")
    expect(
      (
        await setFleetParticipation(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 20,
          enabled: false,
          expectedGeneration: 1,
          now: at(3500),
        })
      ).ok,
    ).toBe(true);
  else if (loss === "Stop")
    expect(
      (
        await controlFleetSource(ctx.db, {
          sessionId: p.a.sessionId,
          revision: 20,
          now: at(3500),
          command: {
            operation: "stop",
            sourceId: p.source.sourceId,
            expectedGeneration: 1,
          },
        })
      ).ok,
    ).toBe(true);
  else if (loss === "Member" || loss === "source Member")
    await fleetLifecycleTransaction(ctx.db, (tx) =>
      setTierManual(
        tx,
        "system",
        loss === "Member" ? p.participant.id : p.owner.id,
        "alumni",
      ),
    );
  else if (loss === "unlink")
    expect(
      await fleetLifecycleTransaction(ctx.db, (tx) =>
        unlinkCharacter(tx, testConfig(), p.participant.id, p.alts[0].id),
      ),
    ).toEqual({ ok: true });
  else if (loss === "participant revoke" || loss === "initiator revoke") {
    const device = loss === "participant revoke" ? p.b : p.a;
    await revokeFleetDevice(ctx.db, device.device.id, device.device.accountId, at(3500));
  } else await cleanupFleetSources(ctx.db, () => at(12000));
}
const cases = losses.flatMap((loss) =>
  (["publish", "read", "quiet read", "eligibility"] as const).flatMap((kind) =>
    (["admission first", "invalidation first"] as const).map((order) => ({
      loss,
      kind,
      order,
    })),
  ),
);
it.each(cases)(
  "real PG $kind versus $loss: $order, with a successful real admission baseline",
  async ({ loss, kind, order }) => {
    const p = await sharedAccounts(ctx.db);
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(2500),
        rows: [{ characterId: p.alts[0].id, dps: 77, ewar: [] }],
      }),
    ).toEqual({ ok: true });
    const baseline = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 4,
      now: at(2500),
    });
    expect(baseline.ok && baseline.rows.map((r) => r.characterId)).toEqual([
      p.alts[0].id,
    ]);
    const call = {
      sessionId: kind === "quiet read" ? p.a.sessionId : p.b.sessionId,
      revision: kind === "quiet read" ? 5 : 4,
      now: at(3000),
    };
    const admit = () =>
      kind === "publish"
        ? replaceDeviceProjection(ctx.db, {
            ...call,
            rows: [{ characterId: p.alts[0].id, dps: 88, ewar: [] }],
          })
        : kind === "read" || kind === "quiet read"
          ? readFleetProjection(ctx.db, call)
          : readDeviceEligibility(ctx.db, call);
    const holder = await ctx.pool.connect();
    let admission: ReturnType<typeof admit> | undefined;
    let invalidation: Promise<void> | undefined;
    try {
      await holder.query("begin");
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      // Admission's final lock (eligibility has no relay rows) or cleanup's final
      // relay lock holds the earlier real transaction open, not a fabricated sleep.
      await holder.query(
        order === "admission first" && kind === "eligibility"
          ? "select pg_advisory_xact_lock(6, hashint8(123))"
          : "select pg_advisory_xact_lock(2, hashint8(90000002))",
      );
      if (order === "admission first") admission = admit();
      else invalidation = invalidate(p, loss);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      const waiting = (
        await ctx.pool.query<{ pid: number }>(
          "select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
          [pid],
        )
      ).rows;
      expect(waiting).toHaveLength(1);
      if (order === "admission first") invalidation = invalidate(p, loss);
      else admission = admit();
      expect(await waitUntilBlockedBy(ctx.pool, waiting[0].pid)).toBe(true);
      await holder.query("commit");
      const result = await admission;
      await invalidation;
      if (order === "admission first") {
        expect(result?.ok).toBe(true);
        if (result?.ok && "rows" in result)
          expect(result.rows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ characterId: p.alts[0].id }),
            ]),
          );
        if (result?.ok && "value" in result)
          expect(result.value).toMatchObject({
            characters: expect.arrayContaining([
              expect.objectContaining({ characterId: p.alts[0].id }),
            ]),
          });
      } else {
        if (kind === "publish") expect(result?.ok).toBe(false);
        if (result?.ok && "rows" in result) expect(result.rows).toEqual([]);
        if (result?.ok && "value" in result)
          expect(result.value).not.toMatchObject({
            characters: expect.arrayContaining([
              expect.objectContaining({ characterId: p.alts[0].id }),
            ]),
          });
      }
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
      const after = await readFleetProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 30,
        now: at(loss === "expiry" ? 12000 : 4500),
      });
      expect(after.ok ? after.rows : []).toEqual([]);
      if (loss === "unlink") {
        // Negative ABA check via actual relink; no Fleet Read is granted. Discard
        // the baseline callback token before checking tokenless eligibility again.
        expect(
          await fleetLifecycleTransaction(ctx.db, (tx) =>
            linkCharacter(tx, testConfig(), p.participant.id, {
              characterId: p.alts[0].id,
              characterName: p.alts[0].name,
              ownerHash: p.alts[0].ownerHash,
              refreshToken: "synthetic-baseline-only",
              scopes: [],
            }),
          ),
        ).toEqual({ ok: true });
        await ctx.db
          .update(character)
          .set({ refreshTokenEnc: null, tokenStatus: "missing" })
          .where(eq(character.id, p.alts[0].id));
        const [linked] = await ctx.db
          .select()
          .from(character)
          .where(eq(character.id, p.alts[0].id));
        expect(linked.fleetLinkEpoch).not.toBe(p.alts[0].fleetLinkEpoch);
        const view = await readDeviceEligibility(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 31,
          now: at(5000),
        });
        expect(
          view.ok && view.value.characters.map((ch) => ch.characterId),
        ).not.toContain(p.alts[0].id);
      }
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled([admission, invalidation]);
    }
  },
  20000,
);

it("new competing source dependencies after an identity wait release and retry the actual OUTER transaction", async () => {
  const p = await sharedAccounts(ctx.db);
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 80000000,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const device = await participatingDevice(ctx.db, owner.id);
  const holder = await ctx.pool.connect();
  const transaction = vi.spyOn(ctx.db, "transaction");
  let pending: ReturnType<typeof readDeviceEligibility> | undefined;
  try {
    await holder.query("begin");
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    await holder.query("select pg_advisory_xact_lock(1, hashint8(90000001))");
    pending = readDeviceEligibility(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      now: at(3000),
    });
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    // This actual worker locks its own boss and retained B link, NOT old boss A.
    await realSource(ctx.db, device, boss, 124, [boss.id, p.alts[0].id]);
    transaction.mockClear();
    await holder.query("commit");
    const result = await pending;
    expect(result.ok && result.value.characters.map((ch) => ch.characterId)).toEqual([
      p.alts[1].id,
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
  } finally {
    await holder.query("rollback");
    holder.release();
    await pending;
    transaction.mockRestore();
  }
});

it.each(["publish", "read", "eligibility"] as const)(
  "%s samples source expiry only after the final actual PG lock wait",
  async (kind) => {
    const p = await sharedAccounts(ctx.db);
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(2500),
        rows: [{ characterId: p.alts[0].id, dps: 77, ewar: [] }],
      }),
    ).toEqual({ ok: true });
    const before = await ctx.db.select().from(fleetTelemetryRow);
    expect(before[0].publicationId).toMatch(/^[0-9a-f-]{36}$/);
    let now = at(3000);
    const call = {
      sessionId: p.b.sessionId,
      revision: 4,
      get now() {
        return now;
      },
    };
    const holder = await ctx.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("begin");
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await holder.query(
        kind === "eligibility"
          ? "select pg_advisory_xact_lock(7, hashtext($1))"
          : "select pg_advisory_xact_lock(2, hashint8(90000002))",
        kind === "eligibility" ? [p.source.sourceId] : [],
      );
      pending =
        kind === "publish"
          ? replaceDeviceProjection(ctx.db, {
              sessionId: call.sessionId,
              revision: call.revision,
              get now() {
                return now;
              },
              rows: [{ characterId: p.alts[0].id, dps: 88, ewar: [] }],
            })
          : kind === "read"
            ? readFleetProjection(ctx.db, call)
            : readDeviceEligibility(ctx.db, call);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      now = at(12000);
      await holder.query("commit");
      const result = await pending;
      if (kind === "eligibility")
        expect(result).toMatchObject({
          ok: true,
          value: { state: "not_verified", characters: [] },
        });
      else expect(result).toMatchObject({ ok: false });
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual(before);
    } finally {
      await holder.query("rollback");
      holder.release();
      await pending;
    }
  },
);
