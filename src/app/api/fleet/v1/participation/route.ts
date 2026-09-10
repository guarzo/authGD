import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import { setFleetParticipation } from "@/services/fleet-participation";
import { FLEET_RELAY_PROTOCOL, FLEET_RELAY_STATUS_BY_CODE } from "@/services/fleet-relay";

export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v1/participation";
const BodySchema = z
  .object({
    protocol: z.literal(1),
    enabled: z.boolean(),
    expected_generation: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
function error(code: string, status: number) {
  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL, error: code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: NextRequest) {
  if (hasUnsignedQueryString(req)) return error("bad_headers", 400);
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return error("bad_headers", 400);
  const raw = await readBoundedRequestBody(req, 1024);
  if (!raw.ok) return error("bad_request", 400);
  try {
    const auth = await authenticateFleetRequest(getDb(), headers, raw.bytes, {
      method: "PUT",
      path: PATH,
      now: new Date(),
    });
    if (!auth.ok) return error(auth.code, auth.code === "bad_headers" ? 400 : 401);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw.bytes));
    } catch {
      return error("bad_request", 400);
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "protocol" in parsed &&
      parsed.protocol !== 1
    )
      return error("update_required", 400);
    const body = BodySchema.safeParse(parsed);
    if (!body.success) return error("bad_request", 400);
    const result = await setFleetParticipation(getDb(), {
      sessionId: auth.auth.sessionId,
      revision: headers.revision,
      enabled: body.data.enabled,
      expectedGeneration: body.data.expected_generation,
    });
    if (!result.ok)
      return error(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
    return NextResponse.json(
      { protocol: FLEET_RELAY_PROTOCOL, participation: result.value },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // SQL/driver errors may carry credentials or query parameters. Stable failure
    // only; never expose those details through either this response or its log.
    console.error("fleet participation mutation failed");
    return error("service_unavailable", 503);
  }
}
