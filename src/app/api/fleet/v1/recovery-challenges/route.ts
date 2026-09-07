import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  readRecoveryEnvelope,
  recoveryError,
  recoveryJson,
} from "@/lib/fleet-recovery-http";
import { beginFleetRecovery } from "@/services/fleet-recovery";
import { RelayRefusal } from "@/services/fleet-relay";

export const dynamic = "force-dynamic";
const Body = z
  .object({
    protocol: z.literal(1),
    public_key_spki_b64url: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    initiation_signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

// Key-proven admission, no cookies, account data or external API calls.
export async function POST(req: NextRequest) {
  const body = await readRecoveryEnvelope(req, Body);
  if ("response" in body) return body.response;
  try {
    const c = await beginFleetRecovery(getDb(), {
      publicKeySpki: Buffer.from(body.value.public_key_spki_b64url, "base64url"),
      requestId: body.value.request_id,
      issuedAt: body.value.issued_at,
      initiationSignature: body.value.initiation_signature,
    });
    return recoveryJson({
      challenge_id: c.challengeId,
      request_id: c.requestId,
      nonce: c.nonce,
      expires_at: c.expiresAt.toISOString(),
    });
  } catch (err) {
    if (
      err instanceof RelayRefusal &&
      (err.code === "unauthorized" ||
        err.code === "rate_limited" ||
        err.code === "feature_disabled")
    )
      return recoveryError(err.code);
    console.error("fleet recovery challenge failed");
    return recoveryError("service_unavailable");
  }
}
