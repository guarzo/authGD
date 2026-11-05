import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "@/db";
import {
  account,
  character,
  fleetAutomaticCandidate,
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
  outbox,
  session,
} from "@/db/schema";
import {
  AutomaticCommandSchema,
  AutomaticTaskSchema,
  reconcileAutomaticCandidateBinding,
  AutomaticGetSchema,
  AutomaticOffSchema,
  AutomaticReceiptSchema,
  AutomaticResultSchema,
  BrowserAutomaticViewSchema,
  BrowserOffReplySchema,
  ReceiptGetSchema,
  ReceiptSchema,
  ConsentSchema,
  AUTOMATIC_RECEIPT_TTL_MS,
  AUTOMATIC_INTENT_TTL_MS,
  parseAutomaticResult,
  parseBrowserOffReply,
  parseReceiptGet,
  automaticCandidateAdmissible,
  automaticRetrySchedule,
  isAutomaticCandidateSuspended,
  type AutomaticTask,
  type AutomaticClaim,
  type AutomaticToken,
  type AutomaticRejectedToken,
  type AutomaticBound,
  type AutomaticVerified,
  type AutomaticCommit,
  type AutomaticAuthLossProof,
  type AutomaticRetryFailure,
  type AutomaticCommand,
  type AutomaticGet,
  type AutomaticOff,
  type AutomaticReceipt,
  type AutomaticResult,
  type AutomaticStatus,
  type BrowserAutomaticView,
  type BrowserOffReply,
  type Consent,
  type Receipt,
  type ReceiptGet,
  type SourceStart,
  type SourceStop,
  type StopEffect,
} from "@/core/fleet-automatic";
import {
  FLEET_V2_BYTE_LIMITS,
  ExistingUuidSchema,
  IsoDateSchema,
  PositiveIdSchema,
  SafeCounterSchema,
  UuidV4Schema,
  checkedCounterAdd,
  checkedDateAdd,
} from "@/core/fleet-api-v2";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import {
  SHARED_CAPABILITY,
  validFleetCapabilities,
  type FleetReply,
  type FleetCode,
  type SignedFleetCall,
} from "@/core/fleet-sharing";
import { serializeFleetV2Json } from "@/lib/fleet-api-v2";
import { logAudit } from "@/services/audit";
import {
  fleetDatabaseNow,
  lockFleetDeviceKey,
  resolveFleetDeviceKey,
  FleetDeviceKeyUnavailableError,
} from "@/services/fleet-key-identity";
import {
  FleetLifecycleRetry,
  FLEET_SOURCE_INTENT_TTL_MS,
  FLEET_SOURCE_TOMBSTONE_RETENTION_MS,
  fleetLifecycleTransaction,
  hasUsableFleetRead,
  invalidateFleetSources,
  lockFleetAccounts,
  lockFleetAuthoritySlots,
  lockFleetIdentityCharacters,
  lockFleetLifecycle,
} from "@/services/fleet-lifecycle";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  commitSessionCadence,
  isRetryableRelayError,
  RelayRefusal,
  sampleFleetSessionAdmission,
} from "@/services/fleet-relay";
import { currentSourceEvidence } from "@/services/fleet-shared-admission";
import {
  FleetLinkSnapshotOverflow,
  MAX_FLEET_LINK_SNAPSHOT,
  applyFleetAuthorityProof,
  FleetAuthorityProofRefusal,
} from "@/services/fleet-source-observation";
import { enqueueSync } from "@/services/outbox";

const AutomaticTaskInput = AutomaticTaskSchema;
const internalDate = z
  .date()
  .refine((d) => d.getTime() >= 0 && IsoDateSchema.safeParse(d.toISOString()).success);
// The rest of Boss is a detached existing character row, not an extra authority
// namespace. Validate every field used by these guards without duplicating its
// unrelated contacts/location storage schema.
const AutomaticClaimInput = z
  .object({
    task: AutomaticTaskInput,
    consentRevision: PositiveIdSchema,
    approverDeviceId: ExistingUuidSchema,
    boss: z
      .object({
        id: PositiveIdSchema,
        accountId: ExistingUuidSchema,
        ownerHash: z.string(),
        fleetLinkEpoch: ExistingUuidSchema,
        refreshTokenEnc: z.string().nullable(),
        scopes: z.array(z.string()),
        tokenStatus: z.enum(["valid", "invalid", "needs_reauth", "missing"]),
      })
      .passthrough(),
    claimGeneration: PositiveIdSchema,
    claimExpiresAt: internalDate,
  })
  .strict();
const tokenFields = {
  claim: AutomaticClaimInput,
  settledTokenEnc: z.string().min(1),
  accessTokenExpiresAt: internalDate,
};
const AutomaticTokenInput = z
  .object({ admission: z.literal("admitted"), ...tokenFields })
  .strict();
const AutomaticRejectedInput = z
  .object({ admission: z.literal("rejected"), ...tokenFields })
  .strict();
const AutomaticBoundInput = z
  .object({
    token: AutomaticTokenInput,
    fleetId: PositiveIdSchema,
    linkedCharacters: z
      .array(
        z
          .object({ characterId: PositiveIdSchema, linkEpoch: ExistingUuidSchema })
          .strict(),
      )
      .max(8192),
    expectedAuthorityGeneration: SafeCounterSchema.max(2147483647),
    membershipRetryAt: internalDate,
  })
  .strict();
const AutomaticVerifiedInput = z
  .object({
    evidence: z
      .object({
        observedAt: internalDate,
        expiresAt: internalDate,
        nextFetchAt: internalDate,
      })
      .strict(),
    memberIds: z.array(PositiveIdSchema),
    nextFetchAt: internalDate,
  })
  .strict();
const AutomaticAuthLossInput = z.discriminatedUnion("cause", [
  z
    .object({
      cause: z.enum([
        "verified_scope_missing",
        "verified_subject_mismatch",
        "verified_owner_mismatch",
      ]),
      rejected: AutomaticRejectedInput,
    })
    .strict(),
  z
    .object({
      cause: z.literal("esi_membership_unauthorized"),
      token: AutomaticTokenInput,
    })
    .strict(),
  z
    .object({ cause: z.literal("esi_roster_unauthorized"), bound: AutomaticBoundInput })
    .strict(),
]);
const AutomaticRetryInput = z
  .object({
    outcome: z.enum([
      "not_in_fleet",
      "not_boss",
      "service_unavailable",
      "untrustworthy_evidence",
      "timed_out",
      "capacity_limited",
    ]),
    nextAttemptAt: z.custom<Date | null>((v) => v === null || v instanceof Date),
  })
  .strict();
const clearDiscoveryCallbacks = {
  reservationId: null,
  enqueueUntil: null,
  claimReservationId: null,
  claimExpiresAt: null,
  sourceId: null,
};

// Only signed/browser gates and the transaction-only revoke entry construct this
// capability. Lock expansion
// is deliberately broader than the generation-specific mutation below.
type PreparedAutomaticControl = {
  accountId: string;
  actor: { kind: "device"; deviceId: string } | { kind: "browser_off" };
  consent: Consent | null;
  locked: Awaited<ReturnType<typeof lockFleetLifecycle>>;
};
type AutomaticMutation = {
  request_id: string;
  result: "applied" | "replayed" | "already_off";
  receipt: AutomaticReceipt | null;
  consent: Consent;
};
type BrowserAuth = { accountId: string; browserSessionId: string };
type ConsentRow = typeof fleetAutomaticConsent.$inferSelect;
const ABSENT: Consent = {
  generation: 0,
  revision: 0,
  enabled: false,
  approving_device_id: null,
  approved_at: null,
  disabled_at: null,
  closed_reason: null,
};
function consentView(row?: ConsentRow): Consent {
  return row
    ? {
        generation: row.generation,
        revision: row.revision,
        enabled: row.enabled,
        approving_device_id: row.approvingDeviceId,
        approved_at: row.approvedAt.toISOString(),
        disabled_at: row.disabledAt?.toISOString() ?? null,
        closed_reason: row.closedReason,
      }
    : { ...ABSENT };
}
function bounded<T>(value: T, schema: z.ZodType<T>, maxBytes: number): T {
  if (!serializeFleetV2Json(value, schema, maxBytes).ok)
    throw new RelayRefusal("service_unavailable");
  return value;
}
function digest(raw: string) {
  return createHash("sha256").update(raw).digest("base64url");
}
const present = <T>(v: T | null): v is T => v !== null;
const unique = <T>(values: T[]) => [...new Set(values)];
async function signedActor(tx: DbTx, raw: string) {
  const [row] = await tx
    .select({ device: fleetDevice, session: fleetDeviceSession })
    .from(fleetDeviceSession)
    .innerJoin(fleetDevice, eq(fleetDevice.id, fleetDeviceSession.deviceId))
    .where(eq(fleetDeviceSession.id, digest(raw)));
  if (!row) throw new RelayRefusal("unauthorized");
  return row;
}

/** Account sources, candidates and actor-device OR selections all contribute
 * dependencies before ANY identity/account lock. Relay publishers can belong to
 * another account; include them without turning them into mutation selectors. */
type ControlTarget = {
  sourceId?: string;
  characterId?: number;
  fleetId?: number;
  linkedIds?: readonly number[];
};
async function probeControl(
  tx: DbTx,
  accountId: string,
  actorDeviceId?: string,
  target: ControlTarget = {},
) {
  const sources = await tx
    .select()
    .from(fleetSourceIntent)
    .where(
      or(
        eq(fleetSourceIntent.accountId, accountId),
        target.sourceId ? eq(fleetSourceIntent.id, target.sourceId) : undefined,
        actorDeviceId ? eq(fleetSourceIntent.deviceId, actorDeviceId) : undefined,
        target.fleetId === undefined
          ? undefined
          : and(
              eq(fleetSourceIntent.fleetId, target.fleetId),
              isNotNull(fleetSourceIntent.activatedAt),
              ne(fleetSourceIntent.state, "ended"),
            ),
      ),
    );
  const candidates = await tx
    .select()
    .from(fleetAutomaticCandidate)
    .where(eq(fleetAutomaticCandidate.accountId, accountId));
  const [consent] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, accountId));
  const sourceIds = unique([
    ...sources.map((s) => s.id),
    ...(target.sourceId ? [target.sourceId] : []),
  ]);
  const authorities =
    sourceIds.length || target.fleetId !== undefined
      ? await tx
          .select()
          .from(fleetSourceAuthority)
          .where(
            or(
              sourceIds.length
                ? inArray(fleetSourceAuthority.sourceId, sourceIds)
                : undefined,
              target.fleetId === undefined
                ? undefined
                : eq(fleetSourceAuthority.fleetId, target.fleetId),
            ),
          )
      : [];
  if (authorities.some((a) => a.sourceId && !sourceIds.includes(a.sourceId)))
    throw new FleetLifecycleRetry();
  const relayPredicate = (t: typeof fleetTelemetryRow | typeof fleetPublisherLease) =>
    or(
      sourceIds.length ? inArray(t.sourceId, sourceIds) : undefined,
      actorDeviceId ? eq(t.deviceId, actorDeviceId) : undefined,
    ) ?? sql`false`;
  const rows = await tx
    .select()
    .from(fleetTelemetryRow)
    .where(relayPredicate(fleetTelemetryRow));
  const leases = await tx
    .select()
    .from(fleetPublisherLease)
    .where(relayPredicate(fleetPublisherLease));
  const deviceIds = unique([
    ...(actorDeviceId ? [actorDeviceId] : []),
    ...(consent ? [consent.approvingDeviceId] : []),
    ...sources.map((s) => s.deviceId).filter(present),
    ...rows.map((r) => r.deviceId),
    ...leases.map((r) => r.deviceId),
  ]);
  const devices = deviceIds.length
    ? await tx.select().from(fleetDevice).where(inArray(fleetDevice.id, deviceIds))
    : [];
  const identityIds = unique([
    ...(target.linkedIds ?? []),
    ...(target.characterId ? [target.characterId] : []),
    ...sources.map((s) => s.bossCharacterId).filter(present),
    ...candidates.map((c) => c.characterId),
    ...rows.map((r) => r.characterId),
    ...leases.map((r) => r.characterId),
  ]);
  const identities = identityIds.length
    ? await tx.select().from(character).where(inArray(character.id, identityIds))
    : [];
  const accountIds = unique([
    accountId,
    ...sources.map((s) => s.accountId).filter(present),
    ...devices.map((d) => d.accountId),
    ...identities.map((c) => c.accountId),
  ]);
  return {
    sources,
    candidates,
    consent,
    sourceIds,
    authorities,
    devices,
    deviceIds,
    identities,
    identityIds,
    accountIds,
  };
}
function selectors(p: Awaited<ReturnType<typeof probeControl>>) {
  return JSON.stringify([
    [...p.identityIds].sort(),
    [...p.accountIds].sort(),
    [...p.deviceIds].sort(),
    p.sources
      .map((s) => [
        s.id,
        s.accountId,
        s.deviceId,
        s.bossCharacterId,
        s.bossLinkEpoch,
        s.fleetId,
        s.automaticConsentAccountId,
        s.automaticConsentGeneration,
      ])
      .sort(),
    p.identities.map((c) => [c.id, c.accountId, c.fleetLinkEpoch]).sort(),
    p.authorities.map((a) => [a.fleetId, a.sourceId]).sort(),
    p.candidates.map((c) => [c.characterId, c.linkEpoch]).sort(),
  ]);
}
async function prepareControl(
  tx: DbTx,
  accountId: string,
  actor: PreparedAutomaticControl["actor"],
  browser?: BrowserAuth,
  target: ControlTarget = {},
) {
  const actorId = actor.kind === "device" ? actor.deviceId : undefined;
  const p = await probeControl(tx, accountId, actorId, target);
  const recheck = async () => {
    const current = await probeControl(tx, accountId, actorId, target);
    if (selectors(p) !== selectors(current)) throw new FleetLifecycleRetry();
    return current;
  };
  await lockFleetIdentityCharacters(tx, p.identityIds);
  const accounts = await lockFleetAccounts(tx, p.accountIds);
  if (!accounts.has(accountId)) throw new RelayRefusal("unauthorized");
  await recheck();
  // Never call getSessionAccount here: its lastSeen UPDATE would take a browser
  // row lock before accounts. Logout and account merge serialize at this row.
  const [browserSession] = browser
    ? await tx
        .select()
        .from(session)
        .where(eq(session.id, digest(browser.browserSessionId)))
        .for("update")
    : [];
  if (browser && (!browserSession || browserSession.accountId !== accountId))
    throw new RelayRefusal("unauthorized");
  if (target.fleetId !== undefined) {
    // Include empty/discovered slots BEFORE any source/device wait. Paused
    // predecessors still contribute every earlier identity/account selector.
    await lockFleetAuthoritySlots(tx, [
      target.fleetId,
      ...p.sources.flatMap((s) => (s.fleetId === null ? [] : [s.fleetId])),
      ...p.authorities.map((a) => a.fleetId),
    ]);
    await recheck();
  }
  const locked = await lockFleetLifecycle(tx, {
    sourceIds: p.sourceIds,
    deviceIds: actorId ? [actorId] : [],
  });
  const current = await recheck();
  const consent = current.consent
    ? bounded(consentView(current.consent), ConsentSchema, 2048)
    : null;
  const prepared: PreparedAutomaticControl = { accountId, actor, consent, locked };
  return { prepared, browserSession, accounts, identities: current.identities };
}
async function prepareSigned(
  tx: DbTx,
  call: SignedFleetCall,
  target: ControlTarget = {},
) {
  const mode = await lockFleetSharingMode(tx);
  const probe = await signedActor(tx, call.sessionId);
  if (mode.keyIdentityPhase !== "ready") throw new RelayRefusal("service_unavailable");
  let canonicalKey: string;
  try {
    const key = await resolveFleetDeviceKey(tx, probe.device.publicKeySpkiB64, mode);
    if (key.unavailable || key.device?.id !== probe.device.id)
      throw new RelayRefusal("unauthorized");
    canonicalKey = key.canonicalKey;
  } catch (err) {
    if (err instanceof FleetDeviceKeyUnavailableError)
      throw new RelayRefusal("unauthorized");
    throw err;
  }
  await lockFleetDeviceKey(tx, canonicalKey);
  const p = await prepareControl(
    tx,
    probe.device.accountId,
    {
      kind: "device",
      deviceId: probe.device.id,
    },
    undefined,
    target,
  );
  const actor = await signedActor(tx, call.sessionId);
  const now = await fleetDatabaseNow(tx, call.now);
  const key = await resolveFleetDeviceKey(tx, actor.device.publicKeySpkiB64, mode);
  if (
    actor.device.id !== probe.device.id ||
    actor.device.accountId !== probe.device.accountId ||
    actor.device.revokedAt ||
    key.unavailable ||
    key.device?.id !== actor.device.id ||
    key.canonicalKey !== canonicalKey ||
    !validFleetCapabilities(actor.device.approvedCapabilities) ||
    !actor.device.approvedCapabilities.includes(SHARED_CAPABILITY)
  )
    throw new RelayRefusal("unauthorized");
  sampleFleetSessionAdmission(actor.session, {
    ...call,
    now,
    cadence: "read",
    invalidSessionCode: "unauthorized",
  });
  return { ...p, actor, mode, now };
}

/** Discovery preparation reuses the complete control probe, including all
 * boss/approver/sibling dependencies, without allocating a source or authority.
 * Positive commit also supplies its prospective source and captured roster IDs.
 * Keys precede identities/accounts; changed earlier selectors retry OUTSIDE Tx. */
async function prepareAutomaticDiscovery(
  tx: DbTx,
  task: AutomaticTask,
  fleetId?: number,
  sourceId?: string,
  linkedIds?: readonly number[],
) {
  const mode = await lockFleetSharingMode(tx);
  if (!mode.enabled || mode.keyIdentityPhase !== "ready") return null;
  const [consentProbe] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, task.accountId));
  if (!consentProbe?.enabled) return null;
  const [deviceProbe] = await tx
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.id, consentProbe.approvingDeviceId));
  if (!deviceProbe) return null;
  let canonicalKey: string;
  try {
    const key = await resolveFleetDeviceKey(tx, deviceProbe.publicKeySpkiB64, mode);
    if (key.unavailable || key.device?.id !== deviceProbe.id) return null;
    canonicalKey = key.canonicalKey;
  } catch (err) {
    if (err instanceof FleetDeviceKeyUnavailableError) return null;
    throw err;
  }
  await lockFleetDeviceKey(tx, canonicalKey);
  const p = await prepareControl(
    tx,
    task.accountId,
    { kind: "device", deviceId: deviceProbe.id },
    undefined,
    { characterId: task.characterId, fleetId, sourceId, linkedIds },
  );
  const [consent] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, task.accountId));
  if (consent && consent.approvingDeviceId !== deviceProbe.id)
    throw new FleetLifecycleRetry();
  const [device] = await tx
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.id, deviceProbe.id));
  if (
    !consent?.enabled ||
    consent.generation !== task.consentGeneration ||
    !device ||
    device.revokedAt ||
    device.accountId !== task.accountId ||
    !validFleetCapabilities(device.approvedCapabilities) ||
    !device.approvedCapabilities.includes(SHARED_CAPABILITY) ||
    p.accounts.get(task.accountId)?.tier !== "member"
  )
    return null;
  try {
    const key = await resolveFleetDeviceKey(tx, device.publicKeySpkiB64, mode);
    if (
      key.unavailable ||
      key.device?.id !== device.id ||
      key.canonicalKey !== canonicalKey
    )
      return null;
  } catch (err) {
    if (err instanceof FleetDeviceKeyUnavailableError) return null;
    throw err;
  }
  const boss = p.identities.find((b) => b.id === task.characterId);
  const [candidate] = await tx
    .select()
    .from(fleetAutomaticCandidate)
    .where(
      and(
        eq(fleetAutomaticCandidate.accountId, task.accountId),
        eq(fleetAutomaticCandidate.characterId, task.characterId),
      ),
    );
  if (
    !boss ||
    !candidate ||
    boss.accountId !== task.accountId ||
    !hasUsableFleetRead(boss) ||
    candidate.consentGeneration !== task.consentGeneration ||
    candidate.candidateGeneration !== task.candidateGeneration ||
    candidate.ownerHash !== boss.ownerHash ||
    candidate.linkEpoch !== boss.fleetLinkEpoch ||
    isAutomaticCandidateSuspended(candidate, boss)
  )
    return null;
  return {
    candidate,
    consent,
    boss,
    device,
    mode,
    owner: p.accounts.get(task.accountId)!,
    identities: new Map(p.identities.map((ch) => [ch.id, ch])),
    locked: p.prepared.locked,
  };
}
type PreparedDiscovery = NonNullable<
  Awaited<ReturnType<typeof prepareAutomaticDiscovery>>
>;
function currentAutomaticClaim(
  p: PreparedDiscovery,
  claim: AutomaticClaim,
  now: Date,
): boolean {
  const { candidate: c, consent, boss } = p;
  return (
    claim.task.accountId === c.accountId &&
    claim.task.characterId === c.characterId &&
    claim.task.consentGeneration === c.consentGeneration &&
    claim.task.candidateGeneration === c.candidateGeneration &&
    consent.revision === claim.consentRevision &&
    consent.approvingDeviceId === claim.approverDeviceId &&
    boss.id === claim.boss.id &&
    boss.accountId === claim.boss.accountId &&
    boss.ownerHash === claim.boss.ownerHash &&
    boss.fleetLinkEpoch === claim.boss.fleetLinkEpoch &&
    c.claimGeneration === claim.claimGeneration &&
    c.claimGeneration < Number.MAX_SAFE_INTEGER &&
    c.candidateGeneration < Number.MAX_SAFE_INTEGER &&
    c.claimReservationId === claim.task.reservationId &&
    c.claimExpiresAt?.getTime() === claim.claimExpiresAt.getTime() &&
    now < claim.claimExpiresAt &&
    c.reservationId === null &&
    c.enqueueUntil === null &&
    c.sourceId === null
  );
}
function currentAutomaticToken(
  p: PreparedDiscovery,
  token: AutomaticToken | AutomaticRejectedToken,
  now: Date,
): boolean {
  return (
    currentAutomaticClaim(p, token.claim, now) &&
    now < token.accessTokenExpiresAt &&
    p.boss.refreshTokenEnc === token.settledTokenEnc
  );
}
function candidateKey(task: AutomaticTask) {
  return and(
    eq(fleetAutomaticCandidate.accountId, task.accountId),
    eq(fleetAutomaticCandidate.characterId, task.characterId),
  );
}

/** Discard only obsolete automatic delivery inputs, including rows inserted late
 * after their reservation was superseded. Text comparisons avoid trusting jsonb
 * casts; the current candidate/lease is the sole authority, not outbox age.
 * This bounded prune also runs when consent is Off or the account is gone. */
async function pruneAutomaticOutbox(db: Db, now: Date): Promise<void> {
  await db.execute(sql`delete from ${outbox} where ${outbox.id} in (
    select o.id from outbox o where o.dispatched_at is null
      and o.payload->>'kind' = 'fleet-automatic'
      and not exists (
        select 1 from fleet_automatic_candidate c
        where c.account_id::text = o.payload->>'accountId'
          and c.character_id::text = o.payload->>'characterId'
          and c.consent_generation::text = o.payload->>'consentGeneration'
          and c.candidate_generation::text = o.payload->>'candidateGeneration'
          and c.reservation_id::text = o.payload->>'reservationId'
          and c.enqueue_until > ${now}
      ) order by o.id limit 100 for update skip locked
  )`);
}
async function automaticCatalogue(tx: DbTx, accountId: string) {
  return tx
    .select()
    .from(character)
    .where(eq(character.accountId, accountId))
    .orderBy(character.id)
    .limit(257);
}
async function reserveAutomaticAccount(
  tx: DbTx,
  accountId: string,
  limit: number,
  clock?: () => Date,
): Promise<{ considered: number; reserved: number }> {
  const empty = { considered: 0, reserved: 0 };
  const mode = await lockFleetSharingMode(tx);
  const [probe] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, accountId));
  if (!probe?.enabled) return empty;
  const catalogue = await automaticCatalogue(tx, accountId);
  const [deviceProbe] = await tx
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.id, probe.approvingDeviceId));
  let canonicalKey: string | null = null;
  if (deviceProbe && mode.keyIdentityPhase === "ready") {
    try {
      const key = await resolveFleetDeviceKey(tx, deviceProbe.publicKeySpkiB64, mode);
      if (!key.unavailable && key.device?.id === deviceProbe.id) {
        canonicalKey = key.canonicalKey;
        await lockFleetDeviceKey(tx, canonicalKey);
      }
    } catch (err) {
      if (!(err instanceof FleetDeviceKeyUnavailableError)) throw err;
    }
  }
  const p = await prepareControl(
    tx,
    accountId,
    { kind: "device", deviceId: probe.approvingDeviceId },
    undefined,
    { linkedIds: catalogue.length <= 256 ? catalogue.map((c) => c.id) : [] },
  );
  const [consent] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, accountId));
  if (consent && consent.approvingDeviceId !== probe.approvingDeviceId)
    throw new FleetLifecycleRetry();
  const current = await automaticCatalogue(tx, accountId);
  // Account serialization prevents new links after this recheck. A newly linked
  // character before the account wait must acquire its earlier identity selector
  // on a fresh transaction, not be silently admitted from the old catalogue.
  const bindings = (rows: typeof catalogue) =>
    JSON.stringify(rows.map((c) => [c.id, c.ownerHash, c.fleetLinkEpoch]));
  if (bindings(catalogue) !== bindings(current)) throw new FleetLifecycleRetry();
  const [device] = await tx
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.id, probe.approvingDeviceId));
  let validKey = false;
  if (device && canonicalKey !== null) {
    try {
      const key = await resolveFleetDeviceKey(tx, device.publicKeySpkiB64, mode);
      validKey =
        !key.unavailable &&
        key.device?.id === device.id &&
        key.canonicalKey === canonicalKey;
    } catch (err) {
      if (!(err instanceof FleetDeviceKeyUnavailableError)) throw err;
    }
  }
  const now = await fleetDatabaseNow(tx, clock?.());
  if (!consent?.enabled || consent.nextReconcileAt > now) return empty;
  const retry = checkedDateAdd(now.toISOString(), 30000);
  const soon = checkedDateAdd(now.toISOString(), 500);
  if (!retry || !soon) return empty;
  const advance = async (
    nextReconcileAt: Date,
    candidateCursor = consent.candidateCursor,
  ) => {
    await tx
      .update(fleetAutomaticConsent)
      .set({ nextReconcileAt, candidateCursor })
      .where(eq(fleetAutomaticConsent.accountId, accountId));
  };
  if (
    !mode.enabled ||
    mode.keyIdentityPhase !== "ready" ||
    !validKey ||
    p.accounts.get(accountId)?.tier !== "member" ||
    !device ||
    device.revokedAt ||
    device.accountId !== accountId ||
    !validFleetCapabilities(device.approvedCapabilities) ||
    !device.approvedCapabilities.includes(SHARED_CAPABILITY) ||
    current.length > 256
  ) {
    await advance(new Date(retry));
    return empty;
  }
  const retained = await tx
    .select()
    .from(fleetAutomaticCandidate)
    .where(eq(fleetAutomaticCandidate.accountId, accountId));
  const byId = new Map(retained.map((c) => [c.characterId, c]));
  const remaining = current.filter((c) => c.id > (consent.candidateCursor ?? 0));
  const considered = remaining.slice(0, limit);
  let reserved = 0;
  let nextReconcileAt = new Date(retry);
  for (const boss of considered) {
    const old = byId.get(boss.id);
    // Retained removed-character rows are not spare slots: deletion/recreation
    // would pardon exhausted counters and old same-binding authorization loss.
    if (!old && byId.size >= 256) continue;
    let c = old
      ? reconcileAutomaticCandidateBinding(old, boss, consent.generation)
      : {
          accountId,
          characterId: boss.id,
          consentGeneration: consent.generation,
          candidateGeneration: 1,
          ownerHash: boss.ownerHash,
          linkEpoch: boss.fleetLinkEpoch,
          nextAttemptAt: now,
          failureCount: 0,
          lastOutcome: null,
          claimGeneration: 0,
          ...clearDiscoveryCallbacks,
        };
    if (!c) continue;
    const live = p.prepared.locked.sources.find(
      (s) =>
        s.state !== "ended" &&
        s.accountId === accountId &&
        s.deviceId === device.id &&
        s.automaticConsentAccountId === accountId &&
        s.automaticConsentGeneration === consent.generation &&
        s.bossCharacterId === boss.id &&
        s.bossOwnerHash === boss.ownerHash &&
        s.bossLinkEpoch === boss.fleetLinkEpoch,
    );
    if (isAutomaticCandidateSuspended(c, boss)) {
      c = { ...c, ...clearDiscoveryCallbacks };
    } else if (
      c.candidateGeneration >= Number.MAX_SAFE_INTEGER ||
      c.claimGeneration >= Number.MAX_SAFE_INTEGER - 1
    ) {
      c = { ...c, ...clearDiscoveryCallbacks, lastOutcome: "capacity_limited" };
    } else if (live) {
      c = { ...c, ...clearDiscoveryCallbacks, sourceId: live.id };
    } else {
      // A terminal/purged pointer cannot revive a source. Callback recovery keeps
      // both monotonic counters but the next reservation always gets a new UUID.
      c = { ...c, sourceId: null };
      if (c.enqueueUntil && c.enqueueUntil <= now)
        c = { ...c, reservationId: null, enqueueUntil: null };
      if (c.claimExpiresAt && c.claimExpiresAt <= now)
        c = { ...c, claimReservationId: null, claimExpiresAt: null };
      if (!hasUsableFleetRead(boss)) {
        c = {
          ...c,
          ...clearDiscoveryCallbacks,
          lastOutcome: "waiting_for_grant",
          nextAttemptAt: new Date(Math.max(c.nextAttemptAt.getTime(), Date.parse(retry))),
        };
      } else if (
        c.reservationId === null &&
        c.claimReservationId === null &&
        automaticCandidateAdmissible(c, boss, consent.generation, now)
      ) {
        const until = checkedDateAdd(now.toISOString(), 10000);
        if (until) {
          const reservationId = randomUUID();
          c = { ...c, reservationId, enqueueUntil: new Date(until) };
          await enqueueSync(tx, {
            kind: "fleet-automatic",
            accountId,
            characterId: boss.id,
            consentGeneration: c.consentGeneration,
            candidateGeneration: c.candidateGeneration,
            reservationId,
          });
          reserved++;
        }
      }
      const due = c.enqueueUntil ?? c.claimExpiresAt ?? c.nextAttemptAt;
      if (due > now && due < nextReconcileAt) nextReconcileAt = due;
    }
    if (old)
      await tx
        .update(fleetAutomaticCandidate)
        .set(c)
        .where(
          and(
            eq(fleetAutomaticCandidate.accountId, accountId),
            eq(fleetAutomaticCandidate.characterId, boss.id),
          ),
        );
    else await tx.insert(fleetAutomaticCandidate).values(c);
    byId.set(boss.id, c);
  }
  // Partial scans resume promptly from the persisted cursor. Blocked rows count
  // too; neither an old failed character nor an ineligible account owns the head.
  const partial = considered.length < remaining.length;
  if (partial) nextReconcileAt = new Date(soon);
  else {
    // Finishing a sweep resets the cursor, not the candidates. Fold retained
    // timers (including earlier batches) without repeating eligibility work.
    // Wrapping mid-batch would keep a >99-character no-grant account permanently
    // on the 500ms partial-scan path instead of its required 30s rescan.
    const currentIds = new Set(current.map((boss) => boss.id));
    for (const c of byId.values()) {
      if (!currentIds.has(c.characterId)) continue;
      const callback = c.enqueueUntil ?? c.claimExpiresAt;
      const due =
        callback && callback <= now ? new Date(soon) : (callback ?? c.nextAttemptAt);
      if (due > now && due < nextReconcileAt) nextReconcileAt = due;
    }
  }
  await advance(
    nextReconcileAt,
    partial ? (considered.at(-1)?.id ?? consent.candidateCursor) : null,
  );
  return { considered: considered.length, reserved };
}

/** Persistence only — no provider, queue callback, job or scheduler activation.
 * One tick spends at most 100 total account/candidate considerations, not 100
 * successes per account. The due order and candidate cursor survive restarts. */
export async function reserveDueFleetAutomatic(
  db: Db,
  clock?: () => Date,
): Promise<number> {
  const now = await db.transaction((tx) => fleetDatabaseNow(tx, clock?.()));
  await pruneAutomaticOutbox(db, now);
  const due = await db
    .select({ accountId: fleetAutomaticConsent.accountId })
    .from(fleetAutomaticConsent)
    .where(
      and(
        eq(fleetAutomaticConsent.enabled, true),
        lte(fleetAutomaticConsent.nextReconcileAt, now),
      ),
    )
    .orderBy(fleetAutomaticConsent.nextReconcileAt, fleetAutomaticConsent.accountId)
    .limit(100);
  const share = Math.max(1, Math.floor(100 / Math.max(1, due.length)) - 1);
  let budget = 100;
  let reserved = 0;
  for (const row of due) {
    if (budget === 0) break;
    budget--;
    const result = await fleetLifecycleTransaction(db, (tx) =>
      reserveAutomaticAccount(tx, row.accountId, Math.min(budget, share), clock),
    );
    budget -= result.considered;
    reserved += result.reserved;
  }
  return reserved;
}

export async function claimFleetAutomaticDiscovery(
  db: Db,
  task: AutomaticTask,
  clock?: () => Date,
): Promise<AutomaticClaim | null> {
  const parsed = AutomaticTaskInput.safeParse(task);
  if (!parsed.success) return null;
  const input = { ...parsed.data, accountId: parsed.data.accountId.toLowerCase() };
  return fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepareAutomaticDiscovery(tx, input);
    if (!p) return null;
    const now = await fleetDatabaseNow(tx, clock?.());
    const c = p.candidate;
    if (
      c.reservationId !== input.reservationId ||
      c.enqueueUntil === null ||
      c.enqueueUntil <= now ||
      c.claimReservationId !== null ||
      c.claimExpiresAt !== null ||
      c.sourceId !== null ||
      c.nextAttemptAt > now
    )
      return null;
    const claimGeneration = checkedCounterAdd(
      c.claimGeneration,
      1,
      Number.MAX_SAFE_INTEGER - 1,
    );
    if (claimGeneration === null || c.candidateGeneration >= Number.MAX_SAFE_INTEGER) {
      // The schema forbids outstanding work at Gmax. Release this exact input
      // without recycling its counter or leaving status in waiting_for_fleet.
      const schedule = automaticRetrySchedule(c, "capacity_limited", null, now);
      await tx
        .update(fleetAutomaticCandidate)
        .set({
          ...clearDiscoveryCallbacks,
          lastOutcome: "capacity_limited",
          nextAttemptAt: schedule.nextAttemptAt,
        })
        .where(candidateKey(input));
      return null;
    }
    if (!automaticCandidateAdmissible(c, p.boss, p.consent.generation, now)) return null;
    const expiry = checkedDateAdd(now.toISOString(), 30000);
    if (!expiry) return null;
    const claimExpiresAt = new Date(expiry);
    await tx
      .update(fleetAutomaticCandidate)
      .set({
        reservationId: null,
        enqueueUntil: null,
        claimReservationId: input.reservationId,
        claimGeneration,
        claimExpiresAt,
      })
      .where(candidateKey(input));
    return {
      task: input,
      consentRevision: p.consent.revision,
      approverDeviceId: p.device.id,
      boss: p.boss,
      claimGeneration,
      claimExpiresAt,
    };
  });
}

/** Pre-roster binding only. No source intent or authority owner is allocated. */
export async function bindFleetAutomaticDiscovery(
  db: Db,
  token: AutomaticToken,
  fleetId: number,
  membershipRetryAt: Date,
  clock?: () => Date,
): Promise<AutomaticBound | null> {
  if (
    !AutomaticTokenInput.safeParse(token).success ||
    !PositiveIdSchema.safeParse(fleetId).success ||
    !internalDate.safeParse(membershipRetryAt).success
  )
    return null;
  const detached = structuredClone(token);
  const retryAt = new Date(membershipRetryAt);
  return fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepareAutomaticDiscovery(tx, detached.claim.task, fleetId);
    if (!p) return null;
    const links = await tx
      .select({ characterId: character.id, linkEpoch: character.fleetLinkEpoch })
      .from(character)
      .orderBy(character.id)
      .limit(MAX_FLEET_LINK_SNAPSHOT + 1);
    if (links.length > MAX_FLEET_LINK_SNAPSHOT) throw new FleetLinkSnapshotOverflow();
    const now = await fleetDatabaseNow(tx, clock?.());
    if (!currentAutomaticToken(p, detached, now)) return null;
    await tx.insert(fleetSourceAuthority).values({ fleetId }).onConflictDoNothing();
    const [authority] = await tx
      .select()
      .from(fleetSourceAuthority)
      .where(eq(fleetSourceAuthority.fleetId, fleetId));
    return {
      token: detached,
      fleetId,
      linkedCharacters: links,
      expectedAuthorityGeneration: authority.authorityGeneration,
      membershipRetryAt: retryAt,
    };
  });
}

/** Rejected positive work releases only its exact outstanding callback. This
 * deliberately does not require JWT/grant/claim freshness: expiry or revoked
 * admission must still relinquish old work, never rewrite a newer delivery/latch.
 * Runs separately so a typed proof refusal has already rolled back its source. */
async function settleAutomaticCommit(
  db: Db,
  claim: AutomaticClaim,
  result: "fenced" | "capacity_limited" | "authority_changed",
  nextFetchAt: Date | null,
  clock?: () => Date,
): Promise<void> {
  await fleetLifecycleTransaction(db, async (tx) => {
    await lockFleetSharingMode(tx);
    await lockFleetIdentityCharacters(tx, [claim.task.characterId]);
    const owners = await lockFleetAccounts(tx, [claim.task.accountId]);
    if (!owners.has(claim.task.accountId)) return;
    const [c] = await tx
      .select()
      .from(fleetAutomaticCandidate)
      .where(candidateKey(claim.task));
    if (
      !c ||
      c.consentGeneration !== claim.task.consentGeneration ||
      c.candidateGeneration !== claim.task.candidateGeneration ||
      c.ownerHash !== claim.boss.ownerHash ||
      c.linkEpoch !== claim.boss.fleetLinkEpoch ||
      c.claimGeneration !== claim.claimGeneration ||
      c.claimReservationId !== claim.task.reservationId ||
      c.claimExpiresAt?.getTime() !== claim.claimExpiresAt.getTime() ||
      c.reservationId !== null ||
      c.enqueueUntil !== null ||
      c.sourceId !== null
    )
      return;
    const now = await fleetDatabaseNow(tx, clock?.());
    const schedule =
      result === "capacity_limited"
        ? {
            ...automaticRetrySchedule(c, "capacity_limited", nextFetchAt, now),
            lastOutcome: "capacity_limited" as const,
          }
        : result === "authority_changed"
          ? {
              nextAttemptAt: new Date(
                Math.max(
                  c.nextAttemptAt.getTime(),
                  nextFetchAt?.getTime() ?? 0,
                  now.getTime() + 5000,
                ),
              ),
            }
          : {};
    // No newer consent or suspended state may inherit this callback's schedule.
    const [consent] = await tx
      .select()
      .from(fleetAutomaticConsent)
      .where(eq(fleetAutomaticConsent.accountId, claim.task.accountId));
    const current =
      consent?.enabled &&
      consent.generation === claim.task.consentGeneration &&
      consent.revision === claim.consentRevision &&
      consent.approvingDeviceId === claim.approverDeviceId &&
      c.lastOutcome !== "fleet_read_invalid" &&
      c.lastOutcome !== "identity_changed";
    await tx
      .update(fleetAutomaticCandidate)
      .set({ ...clearDiscoveryCallbacks, ...(current ? schedule : {}) })
      .where(candidateKey(claim.task));
  });
}

/** Consumes the bounded upstream's real UNCOMMITTED continuation. Prospective
 * identity is advisory-locked before devices, but no Source exists until every
 * admission/proof/capacity guard passes. There is still no scheduler/job here. */
export async function commitFleetAutomaticDiscovery(
  db: Db,
  bound: AutomaticBound,
  verified: AutomaticVerified,
  clock?: () => Date,
): Promise<AutomaticCommit> {
  if (!AutomaticBoundInput.safeParse(bound).success) {
    // A malformed positive witness grants no authority, but a recognizable
    // current claim must still be released. Never import its unvalidated pacing.
    const claim = bound?.token?.claim;
    if (AutomaticClaimInput.safeParse(claim).success)
      await settleAutomaticCommit(db, structuredClone(claim), "fenced", null, clock);
    return { result: "fenced" };
  }
  const captured = structuredClone(bound);
  const claim = captured.token.claim;
  if (!AutomaticVerifiedInput.safeParse(verified).success) {
    await settleAutomaticCommit(db, claim, "fenced", captured.membershipRetryAt, clock);
    return { result: "fenced" };
  }
  const proof = structuredClone(verified);
  const retained = captured.linkedCharacters.filter((ch) =>
    proof.memberIds.includes(ch.characterId),
  );
  const sourceId = randomUUID();
  let result: AutomaticCommit;
  try {
    result = await fleetLifecycleTransaction(db, async (tx): Promise<AutomaticCommit> => {
      const p = await prepareAutomaticDiscovery(
        tx,
        claim.task,
        captured.fleetId,
        sourceId,
        retained.map((ch) => ch.characterId),
      );
      if (!p) return { result: "fenced" };
      const [authority] = await tx
        .select()
        .from(fleetSourceAuthority)
        .where(eq(fleetSourceAuthority.fleetId, captured.fleetId));
      const now = await fleetDatabaseNow(tx, clock?.());
      if (
        !currentAutomaticToken(p, captured.token, now) ||
        proof.evidence.observedAt > now ||
        proof.evidence.expiresAt <= now ||
        retained.length > 256 ||
        !retained.some(
          (ch) => ch.characterId === p.boss.id && ch.linkEpoch === p.boss.fleetLinkEpoch,
        )
      )
        return { result: "fenced" };
      const sameBinding = p.locked.sources.find(
        (s) =>
          s.accountId === claim.task.accountId &&
          s.automaticConsentAccountId === claim.task.accountId &&
          s.automaticConsentGeneration === claim.task.consentGeneration &&
          s.deviceId === claim.approverDeviceId &&
          s.bossCharacterId === p.boss.id &&
          s.bossOwnerHash === p.boss.ownerHash &&
          s.bossLinkEpoch === p.boss.fleetLinkEpoch,
      );
      if (sameBinding) {
        // The active source owner alone refreshes a live binding. A different
        // fleet must finish that source before a new UUID can be admitted.
        if (sameBinding.fleetId !== captured.fleetId) return { result: "fenced" };
        await tx
          .update(fleetAutomaticCandidate)
          .set({
            ...clearDiscoveryCallbacks,
            sourceId: sameBinding.id,
            failureCount: 0,
            lastOutcome: "verified",
          })
          .where(candidateKey(claim.task));
        return {
          result: "reused",
          sourceId: sameBinding.id,
          sourceGeneration: sameBinding.generation,
        };
      }
      if (
        !authority ||
        authority.authorityGeneration !== captured.expectedAuthorityGeneration ||
        (authority.verifiedAt !== null &&
          authority.verifiedAt >= proof.evidence.observedAt)
      )
        return { result: "authority_changed" };
      const owned = await tx
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.accountId, claim.task.accountId));
      if (
        owned.length >= 256 ||
        owned.filter((s) => s.state !== "ended").length >= 16 ||
        authority.authorityGeneration >= 2147483646 ||
        p.locked.sources.some(
          (s) =>
            s.fleetId === captured.fleetId &&
            s.activatedAt !== null &&
            (s.generation >= 2147483647 || s.fetchGeneration >= 2147483647),
        )
      )
        return { result: "capacity_limited" };
      const intentExpiresAt = checkedDateAdd(
        now.toISOString(),
        FLEET_SOURCE_INTENT_TTL_MS,
      );
      const retainUntil =
        intentExpiresAt &&
        checkedDateAdd(intentExpiresAt, FLEET_SOURCE_TOMBSTONE_RETENTION_MS);
      if (!intentExpiresAt || !retainUntil) return { result: "fenced" };
      const [source] = await tx
        .insert(fleetSourceIntent)
        .values({
          id: sourceId,
          accountId: claim.task.accountId,
          deviceId: claim.approverDeviceId,
          bossCharacterId: p.boss.id,
          bossOwnerHash: p.boss.ownerHash,
          bossLinkEpoch: p.boss.fleetLinkEpoch,
          automaticConsentAccountId: claim.task.accountId,
          automaticConsentGeneration: claim.task.consentGeneration,
          generation: 1,
          fetchGeneration: 0,
          state: "active",
          latestOutcome: "verified",
          fleetId: captured.fleetId,
          intentCreatedAt: now,
          intentExpiresAt: new Date(intentExpiresAt),
          activatedAt: now,
          lastAttemptAt: now,
          nextFetchAt: proof.nextFetchAt,
          fetchClaimExpiresAt: null,
          enqueueUntil: null,
          endedAt: null,
          terminalReason: null,
          retainUntil: new Date(retainUntil),
          stopReceipt: null,
          explicitlyStopped: false,
        })
        .returning();
      await applyFleetAuthorityProof(
        tx,
        {
          source,
          authority,
          boss: p.boss,
          device: p.device,
          owner: p.owner,
          mode: p.mode,
          identities: p.identities,
          locked: { ...p.locked, sources: [...p.locked.sources, source] },
        },
        {
          expectedAuthorityGeneration: captured.expectedAuthorityGeneration,
          evidence: proof.evidence,
          linkedCharacters: retained,
          nextFetchAt: proof.nextFetchAt,
        },
        now,
      );
      await tx
        .update(fleetAutomaticCandidate)
        .set({
          ...clearDiscoveryCallbacks,
          sourceId: source.id,
          failureCount: 0,
          lastOutcome: "verified",
        })
        .where(candidateKey(claim.task));
      return {
        result: "created",
        sourceId: source.id,
        sourceGeneration: source.generation,
      };
    });
  } catch (err) {
    if (!(err instanceof FleetAuthorityProofRefusal)) throw err;
    result = {
      result: err.reason === "authority_changed" ? "authority_changed" : "fenced",
    };
  }
  if (result.result !== "created" && result.result !== "reused")
    await settleAutomaticCommit(db, claim, result.result, proof.nextFetchAt, clock);
  return result;
}

export async function settleFleetAutomaticAuthorizationLoss(
  db: Db,
  proof: AutomaticAuthLossProof,
  nextAttemptAt: Date | null,
  clock?: () => Date,
): Promise<"suspended" | "fenced"> {
  // No string outcome, error code, wrong stage or wrong admission can write a
  // latch. Shape checks are necessary, not a substitute for upstream provenance.
  if (!AutomaticAuthLossInput.safeParse(proof).success) return "fenced";
  const witness = structuredClone(proof);
  const token =
    "rejected" in witness
      ? witness.rejected
      : "token" in witness
        ? witness.token
        : witness.bound.token;
  const pacing = nextAttemptAt instanceof Date ? new Date(nextAttemptAt) : nextAttemptAt;
  return fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepareAutomaticDiscovery(tx, token.claim.task);
    if (!p) return "fenced";
    const now = await fleetDatabaseNow(tx, clock?.());
    if (!currentAutomaticToken(p, token, now)) return "fenced";
    const lastOutcome =
      witness.cause === "verified_subject_mismatch" ||
      witness.cause === "verified_owner_mismatch"
        ? "identity_changed"
        : "fleet_read_invalid";
    const schedule = automaticRetrySchedule(p.candidate, lastOutcome, pacing, now);
    await tx
      .update(fleetAutomaticCandidate)
      .set({
        ...clearDiscoveryCallbacks,
        lastOutcome,
        nextAttemptAt: schedule.nextAttemptAt,
      })
      .where(candidateKey(token.claim.task));
    return "suspended";
  });
}

export async function settleFleetAutomaticDiscovery(
  db: Db,
  ticket: AutomaticClaim | AutomaticToken | AutomaticBound,
  failure: AutomaticRetryFailure,
  clock?: () => Date,
): Promise<void> {
  if (!AutomaticRetryInput.safeParse(failure).success) return;
  const stage = AutomaticBoundInput.safeParse(ticket).success
    ? "bound"
    : AutomaticTokenInput.safeParse(ticket).success
      ? "token"
      : AutomaticClaimInput.safeParse(ticket).success
        ? "claim"
        : null;
  if (
    stage === null ||
    (failure.outcome === "not_in_fleet" && stage !== "token") ||
    (failure.outcome === "not_boss" && stage !== "bound")
  )
    return;
  const detached = structuredClone(ticket);
  const token =
    "token" in detached ? detached.token : "claim" in detached ? detached : null;
  const claim = token?.claim ?? (detached as AutomaticClaim);
  const retry = structuredClone(failure);
  await fleetLifecycleTransaction(db, async (tx) => {
    const p = await prepareAutomaticDiscovery(tx, claim.task);
    if (!p) return;
    const now = await fleetDatabaseNow(tx, clock?.());
    if (
      !(token
        ? currentAutomaticToken(p, token, now)
        : currentAutomaticClaim(p, claim, now))
    )
      return;
    const schedule = automaticRetrySchedule(
      p.candidate,
      retry.outcome,
      retry.nextAttemptAt,
      now,
    );
    await tx
      .update(fleetAutomaticCandidate)
      .set({
        ...clearDiscoveryCallbacks,
        ...schedule,
        lastOutcome: retry.outcome,
      })
      .where(candidateKey(claim.task));
  });
}

async function receiptFor(
  tx: DbTx,
  accountId: string,
  requestId: string,
  now: Date,
): Promise<Receipt | null> {
  const [automatic] = await tx
    .select()
    .from(fleetAutomaticReceipt)
    .where(
      and(
        eq(fleetAutomaticReceipt.accountId, accountId),
        eq(fleetAutomaticReceipt.requestId, requestId),
        gt(fleetAutomaticReceipt.expiresAt, now),
      ),
    );
  const inline = await tx
    .select({ receipt: fleetSourceIntent.stopReceipt })
    .from(fleetSourceIntent)
    .where(
      and(
        eq(fleetSourceIntent.accountId, accountId),
        sql`${fleetSourceIntent.stopReceipt}->'command'->>'request_id' = ${requestId}`,
        sql`(${fleetSourceIntent.stopReceipt}->>'expires_at')::timestamptz > ${now.toISOString()}::timestamptz`,
      ),
    );
  if (inline.length + Number(!!automatic) > 1)
    throw new RelayRefusal("service_unavailable");
  const receipt = automatic?.receipt ?? inline[0]?.receipt ?? null;
  return receipt ? bounded(receipt, ReceiptSchema, 2048) : null;
}
function sameAutomatic(a: AutomaticCommand, b: AutomaticCommand) {
  return (
    a.protocol === b.protocol &&
    a.request_id === b.request_id &&
    a.intent_created_at === b.intent_created_at &&
    a.enabled === b.enabled &&
    a.expected_generation === b.expected_generation &&
    a.expected_revision === b.expected_revision
  );
}

/** Transaction-only closure shared by explicit commands and narrow terminal
 * actors. No synthetic command UUID/receipt; no account-wide source cleanup. */
async function closeGeneration(
  tx: DbTx,
  prepared: PreparedAutomaticControl,
  reason: NonNullable<Consent["closed_reason"]>,
  now: Date,
): Promise<Consent> {
  const consent = prepared.consent ?? { ...ABSENT };
  if (!consent.enabled) return consent;
  const result: Consent = {
    ...consent,
    enabled: false,
    revision: consent.revision + 1,
    disabled_at: now.toISOString(),
    closed_reason: reason,
  };
  bounded(result, ConsentSchema, 2048);
  const sources = prepared.locked.sources.filter(
    (s) =>
      s.accountId === prepared.accountId &&
      s.automaticConsentAccountId === prepared.accountId &&
      s.automaticConsentGeneration === consent.generation,
  );
  await invalidateFleetSources(
    tx,
    { ...prepared.locked, sources, selectors: { sourceIds: sources.map((s) => s.id) } },
    reason === "approver_revoked" ? "device_revoked" : "stopped",
    prepared.accountId,
    now,
  );
  await tx
    .update(fleetAutomaticCandidate)
    .set({
      reservationId: null,
      enqueueUntil: null,
      claimReservationId: null,
      claimExpiresAt: null,
      sourceId: null,
    })
    .where(
      and(
        eq(fleetAutomaticCandidate.accountId, prepared.accountId),
        eq(fleetAutomaticCandidate.consentGeneration, consent.generation),
      ),
    );
  await tx
    .update(fleetAutomaticConsent)
    .set({
      enabled: false,
      revision: result.revision,
      disabledAt: now,
      closedReason: reason,
    })
    .where(eq(fleetAutomaticConsent.accountId, prepared.accountId));
  return result;
}
function validateNewCommand(
  prepared: PreparedAutomaticControl,
  command: AutomaticCommand,
  now: Date,
) {
  const age = now.getTime() - Date.parse(command.intent_created_at);
  if (age < 0 || (command.enabled && age >= AUTOMATIC_INTENT_TTL_MS))
    throw new RelayRefusal("invalid_intent");
  const old = prepared.consent ?? { ...ABSENT };
  if (
    old.generation !== command.expected_generation ||
    old.revision !== command.expected_revision
  )
    throw new RelayRefusal("conflict");
  return old;
}
async function applyFleetAutomaticCommand(
  tx: DbTx,
  prepared: PreparedAutomaticControl,
  command: AutomaticCommand,
  now: Date,
): Promise<AutomaticMutation> {
  // Browser cannot read/replay an On receipt, even before all other work gates.
  if (prepared.actor.kind === "browser_off" && command.enabled)
    throw new RelayRefusal("bad_request");
  const receipt = await receiptFor(tx, prepared.accountId, command.request_id, now);
  if (receipt) {
    if (receipt.kind !== "automatic" || !sameAutomatic(receipt.command, command))
      throw new RelayRefusal("request_id_conflict");
    return {
      request_id: command.request_id,
      result: "replayed",
      receipt,
      consent: prepared.consent ?? { ...ABSENT },
    };
  }
  const old = validateNewCommand(prepared, command, now);
  if (!command.enabled && !old.enabled)
    return {
      request_id: command.request_id,
      result: "already_off",
      receipt: null,
      consent: old,
    };
  if (command.enabled) {
    // Replay precedes these WORK-only gates. The terminal identity was already
    // checked by the signed gate; no source/grant/combat/participation needed.
    const [owner] = await tx
      .select()
      .from(account)
      .where(eq(account.id, prepared.accountId));
    if (owner?.tier !== "member") throw new RelayRefusal("forbidden");
    const mode = await lockFleetSharingMode(tx);
    if (!mode.enabled) throw new RelayRefusal("feature_disabled");
    // The caller carries its session permission check outside this helper after
    // receipt lookup; see controlFleetAutomatic's preflight below.
    const retained = await tx
      .select({ id: fleetAutomaticReceipt.requestId })
      .from(fleetAutomaticReceipt)
      .where(
        and(
          eq(fleetAutomaticReceipt.accountId, prepared.accountId),
          gt(fleetAutomaticReceipt.expiresAt, now),
        ),
      )
      .limit(256);
    if (
      retained.length + 2 > 256 ||
      old.generation >= Number.MAX_SAFE_INTEGER ||
      old.revision > Number.MAX_SAFE_INTEGER - 2
    )
      throw new RelayRefusal("receipt_capacity");
  }
  const expiry = checkedDateAdd(now.toISOString(), AUTOMATIC_RECEIPT_TTL_MS);
  if (!expiry) throw new RelayRefusal("service_unavailable");
  let consent: Consent;
  if (command.enabled && prepared.actor.kind === "device") {
    await closeGeneration(tx, prepared, "explicit_off", now);
    consent = {
      generation: old.generation + 1,
      revision: old.revision + 1,
      enabled: true,
      approving_device_id: prepared.actor.deviceId,
      approved_at: now.toISOString(),
      disabled_at: null,
      closed_reason: null,
    };
    const values = {
      generation: consent.generation,
      revision: consent.revision,
      enabled: true,
      approvingDeviceId: prepared.actor.deviceId,
      approvedAt: now,
      disabledAt: null,
      closedReason: null,
      nextReconcileAt: now,
      candidateCursor: null,
    };
    await tx
      .insert(fleetAutomaticConsent)
      .values({ accountId: prepared.accountId, ...values })
      .onConflictDoUpdate({ target: fleetAutomaticConsent.accountId, set: values });
    // No discovery/reservation population. Even dormant predecessor candidates
    // lose callbacks; retained counters are never reset or recycled by reOn.
    await tx
      .update(fleetAutomaticCandidate)
      .set({
        reservationId: null,
        enqueueUntil: null,
        claimReservationId: null,
        claimExpiresAt: null,
        sourceId: null,
      })
      .where(eq(fleetAutomaticCandidate.accountId, prepared.accountId));
  } else consent = await closeGeneration(tx, prepared, "explicit_off", now);
  const accepted: AutomaticReceipt = {
    kind: "automatic",
    command,
    accepted_at: now.toISOString(),
    expires_at: expiry,
    result: consent,
  };
  bounded(accepted, AutomaticReceiptSchema, 2048);
  await tx
    .delete(fleetAutomaticReceipt)
    .where(
      and(
        eq(fleetAutomaticReceipt.accountId, prepared.accountId),
        lte(fleetAutomaticReceipt.expiresAt, now),
      ),
    );
  await tx.insert(fleetAutomaticReceipt).values({
    accountId: prepared.accountId,
    requestId: command.request_id,
    expiresAt: new Date(expiry),
    receipt: accepted,
  });
  await logAudit(tx, {
    actor: prepared.accountId,
    action: "fleet_automatic.changed",
    target: prepared.accountId,
    details: {
      actor: prepared.actor.kind,
      ...(prepared.actor.kind === "device" ? { deviceId: prepared.actor.deviceId } : {}),
      enabled: consent.enabled,
      generation: consent.generation,
      revision: consent.revision,
    },
  });
  return {
    request_id: command.request_id,
    result: "applied",
    receipt: accepted,
    consent,
  };
}

async function statusFor(
  tx: DbTx,
  p: {
    prepared: Pick<PreparedAutomaticControl, "accountId" | "actor">;
    accounts: Awaited<ReturnType<typeof lockFleetAccounts>>;
  },
  mode: Awaited<ReturnType<typeof lockFleetSharingMode>>,
  now: Date,
): Promise<AutomaticStatus> {
  const [row] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, p.prepared.accountId));
  const consent = consentView(row);
  const [approver] = consent.approving_device_id
    ? await tx
        .select()
        .from(fleetDevice)
        .where(eq(fleetDevice.id, consent.approving_device_id))
    : [];
  const status: AutomaticStatus = {
    consent,
    approver:
      consent.generation === 0
        ? "none"
        : !approver || approver.revokedAt
          ? "revoked"
          : p.prepared.actor.kind === "device" &&
              approver.id === p.prepared.actor.deviceId
            ? "this_device"
            : "other_device",
    readiness: "off",
    recovery_action: "none",
    retry_at: null,
    sources: [],
  };
  if (!consent.enabled) return status;
  const facts = await probeControl(
    tx,
    p.prepared.accountId,
    p.prepared.actor.kind === "device" ? p.prepared.actor.deviceId : undefined,
  );
  const current = facts.sources.filter(
    (s) =>
      s.state !== "ended" &&
      s.automaticConsentAccountId === p.prepared.accountId &&
      s.automaticConsentGeneration === consent.generation,
  );
  status.sources = current
    .map((s) => ({
      source_id: s.id,
      source_generation: s.generation,
      consent_generation: consent.generation,
    }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id));
  const blocked = (
    readiness: AutomaticStatus["readiness"],
    action: AutomaticStatus["recovery_action"],
  ) => ({ ...status, readiness, recovery_action: action });
  if (!mode.enabled) return blocked("global_disabled", "wait");
  if (p.accounts.get(p.prepared.accountId)?.tier !== "member")
    return blocked("member_required", "restore_membership");
  if (status.approver === "revoked")
    return blocked("authorization_required", "reauthorize_automatic");
  const validKeys = new Set<string>();
  for (const device of facts.devices) {
    try {
      const key = await resolveFleetDeviceKey(tx, device.publicKeySpkiB64, mode);
      if (!key.unavailable && key.device?.id === device.id) validKeys.add(device.id);
    } catch (err) {
      if (!(err instanceof FleetDeviceKeyUnavailableError)) throw err;
    }
  }
  const usable = facts.authorities.some(
    (a) =>
      current.some(
        (s) => s.id === a.sourceId && s.deviceId === consent.approving_device_id,
      ) &&
      currentSourceEvidence(
        {
          sources: facts.sources,
          identities: facts.identities,
          devices: facts.devices,
          accounts: [...p.accounts.values()],
          automaticConsents: row ? [row] : [],
          validKeys,
          now,
        },
        a,
      ),
  );
  if (usable) return blocked("ready", "none");
  const candidates = facts.candidates.filter(
    (c) => c.consentGeneration === consent.generation,
  );
  if (
    current.some((s) => s.fetchClaimExpiresAt && s.fetchClaimExpiresAt > now) ||
    candidates.some(
      (c) => c.claimReservationId && c.claimExpiresAt && c.claimExpiresAt > now,
    )
  )
    return blocked("verifying", "none");
  const transient = new Set([
    "service_unavailable",
    "untrustworthy_evidence",
    "timed_out",
  ]);
  if (
    current.some(
      (s) =>
        transient.has(s.latestOutcome ?? "") ||
        (s.activatedAt !== null &&
          !facts.authorities.some(
            (a) => a.sourceId === s.id && a.expiresAt && a.expiresAt > now,
          )),
    ) ||
    candidates.some((c) => transient.has(c.lastOutcome ?? ""))
  ) {
    const due = [
      ...current.map((s) => s.nextFetchAt),
      ...candidates.map((c) => c.nextAttemptAt),
    ]
      .filter(present)
      .filter((d) => d > now)
      .sort((a, b) => a.getTime() - b.getTime());
    return {
      ...blocked("reconnecting", "wait"),
      retry_at: due[0]?.toISOString() ?? null,
    };
  }
  const grants = await tx
    .select()
    .from(character)
    .where(eq(character.accountId, p.prepared.accountId))
    .limit(257);
  if (
    grants.length > 256 ||
    (facts.candidates.length >= 256 &&
      grants.some((boss) => !facts.candidates.some((c) => c.characterId === boss.id))) ||
    facts.sources.filter((s) => s.state !== "ended").length >= 16 ||
    facts.sources.length >= 256 ||
    candidates.some((c) => c.lastOutcome === "capacity_limited") ||
    // Exhausted retained task identities cannot be rebound into a newer consent.
    // Filtering by consent first would hide capacity immediately after reOn.
    facts.candidates.some(
      (c) =>
        grants.some((boss) => boss.id === c.characterId) &&
        (c.candidateGeneration === Number.MAX_SAFE_INTEGER ||
          c.claimGeneration >= Number.MAX_SAFE_INTEGER - 1),
    )
  )
    return blocked("capacity_limited", "wait");
  // A latch is identity-bound, not consent-bound. ReOn may not have reconciled
  // its candidates yet; ordinary usable-looking token rotation is not a wake.
  const suspended = (boss: typeof character.$inferSelect) =>
    facts.candidates.some((c) => isAutomaticCandidateSuspended(c, boss));
  if (!grants.some((boss) => hasUsableFleetRead(boss) && !suspended(boss)))
    return blocked(
      grants.some(suspended) ||
        candidates.some((c) => c.lastOutcome === "fleet_read_invalid") ||
        facts.sources.some(
          (s) =>
            s.automaticConsentAccountId === p.prepared.accountId &&
            s.automaticConsentGeneration === consent.generation &&
            (s.terminalReason === "fleet_read_invalid" ||
              s.terminalReason === "token_invalid"),
        )
        ? "authorization_required"
        : "waiting_for_grant",
      "authorize_fleet_read",
    );
  return blocked("waiting_for_fleet", "none");
}
function browserView(status: AutomaticStatus): BrowserAutomaticView {
  return {
    ...status,
    approver:
      status.approver === "none" || status.approver === "revoked"
        ? status.approver
        : "account_device",
  };
}
type AutomaticReply<T> =
  | (Extract<FleetReply<T>, { ok: true }> & { json: string })
  | Extract<FleetReply<T>, { ok: false }>;
async function reply<T>(
  work: () => Promise<{ value: T; json: string }>,
): Promise<AutomaticReply<T>> {
  try {
    return { ok: true, ...(await work()) };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (err instanceof FleetLifecycleRetry || isRetryableRelayError(err))
      return { ok: false, code: "service_unavailable" };
    throw err;
  }
}
/** Source controls borrow the same terminal identity/selector gate, never a new
 * transaction owner. The private automatic mutation capability is not exported.
 * Include even an absent/ended target and Start's identity BEFORE account locks. */
export async function prepareFleetSourceControl(
  tx: DbTx,
  call: SignedFleetCall,
  command?: SourceStart | SourceStop,
) {
  const p = await prepareSigned(
    tx,
    call,
    command
      ? {
          sourceId: command.source_id.toLowerCase(),
          ...(command.operation === "start" ? { characterId: command.character_id } : {}),
        }
      : {},
  );
  return {
    accountId: p.prepared.accountId,
    deviceId: p.actor.device.id,
    session: p.actor.session,
    accounts: p.accounts,
    identities: p.identities,
    locked: p.prepared.locked,
    mode: p.mode,
    now: p.now,
  };
}
export function requireFleetSourceWork(
  p: Awaited<ReturnType<typeof prepareFleetSourceControl>>,
) {
  if (p.accounts.get(p.accountId)?.tier !== "member") throw new RelayRefusal("forbidden");
  if (!p.mode.enabled) throw new RelayRefusal("feature_disabled");
  if (
    ![p.session.approvedCapabilities, p.session.acknowledgedCapabilities].every(
      (c) => validFleetCapabilities(c) && c.includes(SHARED_CAPABILITY),
    )
  )
    throw new RelayRefusal("capability_required");
}
export function readFleetSourceAutomaticStatus(
  tx: DbTx,
  p: Awaited<ReturnType<typeof prepareFleetSourceControl>>,
) {
  return statusFor(
    tx,
    {
      prepared: {
        accountId: p.accountId,
        actor: { kind: "device", deviceId: p.deviceId },
      },
      accounts: p.accounts,
    },
    p.mode,
    p.now,
  );
}
export { receiptFor as findFleetControlReceipt };
/** Called only after the source owner has checked immutable binding and source
 * CAS. No generated AutomaticCommand or receipt: Stop uses its inline slot. */
export async function closeFleetAutomaticForSourceStop(
  tx: DbTx,
  p: Awaited<ReturnType<typeof prepareFleetSourceControl>>,
  source: typeof fleetSourceIntent.$inferSelect,
): Promise<{ consent: Consent; effect: StopEffect }> {
  const [row] = await tx
    .select()
    .from(fleetAutomaticConsent)
    .where(eq(fleetAutomaticConsent.accountId, p.accountId));
  const consent = consentView(row);
  if (source.automaticConsentAccountId === null)
    return { consent, effect: "manual_only" };
  if (
    source.automaticConsentAccountId !== p.accountId ||
    source.automaticConsentGeneration! > consent.generation
  )
    throw new RelayRefusal("conflict");
  if (source.automaticConsentGeneration! < consent.generation)
    return { consent, effect: "older_generation_only" };
  if (!consent.enabled) return { consent, effect: "current_already_off" };
  return {
    consent: await closeGeneration(
      tx,
      {
        accountId: p.accountId,
        actor: { kind: "device", deviceId: p.deviceId },
        consent,
        locked: p.locked,
      },
      "source_stop",
      p.now,
    ),
    effect: "disabled_current",
  };
}

async function finishSigned(
  tx: DbTx,
  p: Awaited<ReturnType<typeof prepareSigned>>,
  call: SignedFleetCall,
) {
  await commitSessionCadence(tx, p.actor.session.id, {
    revision: call.revision,
    now: p.now,
    cadence: "read",
  });
}
export async function readFleetAutomatic(
  db: Db,
  call: SignedFleetCall,
): Promise<AutomaticReply<AutomaticGet>> {
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareSigned(tx, call);
      const value = bounded(
        { protocol: 2 as const, status: await statusFor(tx, p, p.mode, p.now) },
        AutomaticGetSchema,
        FLEET_V2_BYTE_LIMITS.automaticGet.successBytes,
      );
      const json = JSON.stringify(value);
      await finishSigned(tx, p, call);
      return { value, json };
    }),
  );
}
export async function controlFleetAutomatic(
  db: Db,
  call: SignedFleetCall,
  command: AutomaticCommand,
): Promise<AutomaticReply<AutomaticResult>> {
  const parsed = safeParseFleetV2Dto(AutomaticCommandSchema, command);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 2048)
    return { ok: false, code: "bad_request" };
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareSigned(tx, call);
      // Session rights are deliberately not fields of PreparedAutomaticControl.
      // Check only NEW On; exact replay and UUID conflict must win first.
      if (
        parsed.data.enabled &&
        !(await receiptFor(tx, p.prepared.accountId, parsed.data.request_id, p.now))
      ) {
        validateNewCommand(p.prepared, parsed.data, p.now);
        if (p.accounts.get(p.prepared.accountId)?.tier !== "member")
          throw new RelayRefusal("forbidden");
        if (!p.mode.enabled) throw new RelayRefusal("feature_disabled");
        if (
          ![
            p.actor.session.approvedCapabilities,
            p.actor.session.acknowledgedCapabilities,
          ].every((c) => validFleetCapabilities(c) && c.includes(SHARED_CAPABILITY))
        )
          throw new RelayRefusal("capability_required");
      }
      const mutation = await applyFleetAutomaticCommand(
        tx,
        p.prepared,
        parsed.data,
        p.now,
      );
      const { consent: _consent, ...result } = mutation;
      const value: AutomaticResult = {
        protocol: 2,
        ...result,
        status: await statusFor(tx, p, p.mode, p.now),
      };
      if (!parseAutomaticResult(value, parsed.data).success)
        throw new RelayRefusal("service_unavailable");
      bounded(
        value,
        AutomaticResultSchema,
        FLEET_V2_BYTE_LIMITS.automaticPut.successBytes,
      );
      const json = JSON.stringify(value);
      await finishSigned(tx, p, call);
      return { value, json };
    }),
  );
}
export async function readFleetAutomaticReceipt(
  db: Db,
  call: SignedFleetCall,
  requestId: string,
): Promise<AutomaticReply<ReceiptGet>> {
  if (!safeParseFleetV2Dto(UuidV4Schema, requestId).success)
    return { ok: false, code: "bad_request" };
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareSigned(tx, call);
      const receipt = await receiptFor(tx, p.prepared.accountId, requestId, p.now);
      if (!receipt) throw new RelayRefusal("receipt_not_found");
      const value: ReceiptGet = {
        protocol: 2,
        receipt,
        status: await statusFor(tx, p, p.mode, p.now),
      };
      if (!parseReceiptGet(value, requestId).success)
        throw new RelayRefusal("service_unavailable");
      bounded(value, ReceiptGetSchema, FLEET_V2_BYTE_LIMITS.receiptGet.successBytes);
      const json = JSON.stringify(value);
      await finishSigned(tx, p, call);
      return { value, json };
    }),
  );
}
async function prepareBrowser(tx: DbTx, auth: BrowserAuth, clock?: () => Date) {
  const mode = await lockFleetSharingMode(tx);
  const [probe] = await tx
    .select({ accountId: session.accountId })
    .from(session)
    .where(eq(session.id, digest(auth.browserSessionId)));
  if (!probe || probe.accountId !== auth.accountId)
    throw new RelayRefusal("unauthorized");
  const p = await prepareControl(tx, auth.accountId, { kind: "browser_off" }, auth);
  const now = await fleetDatabaseNow(tx, clock?.());
  if (!p.browserSession || p.browserSession.expiresAt <= now)
    throw new RelayRefusal("unauthorized");
  return { ...p, mode, now };
}
/** Revoke has no user command identity. Prepare all dependencies before account
 * locks, then close only the STILL-current approving generation (even with zero
 * sources). Return the remaining device-specific cleanup, never account-wide
 * mutation selectors borrowed from preparation. Caller owns mode and revocation. */
export async function revokeFleetAutomaticApproval(
  tx: DbTx,
  accountId: string,
  deviceId: string,
  testNow?: Date,
) {
  const p = await prepareControl(tx, accountId, { kind: "device", deviceId });
  const now = await fleetDatabaseNow(tx, testNow);
  const closing =
    p.prepared.consent?.enabled && p.prepared.consent.approving_device_id === deviceId;
  if (closing) await closeGeneration(tx, p.prepared, "approver_revoked", now);
  return {
    ...p.prepared.locked,
    sources: p.prepared.locked.sources.filter(
      (s) =>
        s.deviceId === deviceId &&
        !(
          closing &&
          s.automaticConsentAccountId === accountId &&
          s.automaticConsentGeneration === p.prepared.consent?.generation
        ),
    ),
    selectors: { deviceIds: [deviceId] },
  };
}
export async function readFleetAutomaticForBrowser(
  db: Db,
  auth: BrowserAuth,
  clock?: () => Date,
): Promise<BrowserAutomaticView | null> {
  try {
    return await fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareBrowser(tx, auth, clock);
      return bounded(
        browserView(await statusFor(tx, p, p.mode, p.now)),
        BrowserAutomaticViewSchema,
        16384,
      );
    });
  } catch (err) {
    if (err instanceof RelayRefusal && err.code === "unauthorized") return null;
    throw err;
  }
}
export async function turnOffFleetAutomaticForBrowser(
  db: Db,
  auth: BrowserAuth,
  command: AutomaticOff,
  clock?: () => Date,
): Promise<BrowserOffReply> {
  const parsed = safeParseFleetV2Dto(AutomaticOffSchema, command);
  if (!parsed.success)
    return { ok: false, request_id: null, error: "bad_request", status: null };
  try {
    return await fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareBrowser(tx, auth, clock);
      let value: BrowserOffReply;
      try {
        const mutation = await applyFleetAutomaticCommand(
          tx,
          p.prepared,
          parsed.data,
          p.now,
        );
        const { consent: _consent, ...result } = mutation;
        value = {
          ok: true,
          ...result,
          status: browserView(await statusFor(tx, p, p.mode, p.now)),
        };
      } catch (err) {
        if (
          !(err instanceof RelayRefusal) ||
          (err.code !== "conflict" && err.code !== "request_id_conflict")
        )
          throw err;
        value = {
          ok: false,
          request_id: parsed.data.request_id,
          error: err.code,
          status: browserView(await statusFor(tx, p, p.mode, p.now)),
        };
      }
      if (!parseBrowserOffReply(value, parsed.data).success)
        throw new RelayRefusal("service_unavailable");
      return bounded(value, BrowserOffReplySchema, 16384);
    });
  } catch (err) {
    const error =
      err instanceof RelayRefusal &&
      (err.code === "unauthorized" || err.code === "invalid_intent")
        ? err.code
        : "service_unavailable";
    // No DB/provider/cookie detail crosses the action boundary. Any exception
    // here has already rolled back all withdrawal and receipt changes.
    return bounded(
      { ok: false, request_id: parsed.data.request_id, error, status: null },
      BrowserOffReplySchema,
      16384,
    );
  }
}
