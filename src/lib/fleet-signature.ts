import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";

/**
 * authGD's fleet relay signed-request contract, `fleet-v1`.
 *
 * A paired device signs every relay HTTP request with its Ed25519 key. The
 * canonical bytes bind protocol, HTTP method, exact path, device session,
 * issued-at, a monotonic per-session revision, and the request body's SHA-256
 * digest — so a captured signed request cannot be replayed against a
 * different route, resent with a stale revision, reattached to another
 * session, or paired with a different body than the one it was signed for.
 */

/** authGD rejects clock skew outside this window, in either direction. */
const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * `fleet_device_session.last_revision` is stored as Postgres `integer`
 * (int4), not `bigint` (controller ruling: a non-negative JS safe integer,
 * rendered as base-10 canonical text, is far below int4's range at the
 * intended cadence). A revision beyond int4's max is still a valid JS safe
 * integer, so `Number.isSafeInteger` alone would accept it here and only fail
 * once the relay service tries to persist it — rejecting it in this contract
 * instead turns that into an immediate, diagnosable `bad_headers` at the
 * boundary.
 */
const MAX_REVISION = 2_147_483_647; // Postgres int4 max

// Opaque session identifiers are `randomBytes(32).toString("base64url")`
// (src/services/session.ts's existing convention) — base64url charset, no
// padding. A comma could only appear here if a caller naively joined two
// duplicate `X-Fleet-Session` header values, which this rejects as malformed
// rather than letting it fall through to a signature mismatch.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

// RFC3339 date-time, UTC or a numeric offset. A comma-joined duplicate
// `X-Fleet-Issued-At` header fails this shape check outright.
const ISSUED_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// Lowercase SHA-256 hex digest: exactly 64 hex characters.
const BODY_SHA256_RE = /^[0-9a-f]{64}$/;

// Ed25519 signatures are always 64 bytes; base64url without padding encodes
// that as exactly 86 characters.
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

export type FleetAuthHeaders = {
  sessionId: string;
  issuedAt: string;
  revision: number;
  bodySha256: string;
  signature: string;
};

/**
 * Builds the exact UTF-8 canonical bytes a device signs and authGD verifies.
 * Line order is fixed and versioned by the leading `fleet-v<protocol>` line;
 * changing the shape of these lines is a new protocol version, not a patch.
 */
export function canonicalFleetRequest(input: {
  protocol: 1;
  method: "GET" | "POST" | "PUT";
  path: string;
  sessionId: string;
  issuedAt: string;
  revision: number;
  bodySha256: string;
}): Uint8Array {
  const lines = [
    `fleet-v${input.protocol}`,
    input.method,
    input.path,
    input.sessionId,
    input.issuedAt,
    String(input.revision),
    input.bodySha256,
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

/** Response correlation, NOT a server signature. The caller supplies the exact
 * authenticated fleet-v1 canonical bytes; signing and its goldens stay unchanged. */
export function snapshotRequestBinding(canonical: Uint8Array): string {
  return createHash("sha256")
    .update("fleet-snapshot-publication-v1\n", "utf8")
    .update(canonical)
    .digest("hex");
}

/**
 * True when every string-valued header field is well-formed on its own.
 * Catches a naive multi-value header join (a raw comma) and any malformed
 * base64url/hex/timestamp shape before it can reach the digest, clock, or
 * signature checks below — so those three checks only ever fire against
 * headers whose *shape* is already trustworthy.
 */
function hasWellFormedHeaders(headers: FleetAuthHeaders): boolean {
  return (
    SESSION_ID_RE.test(headers.sessionId) &&
    ISSUED_AT_RE.test(headers.issuedAt) &&
    !Number.isNaN(Date.parse(headers.issuedAt)) &&
    Number.isSafeInteger(headers.revision) &&
    headers.revision >= 0 &&
    headers.revision <= MAX_REVISION &&
    BODY_SHA256_RE.test(headers.bodySha256) &&
    SIGNATURE_RE.test(headers.signature)
  );
}

/**
 * Verifies one signed fleet relay request. Checks run in a fixed order —
 * header shape, body digest, clock skew, then signature — so the return code
 * tells the caller which thing failed rather than collapsing every failure
 * into an undifferentiated "bad signature".
 *
 * `request.method`/`request.path` come from the actual HTTP request, not the
 * signed headers: they are exactly what the signature must be checked
 * against, since canonicalFleetRequest's whole purpose is binding the
 * signature to the specific request line it was issued for.
 */
export function verifyFleetRequest(
  publicKeySpki: Uint8Array,
  headers: FleetAuthHeaders,
  body: Uint8Array,
  request: { method: string; path: string; now: Date },
): "ok" | "bad_headers" | "bad_digest" | "bad_time" | "bad_signature" {
  if (!hasWellFormedHeaders(headers)) return "bad_headers";

  const actualBodySha256 = createHash("sha256").update(body).digest("hex");
  if (actualBodySha256 !== headers.bodySha256) return "bad_digest";

  const issuedAtMs = Date.parse(headers.issuedAt);
  if (Math.abs(request.now.getTime() - issuedAtMs) > MAX_CLOCK_SKEW_MS) return "bad_time";

  const canonical = canonicalFleetRequest({
    protocol: 1,
    // The GET/POST/PUT union is the router's contract to enforce, not this
    // pure function's; an unexpected method value simply fails to verify.
    method: request.method as "GET" | "POST" | "PUT",
    path: request.path,
    sessionId: headers.sessionId,
    issuedAt: headers.issuedAt,
    revision: headers.revision,
    bodySha256: headers.bodySha256,
  });

  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpki),
      format: "der",
      type: "spki",
    });
    // No dedicated status exists for "right key material, wrong algorithm" —
    // a paired device can only ever record an Ed25519 SPKI key, so a
    // mismatched key type is exactly as untrusted as a bad signature.
    if (key.asymmetricKeyType !== "ed25519") return "bad_signature";
    const signature = Buffer.from(headers.signature, "base64url");
    return ed25519Verify(null, canonical, key, signature) ? "ok" : "bad_signature";
  } catch {
    // Malformed/non-DER key bytes throw rather than returning false.
    return "bad_signature";
  }
}

/**
 * Serializes RAW SPKI bytes, not key identity: this legacy helper intentionally
 * does not re-export DER. V1 request/pairing proof bytes remain unchanged.
 * Consistent registration identity uses normalizeDevicePublicKeyB64 instead.
 * Converts an Ed25519 SPKI DER public key to the single text form
 * `fleet_device.publicKeySpkiB64` and `fleet_pairing_request.publicKeySpkiB64`
 * persist and compare by: padded, standard (not URL-safe) base64.
 *
 * `fleet_device.publicKeySpkiB64` is UNIQUE on this exact string. The same
 * key bytes can arrive as base64url or unpadded base64 (e.g. decoded from a
 * JSON field or an HTTP header), and those encode to a *different* literal
 * string than padded standard base64 — so without a single canonical form,
 * the same key could be persisted twice under different text, silently
 * defeating the uniqueness constraint. Every pairing service call site MUST
 * canonicalize a device's submitted public key through this function before
 * it ever reaches `fleetPairingRequest`/`fleetDevice`; never persist a
 * caller-supplied encoding directly.
 *
 * `fleet_device.revokedAt` is a soft revoke, but the unique constraint is not
 * scoped by it: a public key that was ever inserted — revoked or not — can
 * never be inserted again. Re-pairing after revocation therefore requires
 * generating a brand-new local key pair, not reusing the old one. This is
 * intentional, not a bug to work around.
 */
export function canonicalDevicePublicKeyB64(spki: Uint8Array): string {
  return Buffer.from(spki).toString("base64");
}

/** One bounded DER normalization boundary shared by reconciliation and runtime.
 * Accepted legacy spellings (including trailing bytes) resolve to the same key. */
export function normalizeDevicePublicKeyB64(spki: Uint8Array): string | null {
  if (spki.byteLength === 0 || spki.byteLength > 90) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return key.export({ format: "der", type: "spki" }).toString("base64");
  } catch {
    return null;
  }
}

/** Inverse of {@link canonicalDevicePublicKeyB64}: decodes a stored/canonical
 * public key string back to raw SPKI DER bytes, e.g. for `verifyFleetRequest`. */
export function decodeDevicePublicKeyB64(canonical: string): Uint8Array {
  return new Uint8Array(Buffer.from(canonical, "base64"));
}

/**
 * True when `spki` parses as valid SPKI DER for an Ed25519 public key, and
 * false for anything else — malformed/non-DER bytes, or DER for a different
 * key algorithm — never throwing. The same defensive shape
 * `verifyFleetRequest` and `verifyCompletionProof` already apply to a
 * *stored* key's bytes, exposed here as a single reusable check so the
 * pairing service can apply it to a *candidate* key BEFORE ever
 * canonicalizing, persisting it, or creating a pairing request a browser
 * could approve — rather than hand-rolling the same `createPublicKey`/
 * `asymmetricKeyType` logic a second time.
 */
export function isEd25519SpkiPublicKey(spki: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(spki),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}
