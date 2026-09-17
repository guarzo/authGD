import { createHash } from "node:crypto";
import { z } from "zod";
import type { character, fleetAutomaticCandidate } from "@/db/schema";
import {
  FLEET_CONSERVATIVE_PROBE_MS,
  type deriveFleetEvidenceWindow,
} from "./fleet-freshness";
import {
  API_VERSION,
  CharacterNameSchema,
  ExistingUuidSchema,
  FLEET_V2_BYTE_LIMITS,
  IsoDateSchema,
  PositiveIdSchema,
  PositiveInt4Schema,
  SafeCounterSchema,
  SourceExpectedGenerationSchema,
  UuidV4Schema,
  checkedCounterAdd,
  checkedDateAdd,
} from "./fleet-api-v2";
import { safeParseFleetV2Dto } from "./fleet-v2-validation";

// Detached in-process witnesses, never wire/queue credentials. Admission is a
// provenance guard; the trusted upstream owner must still verify JWTs and origin.
type Boss = Readonly<typeof character.$inferSelect>;
type Candidate = Readonly<typeof fleetAutomaticCandidate.$inferSelect>;
type Binding = Pick<Boss, "accountId" | "id" | "ownerHash" | "fleetLinkEpoch">;
export const AutomaticTaskSchema = z
  .object({
    accountId: ExistingUuidSchema,
    characterId: PositiveIdSchema,
    consentGeneration: PositiveIdSchema,
    candidateGeneration: PositiveIdSchema,
    reservationId: UuidV4Schema,
  })
  .strict();
export type AutomaticTask = Readonly<z.infer<typeof AutomaticTaskSchema>>;
export const AutomaticOutboxSchema = AutomaticTaskSchema.extend({
  kind: z.literal("fleet-automatic"),
}).strict();
export type AutomaticOutbox = Readonly<z.infer<typeof AutomaticOutboxSchema>>;
export const AutomaticJobSchema = AutomaticTaskSchema.extend({
  jobType: z.literal("fleet-automatic"),
}).strict();
export type AutomaticJob = Readonly<z.infer<typeof AutomaticJobSchema>>;
export type AutomaticClaim = Readonly<{
  task: AutomaticTask;
  consentRevision: number;
  approverDeviceId: string;
  boss: Boss;
  claimGeneration: number;
  claimExpiresAt: Date;
}>;
export type AutomaticToken = Readonly<{
  admission: "admitted";
  claim: AutomaticClaim;
  settledTokenEnc: string;
  accessTokenExpiresAt: Date;
}>;
export type AutomaticBound = Readonly<{
  token: AutomaticToken;
  fleetId: number;
  linkedCharacters: readonly Readonly<{ characterId: number; linkEpoch: string }>[];
  expectedAuthorityGeneration: number;
  membershipRetryAt: Date;
}>;
export type AutomaticVerified = Readonly<{
  evidence: Readonly<NonNullable<ReturnType<typeof deriveFleetEvidenceWindow>>>;
  memberIds: readonly number[];
  nextFetchAt: Date;
}>;
export type AutomaticFailure = Readonly<{
  outcome:
    | "not_in_fleet"
    | "not_boss"
    | "fleet_read_invalid"
    | "identity_changed"
    | "service_unavailable"
    | "untrustworthy_evidence"
    | "timed_out"
    | "capacity_limited";
  nextAttemptAt: Date | null;
}>;
export type AutomaticCommit =
  | Readonly<{ result: "created" | "reused"; sourceId: string; sourceGeneration: number }>
  | Readonly<{ result: "fenced" | "capacity_limited" | "authority_changed" }>;
export type AutomaticRejectedToken = Readonly<{
  admission: "rejected";
  claim: AutomaticClaim;
  settledTokenEnc: string;
  accessTokenExpiresAt: Date;
}>;
export type AutomaticAuthLossProof =
  | Readonly<{
      cause:
        | "verified_scope_missing"
        | "verified_subject_mismatch"
        | "verified_owner_mismatch";
      rejected: AutomaticRejectedToken;
    }>
  | Readonly<{ cause: "esi_membership_unauthorized"; token: AutomaticToken }>
  | Readonly<{ cause: "esi_roster_unauthorized"; bound: AutomaticBound }>;
export type AutomaticRetryFailure = Omit<AutomaticFailure, "outcome"> &
  Readonly<{
    outcome: Exclude<
      AutomaticFailure["outcome"],
      "fleet_read_invalid" | "identity_changed"
    >;
  }>;

function sameAutomaticIdentity(candidate: Candidate, boss: Binding): boolean {
  return (
    candidate.accountId === boss.accountId &&
    candidate.characterId === boss.id &&
    candidate.ownerHash === boss.ownerHash &&
    candidate.linkEpoch === boss.fleetLinkEpoch
  );
}
export function isAutomaticCandidateSuspended(
  candidate: Candidate,
  boss: Binding,
): boolean {
  return (
    sameAutomaticIdentity(candidate, boss) &&
    (candidate.lastOutcome === "fleet_read_invalid" ||
      candidate.lastOutcome === "identity_changed")
  );
}
const clearedAutomaticCallbacks = {
  reservationId: null,
  enqueueUntil: null,
  claimReservationId: null,
  claimExpiresAt: null,
  sourceId: null,
};
/** Pure binding transition; the bounded scanner persists it under account locks.
 * Consent-only reconciliation must not recycle a failed grant or exhausted task. */
export function reconcileAutomaticCandidateBinding(
  candidate: Candidate,
  boss: Binding,
  consentGeneration: number,
): Candidate | null {
  if (
    !PositiveIdSchema.safeParse(consentGeneration).success ||
    candidate.accountId !== boss.accountId ||
    candidate.characterId !== boss.id
  )
    return null;
  const sameIdentity = sameAutomaticIdentity(candidate, boss);
  if (sameIdentity && candidate.consentGeneration === consentGeneration) return candidate;
  const generation = checkedCounterAdd(candidate.candidateGeneration, 1);
  if (generation === null) return { ...candidate, ...clearedAutomaticCallbacks };
  return {
    ...candidate,
    ...clearedAutomaticCallbacks,
    candidateGeneration: generation,
    consentGeneration,
    ownerHash: boss.ownerHash,
    linkEpoch: boss.fleetLinkEpoch,
    ...(sameIdentity ? {} : { lastOutcome: null, failureCount: 0 }),
  };
}
/** Per-candidate half of admission, shared by claim and the bounded scanner.
 * The transaction owner additionally proves mode, Member, grant and approver. */
export function automaticCandidateAdmissible(
  candidate: Candidate,
  boss: Binding,
  consentGeneration: number,
  now: Date,
): boolean {
  return (
    sameAutomaticIdentity(candidate, boss) &&
    candidate.consentGeneration === consentGeneration &&
    !isAutomaticCandidateSuspended(candidate, boss) &&
    candidate.candidateGeneration < Number.MAX_SAFE_INTEGER &&
    candidate.claimGeneration < Number.MAX_SAFE_INTEGER - 1 &&
    candidate.sourceId === null &&
    candidate.nextAttemptAt <= now &&
    (candidate.claimExpiresAt === null || candidate.claimExpiresAt <= now)
  );
}
function automaticJitter(
  candidate: Pick<
    Candidate,
    "accountId" | "characterId" | "consentGeneration" | "claimGeneration"
  >,
): number {
  return (
    createHash("sha256")
      .update(
        [
          "fleet-automatic-jitter-v2",
          candidate.accountId,
          String(candidate.characterId),
          String(candidate.consentGeneration),
          String(candidate.claimGeneration),
        ].join("\n"),
        "utf8",
      )
      .digest()
      .readUInt32BE(0) % 3001
  );
}
/** Invalid supplied pacing is not freshness; preserve the existing conservative
 * probe boundary as well as every independently valid lower bound. */
export function automaticRetrySchedule(
  candidate: Pick<
    Candidate,
    | "accountId"
    | "characterId"
    | "consentGeneration"
    | "claimGeneration"
    | "failureCount"
    | "nextAttemptAt"
  >,
  outcome: AutomaticFailure["outcome"],
  supplied: Date | null,
  now: Date,
): { failureCount: number; nextAttemptAt: Date } {
  const suspended = outcome === "fleet_read_invalid" || outcome === "identity_changed";
  const healthy = outcome === "not_in_fleet" || outcome === "not_boss";
  const failureCount = suspended
    ? candidate.failureCount
    : healthy
      ? 0
      : Math.min(6, candidate.failureCount + 1);
  const delay =
    suspended || healthy || outcome === "capacity_limited"
      ? 30000
      : Math.min(900000, 30000 * 2 ** (failureCount - 1));
  const validSupplied =
    supplied instanceof Date &&
    Number.isFinite(supplied.getTime()) &&
    IsoDateSchema.safeParse(supplied.toISOString()).success;
  return {
    failureCount,
    nextAttemptAt: new Date(
      Math.max(
        candidate.nextAttemptAt.getTime(),
        now.getTime() + delay + automaticJitter(candidate),
        validSupplied ? supplied.getTime() : 0,
        supplied !== null && !validSupplied
          ? now.getTime() + FLEET_CONSERVATIVE_PROBE_MS
          : 0,
      ),
    ),
  };
}

export const AUTOMATIC_RECEIPT_TTL_MS = 86_400_000;
export const AUTOMATIC_INTENT_TTL_MS = 60_000;
export const ClosedReasonSchema = z.enum([
  "explicit_off",
  "source_stop",
  "approver_revoked",
]);
export const ConsentSchema = z
  .object({
    generation: SafeCounterSchema,
    revision: SafeCounterSchema,
    enabled: z.boolean(),
    approving_device_id: ExistingUuidSchema.nullable(),
    approved_at: IsoDateSchema.nullable(),
    disabled_at: IsoDateSchema.nullable(),
    closed_reason: ClosedReasonSchema.nullable(),
  })
  .strict()
  .refine(
    (consent) => {
      if (consent.generation === 0)
        return (
          consent.revision === 0 &&
          !consent.enabled &&
          consent.approving_device_id === null &&
          consent.approved_at === null &&
          consent.disabled_at === null &&
          consent.closed_reason === null
        );
      return (
        consent.revision >= consent.generation &&
        consent.approving_device_id !== null &&
        consent.approved_at !== null &&
        (consent.enabled
          ? consent.revision < Number.MAX_SAFE_INTEGER &&
            consent.disabled_at === null &&
            consent.closed_reason === null
          : consent.disabled_at !== null &&
            consent.disabled_at >= consent.approved_at &&
            consent.closed_reason !== null)
      );
    },
    { message: "inconsistent consent" },
  );
export type Consent = z.infer<typeof ConsentSchema>;

export const AutomaticBindingSchema = z
  .object({ consent_generation: PositiveIdSchema })
  .strict();
export type AutomaticBinding = z.infer<typeof AutomaticBindingSchema>;
export const SourceBindingSchema = z
  .object({
    source_id: UuidV4Schema,
    source_generation: PositiveInt4Schema,
    consent_generation: PositiveIdSchema,
  })
  .strict();
export type SourceBinding = z.infer<typeof SourceBindingSchema>;
const ReadinessSchema = z.enum([
  "off",
  "global_disabled",
  "member_required",
  "authorization_required",
  "capacity_limited",
  "waiting_for_grant",
  "waiting_for_fleet",
  "verifying",
  "reconnecting",
  "ready",
]);
const RecoveryActionSchema = z.enum([
  "none",
  "restore_membership",
  "authorize_fleet_read",
  "reauthorize_automatic",
  "wait",
]);
const statusFields = {
  consent: ConsentSchema,
  readiness: ReadinessSchema,
  recovery_action: RecoveryActionSchema,
  retry_at: IsoDateSchema.nullable(),
  sources: z.array(SourceBindingSchema).max(16),
};
const StatusObjectSchema = z
  .object({
    ...statusFields,
    approver: z.enum(["none", "this_device", "other_device", "revoked"]),
  })
  .strict();
const BrowserViewObjectSchema = z
  .object({ ...statusFields, approver: z.enum(["none", "account_device", "revoked"]) })
  .strict();
type StatusValue =
  z.infer<typeof StatusObjectSchema> | z.infer<typeof BrowserViewObjectSchema>;
function validStatus(status: StatusValue): boolean {
  const {
    consent,
    approver,
    readiness,
    recovery_action: action,
    retry_at: retry,
    sources,
  } = status;
  if ((consent.generation === 0) !== (approver === "none")) return false;
  if (!consent.enabled)
    return (
      readiness === "off" && action === "none" && retry === null && sources.length === 0
    );
  if (
    readiness === "off" ||
    !sources.every(
      (source, index) =>
        source.consent_generation === consent.generation &&
        (index === 0 || sources[index - 1].source_id < source.source_id),
    )
  )
    return false;
  // This checks observable DTO consistency, not grant/authority proof. The
  // runtime owner must compute readiness from its locked facts in this order.
  if (
    approver === "revoked" &&
    !["global_disabled", "member_required", "authorization_required"].includes(readiness)
  )
    return false;
  switch (readiness) {
    case "global_disabled":
    case "capacity_limited":
    case "reconnecting":
      return action === "wait";
    case "member_required":
      return action === "restore_membership" && retry === null;
    case "authorization_required":
      return (
        action ===
          (approver === "revoked" ? "reauthorize_automatic" : "authorize_fleet_read") &&
        retry === null
      );
    case "waiting_for_grant":
      return action === "authorize_fleet_read" && retry === null;
    default:
      return action === "none";
  }
}
export const AutomaticStatusSchema = StatusObjectSchema.refine(validStatus, {
  message: "inconsistent automatic status",
});
export type AutomaticStatus = z.infer<typeof AutomaticStatusSchema>;
export const BrowserAutomaticViewSchema = BrowserViewObjectSchema.refine(validStatus, {
  message: "inconsistent browser status",
});
export type BrowserAutomaticView = z.infer<typeof BrowserAutomaticViewSchema>;

const commandFields = {
  protocol: z.literal(API_VERSION),
  request_id: UuidV4Schema,
  intent_created_at: IsoDateSchema,
  enabled: z.boolean(),
  expected_generation: SafeCounterSchema,
  expected_revision: SafeCounterSchema,
};
export const AutomaticCommandSchema = z.object(commandFields).strict();
export type AutomaticCommand = z.infer<typeof AutomaticCommandSchema>;
export const AutomaticOffSchema = z
  .object({ ...commandFields, enabled: z.literal(false) })
  .strict()
  .refine(
    (command) =>
      new TextEncoder().encode(JSON.stringify(command)).length <=
      FLEET_V2_BYTE_LIMITS.automaticPut.requestBytes,
    { message: "oversized browser Off command" },
  );
export type AutomaticOff = z.infer<typeof AutomaticOffSchema>;

export const SourceReasonSchema = z.enum([
  "stopped",
  "expired",
  "superseded",
  "not_in_fleet",
  "boss_lost",
  "identity_changed",
  "fleet_read_invalid",
  "member_lost",
  "device_revoked",
  "token_invalid",
  "mode_transition",
  "service_unavailable",
  "untrustworthy_evidence",
  "timed_out",
  "ended",
]);
export const SourceViewSchema = z
  .object({
    source_id: ExistingUuidSchema,
    generation: PositiveInt4Schema,
    character_id: PositiveIdSchema.nullable(),
    state: z.enum(["pending", "active", "paused", "ended"]),
    reason: SourceReasonSchema.nullable(),
    pending_expires_at: IsoDateSchema.nullable(),
    automatic: AutomaticBindingSchema.nullable(),
  })
  .strict()
  .refine(
    (source) => {
      switch (source.state) {
        case "pending":
          return source.pending_expires_at !== null;
        case "active":
          return source.pending_expires_at === null;
        case "ended":
          return source.pending_expires_at === null && source.reason !== null;
        case "paused":
          return true;
      }
    },
    { message: "inconsistent source state/expiry" },
  );
export type SourceView = z.infer<typeof SourceViewSchema>;
export const SourceCharacterSchema = z
  .object({
    character_id: PositiveIdSchema,
    character_name: CharacterNameSchema,
    character_link_epoch: ExistingUuidSchema,
    has_fleet_read: z.boolean(),
    token_usable: z.boolean(),
  })
  .strict();
export type SourceCharacter = z.infer<typeof SourceCharacterSchema>;
export const SourcesGetSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    sources: z.array(SourceViewSchema).max(256),
    characters: z.array(SourceCharacterSchema).max(256),
  })
  .strict()
  .refine(
    (value) =>
      value.sources.every(
        (source, index) =>
          index === 0 ||
          value.sources[index - 1].source_id.toLowerCase() <
            source.source_id.toLowerCase(),
      ) &&
      value.characters.every(
        (character, index) =>
          index === 0 ||
          value.characters[index - 1].character_id < character.character_id,
      ),
    { message: "unsorted or duplicate source/character" },
  );
export type SourcesGet = z.infer<typeof SourcesGetSchema>;
export const SourceStartSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    operation: z.literal("start"),
    source_id: ExistingUuidSchema,
    expected_generation: z.literal(0),
    character_id: PositiveIdSchema,
    character_link_epoch: ExistingUuidSchema,
    intent_created_at: IsoDateSchema,
  })
  .strict();
export type SourceStart = z.infer<typeof SourceStartSchema>;
export const SourceStopSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    operation: z.literal("stop"),
    request_id: UuidV4Schema,
    intent_created_at: IsoDateSchema,
    source_id: ExistingUuidSchema,
    expected_generation: SourceExpectedGenerationSchema,
    expected_automatic: AutomaticBindingSchema.nullable(),
  })
  .strict();
export type SourceStop = z.infer<typeof SourceStopSchema>;
export const StopEffectSchema = z.enum([
  "manual_only",
  "unknown_cancelled",
  "disabled_current",
  "current_already_off",
  "older_generation_only",
]);
export type StopEffect = z.infer<typeof StopEffectSchema>;

const sameUuid = (a: string | null, b: string | null) =>
  a?.toLowerCase() === b?.toLowerCase();
const sameBinding = (a: AutomaticBinding | null, b: AutomaticBinding | null) =>
  a?.consent_generation === b?.consent_generation;
function sameConsent(a: Consent, b: Consent): boolean {
  return (
    a.generation === b.generation &&
    a.revision === b.revision &&
    a.enabled === b.enabled &&
    sameUuid(a.approving_device_id, b.approving_device_id) &&
    a.approved_at === b.approved_at &&
    a.disabled_at === b.disabled_at &&
    a.closed_reason === b.closed_reason
  );
}
function currentAfterReceipt(current: Consent, historical: Consent): boolean {
  if (
    current.revision < historical.revision ||
    current.generation < historical.generation
  )
    return false;
  if (current.revision === historical.revision) return sameConsent(current, historical);
  // Within one generation, only the single terminal On -> Off transition can
  // advance revision. Off no-ops cannot grow history; reauthorization is a new
  // generation and may legitimately span observations this receipt never saw.
  if (current.generation === historical.generation)
    return (
      historical.enabled &&
      !current.enabled &&
      current.revision === checkedCounterAdd(historical.revision, 1) &&
      sameUuid(current.approving_device_id, historical.approving_device_id) &&
      current.approved_at === historical.approved_at
    );
  return true;
}
function sameAutomaticCommand(a: AutomaticCommand, b: AutomaticCommand): boolean {
  return (
    a.protocol === b.protocol &&
    a.request_id === b.request_id &&
    a.intent_created_at === b.intent_created_at &&
    a.enabled === b.enabled &&
    a.expected_generation === b.expected_generation &&
    a.expected_revision === b.expected_revision
  );
}
function sameStopCommand(a: SourceStop, b: SourceStop): boolean {
  return (
    a.protocol === b.protocol &&
    a.operation === b.operation &&
    a.request_id === b.request_id &&
    a.intent_created_at === b.intent_created_at &&
    sameUuid(a.source_id, b.source_id) &&
    a.expected_generation === b.expected_generation &&
    sameBinding(a.expected_automatic, b.expected_automatic)
  );
}
function sameSource(a: SourceView, b: SourceView): boolean {
  return (
    sameUuid(a.source_id, b.source_id) &&
    a.generation === b.generation &&
    a.character_id === b.character_id &&
    a.state === b.state &&
    a.reason === b.reason &&
    a.pending_expires_at === b.pending_expires_at &&
    sameBinding(a.automatic, b.automatic)
  );
}
function receiptTimes(
  accepted: string,
  expires: string,
  intent: string,
  consent: Consent,
  boundedIntent: boolean,
): boolean {
  const age = Date.parse(accepted) - Date.parse(intent);
  return (
    checkedDateAdd(accepted, AUTOMATIC_RECEIPT_TTL_MS) === expires &&
    age >= 0 &&
    (!boundedIntent || age < AUTOMATIC_INTENT_TTL_MS) &&
    (consent.approved_at === null || consent.approved_at <= accepted) &&
    (consent.disabled_at === null || consent.disabled_at <= accepted)
  );
}
export const AutomaticReceiptSchema = z
  .object({
    kind: z.literal("automatic"),
    command: AutomaticCommandSchema,
    accepted_at: IsoDateSchema,
    expires_at: IsoDateSchema,
    result: ConsentSchema,
  })
  .strict()
  .refine(
    (receipt) => {
      const { command, result } = receipt;
      return (
        receiptTimes(
          receipt.accepted_at,
          receipt.expires_at,
          command.intent_created_at,
          result,
          command.enabled,
        ) &&
        result.enabled === command.enabled &&
        result.generation ===
          (command.enabled
            ? checkedCounterAdd(command.expected_generation, 1)
            : command.expected_generation) &&
        result.revision ===
          checkedCounterAdd(
            command.expected_revision,
            1,
            command.enabled ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER,
          )
      );
    },
    { message: "inconsistent automatic receipt" },
  );
export type AutomaticReceipt = z.infer<typeof AutomaticReceiptSchema>;

function validStopEffect(
  effect: StopEffect,
  source: SourceView,
  consent: Consent,
): boolean {
  if (source.state !== "ended") return false;
  const generation = source.automatic?.consent_generation;
  switch (effect) {
    case "manual_only":
    case "unknown_cancelled":
      return generation === undefined;
    case "disabled_current":
    case "current_already_off":
      return generation === consent.generation && !consent.enabled;
    case "older_generation_only":
      return generation !== undefined && generation < consent.generation;
  }
}
function stopSourceMatches(command: SourceStop, source: SourceView): boolean {
  return (
    sameUuid(command.source_id, source.source_id) &&
    sameBinding(command.expected_automatic, source.automatic) &&
    (command.expected_generation !== 0 || source.automatic === null)
  );
}
export const SourceStopReceiptSchema = z
  .object({
    kind: z.literal("source_stop"),
    command: SourceStopSchema,
    accepted_at: IsoDateSchema,
    expires_at: IsoDateSchema,
    source: SourceViewSchema,
    automatic_effect: StopEffectSchema,
    consent: ConsentSchema,
  })
  .strict()
  .refine(
    (receipt) => {
      const { command, source, consent, automatic_effect: effect } = receipt;
      return (
        receiptTimes(
          receipt.accepted_at,
          receipt.expires_at,
          command.intent_created_at,
          consent,
          true,
        ) &&
        stopSourceMatches(command, source) &&
        validStopEffect(effect, source, consent) &&
        (effect === "unknown_cancelled"
          ? command.expected_generation === 0 &&
            command.expected_automatic === null &&
            source.generation === 1
          : command.expected_generation > 0 &&
            (source.generation === command.expected_generation ||
              source.generation ===
                checkedCounterAdd(command.expected_generation, 1, 2_147_483_647)))
      );
    },
    { message: "inconsistent source Stop receipt" },
  );
export type SourceStopReceipt = z.infer<typeof SourceStopReceiptSchema>;
export const ReceiptSchema = z.union([AutomaticReceiptSchema, SourceStopReceiptSchema]);
export type Receipt = z.infer<typeof ReceiptSchema>;
export const AutomaticGetSchema = z
  .object({ protocol: z.literal(API_VERSION), status: AutomaticStatusSchema })
  .strict();
export type AutomaticGet = z.infer<typeof AutomaticGetSchema>;
const automaticResultFields = {
  request_id: UuidV4Schema,
  result: z.enum(["applied", "replayed", "already_off"]),
  receipt: AutomaticReceiptSchema.nullable(),
};
function validAutomaticResult(value: {
  request_id: string;
  result: "applied" | "replayed" | "already_off";
  receipt: AutomaticReceipt | null;
  status: StatusValue;
}): boolean {
  if (value.result === "already_off")
    return value.receipt === null && !value.status.consent.enabled;
  return (
    value.receipt !== null &&
    value.request_id === value.receipt.command.request_id &&
    currentAfterReceipt(value.status.consent, value.receipt.result)
  );
}
export const AutomaticResultSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    ...automaticResultFields,
    status: AutomaticStatusSchema,
  })
  .strict()
  .refine(validAutomaticResult, { message: "inconsistent automatic result" });
export type AutomaticResult = z.infer<typeof AutomaticResultSchema>;
export const ReceiptGetSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    receipt: ReceiptSchema,
    status: AutomaticStatusSchema,
  })
  .strict()
  .refine(
    (value) =>
      currentAfterReceipt(
        value.status.consent,
        value.receipt.kind === "automatic" ? value.receipt.result : value.receipt.consent,
      ),
    { message: "contradictory receipt/current consent" },
  );
export type ReceiptGet = z.infer<typeof ReceiptGetSchema>;
export const SourceStartResultSchema = z
  .object({ protocol: z.literal(API_VERSION), source: SourceViewSchema })
  .strict()
  .refine((value) => value.source.automatic === null, {
    message: "manual Start cannot return automatic provenance",
  });
export type SourceStartResult = z.infer<typeof SourceStartResultSchema>;
export const SourceStopResultSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    request_id: UuidV4Schema,
    result: z.enum(["applied", "replayed", "already_stopped"]),
    receipt: SourceStopReceiptSchema.nullable(),
    source: SourceViewSchema,
    automatic_effect: StopEffectSchema,
    status: AutomaticStatusSchema,
  })
  .strict()
  .refine(
    (value) => {
      if (value.result === "already_stopped")
        return (
          value.receipt === null &&
          value.automatic_effect !== "disabled_current" &&
          value.automatic_effect !== "unknown_cancelled" &&
          validStopEffect(value.automatic_effect, value.source, value.status.consent)
        );
      const receipt = value.receipt;
      return (
        receipt !== null &&
        value.request_id === receipt.command.request_id &&
        sameSource(value.source, receipt.source) &&
        value.automatic_effect === receipt.automatic_effect &&
        currentAfterReceipt(value.status.consent, receipt.consent)
      );
    },
    { message: "inconsistent source Stop result" },
  );
export type SourceStopResult = z.infer<typeof SourceStopResultSchema>;

const BrowserOffSuccessSchema = z
  .object({
    ok: z.literal(true),
    ...automaticResultFields,
    status: BrowserAutomaticViewSchema,
  })
  .strict()
  .refine(
    (value) =>
      validAutomaticResult(value) &&
      (value.receipt === null || !value.receipt.command.enabled),
    { message: "inconsistent browser Off result" },
  );
const BrowserOffErrorSchema = z
  .object({
    ok: z.literal(false),
    request_id: UuidV4Schema.nullable(),
    error: z.enum([
      "bad_request",
      "unauthorized",
      "invalid_intent",
      "conflict",
      "request_id_conflict",
      "service_unavailable",
    ]),
    status: BrowserAutomaticViewSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => {
      if (value.error === "bad_request")
        return value.request_id === null && value.status === null;
      return (
        value.request_id !== null &&
        (value.error === "conflict" || value.error === "request_id_conflict"
          ? value.status !== null
          : value.status === null)
      );
    },
    { message: "inconsistent browser error" },
  );
export const BrowserOffReplySchema = z.union([
  BrowserOffSuccessSchema,
  BrowserOffErrorSchema,
]);
export type BrowserOffReply = z.infer<typeof BrowserOffReplySchema>;

function matchesAutomaticResult(
  response: {
    request_id: string;
    result: string;
    receipt: AutomaticReceipt | null;
    status: StatusValue;
  },
  command: AutomaticCommand,
): boolean {
  if (response.request_id !== command.request_id) return false;
  if (response.receipt !== null)
    return sameAutomaticCommand(response.receipt.command, command);
  return (
    !command.enabled &&
    !response.status.consent.enabled &&
    command.expected_generation === response.status.consent.generation &&
    command.expected_revision === response.status.consent.revision
  );
}
/** Context is a production boundary, not an optional fixture hint. Both inputs
 * pass the shared original-value guard. Bare response schemas validate internal
 * correlations; these helpers additionally bind settlement to the caller's exact
 * immutable command (or signed receipt selector). No transport binding is implied.
 */
export function parseAutomaticResult(value: unknown, command: unknown) {
  return safeParseFleetV2Dto(
    z
      .object({ response: AutomaticResultSchema, command: AutomaticCommandSchema })
      .strict()
      .refine(({ response, command }) => matchesAutomaticResult(response, command), {
        message: "automatic command mismatch",
      })
      .transform(({ response }) => response),
    { response: value, command },
  );
}
export function parseSourceStartResult(value: unknown, command: unknown) {
  return safeParseFleetV2Dto(
    z
      .object({ response: SourceStartResultSchema, command: SourceStartSchema })
      .strict()
      .refine(
        ({ response, command }) =>
          sameUuid(response.source.source_id, command.source_id) &&
          response.source.character_id === command.character_id,
        { message: "Start command mismatch" },
      )
      .transform(({ response }) => response),
    { response: value, command },
  );
}
export function parseSourceStopResult(value: unknown, command: unknown) {
  return safeParseFleetV2Dto(
    z
      .object({ response: SourceStopResultSchema, command: SourceStopSchema })
      .strict()
      .refine(
        ({ response, command }) =>
          response.request_id === command.request_id &&
          stopSourceMatches(command, response.source) &&
          (response.receipt !== null
            ? sameStopCommand(response.receipt.command, command)
            : response.source.generation === command.expected_generation),
        { message: "Stop command mismatch" },
      )
      .transform(({ response }) => response),
    { response: value, command },
  );
}
export function parseReceiptGet(value: unknown, requestId: unknown, command?: unknown) {
  return safeParseFleetV2Dto(
    z
      .object({
        response: ReceiptGetSchema,
        requestId: UuidV4Schema,
        command: z.union([AutomaticCommandSchema, SourceStopSchema]).optional(),
      })
      .strict()
      .refine(
        ({ response, requestId, command }) => {
          const receipt = response.receipt;
          if (receipt.command.request_id !== requestId) return false;
          if (command === undefined) return true;
          return receipt.kind === "automatic"
            ? "enabled" in command && sameAutomaticCommand(receipt.command, command)
            : "operation" in command && sameStopCommand(receipt.command, command);
        },
        { message: "receipt selector/command mismatch" },
      )
      .transform(({ response }) => response),
    { response: value, requestId, command },
  );
}
export function parseBrowserOffReply(value: unknown, command: unknown) {
  return safeParseFleetV2Dto(
    z
      .object({ response: BrowserOffReplySchema, command: AutomaticOffSchema })
      .strict()
      .refine(
        ({ response, command }) =>
          response.ok
            ? matchesAutomaticResult(response, command)
            : response.request_id === null || response.request_id === command.request_id,
        { message: "browser Off command mismatch" },
      )
      .transform(({ response }) => response),
    { response: value, command },
  );
}
