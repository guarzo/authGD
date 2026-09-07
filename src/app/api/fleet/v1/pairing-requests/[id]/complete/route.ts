import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { FleetSharingDisabledError } from "@/services/fleet-sharing-mode";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  DeviceBoundToAnotherAccountError,
  InvalidCompletionProofError,
  NonMemberApprovalError,
  PairingAlreadyConsumedError,
  PairingExpiredError,
  PairingNotApprovedError,
  PairingNotFoundError,
  RevokedDeviceKeyError,
  completePairing,
} from "@/services/fleet-pairing";
import {
  FleetDeviceKeyUnavailableError,
  FleetIdentityMaintenanceError,
} from "@/services/fleet-key-identity";
import { FLEET_RELAY_PROTOCOL } from "@/services/fleet-relay";

// Unauthenticated by design, like its sibling: the device has no session yet
// and proves itself here by signing the pairing request's own one-time
// challenge (`completionSignature`), not via the fleet-v1 signed-header
// contract those routes use. Never calls ESI, never reads a browser cookie.
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2048;

// Ed25519 signatures are always 64 bytes -> exactly 86 base64url characters
// with no padding — the same shape fleet-signature.ts's SIGNATURE_RE checks.
const SIGNATURE_B64URL_RE = /^[A-Za-z0-9_-]{86}$/;

const BodySchema = z
  .object({
    protocol: z.literal(1),
    completion_signature: z.string().regex(SIGNATURE_B64URL_RE),
  })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(code: string, status: number) {
  return NextResponse.json({ protocol: FLEET_RELAY_PROTOCOL, error: code }, { status });
}

function hasUnsupportedProtocol(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "protocol" in value &&
    (value as { protocol?: unknown }).protocol !== 1
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // A malformed id is self-evidently the caller's own mistake (it can never
  // match any pairing request this app could have issued), so this is
  // reported distinctly rather than folded into the generic refusal below.
  if (!UUID_RE.test(id)) return jsonError("not_found", 404);

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

  try {
    const { sessionId, catalogue } = await completePairing(getDb(), {
      pairingId: id,
      completionSignature: body.data.completion_signature,
    });
    return NextResponse.json({
      protocol: FLEET_RELAY_PROTOCOL,
      session_id: sessionId,
      catalogue: {
        revision: catalogue.revision,
        characters: catalogue.characters.map((c) => ({
          character_id: c.characterId,
          character_name: c.characterName,
        })),
      },
    });
  } catch (err) {
    if (err instanceof FleetIdentityMaintenanceError)
      return jsonError("service_unavailable", 503);
    // Non-oracle: every reason a completion cannot be issued right now —
    // unknown/expired/consumed/not-yet-approved request, a bad proof, the
    // approving account no longer qualifying, or the key being bound
    // elsewhere/revoked — collapses to one generic code. Distinguishing
    // "no such request" from "wrong proof" would let a caller guessing
    // pairing ids learn which ones exist.
    if (
      err instanceof FleetSharingDisabledError ||
      err instanceof PairingNotFoundError ||
      err instanceof PairingExpiredError ||
      err instanceof PairingAlreadyConsumedError ||
      err instanceof PairingNotApprovedError ||
      err instanceof InvalidCompletionProofError ||
      err instanceof NonMemberApprovalError ||
      err instanceof RevokedDeviceKeyError ||
      err instanceof DeviceBoundToAnotherAccountError ||
      err instanceof FleetDeviceKeyUnavailableError
    ) {
      return jsonError("not_completable", 409);
    }
    throw err;
  }
}
