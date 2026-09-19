import { z } from "zod";
import {
  COMBAT_LIMITS,
  isForbiddenScalar,
  validateObservedName,
} from "./fleet-combat-profile";

// API representation and the deployed cryptographic scheme are independent.
export const API_VERSION = 2 as const;
export const SIGNING_SCHEME_VERSION = 1 as const;

const limits = (requestBytes: number, successBytes: number) =>
  Object.freeze({ requestBytes, successBytes });
export const FLEET_V2_BYTE_LIMITS = Object.freeze({
  snapshotPut: limits(COMBAT_LIMITS.put_bytes, 1_048_576),
  snapshotGet: limits(0, COMBAT_LIMITS.get_bytes),
  automaticGet: limits(0, 16_384),
  automaticPut: limits(2048, 16_384),
  receiptGet: limits(0, 16_384),
  sourcesGet: limits(0, 1_048_576),
  sourcesPut: limits(2048, 1_048_576),
  preSessionPost: limits(2048, 65_536),
  deviceGet: limits(0, 1_048_576),
  devicePut: limits(1024, 1_048_576),
  catalogueGet: limits(0, 1_048_576),
  sessionPut: limits(1024, 1_048_576),
  participationPut: limits(1024, 1_048_576),
  eligibilityGet: limits(0, 1_048_576),
});
export const FLEET_V2_ERROR_BYTES = 65_536;

/** The common dictionary, not permission to use every code on every route.
 * Automatic/pre-session consumers must still enforce their closed subsets.
 */
export const FLEET_V2_STATUS_BY_CODE = Object.freeze({
  bad_headers: 400,
  bad_request: 400,
  update_required: 400,
  invalid_intent: 400,
  invalid_key: 400,
  unauthorized: 401,
  forbidden: 403,
  capability_required: 403,
  fleet_read_required: 403,
  not_verified: 403,
  receipt_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  request_id_conflict: 409,
  revision_replayed: 409,
  not_completable: 409,
  rate_limited: 429,
  receipt_capacity: 429,
  feature_disabled: 503,
  service_unavailable: 503,
} as const);
export type FleetV2Code = keyof typeof FLEET_V2_STATUS_BY_CODE;
export const FleetV2ErrorSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    error: z.enum(Object.keys(FLEET_V2_STATUS_BY_CODE) as FleetV2Code[]),
  })
  .strict();
export type FleetV2Error = z.infer<typeof FleetV2ErrorSchema>;

const existingUuidFormat = z.uuid();
// Zod's UUID version alternatives are case-insensitive, but its special max
// UUID spelling is not. Validate lowercase without rewriting legacy IDs.
export const ExistingUuidSchema = z
  .string()
  .refine((value) => existingUuidFormat.safeParse(value.toLowerCase()).success, {
    message: "invalid existing UUID",
  });
export const UuidV4Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
// 32 bytes leave two unused bits in the last base64url character. Restrict
// those bits rather than accepting alternate spellings of the same token.
export const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(
    (value) => {
      if (value.startsWith("0000-")) return false;
      const ms = Date.parse(value);
      return Number.isFinite(ms) && new Date(ms).toISOString() === value;
    },
    { message: "noncanonical UTC date" },
  );
export const SafeIntegerSchema = z.number().int().max(Number.MAX_SAFE_INTEGER);
export const SafeCounterSchema = SafeIntegerSchema.min(0);
export const PositiveIdSchema = SafeCounterSchema.min(1);
export const Int4Schema = SafeCounterSchema.max(2_147_483_647);
export const PositiveInt4Schema = Int4Schema.min(1);
export const SourceExpectedGenerationSchema = Int4Schema.max(2_147_483_646);
// Catalogue revisions are opaque uint32 fingerprints, never signed-request/CAS counters.
export const CatalogueRevisionSchema = SafeCounterSchema.max(4_294_967_295);
export type CatalogueRevision = z.infer<typeof CatalogueRevisionSchema>;

/** Callers can pass a lower ceiling to reserve a later terminal increment. */
export function checkedCounterAdd(
  value: number,
  increment: number,
  ceiling = Number.MAX_SAFE_INTEGER,
): number | null {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    !Number.isSafeInteger(ceiling) ||
    ceiling < 0 ||
    value > ceiling ||
    increment > ceiling - value
  )
    return null;
  return value + increment;
}

/** Refuse unsupported dates instead of wrapping/clamping authority lifetimes. */
export function checkedDateAdd(value: string, milliseconds: number): string | null {
  if (!IsoDateSchema.safeParse(value).success || !Number.isSafeInteger(milliseconds))
    return null;
  const result = Date.parse(value) + milliseconds;
  if (!Number.isSafeInteger(result)) return null;
  const date = new Date(result);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return IsoDateSchema.safeParse(canonical).success ? canonical : null;
}

export const CapabilitiesSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("shared-source-v1")]),
  z.tuple([z.literal("shared-source-v1"), z.literal("combat-v2")]),
]);
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Identity names deliberately do NOT use tackle trim/NFC/markup rules.
 * Only scalar classification is shared with the frozen observed-name foundation.
 */
export const CharacterNameSchema = z.string().refine(
  (value) => {
    if (value.length > COMBAT_LIMITS.character_name_scalars * 2) return false;
    const scalars = Array.from(value);
    if (scalars.length < 1 || scalars.length > COMBAT_LIMITS.character_name_scalars)
      return false;
    return scalars.every((char) => !isForbiddenScalar(char.codePointAt(0)));
  },
  { message: "invalid character display name" },
);

export const CatalogueSchema = z
  .object({
    revision: CatalogueRevisionSchema,
    characters: z
      .array(
        z
          .object({
            character_id: PositiveIdSchema,
            character_name: CharacterNameSchema,
          })
          .strict(),
      )
      .max(8192)
      .refine(
        (characters) =>
          new Set(characters.map((character) => character.character_id)).size ===
          characters.length,
        { message: "duplicate catalogue character" },
      ),
  })
  .strict();
export type Catalogue = z.infer<typeof CatalogueSchema>;
export const CatalogueGetSchema = CatalogueSchema.extend({
  protocol: z.literal(API_VERSION),
});
export type CatalogueGet = z.infer<typeof CatalogueGetSchema>;
export const PairingCompletedSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    session_id: TokenSchema,
    catalogue: CatalogueSchema,
  })
  .strict();
export type PairingCompleted = z.infer<typeof PairingCompletedSchema>;

const AgeSchema = SafeCounterSchema.max(COMBAT_LIMITS.activity_ms - 1);
const DpsSchema = SafeCounterSchema.max(10_000_000).nullable();
export const CombatObservationSchema = z
  .object({
    name: z
      .string()
      .refine(validateObservedName, { message: "noncanonical observed name" })
      .nullable(),
    age_ms: AgeSchema,
  })
  .strict();
export const CombatEffectSchema = z
  .object({
    kind: z.enum(["SCRAM", "POINT", "NEUT"]),
    observations: z
      .array(CombatObservationSchema)
      .min(1)
      .max(COMBAT_LIMITS.observations_per_tackle),
  })
  .strict()
  .refine(
    (effect) => {
      if (effect.kind === "NEUT")
        return effect.observations.length === 1 && effect.observations[0].name === null;
      const names = effect.observations.map((observation) => observation.name);
      return (
        new Set(names).size === names.length &&
        names.filter((name) => name !== null).length <= COMBAT_LIMITS.named_per_tackle
      );
    },
    { message: "duplicate or excessive observations" },
  );
export type CombatObservation = z.infer<typeof CombatObservationSchema>;
export type CombatEffect = z.infer<typeof CombatEffectSchema>;

const RowObjectSchema = z
  .object({
    character_id: PositiveIdSchema,
    outgoing_dps: DpsSchema,
    incoming_dps: DpsSchema,
    activity_age_ms: AgeSchema,
    effects: z.array(CombatEffectSchema).max(COMBAT_LIMITS.effects_per_row),
  })
  .strict();
function validRowAgesAndOrder(row: z.infer<typeof RowObjectSchema>): boolean {
  return row.effects.every(
    (effect, index) =>
      (index === 0 ||
        COMBAT_LIMITS.effect_order.indexOf(row.effects[index - 1].kind) <
          COMBAT_LIMITS.effect_order.indexOf(effect.kind)) &&
      effect.observations.every(
        (observation) => row.activity_age_ms <= observation.age_ms,
      ),
  );
}
export const CombatRowSchema = RowObjectSchema.refine(validRowAgesAndOrder, {
  message: "invalid effect order or activity age",
});
export type CombatRow = z.infer<typeof CombatRowSchema>;

function nonnegativeOrigins(row: CombatRow, sample: number): boolean {
  return (
    sample >= row.activity_age_ms &&
    row.effects.every((effect) =>
      effect.observations.every((observation) => sample >= observation.age_ms),
    )
  );
}
export const CombatPutSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    sampled_at_ms: SafeCounterSchema,
    rows: z.array(CombatRowSchema).max(COMBAT_LIMITS.put_rows),
  })
  .strict()
  .refine(
    (value) => {
      if (value.rows.length === 0) return value.sampled_at_ms === 0;
      return (
        new Set(value.rows.map((row) => row.character_id)).size === value.rows.length &&
        value.rows.every((row) => nonnegativeOrigins(row, value.sampled_at_ms))
      );
    },
    { message: "duplicate character, invalid withdrawal or negative origin" },
  );
export type CombatPut = z.infer<typeof CombatPutSchema>;
export const CombatPutSuccessSchema = z
  .object({ protocol: z.literal(API_VERSION) })
  .strict();
export type CombatPutSuccess = z.infer<typeof CombatPutSuccessSchema>;

export const CombatReadRowSchema = RowObjectSchema.extend({
  character_name: CharacterNameSchema,
  state: z.enum(["live", "stale"]),
  age_ms: SafeCounterSchema.max(COMBAT_LIMITS.transport_ms - 1),
  publication_id: UuidV4Schema,
})
  .refine(validRowAgesAndOrder, { message: "invalid effect order or activity age" })
  .refine(
    (row) =>
      row.age_ms <= row.activity_age_ms &&
      row.state === (row.age_ms < COMBAT_LIMITS.stale_ms ? "live" : "stale"),
    { message: "inconsistent transport age/state" },
  );
export type CombatReadRow = z.infer<typeof CombatReadRowSchema>;
export const CombatGetSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    server_time_ms: SafeCounterSchema,
    rows: z.array(CombatReadRowSchema).max(COMBAT_LIMITS.get_rows),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.rows.map((row) => row.character_id)).size === value.rows.length &&
      new Set(value.rows.map((row) => row.publication_id)).size === value.rows.length &&
      value.rows.every((row) => nonnegativeOrigins(row, value.server_time_ms)),
    { message: "duplicate character/publication or negative origin" },
  );
export type CombatGet = z.infer<typeof CombatGetSchema>;

export const DeviceAckSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    capabilities: CapabilitiesSchema,
  })
  .strict();
export type DeviceAck = z.infer<typeof DeviceAckSchema>;
export const ControlDeviceSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    device_id: ExistingUuidSchema,
    session_expires_at: IsoDateSchema,
    feature_enabled: z.boolean(),
    approved_capabilities: CapabilitiesSchema,
    session_approved_capabilities: CapabilitiesSchema,
    acknowledged_capabilities: CapabilitiesSchema,
    participation: z.object({ enabled: z.boolean(), generation: Int4Schema }).strict(),
    server_time_ms: SafeCounterSchema,
  })
  .strict();
export type ControlDevice = z.infer<typeof ControlDeviceSchema>;

export const SessionRenewSchema = z.object({ protocol: z.literal(API_VERSION) }).strict();
export const SessionRenewedSchema = SessionRenewSchema.extend({
  expires_at: IsoDateSchema,
});
export const ParticipationSchema = z
  .object({ enabled: z.boolean(), generation: Int4Schema })
  .strict();
export const ParticipationPutSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    enabled: z.boolean(),
    expected_generation: SourceExpectedGenerationSchema,
  })
  .strict();
export const ParticipationResultSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    participation: ParticipationSchema,
  })
  .strict();
export const EligibilityGetSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    participation_generation: Int4Schema,
    state: z.enum(["ready", "participation_off", "not_verified"]),
    characters: z
      .array(
        z
          .object({
            character_id: PositiveIdSchema,
            source_id: ExistingUuidSchema,
            source_generation: PositiveInt4Schema,
            authority_generation: Int4Schema,
            expires_at: IsoDateSchema,
          })
          .strict(),
      )
      .max(8192)
      .refine(
        (rows) => new Set(rows.map((row) => row.character_id)).size === rows.length,
      ),
  })
  .strict();

// Encoding is canonical; DER/Ed25519 acceptance remains the existing crypto gate.
export const PublicKeySpkiSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,120}$/)
  .refine((value) => {
    const remainder = value.length % 4;
    return (
      remainder !== 1 &&
      (remainder === 0 ||
        (remainder === 2 ? /[AQgw]$/ : /[AEIMQUYcgkosw048]$/).test(value))
    );
  });
export const ProofSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/);
export const PairingBeginSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    public_key_spki_b64url: PublicKeySpkiSchema,
    requested_capabilities: CapabilitiesSchema,
  })
  .strict();
export const PairingCompleteSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    completion_signature: ProofSignatureSchema,
  })
  .strict();

/** Both server output validation and client/fixture decoding use the configured
 * origin, never an incoming Host header. Relative links resolve only after this gate. */
export function pairingBegunSchema(canonicalOrigin?: string) {
  const approvalUrl = z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => {
      if (/[\s\\\\]/u.test(value) || value.startsWith("//")) return false;
      // The server emits a relative link; consumers resolve it against their
      // configured HTTPS origin, never a response-supplied origin.
      if (canonicalOrigin === undefined) return value.startsWith("/");
      try {
        const origin = new URL(canonicalOrigin);
        const url = new URL(value, canonicalOrigin);
        return (
          origin.protocol === "https:" &&
          origin.origin === canonicalOrigin &&
          url.protocol === "https:" &&
          url.origin === canonicalOrigin &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    })
    .transform((value) =>
      canonicalOrigin === undefined ? value : new URL(value, canonicalOrigin).href,
    );
  return z
    .object({
      protocol: z.literal(API_VERSION),
      pairing_id: ExistingUuidSchema,
      approval_url: approvalUrl,
      expires_at: IsoDateSchema,
    })
    .strict();
}
export const RecoveryBeginSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    public_key_spki_b64url: PublicKeySpkiSchema,
    request_id: TokenSchema,
    issued_at: IsoDateSchema,
    initiation_signature: ProofSignatureSchema,
  })
  .strict();
export const RecoveryCompleteSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    nonce: TokenSchema,
    recovery_signature: ProofSignatureSchema,
  })
  .strict();
export const RecoveryBegunSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    challenge_id: ExistingUuidSchema,
    request_id: TokenSchema,
    nonce: TokenSchema,
    expires_at: IsoDateSchema,
  })
  .strict();
export const RecoveryReconnectedSchema = z
  .object({
    protocol: z.literal(API_VERSION),
    result: z.literal("reconnected"),
    device_id: ExistingUuidSchema,
    session_id: TokenSchema,
    session_expires_at: IsoDateSchema,
    approved_capabilities: CapabilitiesSchema,
    participation: ParticipationSchema,
  })
  .strict();
export const RecoveryRetrySchema = z
  .object({
    protocol: z.literal(API_VERSION),
    result: z.enum(["account_ineligible", "retry_later"]),
    retry_after_ms: PositiveInt4Schema.max(86_400_000),
  })
  .strict();
export const RecoveryCompletedSchema = z.union([
  RecoveryReconnectedSchema,
  RecoveryRetrySchema,
  z
    .object({
      protocol: z.literal(API_VERSION),
      result: z.enum(["device_revoked", "device_key_conflict"]),
    })
    .strict(),
]);
