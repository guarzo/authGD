import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  readRecoveryEnvelope,
  recoveryError,
  recoveryJson,
} from "@/lib/fleet-recovery-http";
import { completeFleetRecovery } from "@/services/fleet-recovery";

export const dynamic = "force-dynamic";
const Body = z
  .object({
    protocol: z.literal(1),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    recovery_signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readRecoveryEnvelope(req, Body);
  if ("response" in body) return body.response;
  try {
    const reply = await completeFleetRecovery(getDb(), {
      challengeId: id,
      nonce: body.value.nonce,
      recoverySignature: body.value.recovery_signature,
    });
    if (!reply.ok) return recoveryError(reply.code);
    const result = reply.value;
    if (result.result === "reconnected")
      return recoveryJson({
        result: result.result,
        device_id: result.deviceId,
        session_id: result.sessionId,
        session_expires_at: result.sessionExpiresAt.toISOString(),
        approved_capabilities: result.approvedCapabilities,
        participation: result.participation,
      });
    if (result.result === "device_revoked" || result.result === "device_key_conflict")
      return recoveryJson({ result: result.result });
    return recoveryJson({ result: result.result, retry_after_ms: result.retryAfterMs });
  } catch {
    // An outer transaction/transport failure cannot promise durable consumption or
    // reconnection. Never turn it into a guessed key-specific recovery outcome.
    console.error("fleet recovery completion failed");
    return recoveryError("service_unavailable");
  }
}
