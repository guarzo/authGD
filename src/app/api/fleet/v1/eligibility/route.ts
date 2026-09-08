import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import { readDeviceEligibility } from "@/services/fleet-eligibility";
import { FLEET_RELAY_PROTOCOL, FLEET_RELAY_STATUS_BY_CODE } from "@/services/fleet-relay";

export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v1/eligibility";
const NO_STORE = { "Cache-Control": "no-store" };
function error(code: string, status: number) {
  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL, error: code },
    { status, headers: NO_STORE },
  );
}

/** Own IDs and proof versions only. No account/fleet selector, roster or names. */
export async function GET(req: NextRequest) {
  if (hasUnsignedQueryString(req)) return error("bad_headers", 400);
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return error("bad_headers", 400);
  const raw = await readBoundedRequestBody(req, 1024);
  if (!raw.ok || raw.bytes.length !== 0) return error("bad_request", 400);
  try {
    const auth = await authenticateFleetRequest(getDb(), headers, raw.bytes, {
      method: "GET",
      path: PATH,
      now: new Date(),
    });
    if (!auth.ok) return error(auth.code, auth.code === "bad_headers" ? 400 : 401);
    const result = await readDeviceEligibility(getDb(), {
      sessionId: auth.auth.sessionId,
      revision: headers.revision,
    });
    if (!result.ok)
      return error(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
    return NextResponse.json(
      {
        protocol: FLEET_RELAY_PROTOCOL,
        participation_generation: result.value.participationGeneration,
        state: result.value.state,
        characters: result.value.characters.map((ch) => ({
          character_id: ch.characterId,
          source_id: ch.sourceId,
          source_generation: ch.sourceGeneration,
          authority_generation: ch.authorityGeneration,
          expires_at: ch.expiresAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    );
  } catch {
    // Driver/query context must not become a roster or credential oracle.
    console.error("fleet eligibility read failed");
    return error("service_unavailable", 503);
  }
}
