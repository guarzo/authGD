import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";
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
  session,
} from "@/db/schema";
import {
  AutomaticCommandSchema,
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
import { FLEET_V2_BYTE_LIMITS, UuidV4Schema, checkedDateAdd } from "@/core/fleet-api-v2";
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
  fleetLifecycleTransaction,
  hasUsableFleetRead,
  invalidateFleetSources,
  lockFleetAccounts,
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
type ControlTarget = { sourceId?: string; characterId?: number };
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
  const authorities = sourceIds.length
    ? await tx
        .select()
        .from(fleetSourceAuthority)
        .where(inArray(fleetSourceAuthority.sourceId, sourceIds))
    : [];
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
    facts.sources.filter((s) => s.state !== "ended").length >= 16 ||
    facts.sources.length >= 256 ||
    candidates.some(
      (c) =>
        c.lastOutcome === "capacity_limited" ||
        c.candidateGeneration === Number.MAX_SAFE_INTEGER ||
        c.claimGeneration === Number.MAX_SAFE_INTEGER,
    )
  )
    return blocked("capacity_limited", "wait");
  if (!grants.some(hasUsableFleetRead))
    return blocked(
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
