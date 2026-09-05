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
import {
  buildDeviceCatalogue,
  type DeviceCatalogue,
  type Eligibility,
  readEligibleAccount,
} from "@/services/fleet-eligibility";

/**
 * The atomic authGD relay core: sparse per-character DPS/EWAR replacement,
 * global per-character publisher leases, server-clock liveness, and a
 * filtered, name-joined read — the operations every fleet route ever
 * delegates to (Global Constraints: routes never call ESI and never decode a
 * browser session cookie as desktop credentials; they authenticate the
 * signed request, then call exactly one of these functions).
 *
 * Every non-eligibility-leaking, non-obviously-derivable rule lives here,
 * not in the thin route layer:
 *   - `replaceDeviceProjection` atomically replaces one DEVICE's entire
 *     sparse projection: any prior row this device is NOT resubmitting is
 *     withdrawn immediately, even for a non-empty batch (each accepted
 *     request atomically replaces the entire device projection including
 *     non-empty omissions). A malformed/oversized/duplicate/ineligible
 *     batch is refused as one unit before any lease or row is touched and
 *     before `lastRevision` advances.
 *   - `readFleetProjection` re-resolves the requester's identity and
 *     eligibility on every call and returns only the flat union of rows
 *     from fleets in the requester's OWN unexpired eligibility cache — never
 *     a client-supplied fleet id. A refusal never distinguishes WHY (do not
 *     expose why a non-eligible requester failed beyond the generic API
 *     error code) — an unknown/expired session, a revoked device, and an
 *     account with no current fleet all collapse to the same `forbidden`
 *     code. Cadence violations use their own distinct code, since knowing
 *     you were rate-limited leaks nothing about eligibility.
 *   - `readDeviceCatalogueForSession` is the signed-and-gated counterpart to
 *     `readFleetProjection` for the device's OWN character catalogue: same
 *     shared session gate, same read cadence bucket (a device cannot dodge
 *     the read cadence by alternating between the catalogue and snapshot GET
 *     endpoints), no character-scoped lock (it never touches per-character
 *     relay state).
 *
 * `dbx: Dbx` is threaded explicitly as the leading parameter on every
 * exported function, matching every other service in this codebase
 * (`fleet-pairing.ts`, `fleet-eligibility.ts`, `accounts.ts`, ...) rather
 * than this module calling `getDb()` itself: `getDb()` is called only from
 * route/page/action call sites in this repository (never from
 * `src/services/*`), and its cached pool reads `process.env.DATABASE_URL`,
 * which `tests/helpers/env.ts`'s `BASE_ENV` sets to a deliberately
 * non-connectable placeholder — a `getDb()`-owning service would be
 * untestable through this suite's established `ctx.db` pattern.
 *
 * LOCK ORDER (deadlock avoidance), applied top to bottom by every fleet-relay
 * code path that locks any of these tables — `replaceDeviceProjection`,
 * `readFleetProjection`, `readDeviceCatalogueForSession`,
 * `renewFleetDeviceSession` (fleet-pairing.ts), `revokeFleetDevice` /
 * `revokeFleetRelayForAccount` (fleet-pairing.ts), and
 * `pruneExpiredFleetRelay`:
 *   1. `fleetDevice` row FOR UPDATE.
 *   2. `fleetDeviceSession` row(s) FOR UPDATE.
 *   3. `pg_advisory_xact_lock(RELAY_CHARACTER_LOCK_CLASS, characterId)`, then
 *      `fleetPublisherLease` + `fleetTelemetryRow` rows FOR UPDATE, always in
 *      ascending `characterId` order (`lockFleetCharactersAscending`).
 * A path that needs only a SUBSET of these levels still acquires whichever
 * it does need in this same relative order: `pruneExpiredFleetRelay` takes
 * no device/session lock at all (it is not scoped to one device), but the
 * one lock it does take (level 3) is still ascending, so it can never
 * contend against a publish's own level-3 acquisition in the opposite
 * order. Getting the device-before-session half of this order backwards is
 * exactly what used to let a concurrent publish (session locked first, then
 * device) and a concurrent revoke (device locked first, then its
 * sessions/leases/rows touched) deadlock against each other —
 * `gateSignedSession` and `lockFleetCharactersAscending` below are the two
 * functions that now make every path agree on this order instead of each
 * hand-rolling its own.
 *
 * Even with this order in place, Postgres can still report a deadlock or a
 * serialization failure under enough concurrent contention (the detector
 * has to pick a victim among many waiters, or an isolation level above read
 * committed can still abort a transaction that never truly deadlocked).
 * `isRetryableRelayError` and every catch block below turn that into a
 * distinct, retryable `try_again` outcome rather than letting a raw
 * Postgres error escape as an unhandled exception (a bare 500 with a stack
 * trace, from a route's perspective).
 */

/** Echoed by every fleet route in every response (`{ protocol: 1, ... }`) —
 * defined here, once, rather than as a magic literal at each route, since
 * this module is the thing whose accepted request/row shape it names. */
export const FLEET_RELAY_PROTOCOL = 1;

/** The HTTP status every fleet route maps a relay/session refusal code to —
 * one shared table rather than each route redeclaring its own copy (they
 * used to, and the two copies had already started to disagree on nothing in
 * particular). A code with no entry falls back to 400 at the call site. */
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
};

const MAX_ROWS_PER_BATCH = 32;
/**
 * A generous, defense-in-depth secondary bound on the parsed `rows` array's
 * own JSON size. The PRIMARY defense against an oversized wire body is the
 * route layer, which must measure the actual raw request bytes before ever
 * calling `JSON.parse` (this function only ever sees the parsed result, so
 * it cannot see padding/whitespace/duplicate-key bytes a raw body might have
 * carried). In practice `MAX_ROWS_PER_BATCH` rows of `PublishedRow`'s
 * bounded shape (a positive character id, a DPS integer capped at eight
 * digits, an EWAR array with at most one 11-character literal) can never
 * approach this bound on their own — this check exists so a future looser
 * row shape does not silently lose this limit, not because today's shape
 * can trip it.
 */
const MAX_BODY_BYTES = 8192;
const MIN_DPS = 0;
const MAX_DPS = 10_000_000;
/** Applies identically to publish and read cadence (publish/read minimum
 *  interval 500 ms) — one constant, checked against each request kind's own
 *  timestamp column on `fleet_device_session`
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
 *  roll back the surrounding transaction, caught at each exported function's
 *  own outer boundary (in this module, and in `fleet-pairing.ts`'s
 *  `renewFleetDeviceSession`, which shares `gateSignedSession` below) and
 *  translated to `{ ok: false, code }`. Never escapes as a raw exception
 *  past either of those boundaries. */
export class RelayRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** SQLSTATEs Postgres uses for a detected deadlock (`40P01`) and a
 *  serialization failure (`40001`) — both are the database saying "abort
 *  and retry the whole transaction", not "this request is invalid", and
 *  both can still occur even with a consistent lock order under enough
 *  concurrent contention (the deadlock detector has to pick SOME victim
 *  among several waiters). */
const RETRYABLE_PG_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * True for a driver-level error carrying one of `RETRYABLE_PG_SQLSTATES`.
 * `node-postgres` attaches the server's SQLSTATE as a plain `code` string
 * property on the thrown error -- but every query issued through drizzle's
 * typed query builders (`.select()`/`.insert()`/`.update()`/`.delete()`,
 * which is the overwhelming majority of what this module issues; only the
 * advisory-lock calls use raw `tx.execute(sql\`...\`)`) never lets that raw
 * error escape directly: `queryWithCache` (drizzle-orm's `pg-core/session.ts`)
 * always rewraps it as a `DrizzleQueryError`, with the ORIGINAL error on its
 * own `.cause`. Checking only the outer object would silently never match a
 * real deadlock/serialization failure from any of those calls -- this walks
 * one level into `.cause` too, which is exactly as far as that wrapping
 * ever nests here. Defensive either way: never assumes the shape, never
 * throws on a value that is not a plain object at all.
 */
export function isRetryableRelayError(err: unknown): boolean {
  return hasRetryableCode(err) || hasRetryableCode(getCause(err));
}

function hasRetryableCode(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    RETRYABLE_PG_SQLSTATES.has((err as { code: string }).code)
  );
}

function getCause(err: unknown): unknown {
  return typeof err === "object" && err !== null && "cause" in err
    ? (err as { cause?: unknown }).cause
    : undefined;
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
 * acquires a lock, and never advances `lastRevision` (reject the whole batch
 * as one unit).
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

/**
 * Locks every one of the given character ids, ascending, via the shared
 * per-character advisory lock class followed by a FOR UPDATE row lock on
 * both the publisher-lease and telemetry-row tables — the ONE place every
 * fleet-relay code path that touches a character's relay state (publish,
 * revoke, expiry pruning) acquires that lock, so no two of them can ever
 * contend over the same characters in different orders (this module's own
 * LOCK ORDER doc, above). Deduplicates and sorts its own input, so every
 * caller can simply pass whatever union of ids it cares about.
 *
 * Returns whichever of the given ids currently have a publisher lease row,
 * for callers (`replaceDeviceProjection`) that need to inspect it; callers
 * that only need the LOCKS (revoke, pruning) simply ignore the returned map.
 */
export async function lockFleetCharactersAscending(
  tx: DbTx,
  characterIds: readonly number[],
): Promise<ReadonlyMap<number, typeof fleetPublisherLease.$inferSelect>> {
  const leaseByCharacterId = new Map<number, typeof fleetPublisherLease.$inferSelect>();
  for (const characterId of [...new Set(characterIds)].sort((a, b) => a - b)) {
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
  return leaseByCharacterId;
}

/**
 * The one shared gate every signed fleet-relay request passes through
 * before its own kind-specific work begins: publish (`replaceDeviceProjection`),
 * read (`readFleetProjection`, `readDeviceCatalogueForSession`), and session
 * renewal (`fleet-pairing.ts`'s `renewFleetDeviceSession`). All of them
 * authenticate a signed request against the SAME two tables and must never
 * contend over them in different orders (this module's own LOCK ORDER doc),
 * so this is the ONE place that:
 *   - resolves the session's claimed owning device from an UNLOCKED probe
 *     read (just to learn which device row to lock — never trusted on its
 *     own);
 *   - locks the device row FOR UPDATE (LOCK ORDER level 1), checks it exists
 *     and is not revoked;
 *   - re-selects and locks the session row FOR UPDATE (LOCK ORDER level 2;
 *     the probe read is re-verified here, not assumed still true — the same
 *     "lock, then re-check" discipline `replaceDeviceProjection`'s
 *     withdrawal logic documents further down in this file), checks it
 *     exists and has not expired;
 *   - requires `revision` to be strictly greater than this SESSION's own
 *     single monotonic counter — shared by every request kind against this
 *     session, not one counter per kind, so a captured-and-replayed signed
 *     GET is exactly as inert as a replayed PUT;
 *   - applies the caller's own cadence bound against its own timestamp
 *     column (`lastPublishAt` for `cadence: "publish"`, `lastReadAt` for
 *     `cadence: "read"` — shared by every read-shaped request, including a
 *     catalogue fetch and a session renewal, so a device cannot evade the
 *     read cadence by alternating between them).
 *
 * `invalidSessionCode` is the caller's OWN choice of refusal code for
 * "no such session" / "expired" / "device revoked", independent of the
 * cadence bucket: `replaceDeviceProjection` has always answered
 * `invalid_session` here, `readFleetProjection` has always answered
 * `forbidden` (its own non-oracle ruling — an unknown session must not be
 * distinguishable from a real one that merely lacks eligibility), and
 * `renewFleetDeviceSession` reuses `invalid_session` despite sharing the
 * read cadence bucket, since renewal is a session-lifecycle operation in
 * the same sense publish is, not an eligibility-filtered read.
 *
 * Returns the LOCKED session/device rows for the caller to continue with
 * inside the SAME transaction. Every failure throws `RelayRefusal`; this
 * function never mutates anything itself — committing the consumed
 * revision/cadence timestamp (and anything else the caller's own operation
 * changes) is each caller's own job, since exactly WHEN that happens
 * differs by kind (after a publish's row mutations, after a read's query,
 * after a renewal's new expiry).
 */
export async function gateSignedSession(
  tx: DbTx,
  args: {
    sessionId: string;
    revision: number;
    now: Date;
    invalidSessionCode: string;
    cadence: "publish" | "read";
  },
): Promise<{
  session: typeof fleetDeviceSession.$inferSelect;
  device: typeof fleetDevice.$inferSelect;
}> {
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
  if (!session || session.expiresAt.getTime() <= args.now.getTime()) {
    throw new RelayRefusal(args.invalidSessionCode);
  }

  if (args.revision <= session.lastRevision) {
    throw new RelayRefusal("revision_replayed");
  }
  const lastAt = args.cadence === "publish" ? session.lastPublishAt : session.lastReadAt;
  if (
    lastAt !== null &&
    args.now.getTime() - lastAt.getTime() < MIN_REQUEST_INTERVAL_MS
  ) {
    throw new RelayRefusal("rate_limited");
  }

  return { session, device };
}

/** Writes back the SAME two fields `gateSignedSession` just gated on —
 *  `lastRevision` and the cadence column for `cadence` — called by each
 *  caller only once its own operation has otherwise fully succeeded, so a
 *  refused/failed attempt (this function never reached) never advances
 *  either. `renewFleetDeviceSession` (fleet-pairing.ts) does not use this:
 *  it also changes `expiresAt` in the same update, so it writes its own. */
async function commitSessionCadence(
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
 * Validation order: pure body/revision shape first (no DB access at all);
 * then, inside one transaction, `gateSignedSession` (device, then session,
 * per this module's LOCK ORDER doc — revision-greater-than-`lastRevision`
 * and publish cadence); per-row character ownership (`character.accountId`)
 * and current-fleet membership via `readEligibleAccount`'s materialized
 * cache (unlocked reads, run BEFORE any lease/row is locked, validated
 * before acquiring any lease); THEN, in deterministic ascending
 * character-id order, an advisory lock plus a row lock on every target
 * lease/telemetry row (the union of this request's characters and this
 * DEVICE's existing published characters, so an omitted row from an older,
 * still-live session of the SAME device still withdraws) — where a
 * submitted row's existing lease belongs to a DIFFERENT, still-unexpired
 * device, the whole request refuses. Only once every check has passed does
 * this function delete withdrawn rows, upsert submitted rows/leases, and
 * advance the session's revision/`lastPublishAt` — a single Postgres
 * transaction makes every one of those a no-op if anything above throws.
 *
 * Locking the OWNING DEVICE row (not just the named session) is intentional
 * and goes one step past locking only the named session: a single device
 * can hold more than one concurrently valid session (re-pairing stays
 * idempotent — a same-account re-pair with the same key issues a second
 * session against the SAME device row), so two publishes naming DIFFERENT
 * sessions of the SAME device would not otherwise serialize against each
 * other at all, defeating "one device projection" atomicity.
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
      const { session, device } = await gateSignedSession(tx, {
        sessionId: args.sessionId,
        revision: args.revision,
        now: args.now,
        invalidSessionCode: "invalid_session",
        cadence: "publish",
      });

      // Row eligibility, validated entirely through UNLOCKED reads, before
      // any lease/row lock is acquired.
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
      const allIds = [...submittedIds, ...existingLeases.map((l) => l.characterId)];

      const leaseByCharacterId = await lockFleetCharactersAscending(tx, allIds);

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
      // `existingLeases` snapshot alone. A character can legitimately change
      // owners between that early, unlocked snapshot and this device's own
      // lock acquisition on it: a DIFFERENT device's publish can validly
      // take over a character whose lease had expired, landing exactly in
      // that window. Withdrawing by the stale snapshot would delete that
      // OTHER device's fresh row instead of this device's own now-absent
      // claim.
      const toWithdraw = [...leaseByCharacterId.keys()].filter((id) => {
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

      await commitSessionCadence(tx, session.id, {
        revision: args.revision,
        now: args.now,
        cadence: "publish",
      });
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code };
    if (isRetryableRelayError(err)) return { ok: false, code: "try_again" };
    throw err;
  }
}

/**
 * Deletes every hard-expired telemetry row and lease, globally — no fleet or
 * account scoping, since this is the same sweep a future worker-owned
 * schedule runs unconditionally. `readFleetProjection` also calls this on
 * every read so staleness is enforced even between worker ticks, but it is
 * independently exposed and independently correct with NO reader at all: a
 * lease/row's own expiry column is the only thing that decides whether it
 * survives this call.
 *
 * Always runs inside its own transaction (a SAVEPOINT when the caller —
 * `readFleetProjection` — is already inside one), because the character
 * locks below are transaction-scoped: locking, then deleting, only serializes
 * against a concurrent publish's own ascending lock acquisition if both
 * happen inside the SAME transaction. Finds every character id that is about
 * to be swept (from BOTH tables — a lease and its row can, in principle,
 * expire independently), locks all of them ascending via
 * `lockFleetCharactersAscending` (this module's own LOCK ORDER level 3),
 * THEN runs the same two unconditional DELETEs the expiry columns already
 * describe. Without this, a bulk DELETE's own row-lock acquisition order is
 * whatever Postgres's scan happens to pick (`deviceId`/expiry-column scans,
 * not `characterId` order) — exactly the opposite order a concurrent
 * publish's ascending acquisition could be waiting on, which is what let
 * pruning and publish deadlock against each other before this locked the
 * same characters the same way publish does.
 */
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
    const characterIds = [
      ...expiredTelemetry.map((r) => r.characterId),
      ...expiredLeases.map((r) => r.characterId),
    ];
    if (characterIds.length > 0) {
      await lockFleetCharactersAscending(tx, characterIds);
    }
    await tx.delete(fleetTelemetryRow).where(lte(fleetTelemetryRow.hardExpiresAt, now));
    await tx
      .delete(fleetPublisherLease)
      .where(lte(fleetPublisherLease.leaseExpiresAt, now));
  });
}

/**
 * Re-resolves the requester's session, device, and current eligibility on
 * EVERY call — nothing about identity or fleet membership is ever cached
 * across calls or trusted from an earlier request. Every refusal reason
 * (unknown/expired session, revoked device, no current fleet eligibility)
 * collapses to the SAME generic `forbidden` code: a caller must not be able
 * to distinguish "wrong session" from "right session, not in a fleet" by
 * probing this endpoint. Cadence (`rate_limited`) and replay
 * (`revision_replayed`) are separate, non-leaking codes, since neither says
 * anything about who the caller is.
 *
 * In one transaction: gates the signed session (device, then session, per
 * this module's LOCK ORDER doc — this also serializes cadence exactly like
 * the publish path and requires a strictly increasing revision), prunes
 * every hard-expired row/lease globally, then selects only rows whose
 * `fleetId` is one of the requester's OWN eligible fleets — a flat,
 * fleet-id-free union that includes the requester's own published row
 * without any self-exclusion (by design: a Wingman client de-duplicates its
 * own local-vs-remote view downstream, not this service).
 */
export async function readFleetProjection(
  dbx: Dbx,
  args: { sessionId: string; revision: number; now: Date },
): Promise<{ ok: true; rows: readonly RelayReadRow[] } | { ok: false; code: string }> {
  try {
    const rows = await dbx.transaction(async (tx) => {
      const { session, device } = await gateSignedSession(tx, {
        sessionId: args.sessionId,
        revision: args.revision,
        now: args.now,
        invalidSessionCode: "forbidden",
        cadence: "read",
      });

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

      await commitSessionCadence(tx, session.id, {
        revision: args.revision,
        now: args.now,
        cadence: "read",
      });

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
    if (isRetryableRelayError(err)) return { ok: false, code: "try_again" };
    throw err;
  }
}

/**
 * Catalogue-fetch's own gated read: the SAME shared session gate as
 * `readFleetProjection` (`cadence: "read"` — the two share ONE cadence
 * bucket and ONE monotonic revision counter on `fleet_device_session`, so a
 * device cannot dodge the read cadence by alternating between
 * `GET /catalogue` and `GET /snapshot`), then simply returns the device's
 * own account's current `DeviceCatalogue`. No character-scoped lock is ever
 * needed here: `buildDeviceCatalogue` reads only `character`, which this
 * path never mutates.
 */
export async function readDeviceCatalogueForSession(
  dbx: Dbx,
  args: { sessionId: string; revision: number; now: Date },
): Promise<{ ok: true; catalogue: DeviceCatalogue } | { ok: false; code: string }> {
  try {
    const catalogue = await dbx.transaction(async (tx) => {
      const { session, device } = await gateSignedSession(tx, {
        sessionId: args.sessionId,
        revision: args.revision,
        now: args.now,
        invalidSessionCode: "forbidden",
        cadence: "read",
      });
      const catalogue = await buildDeviceCatalogue(tx, device.accountId);
      await commitSessionCadence(tx, session.id, {
        revision: args.revision,
        now: args.now,
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
