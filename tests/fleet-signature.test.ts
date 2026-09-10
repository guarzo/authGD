import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as ed25519Sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalDevicePublicKeyB64,
  canonicalFleetRequest,
  decodeDevicePublicKeyB64,
  verifyFleetRequest,
  type FleetAuthHeaders,
} from "@/lib/fleet-signature";
import fixture from "./fixtures/fleet-signature-v1.json";
import recoveryFixture from "./fixtures/fleet-recovery-v1.json";
import {
  recoveryChallengePreimage,
  verifyRecoveryProof,
} from "@/lib/fleet-recovery-proof";

describe("recovery purpose/origin-separated golden proof", () => {
  const input = {
    canonicalOrigin: recoveryFixture.canonical_origin,
    challengeId: recoveryFixture.challenge_id,
    nonce: recoveryFixture.nonce,
    publicKeySpkiB64: recoveryFixture.public_key_spki_b64,
  };
  it("pins exact UTF-8 bytes, canonical DER hash and real Ed25519 verification", () => {
    expect(recoveryChallengePreimage(input).toString("utf8")).toBe(
      recoveryFixture.preimage_utf8,
    );
    expect(
      createHash("sha256")
        .update(Buffer.from(input.publicKeySpkiB64, "base64"))
        .digest("hex"),
    ).toBe(recoveryFixture.public_key_sha256);
    expect(verifyRecoveryProof(input, recoveryFixture.signature_b64url)).toBe(true);
  });
  it.each([
    { canonicalOrigin: "https://other.example" },
    { challengeId: "3f9c1de2-7b8a-4c1f-9a2e-6d4b8f1c9a02" },
    { nonce: "B".repeat(43) },
    { publicKeySpkiB64: "garbage" },
  ])("refuses a changed recovery binding %j", (override) => {
    expect(
      verifyRecoveryProof({ ...input, ...override }, recoveryFixture.signature_b64url),
    ).toBe(false);
  });
  it("refuses malformed and noncanonical signature encodings", () => {
    for (const signature of [
      "x",
      recoveryFixture.signature_b64url + "=",
      recoveryFixture.signature_b64url.slice(0, -1) + "x",
    ]) {
      expect(verifyRecoveryProof(input, signature)).toBe(false);
    }
  });
});

const DEFAULT_METHOD = "PUT" as const;
const DEFAULT_PATH = "/api/fleet/v1/snapshot";
const DEFAULT_BODY = new TextEncoder().encode(JSON.stringify({ protocol: 1, rows: [] }));
const DEFAULT_ISSUED_AT = "2026-09-04T12:00:00.000Z";
const DEFAULT_REVISION = 5;

/**
 * Builds one fully valid signed request with a fresh runtime-generated
 * Ed25519 key pair, so every "start from a known-good request" test shares
 * exactly one construction path.
 */
function buildSigned(
  overrides: Partial<{
    method: "GET" | "POST" | "PUT";
    path: string;
    sessionId: string;
    issuedAt: string;
    revision: number;
    body: Uint8Array;
  }> = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

  const body = overrides.body ?? DEFAULT_BODY;
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const sessionId = overrides.sessionId ?? randomBytes(32).toString("base64url");
  const issuedAt = overrides.issuedAt ?? DEFAULT_ISSUED_AT;
  const revision = overrides.revision ?? DEFAULT_REVISION;
  const method = overrides.method ?? DEFAULT_METHOD;
  const path = overrides.path ?? DEFAULT_PATH;

  const canonical = canonicalFleetRequest({
    protocol: 1,
    method,
    path,
    sessionId,
    issuedAt,
    revision,
    bodySha256,
  });
  const signature = ed25519Sign(null, canonical, privateKey).toString("base64url");

  const headers: FleetAuthHeaders = {
    sessionId,
    issuedAt,
    revision,
    bodySha256,
    signature,
  };
  return { pub, headers, body, request: { method, path, now: new Date(issuedAt) } };
}

describe("canonicalFleetRequest", () => {
  it("joins the seven fields as UTF-8 lines in the fixed protocol order", () => {
    const bytes = canonicalFleetRequest({
      protocol: 1,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId: "sess-1",
      issuedAt: "2026-09-04T12:00:00.000Z",
      revision: 3,
      bodySha256: "a".repeat(64),
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      [
        "fleet-v1",
        "GET",
        "/api/fleet/v1/catalogue",
        "sess-1",
        "2026-09-04T12:00:00.000Z",
        "3",
        "a".repeat(64),
      ].join("\n"),
    );
  });
});

describe("verifyFleetRequest", () => {
  it("verifies a valid canonical request", () => {
    const { pub, headers, body, request } = buildSigned();
    expect(verifyFleetRequest(pub, headers, body, request)).toBe("ok");
  });

  it("rejects an altered HTTP method", () => {
    const { pub, headers, body, request } = buildSigned();
    expect(verifyFleetRequest(pub, headers, body, { ...request, method: "POST" })).toBe(
      "bad_signature",
    );
  });

  it("rejects an altered exact path", () => {
    const { pub, headers, body, request } = buildSigned();
    expect(
      verifyFleetRequest(pub, headers, body, { ...request, path: "/api/fleet/v1/other" }),
    ).toBe("bad_signature");
  });

  it("rejects altered body bytes whose digest no longer matches the header", () => {
    const { pub, headers, body, request } = buildSigned();
    const tampered = new TextEncoder().encode(
      JSON.stringify({ protocol: 1, rows: [{ character_id: 1, dps: 1, ewar: [] }] }),
    );
    expect(tampered).not.toEqual(body);
    expect(verifyFleetRequest(pub, headers, tampered, request)).toBe("bad_digest");
  });

  it("rejects a body_sha256 header that does not match the actual body", () => {
    const { pub, headers, body, request } = buildSigned();
    const changed = { ...headers, bodySha256: "0".repeat(64) };
    expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_digest");
  });

  it("rejects an altered session ID", () => {
    const { pub, headers, body, request } = buildSigned();
    const changed = { ...headers, sessionId: randomBytes(32).toString("base64url") };
    expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_signature");
  });

  it("rejects an altered issued-at", () => {
    const { pub, headers, body, request } = buildSigned();
    const changed = { ...headers, issuedAt: "2026-09-04T12:00:30.000Z" };
    expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_signature");
  });

  it("rejects an altered revision", () => {
    const { pub, headers, body, request } = buildSigned();
    const changed = { ...headers, revision: 8 };
    expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_signature");
  });

  it("rejects a comma-joined value in any string header field as malformed, not merely unsigned", () => {
    const { pub, headers, body, request } = buildSigned();
    for (const field of ["sessionId", "issuedAt", "bodySha256", "signature"] as const) {
      const changed: FleetAuthHeaders = {
        ...headers,
        [field]: `${headers[field]},${headers[field]}`,
      };
      expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_headers");
    }
  });

  it("rejects a malformed base64url signature", () => {
    const { pub, headers, body, request } = buildSigned();
    const changed = { ...headers, signature: "not-valid-base64url!!!" };
    expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_headers");
  });

  it("rejects a non-hex or wrong-length body_sha256", () => {
    const { pub, headers, body, request } = buildSigned();
    expect(
      verifyFleetRequest(pub, { ...headers, bodySha256: "not-hex" }, body, request),
    ).toBe("bad_headers");
    expect(
      verifyFleetRequest(pub, { ...headers, bodySha256: "AB".repeat(32) }, body, request),
    ).toBe("bad_headers");
  });

  it("rejects a negative or non-integer revision", () => {
    const { pub, headers, body, request } = buildSigned();
    expect(verifyFleetRequest(pub, { ...headers, revision: -1 }, body, request)).toBe(
      "bad_headers",
    );
    expect(verifyFleetRequest(pub, { ...headers, revision: 1.5 }, body, request)).toBe(
      "bad_headers",
    );
  });

  it("rejects a wrong key type presented as the device's public key", () => {
    const { headers, body, request } = buildSigned();
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongPub = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    expect(verifyFleetRequest(wrongPub, headers, body, request)).toBe("bad_signature");
  });

  it("rejects a public key that is not valid SPKI DER at all", () => {
    const { headers, body, request } = buildSigned();
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    expect(verifyFleetRequest(garbage, headers, body, request)).toBe("bad_signature");
  });

  it("accepts clock skew of exactly +60 seconds", () => {
    const { pub, headers, body, request } = buildSigned({ issuedAt: DEFAULT_ISSUED_AT });
    const now = new Date("2026-09-04T12:01:00.000Z"); // +60000ms
    expect(verifyFleetRequest(pub, headers, body, { ...request, now })).toBe("ok");
  });

  it("rejects clock skew of +60001ms", () => {
    const { pub, headers, body, request } = buildSigned({ issuedAt: DEFAULT_ISSUED_AT });
    const now = new Date("2026-09-04T12:01:00.001Z"); // +60001ms
    expect(verifyFleetRequest(pub, headers, body, { ...request, now })).toBe("bad_time");
  });

  it("accepts clock skew of exactly -60 seconds", () => {
    const { pub, headers, body, request } = buildSigned({
      issuedAt: "2026-09-04T12:01:00.000Z",
    });
    const now = new Date("2026-09-04T12:00:00.000Z"); // -60000ms
    expect(verifyFleetRequest(pub, headers, body, { ...request, now })).toBe("ok");
  });

  it("rejects clock skew of -60001ms", () => {
    const { pub, headers, body, request } = buildSigned({
      issuedAt: "2026-09-04T12:01:00.001Z",
    });
    const now = new Date("2026-09-04T12:00:00.000Z"); // -60001ms
    expect(verifyFleetRequest(pub, headers, body, { ...request, now })).toBe("bad_time");
  });

  // fleet_device_session.last_revision is a Postgres `integer` (int4), not
  // `bigint` (controller ruling). A revision beyond int4's range is a valid
  // JS safe integer but could never be persisted, so it must be rejected here
  // rather than surfacing as a runtime failure deep in Task 5's write path.
  it("accepts the maximum 32-bit revision value", () => {
    const { pub, headers, body, request } = buildSigned({ revision: 2_147_483_647 });
    expect(verifyFleetRequest(pub, headers, body, request)).toBe("ok");
  });

  it("rejects a revision one past the 32-bit maximum as malformed, not merely unsigned", () => {
    const { pub, headers, body, request } = buildSigned();
    const changed = { ...headers, revision: 2_147_483_648 };
    expect(verifyFleetRequest(pub, changed, body, request)).toBe("bad_headers");
  });
});

describe("canonicalDevicePublicKeyB64 / decodeDevicePublicKeyB64", () => {
  // fleet_device.publicKeySpkiB64 is UNIQUE on this exact string. Two
  // encodings of the identical key bytes (base64url vs. base64, padded vs.
  // unpadded) must canonicalize to the one value Task 4's pairing service
  // persists and compares, or the uniqueness constraint stops meaning
  // anything and the same key could be paired twice under different text.
  it("canonicalizes to padded, standard (non-URL-safe) base64 and round-trips", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));

    const canonical = canonicalDevicePublicKeyB64(spki);
    expect(canonical).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(canonical.length % 4).toBe(0);
    expect(decodeDevicePublicKeyB64(canonical)).toEqual(spki);
  });

  it("canonicalizes identically regardless of the encoding the caller decoded from", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const canonical = canonicalDevicePublicKeyB64(spki);

    // Same bytes, obtained by decoding a base64url representation instead —
    // exactly the path a device submitting its key over JSON/a header takes.
    const viaBase64Url = Buffer.from(spki).toString("base64url");
    const bytesFromUrl = new Uint8Array(Buffer.from(viaBase64Url, "base64url"));
    expect(canonicalDevicePublicKeyB64(bytesFromUrl)).toBe(canonical);
  });
});

describe("fleet-signature-v1 fixture vector", () => {
  // Copied byte-for-byte into Wingman's tests/fixtures/ in Task 7; its Python
  // crypto test verifies this same public vector so both sides of the
  // canonical contract are proven against one another, not just self-tested.
  it("reproduces the recorded canonical text and verifies the recorded signature", () => {
    const body = new TextEncoder().encode(fixture.body_utf8);
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    expect(bodySha256).toBe(fixture.body_sha256);

    const canonical = canonicalFleetRequest({
      protocol: 1,
      method: fixture.method as "GET" | "POST" | "PUT",
      path: fixture.path,
      sessionId: fixture.session_id,
      issuedAt: fixture.issued_at,
      revision: fixture.revision,
      bodySha256: fixture.body_sha256,
    });
    expect(new TextDecoder().decode(canonical)).toBe(fixture.canonical_text);

    const pub = new Uint8Array(Buffer.from(fixture.public_key_spki_b64, "base64"));
    const headers: FleetAuthHeaders = {
      sessionId: fixture.session_id,
      issuedAt: fixture.issued_at,
      revision: fixture.revision,
      bodySha256: fixture.body_sha256,
      signature: fixture.signature_b64url,
    };
    const result = verifyFleetRequest(pub, headers, body, {
      method: fixture.method,
      path: fixture.path,
      now: new Date(fixture.issued_at),
    });
    expect(result).toBe("ok");
  });
});
