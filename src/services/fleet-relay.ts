import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Dbx, DbTx } from "@/db";
import {
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { type Eligibility, readEligibleAccount } from "@/services/fleet-eligibility";

/**
 * The atomic authGD relay core: sparse per-character DPS/EWAR replacement,
 * global per-character publisher leases, server-clock liveness, and a
 * filtered, name-joined read — the only two operations Task 6's routes ever
 * delegate to (Global Constraints: routes never call ESI and never decode a
 * browser session cookie as desktop credentials; they authenticate the
 * signed request, then call exactly one of these two functions).
 *
 * Every non-eligibility-leaking, non-obviously-derivable rule lives here,
 * not in the (thin, Task 6) route layer:
 *   - `replaceDeviceProjection` atomically replaces one DEVICE's entire
 *     sparse projection: any prior row this device is NOT resubmitting is
 *     withdrawn immediately, even for a non-empty batch (brief: "each
 *     accepted request atomically replaces the entire device projection
 *     including non-empty omissions"). A malformed/oversized/duplicate/
 *     ineligible batch is refused as one unit before any lease or row is
 *     touched and before `lastRevision` advances.
 *   - `readFleetProjection` re-resolves the requester's identity and
 *     eligibility on every call and returns only the flat union of rows
 *     from fleets in the requester's OWN unexpired eligibility cache — never
 *     a client-supplied fleet id. A refusal never distinguishes WHY (brief:
 *     "Do not expose why a non-eligible requester failed beyond the generic
 *     API error code") — an unknown/expired session, a revoked device, and
 *     an account with no current fleet all collapse to the same `forbidden`
 *     code. Cadence violations use their own distinct code, since knowing
 *     you were rate-limited leaks nothing about eligibility.
 *
 * `dbx: Dbx` is threaded explicitly as the leading parameter on every
 * exported function, matching every other service in this codebase
 * (`fleet-pairing.ts`, `fleet-eligibility.ts`, `accounts.ts`, ...) rather
 * than this module calling `getDb()` itself — see this task's fix report for
 * why: `getDb()` is called only from route/page/action call sites in this
 * repository (never from `src/services/*`), and its cached pool reads
 * `process.env.DATABASE_URL`, which `tests/helpers/env.ts`'s `BASE_ENV` sets
 * to a deliberately non-connectable placeholder — a `getDb()`-owning service
 * would be untestable through this suite's established `ctx.db` pattern.
 */

/** Echoed by Task 6's routes in every response (`{ protocol: 1, ... }`) —
 * defined here, once, rather than as a magic literal at each route, since
 * this module is the thing whose accepted request/row shape it names. */
export const FLEET_RELAY_PROTOCOL = 1;

const MAX_ROWS_PER_BATCH = 32;
/**
 * A generous, defense-in-depth secondary bound on the parsed `rows` array's
 * own JSON size. The PRIMARY defense against an oversized wire body is Task
 * 6's route layer, which must measure the actual raw request bytes before
 * ever calling `JSON.parse` (this function only ever sees the parsed
 * result, so it cannot see padding/whitespace/duplicate-key bytes a raw
 * body might have carried). In practice `MAX_ROWS_PER_BATCH` rows of
 * `PublishedRow`'s bounded shape (a positive character id, a DPS integer
 * capped at eight digits, an EWAR array with at most one 11-character
 * literal) can never approach this bound on their own — this check exists
 * so a future looser row shape does not silently lose the limit the brief
 * names, not because today's shape can trip it.
 */
const MAX_BODY_BYTES = 8192;
const MIN_DPS = 0;
const MAX_DPS = 10_000_000;
/** Applies identically to publish and read cadence (brief: "publish/read
 *  minimum interval 500 ms") — one constant, checked against each request
 *  kind's own timestamp column on `fleet_device_session`
 *  (`lastPublishAt`/`lastReadAt`). */
const MIN_REQUEST_INTERVAL_MS = 500;
const STALE_AGE_MS = 3_000;
const HARD_EXPIRE_MS = 10_000;
/** Postgres `integer` (int4) max — `fleet_device_session.last_revision`'s
 *  actual column type. Duplicated from `fleet-signature.ts`'s own private
 *  `MAX_REVISION` (not imported: that constant is not exported, and both
 *  copies exist only to independently agree with the same column's real
 *  range, exactly like that module's own comment documents). */
const MAX_REVISION = 2_147_483_647;

/**
 * Advisory-lock class for per-character relay serialization — deliberately
 * a DIFFERENT class than `accounts.ts`'s `CHARACTER_LOCK_CLASS` (1). Both
 * lock the exact same character id for unrelated reasons (account/character
 * identity mutation vs. relay publisher state); giving them separate
 * namespaces means a login flow and a fleet publish for the same character
 * never block each other under this key alone.
 */
const RELAY_CHARACTER_LOCK_CLASS = 2;

/** Internal control-flow signal: thrown by any validation step to abort and
 *  roll back the surrounding transaction, caught once at the outer function
 *  boundary and translated to `{ ok: false, code }`. Never escapes this
 *  module. */
class RelayRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Mirrors `session.ts`'s `sessionKey()` / `fleet-pairing.ts`'s
 *  `hashOpaqueValue()` — the same "store the hash, not the secret"
 *  convention, reimplemented locally rather than imported: each of those
 *  modules already keeps its own private copy of this one-liner rather than
 *  sharing one, and this module follows the same established pattern. The
 *  caller-supplied `sessionId` is always the raw opaque bearer value the
 *  device holds; `fleet_device_session.id` stores only this digest. */
function sessionKey(rawSessionId: string): string {
  return createHash("sha256").update(rawSessionId).digest("base64url");
}

export type PublishedRow = {
  characterId: number;
  dps: number;
  ewar: readonly ["SCRAM/POINT"] | readonly [];
};

export type RelayReadRow = PublishedRow & {
  characterName: string;
  state: "live" | "stale";
  ageMs: number;
};

function isValidEwar(ewar: readonly string[]): boolean {
  if (ewar.length === 0) return true;
  return ewar.length === 1 && ewar[0] === "SCRAM/POINT";
}

/** The DB `CHECK` constraint on `fleet_telemetry_row.ewar` guarantees only
 *  `[]` or `["SCRAM/POINT"]` are ever stored, so this read-side conversion
 *  back to the narrow published union is lossless by construction. */
function toEwar(stored: readonly string[]): PublishedRow["ewar"] {
  return stored.length === 0 ? [] : (["SCRAM/POINT"] as const);
}

/**
 * Pure, DB-free validation of an entire publish request: the revision bound,
 * row count, per-row shape (character id, DPS range, EWAR literal), and
 * duplicate character ids — run BEFORE any database access at all, so a
 * malformed/oversized/duplicate request never opens a transaction, never
 * acquires a lock, and never advances `lastRevision` (brief: reject the
 * whole batch as one unit).
 */
function validatePublishShape(
  revision: number,
  rows: readonly PublishedRow[],
): string | null {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    return "invalid_batch";
  }
  if (rows.length > MAX_ROWS_PER_BATCH) return "invalid_batch";
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > MAX_BODY_BYTES) {
    return "invalid_batch";
  }
  const seen = new Set<number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.characterId) || row.characterId <= 0) {
      return "invalid_batch";
    }
    if (seen.has(row.characterId)) return "invalid_batch";
    seen.add(row.characterId);
    if (!Number.isSafeInteger(row.dps) || row.dps < MIN_DPS || row.dps > MAX_DPS) {
      return "invalid_batch";
    }
    if (!isValidEwar(row.ewar)) return "invalid_batch";
  }
  return null;
}

/** Advisory lock, then (if present) row lock — the exact same two-step
 *  shape `accounts.ts`'s `findCharacterForUpdate` uses for the identical
 *  reason: a `FOR UPDATE` select cannot lock a row that does not exist yet,
 *  so a character's very FIRST publish (no lease/telemetry row on file)
 *  still needs something to serialize two concurrent first-claims. */
async function lockCharacterForRelay(tx: DbTx, characterId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${RELAY_CHARACTER_LOCK_CLASS}, hashint8(${characterId}))`,
  );
}

/** The server-derived current fleet for one of the account's OWN characters:
 *  whichever eligible fleet's roster contains it, in ascending fleet-id
 *  order for a deterministic pick on the (expected to be vanishingly rare)
 *  chance a character's id appears in more than one contributing roster.
 *  `null` means "not currently a member of any fleet this account has fresh
 *  Fleet Read evidence for" — the row is rejected, never guessed. */
function currentFleetIdFor(eligibility: Eligibility, characterId: number): number | null {
  for (const fleetId of eligibility.fleetIds) {
    if (eligibility.rosterByFleet.get(fleetId)?.has(characterId)) return fleetId;
  }
  return null;
}

/**
 * Atomically replaces one device's entire sparse telemetry projection.
 *
 * Validation order (brief Steps 4-5): pure body/revision shape first (no DB
 * access at all); then, inside one transaction, the session (locked) and its
 * owning device (locked — see below); revision-greater-than-`lastRevision`
 * and publish cadence; per-row character ownership (`character.accountId`)
 * and current-fleet membership via `readEligibleAccount`'s materialized
 * cache (unlocked reads, run BEFORE any lease/row is locked, per the brief's
 * explicit "validate ... before acquiring any lease"); THEN, in deterministic
 * ascending character-id order, an advisory lock plus a row lock on every
 * target lease/telemetry row (the union of this request's characters and
 * this DEVICE's existing published characters, so an omitted row from an
 * older, still-live session of the SAME device still withdraws) — where a
 * submitted row's existing lease belongs to a DIFFERENT, still-unexpired
 * device, the whole request refuses. Only once every check has passed does
 * this function delete withdrawn rows, upsert submitted rows/leases, and
 * advance the session's revision/`lastPublishAt` — a single Postgres
 * transaction makes every one of those a no-op if anything above throws.
 *
 * Locking the OWNING DEVICE row (not just the named session) is intentional
 * and goes one step past the brief's literal "lock the session" wording: a
 * single device can hold more than one concurrently valid session (Task 4's
 * "re-pairing... stays idempotent" — a same-account re-pair with the same
 * key issues a second session against the SAME device row), so two publishes
 * naming DIFFERENT sessions of the SAME device would not otherwise serialize
 * against each other at all, defeating "one device projection" atomicity.
 */
export async function replaceDeviceProjection(
  dbx: Dbx,
  args: {
    sessionId: string;
    revision: number;
    rows: readonly PublishedRow[];
    now: Date;
  },
): Promise<{ ok: true } | { ok: false; code: string }> {
  const shapeCode = validatePublishShape(args.revision, args.rows);
  if (shapeCode) return { ok: false, code: shapeCode };

  try {
    await dbx.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.id, sessionKey(args.sessionId)))
        .for("update");
      if (!session || session.expiresAt.getTime() <= args.now.getTime()) {
        throw new RelayRefusal("invalid_session");
      }

      const [device] = await tx
        .select()
        .from(fleetDevice)
        .where(eq(fleetDevice.id, session.deviceId))
        .for("update");
      // Defensive/currently unreachable via the public API: revoking a
      // device (fleet-pairing.ts's `revokeFleetDevice`) deletes its
      // sessions in the SAME transaction, so a revoked device's session row
      // cannot still be found above. Kept as a fail-closed backstop against
      // a future revoke path that stops doing that.
      if (!device || device.revokedAt !== null) {
        throw new RelayRefusal("invalid_session");
      }

      if (args.revision <= session.lastRevision) {
        throw new RelayRefusal("revision_replayed");
      }
      if (
        session.lastPublishAt !== null &&
        args.now.getTime() - session.lastPublishAt.getTime() < MIN_REQUEST_INTERVAL_MS
      ) {
        throw new RelayRefusal("rate_limited");
      }

      // Row eligibility, validated entirely through UNLOCKED reads, before
      // any lease/row lock is acquired (brief Step 4).
      let eligibility: Eligibility | null = null;
      if (args.rows.length > 0) {
        eligibility = await readEligibleAccount(tx, device.accountId, args.now);
      }

      const ownerByCharacterId = new Map<number, string>();
      if (args.rows.length > 0) {
        const owners = await tx
          .select({ id: character.id, accountId: character.accountId })
          .from(character)
          .where(
            inArray(
              character.id,
              args.rows.map((r) => r.characterId),
            ),
          );
        for (const o of owners) ownerByCharacterId.set(o.id, o.accountId);
      }

      const fleetIdByCharacterId = new Map<number, number>();
      for (const row of args.rows) {
        if (ownerByCharacterId.get(row.characterId) !== device.accountId) {
          throw new RelayRefusal("character_not_linked");
        }
        const fleetId = eligibility
          ? currentFleetIdFor(eligibility, row.characterId)
          : null;
        if (fleetId === null) throw new RelayRefusal("character_not_eligible");
        fleetIdByCharacterId.set(row.characterId, fleetId);
      }

      // Deterministic ascending lock order over the UNION of submitted
      // character ids and this DEVICE's existing published characters (see
      // this function's own doc comment for why "device", not "session").
      // `existingLeases` is an UNLOCKED, pre-lock snapshot: it exists only to
      // discover WHICH character ids might need a lock, never to decide what
      // gets deleted below — see the withdrawal comment further down for why.
      const existingLeases = await tx
        .select({ characterId: fleetPublisherLease.characterId })
        .from(fleetPublisherLease)
        .where(eq(fleetPublisherLease.deviceId, device.id));
      const submittedIds = args.rows.map((r) => r.characterId);
      const existingIds = existingLeases.map((l) => l.characterId);
      const allIds = [...new Set([...submittedIds, ...existingIds])].sort(
        (a, b) => a - b,
      );

      const leaseByCharacterId = new Map<
        number,
        typeof fleetPublisherLease.$inferSelect
      >();
      for (const characterId of allIds) {
        await lockCharacterForRelay(tx, characterId);
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
        if (lease) leaseByCharacterId.set(characterId, lease);
      }

      const submittedIdSet = new Set(submittedIds);
      for (const row of args.rows) {
        const lease = leaseByCharacterId.get(row.characterId);
        if (
          lease &&
          lease.deviceId !== device.id &&
          lease.leaseExpiresAt.getTime() > args.now.getTime()
        ) {
          throw new RelayRefusal("lease_conflict");
        }
      }

      // Every check above passed: mutate. Withdraw only characters that are
      // BOTH not resubmitted AND, per the lock just taken above, STILL
      // currently leased to THIS device — never decided from the pre-lock
      // `existingIds` snapshot alone. A character can legitimately change
      // owners between that early, unlocked snapshot and this device's own
      // lock acquisition on it: a DIFFERENT device's publish can validly
      // take over a character whose lease had expired, landing exactly in
      // that window. Withdrawing by the stale snapshot would delete that
      // OTHER device's fresh row instead of this device's own now-absent
      // claim (fix round 1, finding M1).
      const toWithdraw = allIds.filter((id) => {
        if (submittedIdSet.has(id)) return false;
        return leaseByCharacterId.get(id)?.deviceId === device.id;
      });
      if (toWithdraw.length > 0) {
        // Belt-and-suspenders: qualify the delete itself by `deviceId`, so
        // even a future defect in `toWithdraw`'s membership could never
        // delete a row/lease this device does not currently own.
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

      for (const row of args.rows) {
        const fleetId = fleetIdByCharacterId.get(row.characterId);
        if (fleetId === undefined) throw new RelayRefusal("character_not_eligible");
        const leaseExpiresAt = new Date(args.now.getTime() + HARD_EXPIRE_MS);
        await tx
          .insert(fleetPublisherLease)
          .values({
            characterId: row.characterId,
            deviceId: device.id,
            sessionId: session.id,
            fleetId,
            leaseExpiresAt,
          })
          .onConflictDoUpdate({
            target: fleetPublisherLease.characterId,
            set: {
              deviceId: device.id,
              sessionId: session.id,
              fleetId,
              leaseExpiresAt,
            },
          });
        await tx
          .insert(fleetTelemetryRow)
          .values({
            characterId: row.characterId,
            fleetId,
            deviceId: device.id,
            sessionId: session.id,
            dps: row.dps,
            ewar: [...row.ewar],
            receivedAt: args.now,
            staleAt: new Date(args.now.getTime() + STALE_AGE_MS),
            hardExpiresAt: new Date(args.now.getTime() + HARD_EXPIRE_MS),
          })
          .onConflictDoUpdate({
            target: fleetTelemetryRow.characterId,
            set: {
              fleetId,
              deviceId: device.id,
              sessionId: session.id,
              dps: row.dps,
              ewar: [...row.ewar],
              receivedAt: args.now,
              staleAt: new Date(args.now.getTime() + STALE_AGE_MS),
              hardExpiresAt: new Date(args.now.getTime() + HARD_EXPIRE_MS),
            },
          });
      }

      await tx
        .update(fleetDeviceSession)
        .set({ lastRevision: args.revision, lastPublishAt: args.now })
        .where(eq(fleetDeviceSession.id, session.id));
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code };
    throw err;
  }
}

/**
 * Deletes every hard-expired telemetry row and lease, globally — no fleet or
 * account scoping, since this is the same sweep a future worker-owned
 * schedule runs unconditionally (brief Step 7). `readFleetProjection` also
 * calls this on every read so staleness is enforced even between worker
 * ticks, but it is independently exposed and independently correct with NO
 * reader at all: a lease/row's own expiry column is the only thing that
 * decides whether it survives this call.
 */
export async function pruneExpiredFleetRelay(dbx: Dbx, now: Date): Promise<void> {
  await dbx.delete(fleetTelemetryRow).where(lte(fleetTelemetryRow.hardExpiresAt, now));
  await dbx
    .delete(fleetPublisherLease)
    .where(lte(fleetPublisherLease.leaseExpiresAt, now));
}

/**
 * Re-resolves the requester's session, device, and current eligibility on
 * EVERY call (brief Step 6) — nothing about identity or fleet membership is
 * ever cached across calls or trusted from an earlier request. Every
 * refusal reason (unknown/expired session, revoked device, no current fleet
 * eligibility) collapses to the SAME generic `forbidden` code: the brief's
 * explicit instruction not to let a caller distinguish "wrong session" from
 * "right session, not in a fleet" by probing this endpoint. Cadence
 * (`rate_limited`) is a separate, non-leaking code, since it says nothing
 * about who the caller is.
 *
 * In one transaction: locks the session (serializing cadence exactly like
 * the publish path), prunes every hard-expired row/lease globally, then
 * selects only rows whose `fleetId` is one of the requester's OWN eligible
 * fleets — a flat, fleet-id-free union that includes the requester's own
 * published row without any self-exclusion (by design: a Wingman client
 * de-duplicates its own local-vs-remote view downstream, not this service).
 */
export async function readFleetProjection(
  dbx: Dbx,
  args: { sessionId: string; now: Date },
): Promise<{ ok: true; rows: readonly RelayReadRow[] } | { ok: false; code: string }> {
  try {
    const rows = await dbx.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.id, sessionKey(args.sessionId)))
        .for("update");
      if (!session || session.expiresAt.getTime() <= args.now.getTime()) {
        throw new RelayRefusal("forbidden");
      }

      const [device] = await tx
        .select()
        .from(fleetDevice)
        .where(eq(fleetDevice.id, session.deviceId));
      // Defensive/currently unreachable, mirroring the same check in
      // `replaceDeviceProjection` — see that function's comment.
      if (!device || device.revokedAt !== null) {
        throw new RelayRefusal("forbidden");
      }

      if (
        session.lastReadAt !== null &&
        args.now.getTime() - session.lastReadAt.getTime() < MIN_REQUEST_INTERVAL_MS
      ) {
        throw new RelayRefusal("rate_limited");
      }

      const eligibility = await readEligibleAccount(tx, device.accountId, args.now);
      if (!eligibility) throw new RelayRefusal("forbidden");

      await pruneExpiredFleetRelay(tx, args.now);

      const joined = await tx
        .select({
          characterId: fleetTelemetryRow.characterId,
          dps: fleetTelemetryRow.dps,
          ewar: fleetTelemetryRow.ewar,
          receivedAt: fleetTelemetryRow.receivedAt,
          characterName: character.name,
        })
        .from(fleetTelemetryRow)
        .innerJoin(character, eq(character.id, fleetTelemetryRow.characterId))
        .where(
          and(
            inArray(fleetTelemetryRow.fleetId, [...eligibility.fleetIds]),
            gt(fleetTelemetryRow.hardExpiresAt, args.now),
          ),
        );

      await tx
        .update(fleetDeviceSession)
        .set({ lastReadAt: args.now })
        .where(eq(fleetDeviceSession.id, session.id));

      return joined.map((r): RelayReadRow => {
        const ageMs = args.now.getTime() - r.receivedAt.getTime();
        return {
          characterId: r.characterId,
          dps: r.dps,
          ewar: toEwar(r.ewar),
          characterName: r.characterName,
          state: ageMs < STALE_AGE_MS ? "live" : "stale",
          ageMs,
        };
      });
    });
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code };
    throw err;
  }
}
