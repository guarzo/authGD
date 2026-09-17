import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import {
  CatalogueGetSchema,
  CatalogueRevisionSchema,
  pairingBegunSchema,
  ParticipationResultSchema,
  EligibilityGetSchema,
  RecoveryBegunSchema,
  RecoveryReconnectedSchema,
  RecoveryRetrySchema,
  SessionRenewedSchema,
  CombatEffectSchema,
  CombatGetSchema,
  CombatPutSchema,
  ControlDeviceSchema,
  FleetV2ErrorSchema,
  Int4Schema,
  IsoDateSchema,
  PairingCompletedSchema,
  PositiveIdSchema,
  PositiveInt4Schema,
  SafeCounterSchema,
  SafeIntegerSchema,
  SourceExpectedGenerationSchema,
  TokenSchema,
  FLEET_V2_BYTE_LIMITS,
  FLEET_V2_ERROR_BYTES,
} from "@/core/fleet-api-v2";
import {
  fleetV2PreSessionBinding,
  fleetV2RequestBinding,
  parseBoundedFleetV2Json,
} from "@/lib/fleet-api-v2";
import {
  canonicalFleetRequest,
  snapshotRequestBinding,
  verifyFleetRequest,
} from "@/lib/fleet-signature";
import {
  recoveryChallengePreimage,
  recoveryInitiationPreimage,
  verifyRecoveryInitiation,
  verifyRecoveryProof,
} from "@/lib/fleet-recovery-proof";
import { pairingChallengePreimage } from "@/services/fleet-pairing";
import {
  fixtureField,
  materializeCodec,
  materializeList,
  type CodecVector,
  type FixturePath,
  type ListVector,
} from "./helpers/fleet-api-v2-fixture";

type RawVector = {
  name: string;
  decoder: string;
  accept: boolean;
  wire: string;
  decoded_fields?: [FixturePath, unknown][];
};
type SignedRecord = {
  protocol: 1;
  method: "GET" | "PUT";
  path: string;
  session_id: string;
  issued_at: string;
  revision: number;
  body_sha256: string;
  body_utf8: string;
  canonical_text: string;
  signature_b64url: string;
  request_binding: string;
};
type PreSessionRecord = {
  origin: string;
  path: string;
  attempt: string;
  body_utf8: string;
  body_sha256: string;
  request_binding: string;
};
type ProofRecord = PreSessionRecord & {
  preimage_utf8: string;
  signature_b64url: string;
};
type Fixture = {
  private_key_hex: string;
  public_key_spki_b64url: string;
  valid: Record<string, unknown>;
  codec_vectors: CodecVector[];
  raw_vectors: RawVector[];
  list_vectors: ListVector[];
  signed_request: SignedRecord;
  signed_operations: (SignedRecord & {
    name: string;
    decoder: string;
    response: string;
  })[];
  pairing_begin: PreSessionRecord;
  pairing_complete: ProofRecord & { pairing_id: string };
  recovery_begin: ProofRecord & { request_id: string; issued_at: string };
  recovery_complete: ProofRecord & { challenge_id: string; nonce: string };
  correlation_vectors: {
    name: string;
    operation: "signed_request" | "recovery_complete";
    mutation: "snapshot-domain" | "attempt" | "body" | "origin";
    value?: string;
    matches: boolean;
  }[];
};

const fixtureUrl = new URL("./fixtures/fleet-api-v2.json", import.meta.url);
const approvedSha256 = "cde5318e54d46ad2b6e9769f65685831e9f23bf429dad9a49b8e8a8d9c1877fc";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string) => Buffer.from(text, "utf8");
const fixtureBytes = readFileSync(fixtureUrl);
// Vite's JSON transform rejects the intentional lone-surrogate cases. This
// parses only the fixture container; wire entities always use the real decoder.
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;
const originalFixture = structuredClone(fixture);

const schemas: Record<string, z.ZodType> = {
  catalogue: CatalogueGetSchema,
  pairing_completed: PairingCompletedSchema,
  pairing_begun: pairingBegunSchema("https://relay.example.test"),
  participation: ParticipationResultSchema,
  eligibility: EligibilityGetSchema,
  recovery_challenge: RecoveryBegunSchema,
  recovery_reconnected: RecoveryReconnectedSchema,
  recovery_retry: RecoveryRetrySchema,
  session: SessionRenewedSchema,
  device: ControlDeviceSchema,
  combat_put: CombatPutSchema,
  combat_get: CombatGetSchema,
  effect: CombatEffectSchema,
  token: TokenSchema,
  date: IsoDateSchema,
  error: FleetV2ErrorSchema,
  integer: SafeIntegerSchema,
};
// No acceptance tests are registered for these families: the v2 DTO/context
// helpers do not exist yet. Counts are derived in fixture-execution-report.md.
const unimplemented = [
  "automatic_get",
  "automatic_result",
  "receipt_get",
  "sources",
  "source_start",
  "source_stop",
  "source_start_result",
  "source_stop_result",
  "automatic_command",
  "source",
  "status",
  "consent",
];
const supported = (vector: { decoder: string }) => Object.hasOwn(schemas, vector.decoder);
const vectorGroups = [fixture.codec_vectors, fixture.raw_vectors, fixture.list_vectors];
const allFamilies = new Set([
  ...vectorGroups.flatMap((group) => group.map((vector) => vector.decoder)),
  ...Object.keys(fixture.valid),
  ...fixture.signed_operations.flatMap((operation) => [
    operation.decoder,
    operation.response,
  ]),
]);

// Numeric fixture expectations are mathematical integers, so -0 equals 0.
// Never normalize/reparse a number (or its signed bytes) to make it pass.
function expectField(actual: unknown, expected: unknown): void {
  if (typeof expected === "number") {
    expect(typeof actual).toBe("number");
    expect(
      actual === expected,
      `mathematical equality: ${String(actual)} vs ${expected}`,
    ).toBe(true);
  } else {
    expect(actual).toStrictEqual(expected);
  }
}

function assertDto(
  vector: {
    decoder: string;
    accept: boolean;
    expect_path?: FixturePath;
    expect?: unknown;
  },
  value: unknown,
): void {
  const schema = schemas[vector.decoder];
  if (!schema) throw new Error(`No implemented decoder: ${vector.decoder}`);
  const result = safeParseFleetV2Dto(schema, value);
  expect(result.success, result.success ? "accepted DTO" : result.error.message).toBe(
    vector.accept,
  );
  if (result.success && Object.hasOwn(vector, "expect")) {
    // Error acceptance is a valid closed error envelope, not operation success.
    const decoded =
      vector.decoder === "error"
        ? (result.data as { error: string }).error
        : vector.decoder === "participation"
          ? (result.data as { participation: unknown }).participation
          : result.data;
    expectField(fixtureField(decoded, vector.expect_path ?? []), vector.expect);
  }
}

// These are raw entity budgets, not assertions about HTTP framing or routes.
const rawBudgets: Record<string, number> = {
  combat_put: FLEET_V2_BYTE_LIMITS.snapshotPut.requestBytes,
  error: FLEET_V2_ERROR_BYTES,
  catalogue: FLEET_V2_BYTE_LIMITS.catalogueGet.successBytes,
  pairing_completed: FLEET_V2_BYTE_LIMITS.preSessionPost.successBytes,
  device: FLEET_V2_BYTE_LIMITS.deviceGet.successBytes,
  source_stop: FLEET_V2_BYTE_LIMITS.sourcesPut.requestBytes,
  // Standalone primitive stress vectors have no HTTP operation of their own.
  integer: FLEET_V2_BYTE_LIMITS.snapshotPut.requestBytes,
};
function decodeRaw(vector: RawVector) {
  const parsed = parseBoundedFleetV2Json(bytes(vector.wire), rawBudgets[vector.decoder]);
  if (vector.decoded_fields) {
    expect(parsed.ok, "decoded_fields must be checked before DTO rejection").toBe(true);
    if (parsed.ok) {
      for (const [path, expected] of vector.decoded_fields) {
        expectField(fixtureField(parsed.value, path), expected);
      }
    }
  }
  return parsed;
}

it("pins the approved fixture bytes", () => {
  expect(sha256(fixtureBytes)).toBe(approvedSha256);
});
it("exhaustively dispatches implemented families or explicitly manifests unimplemented DTOs", () => {
  const manifest = [...Object.keys(schemas), ...unimplemented];
  expect(new Set(manifest).size).toBe(manifest.length);
  expect(manifest.sort()).toEqual([...allFamilies].sort());
  expect(Object.keys(rawBudgets).sort()).toEqual(
    [...new Set(fixture.raw_vectors.map((v) => v.decoder))].sort(),
  );
  for (const vector of fixture.codec_vectors.filter(supported)) {
    // Context-bearing schemas must be implemented before adding their family.
    expect(vector.command, vector.name).toBeUndefined();
    expect(vector.command_set, vector.name).toBeUndefined();
  }
  for (const vector of fixture.raw_vectors.filter((v) => !supported(v))) {
    expect(vector.decoded_fields?.length, vector.name).toBeGreaterThan(0);
  }
});

afterAll(() => {
  expect(fixture).toStrictEqual(originalFixture);
  expect(readFileSync(fixtureUrl)).toEqual(fixtureBytes);
  expect(sha256(readFileSync(fixtureUrl))).toBe(approvedSha256);
});

describe("approved codec vectors through the combined production DTO boundary", () => {
  it.each(fixture.codec_vectors.filter(supported))("$name", (vector) => {
    assertDto(vector, materializeCodec(fixture.valid, vector));
  });
});
describe("approved raw vectors: exact decoder then production DTO", () => {
  it.each(fixture.raw_vectors.filter(supported))("$name", (vector) => {
    const parsed = decodeRaw(vector);
    if (parsed.ok) assertDto(vector, parsed.value);
    else expect(vector.accept).toBe(false);
  });
});
describe("raw decoding only — source_stop DTO acceptance remains unimplemented", () => {
  it.each(fixture.raw_vectors.filter((vector) => !supported(vector)))(
    "$name (decoded_fields only)",
    (vector) => {
      const parsed = decodeRaw(vector);
      expect(parsed.ok).toBe(true);
    },
  );
});
describe("approved list recipes through the combined production DTO boundary", () => {
  it.each(fixture.list_vectors.filter(supported))(
    "$name",
    (vector) => {
      assertDto(vector, materializeList(fixture.valid, vector));
    },
    30000,
  );
});

it("accepts negative safe integers without widening nonnegative fields", () => {
  for (const value of [-9007199254740991, -1, -0, 0, 9007199254740991]) {
    expectField(SafeIntegerSchema.parse(value), value);
  }
  for (const value of [
    -9007199254740992,
    9007199254740992,
    0.5,
    true,
    "1",
    null,
    NaN,
    Infinity,
  ]) {
    expect(SafeIntegerSchema.safeParse(value).success).toBe(false);
  }
  for (const [schema, minimum, maximum] of [
    [SafeCounterSchema, 0, 9007199254740991],
    [PositiveIdSchema, 1, 9007199254740991],
    [Int4Schema, 0, 2147483647],
    [PositiveInt4Schema, 1, 2147483647],
    [SourceExpectedGenerationSchema, 0, 2147483646],
    [CatalogueRevisionSchema, 0, 4294967295],
  ] as const) {
    expect(schema.safeParse(-1).success).toBe(false);
    expect(schema.safeParse(minimum - 1).success).toBe(false);
    expect(schema.parse(minimum)).toBe(minimum);
    expect(schema.parse(maximum)).toBe(maximum);
    expect(schema.safeParse(maximum + 1).success).toBe(false);
  }
});

const publicKeyBytes = Buffer.from(fixture.public_key_spki_b64url, "base64url");
const publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(fixture.private_key_hex, "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
const signedRecords = [
  { name: "signed_request", ...fixture.signed_request },
  ...fixture.signed_operations,
];
function signedInput(record: SignedRecord) {
  return {
    protocol: record.protocol,
    method: record.method,
    path: record.path,
    sessionId: record.session_id,
    issuedAt: record.issued_at,
    revision: record.revision,
    bodySha256: record.body_sha256,
  };
}
it.each(signedRecords)(
  "$name: exact canonical/signature/body and request binding (not route success)",
  (record) => {
    const raw = bytes(record.body_utf8);
    expect(sha256(raw)).toBe(record.body_sha256);
    const input = signedInput(record);
    const canonical = canonicalFleetRequest(input);
    expect(Buffer.from(canonical)).toEqual(bytes(record.canonical_text));
    expect(sign(null, canonical, privateKey).toString("base64url")).toBe(
      record.signature_b64url,
    );
    expect(
      verifyFleetRequest(
        publicKeyBytes,
        { ...input, signature: record.signature_b64url },
        raw,
        {
          method: record.method,
          path: record.path,
          now: new Date(record.issued_at),
        },
      ),
    ).toBe("ok");
    expect(fleetV2RequestBinding(input)).toBe(record.request_binding);
  },
);
const preSessionRecords = [
  { name: "pairing_begin", ...fixture.pairing_begin },
  { name: "pairing_complete", ...fixture.pairing_complete },
  { name: "recovery_begin", ...fixture.recovery_begin },
  { name: "recovery_complete", ...fixture.recovery_complete },
];
function preSessionInput(record: PreSessionRecord) {
  return {
    origin: record.origin,
    path: record.path,
    attempt: record.attempt,
    rawBody: bytes(record.body_utf8),
  };
}
it.each(preSessionRecords)(
  "$name: exact pre-session body and request binding (not route success)",
  (record) => {
    expect(sha256(bytes(record.body_utf8))).toBe(record.body_sha256);
    expect(fleetV2PreSessionBinding(preSessionInput(record))).toBe(
      record.request_binding,
    );
  },
);
const initiationInput = {
  canonicalOrigin: fixture.recovery_begin.origin,
  requestId: fixture.recovery_begin.request_id,
  issuedAt: fixture.recovery_begin.issued_at,
  publicKeySpkiB64: fixture.public_key_spki_b64url,
};
const recoveryInput = {
  canonicalOrigin: fixture.recovery_complete.origin,
  challengeId: fixture.recovery_complete.challenge_id,
  nonce: fixture.recovery_complete.nonce,
  publicKeySpkiB64: fixture.public_key_spki_b64url,
};
it.each([
  {
    name: "pairing_complete",
    record: fixture.pairing_complete,
    preimage: () => pairingChallengePreimage(fixture.pairing_complete.pairing_id),
  },
  {
    name: "recovery_begin",
    record: fixture.recovery_begin,
    preimage: () => recoveryInitiationPreimage(initiationInput),
  },
  {
    name: "recovery_complete",
    record: fixture.recovery_complete,
    preimage: () => recoveryChallengePreimage(recoveryInput),
  },
])(
  "$name: production proof preimage and deterministic Ed25519 signature",
  ({ record, preimage }) => {
    const actual = preimage();
    expect(actual).toEqual(bytes(record.preimage_utf8));
    expect(sign(null, actual, privateKey).toString("base64url")).toBe(
      record.signature_b64url,
    );
    expect(
      verify(null, actual, publicKey, Buffer.from(record.signature_b64url, "base64url")),
    ).toBe(true);
  },
);
it("verifies recovery proofs with the production verifiers", () => {
  expect(
    verifyRecoveryInitiation(initiationInput, fixture.recovery_begin.signature_b64url),
  ).toBe(true);
  expect(
    verifyRecoveryProof(recoveryInput, fixture.recovery_complete.signature_b64url),
  ).toBe(true);
});
it.each(fixture.correlation_vectors)("$name: correlation mutation", (vector) => {
  let actual: string | null;
  switch (vector.mutation) {
    case "snapshot-domain":
      expect(vector.operation).toBe("signed_request");
      actual = snapshotRequestBinding(
        canonicalFleetRequest(signedInput(fixture.signed_request)),
      );
      break;
    case "attempt":
    case "body":
    case "origin": {
      expect(vector.operation).toBe("recovery_complete");
      expect(vector.value).toBeDefined();
      const input = preSessionInput(fixture.recovery_complete);
      if (vector.mutation === "body") input.rawBody = bytes(vector.value!);
      else input[vector.mutation] = vector.value!;
      actual = fleetV2PreSessionBinding(input);
      expect(actual).not.toBeNull();
      break;
    }
    default:
      throw new Error(`Unimplemented correlation mutation: ${String(vector.mutation)}`);
  }
  expect(actual === fixture[vector.operation].request_binding).toBe(vector.matches);
});
