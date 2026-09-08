import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Db, DbTx } from "@/db";
import {
  character,
  fleetDevice,
  fleetPublisherLease,
  fleetTelemetryRow,
  fleetSourceAuthority,
  fleetSourceIntent,
  outbox,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import type { deriveFleetEvidenceWindow } from "@/core/fleet-freshness";
import { fleetDatabaseNow } from "@/services/fleet-key-identity";
import {
  FleetLifecycleRetry,
  fleetLifecycleTransaction,
  hasUsableFleetRead,
  invalidateFleetSources,
  lockFleetAccounts,
  lockFleetAuthoritySlots,
  lockFleetIdentityCharacters,
  lockFleetLifecycle,
} from "@/services/fleet-lifecycle";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import { enqueueSync } from "@/services/outbox";

export const FLEET_FETCH_CLAIM_MS = 30_000;
export const MAX_FLEET_LINK_SNAPSHOT = 8192;
export class FleetLinkSnapshotOverflow extends Error {
  constructor() {
    super("fleet_link_snapshot_overflow");
  }
}
type Source = typeof fleetSourceIntent.$inferSelect;
type Link = { characterId: number; linkEpoch: string };
export type FleetFetchTicket = {
  source: Source;
  boss: typeof character.$inferSelect;
  fetchGeneration: number;
  claimExpiresAt: Date;
  accessTokenExpiresAt: Date | null;
  expectedAuthorityGeneration: number | null;
  fleetId: number | null;
  linkedCharacters: Link[];
};
type Clock = (() => Date) | undefined;

function selectors(rows: Source[]) {
  return JSON.stringify(
    rows
      .map((s) => [s.id, s.accountId, s.bossCharacterId, s.bossLinkEpoch, s.fleetId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
async function sourceSet(tx: DbTx, id: string, fleetId?: number) {
  const [source] = await tx
    .select()
    .from(fleetSourceIntent)
    .where(eq(fleetSourceIntent.id, id));
  const fleet = source?.fleetId ?? fleetId;
  const predecessors =
    fleet === undefined || fleet === null
      ? []
      : await tx
          .select()
          .from(fleetSourceIntent)
          .where(
            and(
              eq(fleetSourceIntent.fleetId, fleet),
              isNotNull(fleetSourceIntent.activatedAt),
              ne(fleetSourceIntent.state, "ended"),
            ),
          );
  return {
    source,
    fleet,
    rows: [
      ...new Map(
        [...(source ? [source] : []), ...predecessors].map((s) => [s.id, s]),
      ).values(),
    ],
  };
}
/** Probe earlier selectors, lock them in global order, then revalidate. No
 * transaction here survives a provider call. Paused predecessors also participate
 * in handover even when the durable authority slot has already been emptied. */
async function prepare(tx: DbTx, id: string, fleetId?: number, linkedIds: number[] = []) {
  const mode = await lockFleetSharingMode(tx);
  const probe = await sourceSet(tx, id, fleetId);
  const identities = await lockFleetIdentityCharacters(tx, [
    ...linkedIds,
    ...probe.rows.flatMap((s) => (s.bossCharacterId === null ? [] : [s.bossCharacterId])),
  ]);
  const accounts = await lockFleetAccounts(
    tx,
    probe.rows.flatMap((s) => (s.accountId === null ? [] : [s.accountId])),
  );
  if (selectors((await sourceSet(tx, id, fleetId)).rows) !== selectors(probe.rows))
    throw new FleetLifecycleRetry();
  await lockFleetAuthoritySlots(tx, [
    ...probe.rows.flatMap((s) => (s.fleetId === null ? [] : [s.fleetId])),
    ...(probe.fleet === undefined || probe.fleet === null ? [] : [probe.fleet]),
  ]);
  // An intervening handover may discover a new account/device while waiting.
  // Release rather than acquiring its earlier locks from inside this scope.
  if (selectors((await sourceSet(tx, id, fleetId)).rows) !== selectors(probe.rows))
    throw new FleetLifecycleRetry();
  const locked = await lockFleetLifecycle(tx, {
    sourceIds: probe.rows.map((s) => s.id).concat(id),
  });
  const [source] = await tx
    .select()
    .from(fleetSourceIntent)
    .where(eq(fleetSourceIntent.id, id));
  const [authority] =
    probe.fleet === undefined || probe.fleet === null
      ? []
      : await tx
          .select()
          .from(fleetSourceAuthority)
          .where(eq(fleetSourceAuthority.fleetId, probe.fleet));
  if (authority?.sourceId && !probe.rows.some((s) => s.id === authority.sourceId))
    throw new FleetLifecycleRetry();
  const [device] = source?.deviceId
    ? await tx.select().from(fleetDevice).where(eq(fleetDevice.id, source.deviceId))
    : [];
  const boss = source?.bossCharacterId
    ? identities.get(source.bossCharacterId)
    : undefined;
  const owner = source?.accountId ? accounts.get(source.accountId) : undefined;
  return { source, authority, boss, device, owner, mode, identities, locked };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
function consentLoss(p: Prepared): string | null {
  const { source: s, boss, device, owner, mode } = p;
  if (!mode.enabled || mode.keyIdentityPhase !== "ready") return "mode_transition";
  if (
    !s ||
    !boss ||
    boss.accountId !== s.accountId ||
    boss.ownerHash !== s.bossOwnerHash ||
    boss.fleetLinkEpoch !== s.bossLinkEpoch
  )
    return "identity_changed";
  if (owner?.tier !== "member") return "member_lost";
  if (
    !device ||
    device.revokedAt ||
    device.accountId !== s.accountId ||
    !device.approvedCapabilities.includes(SHARED_CAPABILITY)
  )
    return "device_revoked";
  if (!hasUsableFleetRead(boss)) return "fleet_read_invalid";
  return null;
}
async function end(
  tx: DbTx,
  p: Prepared,
  reason: string,
  now: Date,
  ids = [p.source.id],
) {
  await invalidateFleetSources(
    tx,
    {
      ...p.locked,
      sources: p.locked.sources.filter((s) => ids.includes(s.id)),
      selectors: { sourceIds: ids },
    },
    reason,
    "system",
    now,
  );
}
async function validConsent(tx: DbTx, p: Prepared, now: Date) {
  if (!p.source || p.source.state === "ended") return false;
  const reason =
    consentLoss(p) ??
    (p.source.activatedAt === null && now >= p.source.intentExpiresAt ? "expired" : null);
  if (reason) {
    await end(tx, p, reason, now);
    return false;
  }
  return true;
}
function currentTicket(p: Prepared, ticket: FleetFetchTicket) {
  const s = p.source;
  return (
    s &&
    s.state !== "ended" &&
    s.generation === ticket.source.generation &&
    s.fetchGeneration === ticket.fetchGeneration &&
    s.fetchClaimExpiresAt?.getTime() === ticket.claimExpiresAt.getTime()
  );
}
function currentProof(
  p: Prepared,
  ticket: FleetFetchTicket,
  settledTokenEnc: string,
  now: Date,
) {
  return (
    now < ticket.claimExpiresAt &&
    ticket.accessTokenExpiresAt !== null &&
    Number.isFinite(ticket.accessTokenExpiresAt.getTime()) &&
    now < ticket.accessTokenExpiresAt &&
    p.boss!.refreshTokenEnc === settledTokenEnc
  );
}
export async function claimFleetSourceFetch(
  db: Db,
  input: { sourceId: string; generation: number },
  clock?: () => Date,
): Promise<FleetFetchTicket | null> {
  return fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepare(tx, input.sourceId);
    const now = await fleetDatabaseNow(tx, clock?.());
    const s = p.source;
    if (!s || s.generation !== input.generation || !(await validConsent(tx, p, now)))
      return null;
    if (
      !s.nextFetchAt ||
      s.nextFetchAt > now ||
      (s.fetchClaimExpiresAt && s.fetchClaimExpiresAt > now)
    )
      return null;
    const claimExpiresAt = new Date(now.getTime() + FLEET_FETCH_CLAIM_MS);
    await tx
      .update(fleetSourceIntent)
      .set({
        fetchGeneration: s.fetchGeneration + 1,
        fetchClaimExpiresAt: claimExpiresAt,
        lastAttemptAt: now,
        enqueueUntil: null,
      })
      .where(eq(fleetSourceIntent.id, s.id));
    return {
      source: s,
      boss: p.boss!,
      fetchGeneration: s.fetchGeneration + 1,
      claimExpiresAt,
      accessTokenExpiresAt: null,
      expectedAuthorityGeneration: p.authority?.authorityGeneration ?? null,
      fleetId: s.fleetId,
      linkedCharacters: [],
    };
  });
}
export async function bindPendingFleet(
  db: Db,
  ticket: FleetFetchTicket,
  fleetId: number,
  settledTokenEnc: string,
  clock?: () => Date,
  membershipRetryAt?: Date,
): Promise<FleetFetchTicket | null> {
  if (!Number.isSafeInteger(fleetId) || fleetId <= 0) return null;
  return fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepare(tx, ticket.source.id, fleetId);
    const now = await fleetDatabaseNow(tx, clock?.());
    if (!currentTicket(p, ticket) || !(await validConsent(tx, p, now))) return null;
    // Current database consent loss is independent; every upstream decision,
    // including terminal mismatch, additionally needs current postflight proof.
    if (!currentProof(p, ticket, settledTokenEnc, now)) {
      // A fenced body cannot change authority or be cached for later proof.
      // Its valid request-pacing bound still applies to this current claim.
      if (membershipRetryAt && Number.isFinite(membershipRetryAt.getTime()))
        await tx
          .update(fleetSourceIntent)
          .set({
            nextFetchAt: new Date(
              Math.max(p.source.nextFetchAt?.getTime() ?? 0, membershipRetryAt.getTime()),
            ),
          })
          .where(eq(fleetSourceIntent.id, p.source.id));
      return null;
    }
    if (p.source.fleetId !== null && p.source.fleetId !== fleetId) {
      await end(tx, p, "not_in_fleet", now);
      return null;
    }
    // Indexed, bounded pre-I/O epoch snapshot. Overflow is NOT a truncated
    // roster: the worker pauses/clears evidence and schedules a conservative probe.
    const links = await tx
      .select({ characterId: character.id, linkEpoch: character.fleetLinkEpoch })
      .from(character)
      .orderBy(character.id)
      .limit(MAX_FLEET_LINK_SNAPSHOT + 1);
    if (links.length > MAX_FLEET_LINK_SNAPSHOT) throw new FleetLinkSnapshotOverflow();
    if (p.source.fleetId === null)
      await tx
        .update(fleetSourceIntent)
        .set({ fleetId })
        .where(eq(fleetSourceIntent.id, ticket.source.id));
    await tx.insert(fleetSourceAuthority).values({ fleetId }).onConflictDoNothing();
    return {
      ...ticket,
      fleetId,
      boss: { ...p.boss!, refreshTokenEnc: settledTokenEnc },
      linkedCharacters: links,
      expectedAuthorityGeneration: p.authority?.authorityGeneration ?? 0,
    };
  });
}
/** One bounded maintenance candidate, with the same authority/source ordering
 * as observations. Caller limits its scan, not an unbounded DELETE + rowCount. */
export async function maintainFleetSource(
  db: Db,
  sourceId: string,
  enqueue: boolean,
  clock?: () => Date,
): Promise<number> {
  return fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepare(tx, sourceId);
    const now = await fleetDatabaseNow(tx, clock?.());
    if (!(await validConsent(tx, p, now))) return 0;
    const s = p.source;
    const claimExpired = s.fetchClaimExpiresAt !== null && s.fetchClaimExpiresAt <= now;
    const evidenceExpired =
      p.authority?.sourceId === s.id &&
      p.authority?.sourceGeneration === s.generation &&
      p.authority.expiresAt !== null &&
      p.authority.expiresAt <= now;
    if (claimExpired || evidenceExpired) {
      await tx
        .update(fleetSourceAuthority)
        .set({
          sourceId: null,
          sourceGeneration: null,
          linkedCharacters: [],
          verifiedAt: null,
          expiresAt: null,
          authorityGeneration: sql`${fleetSourceAuthority.authorityGeneration} + 1`,
        })
        .where(
          and(
            eq(fleetSourceAuthority.sourceId, s.id),
            eq(fleetSourceAuthority.sourceGeneration, s.generation),
          ),
        );
      for (const table of [fleetTelemetryRow, fleetPublisherLease])
        await tx
          .delete(table)
          .where(and(eq(table.sourceId, s.id), eq(table.sourceGeneration, s.generation)));
      await tx
        .update(fleetSourceIntent)
        .set({
          state: "paused",
          latestOutcome: claimExpired ? "timed_out" : "untrustworthy_evidence",
          ...(claimExpired
            ? { fetchClaimExpiresAt: null, fetchGeneration: s.fetchGeneration + 1 }
            : {}),
        })
        .where(eq(fleetSourceIntent.id, s.id));
    }
    if (
      !enqueue ||
      !s.nextFetchAt ||
      s.nextFetchAt > now ||
      (s.fetchClaimExpiresAt && !claimExpired) ||
      (s.enqueueUntil && s.enqueueUntil > now)
    )
      return 0;
    const [pending] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        sql`${outbox.dispatchedAt} is null and ${outbox.payload}->>'kind' = 'fleet-source' and ${outbox.payload}->>'sourceId' = ${s.id} and ${outbox.payload}->>'generation' = ${String(s.generation)}`,
      )
      .limit(1);
    if (pending) return 0;
    await tx
      .update(fleetSourceIntent)
      .set({ enqueueUntil: new Date(now.getTime() + 10_000) })
      .where(eq(fleetSourceIntent.id, s.id));
    await enqueueSync(tx, {
      kind: "fleet-source",
      sourceId: s.id,
      generation: s.generation,
    });
    return 1;
  });
}

export type FleetSourceObservation =
  | {
      kind: "verified";
      evidence: NonNullable<ReturnType<typeof deriveFleetEvidenceWindow>>;
      memberIds: number[];
      nextFetchAt: Date;
    }
  | {
      kind: "failure";
      reason: "service_unavailable" | "untrustworthy_evidence" | "timed_out";
      nextFetchAt: Date | null;
      terminal?: "not_in_fleet" | "boss_lost" | "fleet_read_invalid" | "identity_changed";
    };
export async function commitFleetSourceObservation(
  db: Db,
  ticket: FleetFetchTicket,
  settledTokenEnc: string,
  observation: FleetSourceObservation,
  clock: Clock = undefined,
): Promise<void> {
  const retained =
    observation.kind === "verified"
      ? ticket.linkedCharacters.filter((ch) =>
          observation.memberIds.includes(ch.characterId),
        )
      : [];
  await fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepare(
      tx,
      ticket.source.id,
      ticket.fleetId ?? undefined,
      retained.map((ch) => ch.characterId),
    );
    const now = await fleetDatabaseNow(tx, clock?.());
    if (!currentTicket(p, ticket) || !(await validConsent(tx, p, now))) return;
    const s = p.source;
    if (
      observation.kind === "failure" &&
      observation.terminal &&
      currentProof(p, ticket, settledTokenEnc, now)
    ) {
      await end(tx, p, observation.terminal, now);
      return;
    }
    let failure = observation.kind === "failure" ? observation.reason : null;
    if (
      now >= ticket.claimExpiresAt ||
      (ticket.accessTokenExpiresAt !== null &&
        (!Number.isFinite(ticket.accessTokenExpiresAt.getTime()) ||
          now >= ticket.accessTokenExpiresAt)) ||
      (observation.kind === "verified" && ticket.accessTokenExpiresAt === null)
    )
      failure = "timed_out";
    if (p.boss!.refreshTokenEnc !== settledTokenEnc) failure = "service_unavailable";
    const a = p.authority;
    if (
      observation.kind === "verified" &&
      (observation.evidence.expiresAt <= now ||
        observation.evidence.observedAt > now ||
        retained.length > 256 ||
        !retained.some((ch) => ch.characterId === s.bossCharacterId))
    )
      failure = "untrustworthy_evidence";
    if (failure !== null) {
      // A refused pending candidate NEVER clears someone else's slot. Advancing
      // an owned slot also fences every older candidate that observed that slot.
      await tx
        .update(fleetSourceAuthority)
        .set({
          sourceId: null,
          sourceGeneration: null,
          linkedCharacters: [],
          verifiedAt: null,
          expiresAt: null,
          authorityGeneration: sql`${fleetSourceAuthority.authorityGeneration} + 1`,
        })
        .where(
          and(
            eq(fleetSourceAuthority.sourceId, s.id),
            eq(fleetSourceAuthority.sourceGeneration, s.generation),
          ),
        );
      for (const table of [fleetTelemetryRow, fleetPublisherLease])
        await tx
          .delete(table)
          .where(and(eq(table.sourceId, s.id), eq(table.sourceGeneration, s.generation)));
      await tx
        .update(fleetSourceIntent)
        .set({
          state: "paused",
          latestOutcome: failure,
          fetchClaimExpiresAt: null,
          enqueueUntil: null,
          nextFetchAt: observation.nextFetchAt,
        })
        .where(eq(fleetSourceIntent.id, s.id));
      return;
    }
    if (
      observation.kind !== "verified" ||
      ticket.fleetId === null ||
      s.fleetId !== ticket.fleetId ||
      !a
    )
      return;
    if (
      a.authorityGeneration !== ticket.expectedAuthorityGeneration ||
      (a.verifiedAt && a.verifiedAt >= observation.evidence.observedAt)
    ) {
      // A cached replay whose origin-based target already passed must not
      // turn the half-second dispatcher tick into a provider polling loop.
      await tx
        .update(fleetSourceIntent)
        .set({
          fetchClaimExpiresAt: null,
          nextFetchAt: new Date(
            Math.max(observation.nextFetchAt.getTime(), now.getTime() + 5000),
          ),
        })
        .where(eq(fleetSourceIntent.id, s.id));
      return;
    }
    const links = retained.filter(
      (ch) => p.identities.get(ch.characterId)?.fleetLinkEpoch === ch.linkEpoch,
    );
    if (!links.some((ch) => ch.characterId === s.bossCharacterId)) return;
    const replacement = a.sourceId !== s.id || a.sourceGeneration !== s.generation;
    const displaced = p.locked.sources.filter(
      (old) => old.id !== s.id && old.fleetId === s.fleetId && old.activatedAt !== null,
    );
    if (displaced.length)
      await end(
        tx,
        p,
        "superseded",
        now,
        displaced.map((old) => old.id),
      );
    await tx
      .update(fleetSourceAuthority)
      .set({
        sourceId: s.id,
        sourceGeneration: s.generation,
        authorityGeneration: a.authorityGeneration + (replacement ? 1 : 0),
        linkedCharacters: links,
        verifiedAt: observation.evidence.observedAt,
        expiresAt: observation.evidence.expiresAt,
      })
      .where(eq(fleetSourceAuthority.fleetId, ticket.fleetId));
    await tx
      .update(fleetSourceIntent)
      .set({
        state: "active",
        activatedAt: s.activatedAt ?? now,
        latestOutcome: "verified",
        fetchClaimExpiresAt: null,
        enqueueUntil: null,
        nextFetchAt: observation.nextFetchAt,
      })
      .where(eq(fleetSourceIntent.id, s.id));
  });
}
