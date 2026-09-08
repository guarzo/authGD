import { createHash } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import type { DbTx } from "@/db";
import {
  account,
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
} from "@/db/schema";
import { SHARED_CAPABILITY, type SignedFleetCall } from "@/core/fleet-sharing";
import {
  fleetDatabaseNow,
  resolveFleetDeviceKey,
  FleetDeviceKeyUnavailableError,
} from "@/services/fleet-key-identity";
import {
  FleetLifecycleRetry,
  hasUsableFleetRead,
  lockFleetAccounts,
  lockFleetAuthoritySlots,
  lockFleetIdentityCharacters,
  lockFleetSourceIntents,
} from "@/services/fleet-lifecycle";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  lockFleetCharactersAscending,
  RelayRefusal,
  sampleFleetSessionAdmission,
} from "@/services/fleet-relay";

/** Aggregate probe/expansion budget, not a publish batch or per-fleet roster cap.
 * Each SQL selector requests a sentinel; exceeding a bound refuses the operation,
 * never returns a partial union. A retry starts a fresh OUTER transaction. */
export const MAX_SHARED_ADMISSION_ITEMS = 8192;
class Budget {
  remaining = MAX_SHARED_ADMISSION_ITEMS;
  take<T>(rows: T[]): T[] {
    this.remaining -= rows.length;
    if (this.remaining < 0) throw new RelayRefusal("service_unavailable");
    return rows;
  }
}
function unique<T extends string | number>(ids: readonly T[]): T[] {
  const result = [...new Set(ids)];
  if (result.length > MAX_SHARED_ADMISSION_ITEMS)
    throw new RelayRefusal("service_unavailable");
  return result;
}
const present = <T>(v: T | null): v is T => v !== null;
type Kind = "publish" | "read" | "eligibility";

/** Flatten ONLY relevant retained pairs in SQL, with a complete aggregate limit.
 * In particular, competing fleets are searched globally, not in the initial
 * receiver union. Authority arrays themselves are schema-bounded at 256. */
async function evidenceFor(tx: DbTx, ids: number[], budget: Budget) {
  if (!ids.length) return [];
  return budget.take(
    await tx
      .select({
        fleetId: fleetSourceAuthority.fleetId,
        sourceId: fleetSourceAuthority.sourceId,
        sourceGeneration: fleetSourceAuthority.sourceGeneration,
        authorityGeneration: fleetSourceAuthority.authorityGeneration,
        verifiedAt: fleetSourceAuthority.verifiedAt,
        expiresAt: fleetSourceAuthority.expiresAt,
        characterId: sql<number>`(link.value->>'characterId')::bigint`.mapWith(Number),
        linkEpoch: sql<string>`link.value->>'linkEpoch'`,
      })
      .from(fleetSourceAuthority)
      .innerJoin(
        sql`jsonb_array_elements(${fleetSourceAuthority.linkedCharacters}) as link(value)`,
        sql`true`,
      )
      .where(inArray(sql`(link.value->>'characterId')::bigint`, ids))
      .limit(budget.remaining + 1),
  );
}

async function probe(tx: DbTx, call: SignedFleetCall, kind: Kind, submitted: number[]) {
  const budget = new Budget();
  const sessionId = createHash("sha256").update(call.sessionId).digest("base64url");
  const [actor] = budget.take(
    await tx
      .select({ device: fleetDevice, session: fleetDeviceSession })
      .from(fleetDeviceSession)
      .innerJoin(fleetDevice, eq(fleetDevice.id, fleetDeviceSession.deviceId))
      .where(eq(fleetDeviceSession.id, sessionId))
      .limit(1),
  );
  if (!actor) throw new RelayRefusal("forbidden");
  const owned = budget.take(
    await tx
      .select({ id: character.id })
      .from(character)
      .where(eq(character.accountId, actor.device.accountId))
      .limit(budget.remaining + 1),
  );
  const anchors = unique([...owned.map((ch) => ch.id), ...submitted]);
  // Initial evidence chooses candidate fleets only; it is not authorization.
  const initial = await evidenceFor(tx, anchors, budget);
  const fleets = unique(initial.map((e) => e.fleetId));
  const rows =
    kind === "eligibility"
      ? []
      : budget.take(
          await tx
            .select()
            .from(fleetTelemetryRow)
            .where(
              kind === "publish"
                ? eq(fleetTelemetryRow.deviceId, actor.device.id)
                : fleets.length
                  ? inArray(fleetTelemetryRow.fleetId, fleets)
                  : sql`false`,
            )
            .limit(budget.remaining + 1),
        );
  const leases =
    kind === "eligibility"
      ? []
      : budget.take(
          await tx
            .select()
            .from(fleetPublisherLease)
            .where(
              kind === "publish"
                ? or(
                    eq(fleetPublisherLease.deviceId, actor.device.id),
                    submitted.length
                      ? inArray(fleetPublisherLease.characterId, submitted)
                      : undefined,
                  )
                : (or(
                    fleets.length
                      ? inArray(fleetPublisherLease.fleetId, fleets)
                      : undefined,
                    rows.length
                      ? inArray(
                          fleetPublisherLease.characterId,
                          rows.map((r) => r.characterId),
                        )
                      : undefined,
                  ) ?? sql`false`),
            )
            .limit(budget.remaining + 1),
        );
  const relayIds = unique([
    ...submitted,
    ...rows.map((r) => r.characterId),
    ...leases.map((r) => r.characterId),
  ]);
  const extra = relayIds.filter((id) => !anchors.includes(id));
  const evidence = [...initial, ...(await evidenceFor(tx, extra, budget))];
  const sourceIds = unique(evidence.map((e) => e.sourceId).filter(present));
  const sources = sourceIds.length
    ? budget.take(
        await tx
          .select()
          .from(fleetSourceIntent)
          .where(inArray(fleetSourceIntent.id, sourceIds))
          .limit(budget.remaining + 1),
      )
    : [];
  const identityIds = unique([
    ...anchors,
    ...relayIds,
    ...sources.map((s) => s.bossCharacterId).filter(present),
  ]);
  budget.take(identityIds);
  const identities = identityIds.length
    ? budget.take(
        await tx
          .select()
          .from(character)
          .where(inArray(character.id, identityIds))
          .limit(budget.remaining + 1),
      )
    : [];
  const deviceIds = unique([
    actor.device.id,
    ...rows.map((r) => r.deviceId),
    ...leases.map((l) => l.deviceId),
    ...sources.map((s) => s.deviceId).filter(present),
  ]);
  const devices = budget.take(
    await tx
      .select()
      .from(fleetDevice)
      .where(inArray(fleetDevice.id, deviceIds))
      .limit(budget.remaining + 1),
  );
  const accountIds = unique([
    ...devices.map((d) => d.accountId),
    ...identities.map((ch) => ch.accountId),
    ...sources.map((s) => s.accountId).filter(present),
  ]);
  const accounts = accountIds.length
    ? budget.take(
        await tx
          .select()
          .from(account)
          .where(inArray(account.id, accountIds))
          .limit(budget.remaining + 1),
      )
    : [];
  const sessionIds = unique([
    sessionId,
    ...rows.map((r) => r.sessionId),
    ...leases.map((r) => r.sessionId),
  ]);
  const sessions = budget.take(
    await tx
      .select()
      .from(fleetDeviceSession)
      .where(inArray(fleetDeviceSession.id, sessionIds))
      .limit(budget.remaining + 1),
  );
  const fleetIds = unique(evidence.map((e) => e.fleetId));
  return {
    actor,
    owned,
    evidence,
    rows,
    leases,
    sources,
    identities,
    devices,
    accounts,
    sessions,
    identityIds,
    accountIds,
    fleetIds,
    sourceIds,
    deviceIds,
    sessionIds,
    relayIds,
  };
}
type Probe = Awaited<ReturnType<typeof probe>>;
function selectors(p: Probe) {
  return JSON.stringify(
    [
      p.identityIds,
      p.accountIds,
      p.fleetIds,
      p.sourceIds,
      p.deviceIds,
      p.sessionIds,
      p.relayIds,
    ].map((ids) => [...ids].sort()),
  );
}

/** Caller holds mode, chosen BEFORE any device-first gate. No cleanup selectors,
 * no key-index FOR UPDATE, no initiating session requirement. Prepared snapshots
 * are re-probed after waits; new earlier dependencies release all locks via the
 * caller's fleetLifecycleTransaction(Db), never via a savepoint retry. */
export async function prepareSharedAdmission(
  tx: DbTx,
  call: SignedFleetCall,
  kind: Kind,
  submitted: number[] = [],
) {
  const mode = await lockFleetSharingMode(tx);
  if (!mode.enabled || mode.keyIdentityPhase !== "ready")
    throw new RelayRefusal("feature_disabled");
  const p = await probe(tx, call, kind, submitted);
  const recheck = async () => {
    const current = await probe(tx, call, kind, submitted);
    if (selectors(current) !== selectors(p)) throw new FleetLifecycleRetry();
    return current;
  };
  await lockFleetIdentityCharacters(tx, p.identityIds);
  await lockFleetAccounts(tx, p.accountIds);
  await recheck();
  await lockFleetAuthoritySlots(tx, p.fleetIds);
  await lockFleetSourceIntents(tx, p.sourceIds);
  await recheck();
  await tx
    .select()
    .from(fleetDevice)
    .where(inArray(fleetDevice.id, p.deviceIds))
    .orderBy(fleetDevice.id)
    .for("update");
  await tx
    .select()
    .from(fleetDeviceSession)
    .where(inArray(fleetDeviceSession.id, p.sessionIds))
    .orderBy(fleetDeviceSession.id)
    .for("update");
  await lockFleetCharactersAscending(tx, p.relayIds);
  const current = await recheck();
  // Canonical index is FK-bearing. Never lock it under accounts; re-read current
  // mappings after every earlier wait and fail closed on conflicts/tombstones.
  const validKeys = new Set<string>();
  for (const device of current.devices) {
    try {
      const key = await resolveFleetDeviceKey(tx, device.publicKeySpkiB64, mode);
      if (!key.unavailable && key.device?.id === device.id) validKeys.add(device.id);
    } catch (err) {
      if (!(err instanceof FleetDeviceKeyUnavailableError)) throw err;
    }
  }
  const now = await fleetDatabaseNow(tx, call.now);
  const prepared = { ...current, validKeys, now };
  if (
    !sharedDeviceAllowed(
      prepared,
      current.actor.device.id,
      current.actor.session.id,
      false,
    )
  )
    throw new RelayRefusal("forbidden");
  sampleFleetSessionAdmission(current.actor.session, {
    ...call,
    now,
    cadence: kind === "publish" ? "publish" : "read",
    invalidSessionCode: "forbidden",
  });
  return prepared;
}
export type SharedAdmission = Probe & { validKeys: Set<string>; now: Date };

export function sharedDeviceAllowed(
  p: SharedAdmission,
  deviceId: string,
  sessionId: string,
  participation = true,
) {
  const d = p.devices.find((row) => row.id === deviceId);
  const s = p.sessions.find((row) => row.id === sessionId);
  return (
    !!d &&
    !d.revokedAt &&
    p.validKeys.has(d.id) &&
    p.accounts.some((a) => a.id === d.accountId && a.tier === "member") &&
    !!s &&
    s.deviceId === d.id &&
    s.expiresAt > p.now &&
    [d.approvedCapabilities, s.approvedCapabilities, s.acknowledgedCapabilities].every(
      (caps) => caps.includes(SHARED_CAPABILITY),
    ) &&
    (!participation || d.participationEnabled)
  );
}

/** Source consent outlives its initiating session and does NOT imply device
 * participation. Only the boss needs a usable Fleet Read credential. */
export function currentSourceEvidence(p: SharedAdmission, e: Probe["evidence"][number]) {
  const s = p.sources.find((source) => source.id === e.sourceId);
  const boss = p.identities.find((ch) => ch.id === s?.bossCharacterId);
  const d = p.devices.find((device) => device.id === s?.deviceId);
  return (
    !!s &&
    s.state === "active" &&
    s.activatedAt !== null &&
    s.activatedAt <= p.now &&
    s.generation === e.sourceGeneration &&
    s.fleetId === e.fleetId &&
    !!boss &&
    boss.accountId === s.accountId &&
    boss.ownerHash === s.bossOwnerHash &&
    boss.fleetLinkEpoch === s.bossLinkEpoch &&
    hasUsableFleetRead(boss) &&
    p.accounts.some((a) => a.id === s.accountId && a.tier === "member") &&
    !!d &&
    !d.revokedAt &&
    d.accountId === s.accountId &&
    p.validKeys.has(d.id) &&
    d.approvedCapabilities.includes(SHARED_CAPABILITY) &&
    e.verifiedAt !== null &&
    e.expiresAt !== null &&
    e.verifiedAt <= p.now &&
    p.now < e.expiresAt &&
    p.now.getTime() - e.verifiedAt.getTime() < 10_000
  );
}
