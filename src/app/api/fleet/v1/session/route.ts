import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import { renewFleetDeviceSession } from "@/services/fleet-pairing";
import { FLEET_RELAY_PROTOCOL, FLEET_RELAY_STATUS_BY_CODE } from "@/services/fleet-relay";

// Never calls ESI, never reads a browser session cookie as a desktop
// credential — this route authenticates only the signed device request,
// exactly like catalogue and snapshot. A device that STILL holds a valid
// (not yet expired) signed session uses this to extend it in place without
// a new browser approval — see renewFleetDeviceSession's own doc for why
// this extends the existing session rather than issuing a new one.
export const dynamic = "force-dynamic";

const CANONICAL_PATH = "/api/fleet/v1/session";

/** A renewal carries no payload, but the signed envelope still binds a body
 *  digest — devices are expected to sign an EMPTY body here, the same
 *  convention `GET /catalogue` and `GET /snapshot` already use. */
const MAX_BODY_BYTES = 1024;

function jsonError(code: string, status: number) {
  return NextResponse.json({ protocol: FLEET_RELAY_PROTOCOL, error: code }, { status });
}

function authError(code: "bad_headers" | "unauthorized") {
  return jsonError(code, code === "bad_headers" ? 400 : 401);
}

export async function PUT(req: NextRequest) {
  if (hasUnsignedQueryString(req)) return authError("bad_headers");
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return authError("bad_headers");

  const bodyResult = await readBoundedRequestBody(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) return authError("bad_headers");
  const raw = bodyResult.bytes;

  const now = new Date();
  const auth = await authenticateFleetRequest(getDb(), headers, raw, {
    method: "PUT",
    path: CANONICAL_PATH,
    now,
  });
  if (!auth.ok) return authError(auth.code);

  const result = await renewFleetDeviceSession(getDb(), {
    sessionId: auth.auth.sessionId,
    revision: headers.revision,
    now,
  });
  if (!result.ok) {
    return jsonError(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
  }

  return NextResponse.json({
    protocol: FLEET_RELAY_PROTOCOL,
    expires_at: result.expiresAt.toISOString(),
  });
}
