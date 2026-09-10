import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FleetSharingDisabledError } from "@/services/fleet-sharing-mode";
import { fleetPairingRequest } from "@/db/schema";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  InvalidDevicePublicKeyError,
  RevokedDeviceKeyError,
  beginPairing,
} from "@/services/fleet-pairing";
import {
  FleetDeviceKeyUnavailableError,
  FleetIdentityMaintenanceError,
} from "@/services/fleet-key-identity";
import { FLEET_RELAY_PROTOCOL } from "@/services/fleet-relay";

// This route is unauthenticated by design: it is the very first call a
// device makes, before any pairing/session exists. It never calls ESI and
// never reads a browser session cookie — Global Constraints for every
// route in this file.
export const dynamic = "force-dynamic";

/** Defense-in-depth bound on the raw wire body, measured and checked BEFORE
 *  any `JSON.parse` (the route layer is the PRIMARY defense against an
 *  oversized body; the service layer's own bound is a secondary backstop).
 *  A genuine request here is a small fraction of this:
 *  an Ed25519 SPKI public key base64url-encodes to 59 characters. */
const MAX_BODY_BYTES = 2048;

/** Ed25519 SPKI DER is exactly 44 bytes -> 59 base64url characters with no
 *  padding. Bounded generously above that (not pinned to exactly 59) so a
 *  differently-shaped-but-still-small SPKI encoding is not rejected by this
 *  shape check alone — `isEd25519SpkiPublicKey` (invoked by `beginPairing`)
 *  is the actual correctness gate; this is only a bounded-size/charset
 *  pre-check. */
const PUBLIC_KEY_B64URL_RE = /^[A-Za-z0-9_-]{1,120}$/;

const BodySchema = z
  .object({
    protocol: z.literal(1),
    public_key_spki_b64url: z.string().regex(PUBLIC_KEY_B64URL_RE),
    requested_capabilities: z.array(z.literal(SHARED_CAPABILITY)).max(1).optional(),
  })
  .strict();

function jsonError(code: string, status: number) {
  return NextResponse.json({ protocol: FLEET_RELAY_PROTOCOL, error: code }, { status });
}

/** `true` only for a JSON value whose own `protocol` field is present and is
 *  not the literal `1` — the one shape the spec's "explicit major integer"
 *  rule says gets its own `update_required` response rather than a generic
 *  `bad_request`, so a future Wingman build reports "please update" instead
 *  of a confusing validation failure. Checked BEFORE the full `.strict()`
 *  schema, which would otherwise fail identically for either problem. */
function hasUnsupportedProtocol(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "protocol" in value &&
    (value as { protocol?: unknown }).protocol !== 1
  );
}

export async function POST(req: NextRequest) {
  const bodyResult = await readBoundedRequestBody(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) return jsonError("bad_request", 400);
  const raw = bodyResult.bytes;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonError("bad_request", 400);
  }
  if (hasUnsupportedProtocol(parsed)) return jsonError("update_required", 400);

  const body = BodySchema.safeParse(parsed);
  if (!body.success) return jsonError("bad_request", 400);

  const spki = new Uint8Array(Buffer.from(body.data.public_key_spki_b64url, "base64url"));
  const dbx = getDb();

  try {
    const { pairingId, approvalUrl } = await beginPairing(dbx, {
      publicKeySpki: spki,
      requestedCapabilities: body.data.requested_capabilities,
    });
    const [row] = await dbx
      .select({ expiresAt: fleetPairingRequest.expiresAt })
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, pairingId));
    return NextResponse.json({
      protocol: FLEET_RELAY_PROTOCOL,
      pairing_id: pairingId,
      approval_url: approvalUrl,
      expires_at: row.expiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof FleetIdentityMaintenanceError)
      return jsonError("service_unavailable", 503);
    if (err instanceof FleetSharingDisabledError)
      return jsonError("feature_disabled", 503);
    // Non-oracle: a malformed key and a previously-revoked key collapse to
    // one generic code, so this endpoint never confirms to a caller that a
    // specific submitted key was ever paired and revoked before.
    if (
      err instanceof InvalidDevicePublicKeyError ||
      err instanceof RevokedDeviceKeyError ||
      err instanceof FleetDeviceKeyUnavailableError
    ) {
      return jsonError("invalid_key", 400);
    }
    throw err;
  }
}
