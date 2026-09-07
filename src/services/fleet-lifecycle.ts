import { and, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { Db, DbTx, Dbx } from "@/db";
import {
  account,
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetPairingRequest,
  fleetPublisherLease,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
  session,
} from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { normalizeDevicePublicKeyB64 } from "@/lib/fleet-signature";
import { logAudit } from "@/services/audit";
import { fleetDatabaseNow, lockFleetDeviceKey } from "@/services/fleet-key-identity";
import { lockFleetCharactersAscending } from "@/services/fleet-relay";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";

/** Relative order, NOT numeric advisory class order:
 * mode(3) -> canonical keys(5) -> requests -> identity(1)/character -> accounts
 * -> browser sessions -> authority(6) -> sources(7) -> devices -> fleet sessions
 * -> UNION relay characters(2). Never retry a selector under retained locks.
 * No networking belongs in this module or inside these transaction callbacks. */
export const FLEET_AUTHORITY_LOCK_CLASS = 6;
export const FLEET_SOURCE_LOCK_CLASS = 7;
export const FLEET_SOURCE_INTENT_TTL_MS = 60_000;
export const FLEET_SOURCE_TOMBSTONE_RETENTION_MS = 24 * 60 * 60_000;

export class FleetLifecycleRetry extends Error {
  constructor() {
    super("fleet_lifecycle_selectors_changed");
  }
}

/** Actual OUTER transaction boundary only, never a DbTx/savepoint. OAuth callers
 * run network/state-consumption once, then retry only this local write phase. */
export async function fleetLifecycleTransaction<T>(
  db: Db,
  work: (tx: DbTx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (err) {
      if (!(err instanceof FleetLifecycleRetry) || attempt >= 3) throw err;
    }
  }
}

/** Serializes absent character rows too (concurrent first login). hashint8 fits
 * EVE IDs into the int4 advisory namespace; a collision only serializes unrelated
 * characters. Relay locks stay in distinct class 2, acquired much later. */
export async function lockFleetIdentityCharacters(tx: DbTx, ids: readonly number[]) {
  const rows = new Map<number, typeof character.$inferSelect>();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    await tx.execute(sql`select pg_advisory_xact_lock(1, hashint8(${id}))`);
    const [row] = await tx
      .select()
      .from(character)
      .where(eq(character.id, id))
      .for("update");
    if (row) rows.set(id, row);
  }
  return rows;
}

export async function lockFleetAccounts(tx: DbTx, ids: readonly string[]) {
  const rows = new Map<string, typeof account.$inferSelect>();
  for (const id of [...new Set(ids)].sort()) {
    const [row] = await tx.select().from(account).where(eq(account.id, id)).for("update");
    if (row) rows.set(id, row);
  }
  return rows;
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return (
    JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
  );
}

/** Entry prelude for login/link/unlink/reclaim/grant. Only a possible merge needs
 * key/request selectors: account deletion cascades even APPROVED, UNCOMPLETED
 * requests. Probe those before character/account locks and revalidate afterward. */
export async function prepareFleetCharacterMutation(
  tx: DbTx,
  id: number,
  targetAccountId?: string,
  mergeOwnerHash?: string,
) {
  const mode = await lockFleetSharingMode(tx);
  const [probe] = await tx.select().from(character).where(eq(character.id, id));
  const mergeId =
    probe &&
    targetAccountId &&
    probe.accountId !== targetAccountId &&
    probe.ownerHash === mergeOwnerHash
      ? probe.accountId
      : undefined;
  const devices = mergeId
    ? await tx.select().from(fleetDevice).where(eq(fleetDevice.accountId, mergeId))
    : [];
  const requests = mergeId
    ? await tx
        .select()
        .from(fleetPairingRequest)
        .where(eq(fleetPairingRequest.approvedAccountId, mergeId))
    : [];
  const keys = [...devices, ...requests].map((row) => {
    if (mode.keyIdentityPhase !== "ready") return row.publicKeySpkiB64;
    const key = normalizeDevicePublicKeyB64(Buffer.from(row.publicKeySpkiB64, "base64"));
    if (!key) throw new Error("invalid_persisted_device_key");
    return key;
  });
  for (const key of [...new Set(keys)].sort()) await lockFleetDeviceKey(tx, key);
  for (const request of requests.sort((a, b) => a.id.localeCompare(b.id)))
    await tx
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, request.id))
      .for("update");
  const existing = (await lockFleetIdentityCharacters(tx, [id])).get(id);
  const currentMergeId =
    existing &&
    targetAccountId &&
    existing.accountId !== targetAccountId &&
    existing.ownerHash === mergeOwnerHash
      ? existing.accountId
      : undefined;
  // Only EARLIER-level selectors require an outer retry. An ordinary first
  // login may discover the concurrent winner here: no key/request locks were
  // needed, and its account is a later level we have not acquired yet.
  if (
    currentMergeId !== mergeId ||
    (mergeId && existing?.fleetLinkEpoch !== probe?.fleetLinkEpoch)
  )
    throw new FleetLifecycleRetry();
  const accountIds = [existing?.accountId, targetAccountId].filter(
    (v): v is string => !!v,
  );
  const accounts = await lockFleetAccounts(tx, accountIds);
  if (mergeId) {
    const currentDevices = await tx
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, mergeId));
    const currentRequests = await tx
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.approvedAccountId, mergeId));
    if (
      !sameSet(
        devices.map((d) => d.id),
        currentDevices.map((d) => d.id),
      ) ||
      !sameSet(
        requests.map((r) => r.id),
        currentRequests.map((r) => r.id),
      )
    )
      throw new FleetLifecycleRetry();
  }
  if (accountIds.length)
    await tx
      .select()
      .from(session)
      .where(inArray(session.accountId, accountIds))
      .orderBy(session.id)
      .for("update");
  return { existing, accounts };
}

/** Actual Fleet Read usability, not baseline scope health or cryo standing. */
export function hasUsableFleetRead(
  ch: Pick<typeof character.$inferSelect, "scopes" | "refreshTokenEnc" | "tokenStatus">,
): boolean {
  return (
    !!ch.refreshTokenEnc &&
    ch.tokenStatus !== "invalid" &&
    ch.tokenStatus !== "missing" &&
    ch.scopes.includes(FLEET_READ_SCOPE)
  );
}

export type FleetLifecycleSelectors = {
  accountIds?: readonly string[];
  /** Grant/token loss: end these bosses' sources, not their participation. */
  bossCharacterIds?: readonly number[];
  /** Identity-link loss: end owned sources AND withdraw these characters. */
  characterIds?: readonly number[];
  deviceIds?: readonly string[];
  sourceIds?: readonly string[];
  all?: boolean;
};
export type LockedFleetLifecycle = {
  sources: (typeof fleetSourceIntent.$inferSelect)[];
  authorities: (typeof fleetSourceAuthority.$inferSelect)[];
  deviceIds: string[];
  relayCharacterIds: number[];
  selectors: FleetLifecycleSelectors;
};

function sourcePredicate(s: FleetLifecycleSelectors) {
  return s.all
    ? undefined
    : (or(
        s.accountIds?.length
          ? inArray(fleetSourceIntent.accountId, [...s.accountIds])
          : undefined,
        s.bossCharacterIds?.length
          ? inArray(fleetSourceIntent.bossCharacterId, [...s.bossCharacterIds])
          : undefined,
        s.characterIds?.length
          ? inArray(fleetSourceIntent.bossCharacterId, [...s.characterIds])
          : undefined,
        s.deviceIds?.length
          ? inArray(fleetSourceIntent.deviceId, [...s.deviceIds])
          : undefined,
        s.sourceIds?.length ? inArray(fleetSourceIntent.id, [...s.sourceIds]) : undefined,
      ) ?? sql`false`);
}

export async function lockFleetAuthoritySlots(tx: DbTx, fleetIds: readonly number[]) {
  for (const id of [...new Set(fleetIds)].sort((a, b) => a - b)) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${FLEET_AUTHORITY_LOCK_CLASS}, hashint8(${id}))`,
    );
    await tx
      .select()
      .from(fleetSourceAuthority)
      .where(eq(fleetSourceAuthority.fleetId, id))
      .for("update");
  }
}
export async function lockFleetSourceIntents(tx: DbTx, sourceIds: readonly string[]) {
  for (const id of [...new Set(sourceIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${FLEET_SOURCE_LOCK_CLASS}, hashtext(${id}))`,
    );
    await tx
      .select()
      .from(fleetSourceIntent)
      .where(eq(fleetSourceIntent.id, id))
      .for("update");
  }
}

/** Caller already holds mode and the affected identity/account locks (or EX mode
 * for operator drain). Aggregate ALL effects before this call. Source binding
 * selectors are not authority; only the locked current generation is withdrawn.
 * Pending, active and paused all retain consent: only ended intents are excluded. */
export async function lockFleetLifecycle(
  tx: DbTx,
  selectors: FleetLifecycleSelectors,
): Promise<LockedFleetLifecycle> {
  const probe = await tx
    .select()
    .from(fleetSourceIntent)
    .where(and(sourcePredicate(selectors), ne(fleetSourceIntent.state, "ended")));
  const ids = probe.map((s) => s.id);
  const authorities = await tx
    .select()
    .from(fleetSourceAuthority)
    .where(
      selectors.all
        ? undefined
        : ids.length
          ? inArray(fleetSourceAuthority.sourceId, ids)
          : sql`false`,
    );
  const fleetIds = [
    ...probe.flatMap((s) => (s.fleetId === null ? [] : [s.fleetId])),
    ...authorities.map((a) => a.fleetId),
  ];
  await lockFleetAuthoritySlots(tx, fleetIds);
  await lockFleetSourceIntents(tx, [...ids, ...(selectors.sourceIds ?? [])]);
  const sources = await tx
    .select()
    .from(fleetSourceIntent)
    .where(and(sourcePredicate(selectors), ne(fleetSourceIntent.state, "ended")));
  const currentAuthorities = await tx
    .select()
    .from(fleetSourceAuthority)
    .where(
      selectors.all
        ? undefined
        : ids.length
          ? inArray(fleetSourceAuthority.sourceId, ids)
          : sql`false`,
    );
  // A worker can move its fleet while we wait for the old slot. Release ALL
  // locks and redo the caller, never acquire its new (possibly earlier) slot.
  const currentFleetIds = [
    ...sources.flatMap((s) => (s.fleetId === null ? [] : [s.fleetId])),
    ...currentAuthorities.map((a) => a.fleetId),
  ];
  if (
    sources.some((s) => !ids.includes(s.id)) ||
    currentFleetIds.some((id) => !fleetIds.includes(id))
  )
    throw new FleetLifecycleRetry();
  const directDevices = await tx
    .select()
    .from(fleetDevice)
    .where(
      selectors.all
        ? undefined
        : (or(
            selectors.accountIds?.length
              ? inArray(fleetDevice.accountId, [...selectors.accountIds])
              : undefined,
            selectors.deviceIds?.length
              ? inArray(fleetDevice.id, [...selectors.deviceIds])
              : undefined,
          ) ?? sql`false`),
    );
  const relayCondition = (t: typeof fleetTelemetryRow | typeof fleetPublisherLease) =>
    selectors.all
      ? undefined
      : (or(
          ...sources.map((source) =>
            and(eq(t.sourceId, source.id), eq(t.sourceGeneration, source.generation)),
          ),
          selectors.characterIds?.length
            ? inArray(t.characterId, [...selectors.characterIds])
            : undefined,
          directDevices.length
            ? inArray(
                t.deviceId,
                directDevices.map((d) => d.id),
              )
            : undefined,
        ) ?? sql`false`);
  const rows = await tx
    .select()
    .from(fleetTelemetryRow)
    .where(relayCondition(fleetTelemetryRow));
  const leases = await tx
    .select()
    .from(fleetPublisherLease)
    .where(relayCondition(fleetPublisherLease));
  const deviceIds = [
    ...new Set([
      ...directDevices.map((d) => d.id),
      ...sources.flatMap((s) => (s.deviceId ? [s.deviceId] : [])),
      ...rows.map((r) => r.deviceId),
      ...leases.map((r) => r.deviceId),
    ]),
  ].sort();
  if (deviceIds.length) {
    await tx
      .select()
      .from(fleetDevice)
      .where(inArray(fleetDevice.id, deviceIds))
      .orderBy(fleetDevice.id)
      .for("update");
    await tx
      .select()
      .from(fleetDeviceSession)
      .where(inArray(fleetDeviceSession.deviceId, deviceIds))
      .orderBy(fleetDeviceSession.id)
      .for("update");
  }
  // Device serialization can expose a just-committed legacy publication. Union
  // after that wait, before taking ANY relay character locks.
  const currentRows = await tx
    .select()
    .from(fleetTelemetryRow)
    .where(relayCondition(fleetTelemetryRow));
  const currentLeases = await tx
    .select()
    .from(fleetPublisherLease)
    .where(relayCondition(fleetPublisherLease));
  if ([...currentRows, ...currentLeases].some((r) => !deviceIds.includes(r.deviceId)))
    throw new FleetLifecycleRetry();
  const relayCharacterIds = [
    ...new Set([...currentRows, ...currentLeases].map((r) => r.characterId)),
  ];
  await lockFleetCharactersAscending(tx, relayCharacterIds);
  return {
    sources,
    authorities: currentAuthorities,
    deviceIds,
    relayCharacterIds,
    selectors,
  };
}

/** Relay-only withdrawal, safe after owning-device serialization. Unlike recovery
 * teardown this never retires sessions. Off's caller holds only its named session;
 * all other session writers first need the same device lock. */
export async function withdrawFleetDeviceProjection(tx: DbTx, deviceId: string) {
  const rows = await tx
    .select()
    .from(fleetTelemetryRow)
    .where(eq(fleetTelemetryRow.deviceId, deviceId));
  const leases = await tx
    .select()
    .from(fleetPublisherLease)
    .where(eq(fleetPublisherLease.deviceId, deviceId));
  await lockFleetCharactersAscending(
    tx,
    [...rows, ...leases].map((r) => r.characterId),
  );
  await tx.delete(fleetTelemetryRow).where(eq(fleetTelemetryRow.deviceId, deviceId));
  await tx.delete(fleetPublisherLease).where(eq(fleetPublisherLease.deviceId, deviceId));
}

/** Bounded independent maintenance seam, not a scheduler. A later Start MUST
 * validate immutable intentCreatedAt even when no tombstone remains; deleting
 * a fence never makes an expired intent valid again. Task 4 owns that admission. */
export async function purgeExpiredFleetSourceIntents(
  dbx: Dbx,
  testNow?: Date,
): Promise<number> {
  return dbx.transaction(async (tx) => {
    await lockFleetSharingMode(tx);
    const now = await fleetDatabaseNow(tx, testNow);
    const rows = await tx
      .select({ id: fleetSourceIntent.id })
      .from(fleetSourceIntent)
      .where(
        and(
          eq(fleetSourceIntent.state, "ended"),
          lte(fleetSourceIntent.retainUntil, now),
        ),
      )
      .orderBy(fleetSourceIntent.id)
      .limit(100);
    if (!rows.length) return 0;
    const ids = rows.map((row) => row.id);
    await lockFleetSourceIntents(tx, ids);
    const afterWait = await fleetDatabaseNow(tx, testNow);
    const deleted = await tx
      .delete(fleetSourceIntent)
      .where(
        and(
          inArray(fleetSourceIntent.id, ids),
          eq(fleetSourceIntent.state, "ended"),
          lte(fleetSourceIntent.retainUntil, afterWait),
        ),
      )
      .returning({ id: fleetSourceIntent.id });
    return deleted.length;
  });
}

/** Terminal, transaction-local only: never starts/revives consent, never calls ESI.
 * Source/authority generations, evidence, cleanup and audit commit together. */
export async function invalidateFleetSources(
  tx: DbTx,
  locked: LockedFleetLifecycle,
  reason: string,
  actor = "system",
  testNow?: Date,
) {
  const now = await fleetDatabaseNow(tx, testNow);
  for (const source of locked.sources) {
    await tx
      .update(fleetSourceAuthority)
      .set({
        sourceId: null,
        sourceGeneration: null,
        authorityGeneration: sql`${fleetSourceAuthority.authorityGeneration} + 1`,
        linkedCharacters: [],
        verifiedAt: null,
        expiresAt: null,
      })
      .where(
        and(
          eq(fleetSourceAuthority.sourceId, source.id),
          eq(fleetSourceAuthority.sourceGeneration, source.generation),
        ),
      );
    await tx
      .update(fleetSourceIntent)
      .set({
        state: "ended",
        generation: source.generation + 1,
        fetchGeneration: source.fetchGeneration + 1,
        nextFetchAt: null,
        endedAt: now,
        terminalReason: reason,
        retainUntil: new Date(
          Math.max(
            source.retainUntil.getTime(),
            source.intentExpiresAt.getTime() + FLEET_SOURCE_TOMBSTONE_RETENTION_MS,
            now.getTime() + FLEET_SOURCE_TOMBSTONE_RETENTION_MS,
          ),
        ),
      })
      .where(eq(fleetSourceIntent.id, source.id));
    await logAudit(tx, {
      actor,
      action: "fleet_source.ended",
      target: source.id,
      details: { deviceId: source.deviceId, reason },
    });
  }
  for (const t of [fleetTelemetryRow, fleetPublisherLease]) {
    if (!locked.relayCharacterIds.length) continue;
    const s = locked.selectors;
    const predicates = [
      ...locked.sources.map((source) =>
        and(eq(t.sourceId, source.id), eq(t.sourceGeneration, source.generation)),
      ),
      s.characterIds?.length ? inArray(t.characterId, [...s.characterIds]) : undefined,
      s.deviceIds?.length ? inArray(t.deviceId, [...s.deviceIds]) : undefined,
      s.accountIds?.length
        ? inArray(
            t.deviceId,
            tx
              .select({ id: fleetDevice.id })
              .from(fleetDevice)
              .where(inArray(fleetDevice.accountId, [...s.accountIds])),
          )
        : undefined,
    ];
    await tx
      .delete(t)
      .where(
        and(
          inArray(t.characterId, locked.relayCharacterIds),
          s.all ? undefined : (or(...predicates) ?? sql`false`),
        ),
      );
  }
}
