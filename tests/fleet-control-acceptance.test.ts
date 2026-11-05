import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetAutomaticCandidate,
  fleetSourceIntent,
  fleetPublisherLease,
  character,
  account,
  session,
  fleetDevice,
  auditLog,
  fleetDeviceSession,
  fleetSourceAuthority,
} from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import type { AutomaticCommand } from "@/core/fleet-automatic";
import {
  controlFleetAutomatic,
  readFleetAutomatic,
  turnOffFleetAutomaticForBrowser,
} from "@/services/fleet-automatic";
import { fleetLifecycleTransaction } from "@/services/fleet-lifecycle";
import {
  linkCharacter,
  unlinkCharacter,
  completeFleetReadGrant,
} from "@/services/accounts";
import { invalidateTokenIfUnchanged } from "@/services/tokens";
import {
  bindPendingFleet,
  claimFleetSourceFetch,
  commitFleetSourceObservation,
} from "@/services/fleet-source-observation";
import { createSession } from "@/services/session";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { controlFleetSource, readFleetSourceState } from "@/services/fleet-source";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { sharedAccounts } from "./helpers/fleet-shared-admission";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

async function device(accountId: string) {
  const p = await pairDevice(ctx.db, accountId, NOW, ["shared-source-v1"]);
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: p.sessionId,
        revision: 1,
        now: NOW,
        capabilities: ["shared-source-v1"],
      })
    ).ok,
  ).toBe(true);
  return p;
}
function command(
  enabled: boolean,
  generation = 0,
  revision = generation,
): AutomaticCommand {
  return {
    protocol: 2,
    request_id: randomUUID(),
    intent_created_at: NOW.toISOString(),
    enabled,
    expected_generation: generation,
    expected_revision: revision,
  };
}
async function setup() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await device(owner.id);
  expect(
    (
      await controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 2, now: at(1000) },
        command(true),
      )
    ).ok,
  ).toBe(true);
  return { ...p, owner };
}

/** Explicit immutable automatic source storage, never discovery or authority proof. */
async function automaticSource(p: Awaited<ReturnType<typeof setup>>) {
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99002,
    accountId: p.owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const [source] = await ctx.db
    .insert(fleetSourceIntent)
    .values({
      id: randomUUID(),
      accountId: p.owner.id,
      deviceId: p.device.id,
      bossCharacterId: boss.id,
      bossOwnerHash: boss.ownerHash,
      bossLinkEpoch: boss.fleetLinkEpoch,
      generation: 1,
      state: "active",
      activatedAt: NOW,
      fleetId: 123,
      intentCreatedAt: NOW,
      intentExpiresAt: at(60000),
      retainUntil: at(86460000),
      nextFetchAt: at(5000),
      automaticConsentAccountId: p.owner.id,
      automaticConsentGeneration: 1,
    })
    .returning();
  return { source, boss };
}

/** Both contenders must actually be waiting on PostgreSQL, not merely launched.
 * Follow tuple/transaction wait edges: the second writer may wait on the first. */
async function twoAccountWaiters(pid: number) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await ctx.pool.query<{ n: number }>(
      `with recursive blocked(pid) as (
        select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid))
      ) select count(*)::int as n from pg_stat_activity a join blocked b using(pid)
      where a.wait_event_type='Lock' and a.query like '%from "account"%for update%'`,
      [pid],
    );
    if (rows[0].n === 2) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
async function accountOrder(
  accountId: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
) {
  const holder = await ctx.pool.connect();
  let a: Promise<unknown> | undefined;
  let b: Promise<unknown> | undefined;
  try {
    await holder.query("begin");
    await holder.query("select id from account where id=$1 for update", [accountId]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    a = first();
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    b = second();
    expect(await twoAccountWaiters(pid)).toBe(true);
    await holder.query("commit");
    return await Promise.all([a, b]);
  } finally {
    await holder.query("rollback");
    holder.release();
    await Promise.allSettled(
      [a, b].filter((v): v is Promise<unknown> => v !== undefined),
    );
  }
}

it.each([false, true])(
  "Automatic Off versus reOn uses both account lock orders, reOnFirst=%s",
  async (reOnFirst) => {
    const p = await setup();
    const q = await device(p.owner.id);
    const offCommand = command(false, 1);
    const onCommand = command(true, 1);
    const off = () =>
      controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 3, now: at(2000) },
        offCommand,
      );
    const on = () =>
      controlFleetAutomatic(
        ctx.db,
        { sessionId: q.sessionId, revision: 2, now: at(2000) },
        onCommand,
      );
    const [first, second] = await accountOrder(
      p.owner.id,
      reOnFirst ? on : off,
      reOnFirst ? off : on,
    );
    expect(first).toMatchObject({ ok: true, value: { result: "applied" } });
    expect(second).toEqual({ ok: false, code: "conflict" });
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
      enabled: reOnFirst,
      generation: reOnFirst ? 2 : 1,
      revision: 2,
      approvingDeviceId: reOnFirst ? q.device.id : p.device.id,
    });
    const receipts = await ctx.db
      .select()
      .from(fleetAutomaticReceipt)
      .where(eq(fleetAutomaticReceipt.accountId, p.owner.id));
    expect(receipts).toHaveLength(2);
    expect(
      receipts.some(
        (r) => r.requestId === (reOnFirst ? offCommand : onCommand).request_id,
      ),
    ).toBe(false);
  },
);

it.each(["sibling", "candidate", "relay"] as const)(
  "new %s selector during account wait retries the whole outer transaction before earlier locks",
  async (kind) => {
    const p = await setup();
    const { source, boss } = await automaticSource(p);
    const foreign = await seedAccount(ctx.db, { tier: "member" });
    const q = await device(foreign.id);
    const added = await seedCharacter(ctx.db, testConfig(), {
      id: 99001,
      accountId: kind === "relay" ? foreign.id : p.owner.id,
      scopes: [FLEET_READ_SCOPE],
    });
    const holder = await ctx.pool.connect();
    const earlier = await ctx.pool.connect();
    const transaction = vi.spyOn(ctx.db, "transaction");
    let work: ReturnType<typeof controlFleetAutomatic> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from account where id=$1 for update", [p.owner.id]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await earlier.query("begin");
      await earlier.query("select pg_advisory_xact_lock(1, hashint8($1))", [added.id]);
      const earlierPid = (
        await earlier.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0].pid;
      work = controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 3, now: at(2000) },
        command(false, 1),
      );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      const writer = drizzle(holder);
      if (kind === "sibling")
        await writer.insert(fleetSourceIntent).values({
          ...source,
          id: randomUUID(),
          bossCharacterId: added.id,
          bossOwnerHash: added.ownerHash,
          bossLinkEpoch: added.fleetLinkEpoch,
          fleetId: 124,
        });
      if (kind === "candidate")
        await writer.insert(fleetAutomaticCandidate).values({
          accountId: p.owner.id,
          characterId: added.id,
          consentGeneration: 1,
          candidateGeneration: 5,
          claimGeneration: 9,
          ownerHash: added.ownerHash,
          linkEpoch: added.fleetLinkEpoch,
          nextAttemptAt: at(5000),
          claimReservationId: randomUUID(),
          claimExpiresAt: at(30000),
        });
      // Retained negative-cleanup fixture bound to the publisher's actual session;
      // no authority is fabricated or asserted from this row.
      if (kind === "relay")
        await writer.insert(fleetPublisherLease).values({
          characterId: added.id,
          deviceId: q.device.id,
          sessionId: createHash("sha256").update(q.sessionId).digest("base64url"),
          fleetId: 123,
          sourceId: source.id,
          sourceGeneration: source.generation,
          leaseExpiresAt: at(30000),
          linkEpoch: added.fleetLinkEpoch,
        });
      await holder.query("commit");
      expect(await waitUntilBlockedBy(ctx.pool, earlierPid)).toBe(true);
      expect(transaction).toHaveBeenCalledTimes(2);
      // A nested savepoint or opportunistic earlier lock would still own these.
      // The retry waits on the NEW lower identity with no retained account/old identity.
      await holder.query("begin");
      await holder.query("select id from account where id=$1 for update nowait", [
        p.owner.id,
      ]);
      expect(
        (
          await holder.query<{ acquired: boolean }>(
            "select pg_try_advisory_xact_lock(1, hashint8($1)) as acquired",
            [boss.id],
          )
        ).rows[0].acquired,
      ).toBe(true);
      await holder.query("commit");
      await earlier.query("commit");
      expect(await work).toMatchObject({
        ok: true,
        value: { status: { consent: { enabled: false }, sources: [] } },
      });
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(
        (await ctx.db.select().from(fleetSourceIntent)).every((s) => s.state === "ended"),
      ).toBe(true);
      expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([]);
      if (kind === "candidate")
        expect((await ctx.db.select().from(fleetAutomaticCandidate))[0]).toMatchObject({
          candidateGeneration: 5,
          claimGeneration: 9,
          claimReservationId: null,
          claimExpiresAt: null,
        });
    } finally {
      await holder.query("rollback");
      await earlier.query("rollback");
      holder.release();
      earlier.release();
      if (work) await work;
      transaction.mockRestore();
    }
  },
);

it.each([
  "live16",
  "retained256",
  "sources257",
  "characters256",
  "characters257",
] as const)(
  "bounded catalogue/source cap %s cannot strand terminal Off",
  async (cap) => {
    const p = await setup();
    const { source, boss } = await automaticSource(p);
    await ctx.db
      .update(fleetSourceIntent)
      .set({ state: "pending", activatedAt: null, fleetId: null });
    const sourceCount =
      cap === "live16"
        ? 16
        : cap === "retained256"
          ? 256
          : cap === "sources257"
            ? 257
            : 1;
    if (sourceCount > 1)
      await ctx.db.insert(fleetSourceIntent).values(
        Array.from({ length: sourceCount - 1 }, () => ({
          ...source,
          id: randomUUID(),
          bossLinkEpoch: randomUUID(),
          fleetId: null,
          state: cap === "live16" ? ("pending" as const) : ("ended" as const),
          activatedAt: null,
          endedAt: cap === "live16" ? null : at(1000),
          terminalReason: cap === "live16" ? null : "expired",
          automaticConsentAccountId: cap === "live16" ? p.owner.id : null,
          automaticConsentGeneration: cap === "live16" ? 1 : null,
        })),
      );
    const characterCount =
      cap === "characters256" ? 256 : cap === "characters257" ? 257 : 1;
    if (characterCount > 1)
      await ctx.db.insert(character).values(
        Array.from({ length: characterCount - 1 }, (_, i) => ({
          ...boss,
          id: 100000 + i,
          fleetLinkEpoch: randomUUID(),
        })),
      );
    const status = await readFleetAutomatic(ctx.db, {
      sessionId: p.sessionId,
      revision: 3,
      now: at(2000),
    });
    expect(status).toMatchObject({
      ok: true,
      value: {
        status: {
          readiness: cap === "characters256" ? "waiting_for_fleet" : "capacity_limited",
        },
      },
    });
    const catalogue = await readFleetSourceState(ctx.db, {
      sessionId: p.sessionId,
      revision: 4,
      now: at(2500),
    });
    if (cap.endsWith("257"))
      expect(catalogue).toEqual({ ok: false, code: "service_unavailable" });
    else {
      expect(catalogue.ok).toBe(true);
      if (catalogue.ok) {
        expect(catalogue.value.sources).toHaveLength(sourceCount);
        expect(catalogue.value.characters).toHaveLength(characterCount);
      }
    }
    if (sourceCount >= 16)
      expect(
        await controlFleetSource(ctx.db, {
          sessionId: p.sessionId,
          revision: 5,
          now: at(3000),
          command: {
            protocol: 2,
            operation: "start",
            source_id: randomUUID(),
            expected_generation: 0,
            character_id: boss.id,
            character_link_epoch: boss.fleetLinkEpoch,
            intent_created_at: NOW.toISOString(),
          },
        }),
      ).toEqual({ ok: false, code: "rate_limited" });
    const before = await ctx.db.select().from(fleetSourceIntent);
    expect(
      await controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 6, now: at(3500) },
        command(false, 1),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        result: "applied",
        status: {
          readiness: "off",
          sources: [],
          consent: { enabled: false, revision: 2 },
        },
      },
    });
    const after = await ctx.db.select().from(fleetSourceIntent);
    expect(after).toHaveLength(sourceCount);
    for (const s of before) {
      const ended = after.find((row) => row.id === s.id);
      if (s.automaticConsentAccountId)
        expect(ended).toMatchObject({ state: "ended", generation: 2 });
      else expect(ended).toEqual(s);
    }
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(2);
  },
  15000,
);

it.each([false, true])(
  "browser Off versus actual account merge, mergeFirst=%s",
  async (mergeFirst) => {
    const p = await setup();
    const boss = await seedCharacter(ctx.db, testConfig(), {
      id: 99001,
      accountId: p.owner.id,
      scopes: [FLEET_READ_SCOPE],
    });
    const target = await seedAccount(ctx.db, { tier: "member" });
    const cookie = await createSession(ctx.db, p.owner.id);
    await ctx.db.update(session).set({ expiresAt: at(86400000) });
    const offCommand = { ...command(false, 1), enabled: false as const };
    const off = () =>
      turnOffFleetAutomaticForBrowser(
        ctx.db,
        { accountId: p.owner.id, browserSessionId: cookie },
        offCommand,
        () => at(2000),
      );
    const merge = () =>
      fleetLifecycleTransaction(ctx.db, (tx) =>
        linkCharacter(tx, testConfig(), target.id, {
          characterId: boss.id,
          characterName: boss.name,
          ownerHash: boss.ownerHash,
          scopes: boss.scopes,
          refreshToken: "merged-acceptance-refresh",
        }),
      );
    const results = await accountOrder(
      p.owner.id,
      mergeFirst ? merge : off,
      mergeFirst ? off : merge,
    );
    expect(results[mergeFirst ? 0 : 1]).toEqual({ ok: true });
    if (mergeFirst)
      expect(results[1]).toEqual({
        ok: false,
        request_id: offCommand.request_id,
        error: "unauthorized",
        status: null,
      });
    else
      expect(results[0]).toMatchObject({
        ok: true,
        result: "applied",
        status: { consent: { enabled: false, generation: 1, revision: 2 } },
      });
    expect(await ctx.db.select().from(fleetAutomaticConsent)).toEqual([]);
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toEqual([]);
    expect(await ctx.db.select().from(session)).toEqual([]);
    expect(await ctx.db.select().from(account).where(eq(account.id, p.owner.id))).toEqual(
      [],
    );
    expect((await ctx.db.select().from(character))[0].accountId).toBe(target.id);
    const changes = (await ctx.db.select().from(auditLog)).filter(
      (a) => a.action === "fleet_automatic.changed",
    );
    expect(changes).toHaveLength(mergeFirst ? 1 : 2);
    expect(JSON.stringify(changes)).not.toContain(cookie);
  },
);

it.each([false, true])(
  "replacement-device On versus current approver revoke, replacementFirst=%s",
  async (replacementFirst) => {
    const p = await setup();
    const q = await device(p.owner.id);
    const on = () =>
      controlFleetAutomatic(
        ctx.db,
        { sessionId: q.sessionId, revision: 2, now: at(2000) },
        command(true, 1),
      );
    const revoke = () => revokeFleetDevice(ctx.db, p.device.id, p.owner.id, at(2000));
    const results = await accountOrder(
      p.owner.id,
      replacementFirst ? on : revoke,
      replacementFirst ? revoke : on,
    );
    expect(results[replacementFirst ? 1 : 0]).toBeUndefined();
    if (replacementFirst)
      expect(results[0]).toMatchObject({ ok: true, value: { result: "applied" } });
    else expect(results[1]).toEqual({ ok: false, code: "conflict" });
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
      enabled: replacementFirst,
      generation: replacementFirst ? 2 : 1,
      revision: 2,
      approvingDeviceId: replacementFirst ? q.device.id : p.device.id,
      closedReason: replacementFirst ? null : "approver_revoked",
    });
    expect(
      (await ctx.db.select().from(fleetDevice).where(eq(fleetDevice.id, p.device.id)))[0]
        .revokedAt,
    ).toEqual(at(2000));
    expect(
      (await ctx.db.select().from(fleetDevice).where(eq(fleetDevice.id, q.device.id)))[0]
        .revokedAt,
    ).toBeNull();
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(
      replacementFirst ? 2 : 1,
    );
  },
);

const GMAX = Number.MAX_SAFE_INTEGER;
it.each([
  { generation: GMAX - 2, revision: GMAX - 2, enabled: true, admits: true },
  { generation: GMAX - 1, revision: GMAX - 1, enabled: true, admits: false },
  { generation: 1, revision: GMAX - 1, enabled: true, admits: false },
  { generation: GMAX, revision: GMAX, enabled: false, admits: false },
])(
  "G boundary $generation/$revision enabled=$enabled preserves terminal revision",
  async ({ generation, revision, enabled, admits }) => {
    const p = await setup();
    await ctx.db.update(fleetAutomaticConsent).set({
      generation,
      revision,
      enabled,
      disabledAt: enabled ? null : at(1500),
      closedReason: enabled ? null : "explicit_off",
    });
    const before = (await ctx.db.select().from(fleetAutomaticConsent))[0];
    const on = await controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision: 3, now: at(2000) },
      command(true, generation, revision),
    );
    if (admits)
      expect(on).toMatchObject({
        ok: true,
        value: {
          status: {
            consent: { generation: GMAX - 1, revision: GMAX - 1, enabled: true },
          },
        },
      });
    else {
      expect(on).toEqual({ ok: false, code: "receipt_capacity" });
      expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toEqual(before);
      expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(2);
    }
    const g = generation + Number(admits),
      r = revision + Number(admits);
    expect(
      await controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 4, now: at(2500) },
        command(false, g, r),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        result: enabled ? "applied" : "already_off",
        status: { consent: { enabled: false, generation: g, revision: GMAX } },
      },
    });
    const count = (await ctx.db.select().from(fleetAutomaticReceipt)).length;
    expect(
      await controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 5, now: at(3000) },
        command(false, g, GMAX),
      ),
    ).toMatchObject({ ok: true, value: { result: "already_off", receipt: null } });
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(count);
  },
);

it.each(["off", "browserOff", "reOn", "stop", "revoke"] as const)(
  "terminal N reserve through %s ends worker-proven source and never increments ended/empty counters again",
  async (operation) => {
    const p = await sharedAccounts(ctx.db);
    expect(
      (
        await controlFleetAutomatic(
          ctx.db,
          { sessionId: p.a.sessionId, revision: 4, now: at(3000) },
          command(true),
        )
      ).ok,
    ).toBe(true);
    // Authority is from the real proof worker. Only immutable automatic fixture
    // attribution and counter-boundary values are installed, not positive evidence.
    await ctx.db
      .update(fleetSourceIntent)
      .set({
        automaticConsentAccountId: p.owner.id,
        automaticConsentGeneration: 1,
        generation: 2147483646,
        fetchGeneration: 2147483646,
      })
      .where(eq(fleetSourceIntent.id, p.source.sourceId));
    await ctx.db
      .update(fleetSourceAuthority)
      .set({ sourceGeneration: 2147483646, authorityGeneration: 2147483646 });
    const cookie = await createSession(ctx.db, p.owner.id);
    const off = { ...command(false, 1), enabled: false as const };
    const call = { sessionId: p.a.sessionId, revision: 5, now: at(4000) };
    if (operation === "revoke")
      await revokeFleetDevice(ctx.db, p.a.device.id, p.owner.id, at(4000));
    else if (operation === "browserOff")
      expect(
        await turnOffFleetAutomaticForBrowser(
          ctx.db,
          { accountId: p.owner.id, browserSessionId: cookie },
          off,
          () => at(4000),
        ),
      ).toMatchObject({ ok: true });
    else if (operation === "stop")
      expect(
        await controlFleetSource(ctx.db, {
          ...call,
          command: {
            protocol: 2,
            operation: "stop",
            source_id: p.source.sourceId,
            expected_generation: 2147483646,
            expected_automatic: { consent_generation: 1 },
            request_id: randomUUID(),
            intent_created_at: NOW.toISOString(),
          },
        }),
      ).toMatchObject({
        ok: true,
        value: { source: { generation: 2147483647, state: "ended" } },
      });
    else
      expect(
        await controlFleetAutomatic(
          ctx.db,
          call,
          operation === "reOn" ? command(true, 1) : off,
        ),
      ).toMatchObject({ ok: true });
    const ended = (await ctx.db.select().from(fleetSourceIntent))[0];
    const empty = (await ctx.db.select().from(fleetSourceAuthority))[0];
    expect(ended).toMatchObject({
      state: "ended",
      generation: 2147483647,
      fetchGeneration: 2147483647,
      fetchClaimExpiresAt: null,
    });
    expect(empty).toMatchObject({
      sourceId: null,
      sourceGeneration: null,
      authorityGeneration: 2147483647,
      linkedCharacters: [],
    });
    p.source.setNow(5000);
    await p.source.run();
    const [consent] = await ctx.db.select().from(fleetAutomaticConsent);
    expect(
      await turnOffFleetAutomaticForBrowser(
        ctx.db,
        { accountId: p.owner.id, browserSessionId: cookie },
        {
          ...off,
          request_id: randomUUID(),
          expected_generation: consent.generation,
          expected_revision: consent.revision,
        },
        () => at(6000),
      ),
    ).toMatchObject({
      ok: true,
      result: operation === "reOn" ? "applied" : "already_off",
    });
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toEqual(ended);
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toEqual(empty);
  },
);

it.each(
  ["off", "browserOff", "reOn", "start", "stop", "unknownStop"].flatMap((operation) =>
    [false, true].map((overflow) => ({ operation, overflow })),
  ),
)(
  "date-bound $operation overflow=$overflow uses exact representable retention boundary",
  async ({ operation, overflow }) => {
    const p = await setup();
    const { source, boss } = await automaticSource(p);
    const cookie = await createSession(ctx.db, p.owner.id);
    const max = Date.parse("9999-12-31T23:59:59.999Z");
    const horizon = 86400000 + (["start", "unknownStop"].includes(operation) ? 60000 : 0);
    const now = new Date(max - horizon + Number(overflow));
    await ctx.db.update(fleetDeviceSession).set({ expiresAt: new Date(max) });
    await ctx.db.update(session).set({ expiresAt: new Date(max) });
    const call = { sessionId: p.sessionId, revision: 3, now };
    const off = { ...command(false, 1), enabled: false as const };
    const before = {
      consent: await ctx.db.select().from(fleetAutomaticConsent),
      sources: await ctx.db.select().from(fleetSourceIntent),
      receipts: await ctx.db.select().from(fleetAutomaticReceipt),
      audit: await ctx.db.select().from(auditLog),
    };
    const result =
      operation === "browserOff"
        ? await turnOffFleetAutomaticForBrowser(
            ctx.db,
            { accountId: p.owner.id, browserSessionId: cookie },
            off,
            () => now,
          )
        : operation === "off" || operation === "reOn"
          ? await controlFleetAutomatic(
              ctx.db,
              call,
              operation === "off"
                ? off
                : { ...command(true, 1), intent_created_at: now.toISOString() },
            )
          : await controlFleetSource(ctx.db, {
              ...call,
              command:
                operation === "start"
                  ? {
                      protocol: 2,
                      operation: "start",
                      source_id: randomUUID(),
                      expected_generation: 0,
                      character_id: boss.id,
                      character_link_epoch: boss.fleetLinkEpoch,
                      intent_created_at: now.toISOString(),
                    }
                  : {
                      protocol: 2,
                      operation: "stop",
                      source_id: operation === "stop" ? source.id : randomUUID(),
                      expected_generation: operation === "stop" ? 1 : 0,
                      expected_automatic:
                        operation === "stop" ? { consent_generation: 1 } : null,
                      request_id: randomUUID(),
                      intent_created_at: now.toISOString(),
                    },
            });
    if (overflow) {
      expect(result).toMatchObject(
        operation === "browserOff"
          ? { ok: false, error: "service_unavailable", status: null }
          : { ok: false, code: "service_unavailable" },
      );
      expect(await ctx.db.select().from(fleetAutomaticConsent)).toEqual(before.consent);
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(before.sources);
      expect(await ctx.db.select().from(fleetAutomaticReceipt)).toEqual(before.receipts);
      expect(await ctx.db.select().from(auditLog)).toEqual(before.audit);
      expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(2);
    } else {
      expect(result).toMatchObject({ ok: true });
      const rows = await ctx.db.select().from(fleetSourceIntent);
      expect(rows.every((s) => s.retainUntil.getTime() <= max)).toBe(true);
      if (["start", "stop", "unknownStop"].includes(operation))
        expect(rows.some((s) => s.retainUntil.getTime() === max)).toBe(true);
      else
        expect(
          (await ctx.db.select().from(fleetAutomaticReceipt)).some(
            (r) => r.expiresAt.getTime() === max,
          ),
        ).toBe(true);
    }
  },
);

it("terminal no-ops near the final date allocate no receipt or retention horizon", async () => {
  const p = await setup();
  const { source } = await automaticSource(p);
  expect(
    (
      await controlFleetSource(ctx.db, {
        sessionId: p.sessionId,
        revision: 3,
        now: at(2000),
        command: {
          protocol: 2,
          operation: "stop",
          source_id: source.id,
          expected_generation: 1,
          expected_automatic: { consent_generation: 1 },
          request_id: randomUUID(),
          intent_created_at: NOW.toISOString(),
        },
      })
    ).ok,
  ).toBe(true);
  const max = Date.parse("9999-12-31T23:59:59.999Z"),
    now = new Date(max - 1);
  await ctx.db.update(fleetDeviceSession).set({ expiresAt: new Date(max) });
  const before = await ctx.db.select().from(fleetSourceIntent);
  expect(
    await controlFleetSource(ctx.db, {
      sessionId: p.sessionId,
      revision: 4,
      now: new Date(max - 1000),
      command: {
        protocol: 2,
        operation: "stop",
        source_id: source.id,
        expected_generation: 2,
        expected_automatic: { consent_generation: 1 },
        request_id: randomUUID(),
        intent_created_at: new Date(max - 1000).toISOString(),
      },
    }),
  ).toMatchObject({ ok: true, value: { result: "already_stopped", receipt: null } });
  expect(
    await controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision: 5, now },
      command(false, 1, 2),
    ),
  ).toMatchObject({ ok: true, value: { result: "already_off", receipt: null } });
  expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(before);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
});

it.each(
  ["grant", "link"].flatMap((loss) =>
    ["bind", "commit", "candidateOnly"].map((stage) => ({ loss, stage })),
  ),
)(
  "$loss quick restore clears candidate identity and fences old $stage through existing owners",
  async ({ loss, stage }) => {
    const p = await setup();
    const fixture =
      stage === "candidateOnly"
        ? {
            boss: await seedCharacter(ctx.db, testConfig(), {
              id: 99002,
              accountId: p.owner.id,
              scopes: [FLEET_READ_SCOPE],
            }),
            source: null,
          }
        : await automaticSource(p);
    const { boss, source } = fixture;
    await seedCharacter(ctx.db, testConfig(), {
      id: 99003,
      accountId: p.owner.id,
      main: true,
    });
    const cookie = await createSession(ctx.db, p.owner.id);
    const reservation = randomUUID();
    await ctx.db.insert(fleetAutomaticCandidate).values({
      accountId: p.owner.id,
      characterId: boss.id,
      consentGeneration: 1,
      candidateGeneration: GMAX - 1,
      claimGeneration: GMAX - 1,
      failureCount: 6,
      ownerHash: boss.ownerHash,
      linkEpoch: boss.fleetLinkEpoch,
      nextAttemptAt: at(10000),
      sourceId: source?.id ?? null,
      ...(stage === "candidateOnly"
        ? { reservationId: reservation, enqueueUntil: at(30000) }
        : { claimReservationId: reservation, claimExpiresAt: at(30000) }),
    });
    const claim = source
      ? await claimFleetSourceFetch(ctx.db, { sourceId: source.id, generation: 1 }, () =>
          at(5000),
        )
      : null;
    if (source) expect(claim).not.toBeNull();
    const token = claim ? { ...claim, accessTokenExpiresAt: at(3600000) } : null;
    const bound =
      token && stage === "commit"
        ? await bindPendingFleet(ctx.db, token, 123, boss.refreshTokenEnc!, () =>
            at(5000),
          )
        : null;
    if (stage === "commit") expect(bound).not.toBeNull();
    const holder = await ctx.pool.connect();
    let lossWork: Promise<unknown> | undefined;
    let callback: Promise<unknown> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(1, hashint8($1))", [boss.id]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      lossWork =
        loss === "grant"
          ? invalidateTokenIfUnchanged(ctx.db, boss.id, boss.refreshTokenEnc!, {
              action: "test.acceptance.grant_loss",
            })
          : fleetLifecycleTransaction(ctx.db, (tx) =>
              unlinkCharacter(tx, testConfig(), p.owner.id, boss.id),
            );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await holder.query("commit");
      expect(await lossWork).toEqual(loss === "grant" ? true : { ok: true });
      const restored = {
        characterId: boss.id,
        characterName: boss.name,
        ownerHash: boss.ownerHash,
        refreshToken: "quick-restored-acceptance",
        scopes: [...testConfig().eveSso.scopes, FLEET_READ_SCOPE],
      };
      expect(
        await fleetLifecycleTransaction(ctx.db, async (tx) =>
          loss === "grant"
            ? completeFleetReadGrant(
                tx,
                testConfig(),
                p.owner.id,
                boss.id,
                restored,
                cookie,
              )
            : linkCharacter(tx, testConfig(), p.owner.id, restored),
        ),
      ).toEqual({ ok: true });
      const currentBoss = (
        await ctx.db.select().from(character).where(eq(character.id, boss.id))
      )[0];
      expect(currentBoss.scopes).toContain(FLEET_READ_SCOPE);
      expect(currentBoss.refreshTokenEnc).not.toBeNull();
      if (loss === "link")
        expect(currentBoss.fleetLinkEpoch).not.toBe(boss.fleetLinkEpoch);
      else expect(currentBoss.fleetLinkEpoch).toBe(boss.fleetLinkEpoch);
      const [candidate] = await ctx.db.select().from(fleetAutomaticCandidate);
      expect(candidate).toMatchObject({
        candidateGeneration: GMAX - 1,
        claimGeneration: GMAX - 1,
        consentGeneration: 1,
        failureCount: 6,
        ownerHash: boss.ownerHash,
        linkEpoch: boss.fleetLinkEpoch,
        claimReservationId: null,
        claimExpiresAt: null,
        reservationId: null,
        enqueueUntil: null,
        sourceId: null,
      });
      const beforeSources = await ctx.db.select().from(fleetSourceIntent);
      const beforeAuthority = await ctx.db.select().from(fleetSourceAuthority);
      if (token) {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(1, hashint8($1))", [boss.id]);
        callback =
          stage === "bind"
            ? bindPendingFleet(ctx.db, token, 123, boss.refreshTokenEnc!, () => at(6000))
            : commitFleetSourceObservation(
                ctx.db,
                bound!,
                boss.refreshTokenEnc!,
                {
                  kind: "verified",
                  memberIds: [boss.id],
                  evidence: {
                    observedAt: at(5000),
                    expiresAt: at(15000),
                    nextFetchAt: at(10000),
                  },
                  nextFetchAt: at(10000),
                },
                () => at(6000),
              );
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        await holder.query("commit");
        if (stage === "bind") expect(await callback).toBeNull();
        else await callback;
      }
      expect(await ctx.db.select().from(fleetSourceIntent)).toEqual(beforeSources);
      expect(await ctx.db.select().from(fleetSourceAuthority)).toEqual(beforeAuthority);
      expect(beforeSources.every((s) => s.state === "ended")).toBe(true);
      if (!source) expect(beforeSources).toEqual([]);
      expect(await ctx.db.select().from(fleetAutomaticCandidate)).toEqual([candidate]);
      expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
        enabled: true,
        generation: 1,
        revision: 1,
      });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(
        [lossWork, callback].filter((v): v is Promise<unknown> => v !== undefined),
      );
    }
  },
);
