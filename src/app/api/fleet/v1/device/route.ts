import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  SHARED_CAPABILITY,
  type DeviceView,
  type FleetReply,
} from "@/core/fleet-sharing";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import {
  acknowledgeFleetCapabilities,
  readFleetDeviceState,
} from "@/services/fleet-device";
import { FLEET_RELAY_PROTOCOL, FLEET_RELAY_STATUS_BY_CODE } from "@/services/fleet-relay";

export const dynamic = "force-dynamic";
const CANONICAL_PATH = "/api/fleet/v1/device";
const BodySchema = z
  .object({
    protocol: z.literal(1),
    capabilities: z.array(z.literal(SHARED_CAPABILITY)).max(1),
  })
  .strict();

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL, error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
function reply(result: FleetReply<DeviceView>) {
  if (!result.ok)
    return jsonError(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
  const value = result.value;
  return NextResponse.json(
    {
      protocol: FLEET_RELAY_PROTOCOL,
      device_id: value.deviceId,
      session_expires_at: value.sessionExpiresAt.toISOString(),
      feature_enabled: value.featureEnabled,
      approved_capabilities: value.approvedCapabilities,
      session_approved_capabilities: value.sessionApprovedCapabilities,
      acknowledged_capabilities: value.acknowledgedCapabilities,
      participation: value.participation,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function handle(req: NextRequest, method: "GET" | "PUT") {
  if (hasUnsignedQueryString(req)) return jsonError("bad_headers", 400);
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return jsonError("bad_headers", 400);
  const bodyResult = await readBoundedRequestBody(req, 1024);
  if (!bodyResult.ok) return jsonError("bad_request", 400);
  const auth = await authenticateFleetRequest(getDb(), headers, bodyResult.bytes, {
    method,
    path: CANONICAL_PATH,
    now: new Date(),
  });
  if (!auth.ok) return jsonError(auth.code, auth.code === "bad_headers" ? 400 : 401);
  const call = { sessionId: auth.auth.sessionId, revision: headers.revision };
  if (method === "GET") {
    if (bodyResult.bytes.length !== 0) return jsonError("bad_request", 400);
    return reply(await readFleetDeviceState(getDb(), call));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyResult.bytes));
  } catch {
    return jsonError("bad_request", 400);
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "protocol" in parsed &&
    parsed.protocol !== 1
  )
    return jsonError("update_required", 400);
  const body = BodySchema.safeParse(parsed);
  if (!body.success) return jsonError("bad_request", 400);
  return reply(
    await acknowledgeFleetCapabilities(getDb(), {
      ...call,
      capabilities: body.data.capabilities,
    }),
  );
}

export async function GET(req: NextRequest) {
  return handle(req, "GET");
}
export async function PUT(req: NextRequest) {
  return handle(req, "PUT");
}
