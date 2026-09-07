import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  FLEET_RELAY_PROTOCOL,
  FLEET_RELAY_STATUS_BY_CODE,
  readDeviceCatalogueForSession,
} from "@/services/fleet-relay";

// Never calls ESI, never reads a browser session cookie as a desktop
// credential — this route authenticates only the signed device request.
export const dynamic = "force-dynamic";

const CANONICAL_PATH = "/api/fleet/v1/catalogue";

/** A GET carries no telemetry payload, but the signed envelope still binds a
 *  body digest — devices are expected to sign an EMPTY body here. Bounded
 *  generously above zero only to reject, rather than silently ignore, a
 *  device that (incorrectly) attaches a real payload. */
const MAX_BODY_BYTES = 1024;

function jsonError(code: string, status: number) {
  return NextResponse.json({ protocol: FLEET_RELAY_PROTOCOL, error: code }, { status });
}

function authError(code: "bad_headers" | "unauthorized") {
  return jsonError(code, code === "bad_headers" ? 400 : 401);
}

export async function GET(req: NextRequest) {
  if (hasUnsignedQueryString(req)) return authError("bad_headers");
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return authError("bad_headers");

  const bodyResult = await readBoundedRequestBody(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) return authError("bad_headers");
  const raw = bodyResult.bytes;

  const now = new Date();
  const auth = await authenticateFleetRequest(getDb(), headers, raw, {
    method: "GET",
    path: CANONICAL_PATH,
    now,
  });
  if (!auth.ok) return authError(auth.code);

  // The signed request's own revision is consumed here too, atomically and
  // against the SAME read cadence bucket/monotonic counter `GET /snapshot`
  // uses (fleet-relay.ts's gateSignedSession) — a captured-and-replayed
  // signed catalogue fetch is exactly as inert as a replayed snapshot read,
  // and a device cannot dodge the read cadence by alternating between the
  // two endpoints.
  const result = await readDeviceCatalogueForSession(getDb(), {
    sessionId: auth.auth.sessionId,
    revision: headers.revision,
  });
  if (!result.ok) {
    return jsonError(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
  }

  return NextResponse.json({
    protocol: FLEET_RELAY_PROTOCOL,
    revision: result.catalogue.revision,
    characters: result.catalogue.characters.map((c) => ({
      character_id: c.characterId,
      character_name: c.characterName,
    })),
  });
}
