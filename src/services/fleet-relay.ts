import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db, Dbx, DbTx } from "@/db";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetTelemetryRow,
  type StoredCombatEffect,
} from "@/db/schema";
import {
  API_VERSION,
  CombatGetSchema,
  CombatPutSchema,
  CombatPutSuccessSchema,
  CharacterNameSchema,
  FLEET_V2_BYTE_LIMITS,
  Int4Schema,
  UuidV4Schema,
  checkedDateAdd,
  type CombatRow,
} from "@/core/fleet-api-v2";
import { COMBAT_LIMITS } from "@/core/fleet-combat-profile";
import type { FleetCode, SignedFleetCall } from "@/core/fleet-sharing";
import { serializeFleetV2Json } from "@/lib/fleet-api-v2";
import {
  prepareSharedAdmission,
  sharedDeviceAllowed,
  combatPublisherAllowed,
} from "@/services/fleet-shared-admission";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import { fleetDatabaseNow } from "@/services/fleet-key-identity";
import {
  fleetLifecycleTransaction,
  FleetLifecycleRetry,
} from "@/services/fleet-lifecycle";
import {
  buildDeviceCatalogue,
  type DeviceCatalogue,
  sharedCharacterEligibility,
} from "@/services/fleet-eligibility";

/** Sole combat relay. No disabled-mode payload reader/writer or format selector.
 * Routes authenticate exact bytes; this service independently prepares current
 * identity/account/source/device/session/participation authority after ALL waits.
 *
 * LOCK ORDER: mode -> identity/character -> accounts -> authority -> sources ->
 * devices -> sessions -> ascending UNION relay characters (advisory class 2,
 * then lease/row locks). prepareSharedAdmission owns bounded discovery/rechecks.
 * New earlier dependencies retry the OUTER transaction, never a savepoint while
 * retaining later locks. Revocation and source lifecycle use the same order.
 * Device locks serialize replacements across multiple sessions of that device.
 * Expiry pruning needs only the last level, never the reverse of this order.
 */

// Remaining v1 control routes are retired by the following framing slice. This
// constant is not the representation/version of this module's combat payload.
export const FLEET_RELAY_PROTOCOL = 1;
export const FLEET_RELAY_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  invalid_session: 401,
  invalid_batch: 400,
  character_not_linked: 403,
  character_not_eligible: 403,
  lease_conflict: 409,
  revision_replayed: 409,
  rate_limited: 429,
  forbidden: 403,
  not_eligible: 403,
  try_again: 503,
  unauthorized: 401,
  feature_disabled: 503,
  capability_required: 403,
  fleet_read_required: 403,
  conflict: 409,
  invalid_intent: 400,
  service_unavailable: 503,
};
const MIN_REQUEST_INTERVAL_MS = 500;
const RELAY_CHARACTER_LOCK_CLASS = 2;
export class RelayRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const RETRYABLE_PG_SQLSTATES = new Set(["40001", "40P01"]);
/** Drizzle wraps driver SQLSTATE in .cause. Preserve unexpected error context. */
export function isRetryableRelayError(err: unknown): boolean {
  const hasCode = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    RETRYABLE_PG_SQLSTATES.has(value.code);
  return (
    hasCode(err) ||
    hasCode(
      typeof err === "object" && err !== null && "cause" in err ? err.cause : undefined,
    )
  );
}
function sessionKey(rawSessionId: string): string {
  return createHash("sha256").update(rawSessionId).digest("base64url");
}

/** Explicit equivalent of CombatRow; sample belongs to the WHOLE replacement.
 * No optional legacy fields and no default measurement/activity are permitted. */
export type PublishedRow = {
  characterId: number;
  outgoingDps: number | null;
  incomingDps: number | null;
  activityAgeMs: number;
  effects: readonly {
    kind: "SCRAM" | "POINT" | "NEUT";
    observations: readonly { name: string | null; ageMs: number }[];
  }[];
};
export type RelayReadRow = PublishedRow & {
  publicationId: string;
  characterName: string;
  state: "live" | "stale";
  ageMs: number;
};
function wireRow(row: PublishedRow): CombatRow {
  return {
    character_id: row.characterId,
    outgoing_dps: row.outgoingDps,
    incoming_dps: row.incomingDps,
    activity_age_ms: row.activityAgeMs,
    effects: row.effects.map((effect) => ({
      kind: effect.kind,
      observations: effect.observations.map((observation) => ({
        name: observation.name,
        age_ms: observation.ageMs,
      })),
    })),
  };
}
function validPublication(sampledAtMs: number, rows: readonly PublishedRow[]): boolean {
  try {
    const value = {
      protocol: API_VERSION,
      sampled_at_ms: sampledAtMs,
      rows: rows.map(wireRow),
    };
    return (
      CombatPutSchema.safeParse(value).success &&
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
        FLEET_V2_BYTE_LIMITS.snapshotPut.requestBytes
    );
  } catch {
    // An internal DTO still crosses a validation boundary; malformed shape must
    // refuse the whole replacement, not throw midway through row processing.
    return false;
  }
}
function fromStored(row: typeof fleetTelemetryRow.$inferSelect): PublishedRow {
  try {
    const result: PublishedRow = {
      characterId: row.characterId,
      outgoingDps: row.outgoingDps,
      incomingDps: row.incomingDps,
      activityAgeMs: row.sampledAtMs - row.activityOriginMs,
      effects: row.effects.map((effect) => ({
        kind: effect.kind,
        observations: effect.observations.map((o) => ({
          name: o.name,
          ageMs: row.sampledAtMs - o.origin_ms,
        })),
      })),
    };
    if (validPublication(row.sampledAtMs, [result])) return result;
  } catch {
    // Schema drift/corrupt selected JSON is an output refusal, never a subset.
  }
  throw new RelayRefusal("service_unavailable");
}
function relayFailure(err: unknown): { ok: false; code: FleetCode } {
  if (err instanceof FleetLifecycleRetry || isRetryableRelayError(err))
    return { ok: false, code: "service_unavailable" };
  // The shared-admission and combat paths emit the closed common vocabulary.
  if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
  throw err;
}

/** Advisory lock covers first publication (no row exists to FOR UPDATE).
 * One ascending union across all devices/characters prevents cleanup/publish
 * deadlocks. A per-device ascending loop is NOT globally ascending. */
export async function lockFleetCharactersAscending(
  tx: DbTx,
  characterIds: readonly number[],
): Promise<ReadonlyMap<number, typeof fleetPublisherLease.$inferSelect>> {
  const leases = new Map<number, typeof fleetPublisherLease.$inferSelect>();
  for (const characterId of [...new Set(characterIds)].sort((a, b) => a - b)) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RELAY_CHARACTER_LOCK_CLASS}, hashint8(${characterId}))`,
    );
    const [lease] = await tx
      .select()
      .from(fleetPublisherLease)
      .where(eq(fleetPublisherLease.characterId, characterId))
      .for("update");
    await tx
      .select({ characterId: fleetTelemetryRow.characterId })
      .from(fleetTelemetryRow)
      .where(eq(fleetTelemetryRow.characterId, characterId))
      .for("update");
    if (lease) leases.set(characterId, lease);
  }
  return leases;
}

/** Device-first control gate. Shared relay preparation must NOT call this ahead
 * of its identity/account/source locks. The unlocked session probe discovers
 * only which device to lock; both device and session are rechecked under locks.
 * This helper never consumes cadence; complete output must first be validated. */
export async function gateSignedSession(
  tx: DbTx,
  args: SignedFleetCall & {
    invalidSessionCode: string;
    cadence: "publish" | "read";
    /** V2 device opts into DB anchors; other control families migrate separately. */
    databaseClock?: boolean;
  },
): Promise<{
  session: typeof fleetDeviceSession.$inferSelect;
  device: typeof fleetDevice.$inferSelect;
  now: Date;
  featureEnabled: boolean;
}> {
  const mode = await lockFleetSharingMode(tx);
  const key = sessionKey(args.sessionId);
  const [probe] = await tx
    .select({ deviceId: fleetDeviceSession.deviceId })
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.id, key));
  if (!probe) throw new RelayRefusal(args.invalidSessionCode);
  const [device] = await tx
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.id, probe.deviceId))
    .for("update");
  if (!device || device.revokedAt !== null)
    throw new RelayRefusal(args.invalidSessionCode);
  const [session] = await tx
    .select()
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.id, key))
    .for("update");
  if (!session || session.deviceId !== device.id)
    throw new RelayRefusal(args.invalidSessionCode);
  const now = sampleFleetSessionAdmission(session, {
    ...args,
    now: args.databaseClock ? await fleetDatabaseNow(tx, args.now) : args.now,
  });
  return { session, device, now, featureEnabled: mode.enabled };
}

/** Recheck after later locks; caller carries this SAME instant into writes.
 * Deterministic tests may inject now; no route supplies its pre-auth clock. */
export function sampleFleetSessionAdmission(
  session: typeof fleetDeviceSession.$inferSelect,
  args: {
    revision: number;
    now?: Date;
    invalidSessionCode: string;
    cadence: "read" | "publish";
  },
): Date {
  const now = args.now ?? new Date();
  if (session.expiresAt.getTime() <= now.getTime())
    throw new RelayRefusal(args.invalidSessionCode);
  if (!Int4Schema.safeParse(args.revision).success)
    throw new RelayRefusal("invalid_intent");
  if (args.revision <= session.lastRevision) throw new RelayRefusal("revision_replayed");
  const lastAt = args.cadence === "publish" ? session.lastPublishAt : session.lastReadAt;
  if (lastAt !== null && now.getTime() - lastAt.getTime() < MIN_REQUEST_INTERVAL_MS)
    throw new RelayRefusal("rate_limited");
  return now;
}
export async function commitSessionCadence(
  tx: DbTx,
  sessionId: string,
  args: { revision: number; now: Date; cadence: "publish" | "read" },
): Promise<void> {
  await tx
    .update(fleetDeviceSession)
    .set(
      args.cadence === "publish"
        ? { lastRevision: args.revision, lastPublishAt: args.now }
        : { lastRevision: args.revision, lastReadAt: args.now },
    )
    .where(eq(fleetDeviceSession.id, sessionId));
}

/** Atomic DEVICE replacement including nonempty omissions. Checks happen before
 * any row/lease/revision mutation. Source proofs, link epochs and participation
 * remain the single authority supplied by prepareSharedAdmission. */
export async function replaceDeviceProjection(
  dbx: Db,
  args: SignedFleetCall & { sampledAtMs: number; rows: readonly PublishedRow[] },
): Promise<{ ok: true; json: string } | { ok: false; code: FleetCode }> {
  if (
    !Int4Schema.safeParse(args.revision).success ||
    !validPublication(args.sampledAtMs, args.rows)
  )
    return { ok: false, code: "bad_request" };
  try {
    const json = await fleetLifecycleTransaction(dbx, async (tx) => {
      const p = await prepareSharedAdmission(
        tx,
        args,
        "publish",
        args.rows.map((r) => r.characterId),
      );
      const { device, session } = p.actor;
      if (args.rows.length && !sharedDeviceAllowed(p, device.id, session.id))
        throw new RelayRefusal("forbidden");
      if (args.rows.length && !combatPublisherAllowed(p, device.id, session.id))
        throw new RelayRefusal("capability_required");
      const eligible = sharedCharacterEligibility(p);
      const nowMs = p.now.getTime();
      if (
        args.rows.length &&
        (nowMs < args.sampledAtMs ||
          nowMs - args.sampledAtMs >= COMBAT_LIMITS.transport_ms)
      )
        throw new RelayRefusal("bad_request");
      const leases = new Map(p.leases.map((l) => [l.characterId, l]));
      const admitted = args.rows.map((row) => {
        const ch = p.identities.find((ch) => ch.id === row.characterId);
        if (ch?.accountId !== device.accountId) throw new RelayRefusal("forbidden");
        const e = eligible.get(row.characterId);
        if (!e) throw new RelayRefusal("not_verified");
        const activityOriginMs = args.sampledAtMs - row.activityAgeMs;
        if (nowMs - activityOriginMs >= COMBAT_LIMITS.activity_ms)
          throw new RelayRefusal("bad_request");
        const lease = leases.get(row.characterId);
        if (lease && lease.deviceId !== device.id && lease.leaseExpiresAt > p.now)
          throw new RelayRefusal("conflict");
        // Date additions must remain canonical even if current authority would
        // otherwise shorten the result. Never wrap/clamp an unsupported clock.
        const sampleIso = new Date(args.sampledAtMs).toISOString();
        const hard = checkedDateAdd(sampleIso, COMBAT_LIMITS.transport_ms);
        const stale = checkedDateAdd(sampleIso, COMBAT_LIMITS.stale_ms);
        if (!hard || !stale) throw new RelayRefusal("service_unavailable");
        const hardExpiresAt = new Date(
          Math.min(Date.parse(hard), e.expiresAt.getTime(), session.expiresAt.getTime()),
        );
        const staleAt = new Date(Math.min(Date.parse(stale), hardExpiresAt.getTime()));
        const effects: StoredCombatEffect[] = row.effects.flatMap((effect) => {
          const observations = effect.observations
            .map((o) => ({ name: o.name, origin_ms: args.sampledAtMs - o.ageMs }))
            .filter((o) => nowMs - o.origin_ms < COMBAT_LIMITS.activity_ms);
          return observations.length ? [{ kind: effect.kind, observations }] : [];
        });
        return { row, e, activityOriginMs, effects, staleAt, hardExpiresAt };
      });
      const output = serializeFleetV2Json(
        { protocol: API_VERSION },
        CombatPutSuccessSchema,
        FLEET_V2_BYTE_LIMITS.snapshotPut.successBytes,
      );
      if (!output.ok) throw new RelayRefusal(output.code);
      const submitted = new Set(args.rows.map((r) => r.characterId));
      const toWithdraw = [
        ...new Set([
          ...p.leases.filter((l) => l.deviceId === device.id).map((l) => l.characterId),
          ...p.rows.filter((r) => r.deviceId === device.id).map((r) => r.characterId),
        ]),
      ].filter((id) => !submitted.has(id));
      // Use re-locked ownership, never pre-lock probes. Device-qualified deletes
      // cannot remove another device's newly acquired lease after a wait.
      if (toWithdraw.length) {
        await tx
          .delete(fleetTelemetryRow)
          .where(
            and(
              inArray(fleetTelemetryRow.characterId, toWithdraw),
              eq(fleetTelemetryRow.deviceId, device.id),
            ),
          );
        await tx
          .delete(fleetPublisherLease)
          .where(
            and(
              inArray(fleetPublisherLease.characterId, toWithdraw),
              eq(fleetPublisherLease.deviceId, device.id),
            ),
          );
      }
      for (const {
        row,
        e,
        activityOriginMs,
        effects,
        staleAt,
        hardExpiresAt,
      } of admitted) {
        const provenance = {
          fleetId: e.fleetId,
          deviceId: device.id,
          sessionId: session.id,
          sourceId: e.sourceId,
          sourceGeneration: e.sourceGeneration,
          authorityGeneration: e.authorityGeneration,
          linkEpoch: e.linkEpoch,
          participationGeneration: device.participationGeneration,
        };
        const lease = { ...provenance, leaseExpiresAt: hardExpiresAt };
        await tx
          .insert(fleetPublisherLease)
          .values({ characterId: row.characterId, ...lease })
          .onConflictDoUpdate({ target: fleetPublisherLease.characterId, set: lease });
        // Per ROW, not per batch: IDs cannot reveal cross-character grouping.
        const publication = {
          ...provenance,
          publicationId: randomUUID(),
          sampledAtMs: args.sampledAtMs,
          activityOriginMs,
          outgoingDps: row.outgoingDps,
          incomingDps: row.incomingDps,
          effects,
          receivedAt: p.now,
          staleAt,
          hardExpiresAt,
        };
        await tx
          .insert(fleetTelemetryRow)
          .values({ characterId: row.characterId, ...publication })
          .onConflictDoUpdate({
            target: fleetTelemetryRow.characterId,
            set: publication,
          });
      }
      await commitSessionCadence(tx, session.id, {
        revision: args.revision,
        now: p.now,
        cadence: "publish",
      });
      return output.json;
    });
    return { ok: true, json };
  } catch (err) {
    return relayFailure(err);
  }
}

/** Independent cleanup, with the same ascending last-level lock discipline.
 * Reads do NOT clean up: expired/revoked retained rows remain inert evidence. */
export async function pruneExpiredFleetRelay(dbx: Dbx, now: Date): Promise<void> {
  await dbx.transaction(async (tx) => {
    const [expiredTelemetry, expiredLeases] = await Promise.all([
      tx
        .select({ characterId: fleetTelemetryRow.characterId })
        .from(fleetTelemetryRow)
        .where(lte(fleetTelemetryRow.hardExpiresAt, now)),
      tx
        .select({ characterId: fleetPublisherLease.characterId })
        .from(fleetPublisherLease)
        .where(lte(fleetPublisherLease.leaseExpiresAt, now)),
    ]);
    await lockFleetCharactersAscending(
      tx,
      [...expiredTelemetry, ...expiredLeases].map((r) => r.characterId),
    );
    await tx.delete(fleetTelemetryRow).where(lte(fleetTelemetryRow.hardExpiresAt, now));
    await tx
      .delete(fleetPublisherLease)
      .where(lte(fleetPublisherLease.leaseExpiresAt, now));
  });
}

/** Flat authorized fleet union, not a roster. Receiver shared-read permission
 * is unchanged; combat consent belongs only to publishers. Filter authority and
 * expiry first, then validate selected payloads WHOLE before disclosure/cadence.
 * Return the exact compact validated JSON, not a post-commit reserialization. */
export async function readFleetProjection(
  dbx: Db,
  args: SignedFleetCall,
): Promise<
  | { ok: true; rows: readonly RelayReadRow[]; serverTimeMs: number; json: string }
  | { ok: false; code: FleetCode }
> {
  try {
    const value = await fleetLifecycleTransaction(dbx, async (tx) => {
      const p = await prepareSharedAdmission(tx, args, "read");
      if (!sharedDeviceAllowed(p, p.actor.device.id, p.actor.session.id))
        throw new RelayRefusal("forbidden");
      const eligible = sharedCharacterEligibility(p);
      const fleets = new Set(
        p.owned.flatMap((ch) => {
          const e = eligible.get(ch.id);
          return e ? [e.fleetId] : [];
        }),
      );
      if (!fleets.size) throw new RelayRefusal("forbidden");
      const rows: RelayReadRow[] = [];
      const serverTimeMs = p.now.getTime();
      for (const row of p.rows) {
        const e = eligible.get(row.characterId);
        const publisher = p.devices.find((d) => d.id === row.deviceId);
        const ch = p.identities.find((c) => c.id === row.characterId);
        const lease = p.leases.find((l) => l.characterId === row.characterId);
        if (
          !e ||
          !fleets.has(e.fleetId) ||
          !publisher ||
          !ch ||
          ch.accountId !== publisher.accountId ||
          !combatPublisherAllowed(p, publisher.id, row.sessionId) ||
          row.receivedAt > p.now ||
          row.hardExpiresAt <= p.now ||
          !lease ||
          lease.leaseExpiresAt <= p.now ||
          lease.deviceId !== row.deviceId ||
          lease.sessionId !== row.sessionId ||
          lease.fleetId !== row.fleetId ||
          row.fleetId !== e.fleetId
        )
          continue;
        // Both retained objects must still name precisely the current proof.
        if (
          ![row, lease].every(
            (r) =>
              r.sourceId === e.sourceId &&
              r.sourceGeneration === e.sourceGeneration &&
              r.authorityGeneration === e.authorityGeneration &&
              r.linkEpoch === e.linkEpoch &&
              r.participationGeneration === publisher.participationGeneration,
          )
        )
          continue;
        const ageMs = serverTimeMs - row.sampledAtMs;
        const activityAgeMs = serverTimeMs - row.activityOriginMs;
        if (
          ageMs >= COMBAT_LIMITS.transport_ms ||
          activityAgeMs >= COMBAT_LIMITS.activity_ms
        )
          continue;
        const original = fromStored(row);
        if (
          !CharacterNameSchema.safeParse(ch.name).success ||
          !UuidV4Schema.safeParse(row.publicationId).success
        )
          throw new RelayRefusal("service_unavailable");
        rows.push({
          ...original,
          publicationId: row.publicationId,
          characterName: ch.name,
          ageMs,
          activityAgeMs,
          state: ageMs < COMBAT_LIMITS.stale_ms ? "live" : "stale",
          effects: row.effects.flatMap((effect) => {
            const observations = effect.observations
              .map((o) => ({ name: o.name, ageMs: serverTimeMs - o.origin_ms }))
              .filter((o) => o.ageMs < COMBAT_LIMITS.activity_ms);
            return observations.length ? [{ kind: effect.kind, observations }] : [];
          }),
        });
      }
      const output = serializeFleetV2Json(
        {
          protocol: API_VERSION,
          server_time_ms: serverTimeMs,
          rows: rows.map((row) => ({
            ...wireRow(row),
            character_name: row.characterName,
            publication_id: row.publicationId,
            state: row.state,
            age_ms: row.ageMs,
          })),
        },
        CombatGetSchema,
        FLEET_V2_BYTE_LIMITS.snapshotGet.successBytes,
      );
      if (!output.ok) throw new RelayRefusal(output.code);
      await commitSessionCadence(tx, p.actor.session.id, {
        revision: args.revision,
        now: p.now,
        cadence: "read",
      });
      return { rows, serverTimeMs, json: output.json };
    });
    return { ok: true, ...value };
  } catch (err) {
    return relayFailure(err);
  }
}

/** Catalogue retains the existing read cadence and session gate. Its v2 framing
 * and complete-output contract are the next serialized integration slice. */
export async function readDeviceCatalogueForSession(
  dbx: Dbx,
  args: SignedFleetCall,
): Promise<{ ok: true; catalogue: DeviceCatalogue } | { ok: false; code: string }> {
  try {
    const catalogue = await dbx.transaction(async (tx) => {
      const { session, device, now } = await gateSignedSession(tx, {
        ...args,
        invalidSessionCode: "forbidden",
        cadence: "read",
      });
      const catalogue = await buildDeviceCatalogue(tx, device.accountId);
      await commitSessionCadence(tx, session.id, {
        revision: args.revision,
        now,
        cadence: "read",
      });
      return catalogue;
    });
    return { ok: true, catalogue };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code };
    if (isRetryableRelayError(err)) return { ok: false, code: "try_again" };
    throw err;
  }
}
