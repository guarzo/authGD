import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
} from "@/lib/fleet-route-auth";
import { buildDeviceCatalogue } from "@/services/fleet-eligibility";
import { FLEET_RELAY_PROTOCOL } from "@/services/fleet-relay";

// Never calls ESI, never reads a browser session cookie as a desktop
// credential — this route authenticates only the signed device request.
export const dynamic = "force-dynamic";

const CANONICAL_PATH = "/api/fleet/v1/catalogue";

/** A GET carries no telemetry payload, but the signed envelope still binds a
 *  body digest — devices are expected to sign an EMPTY body here. Bounded
 *  generously above zero only to reject, rather than silently ignore, a
 *  device that (incorrectly) attaches a real payload. */
const MAX_BODY_BYTES = 1024;

function jsonError(code: "bad_headers" | "unauthorized") {
  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL, error: code },
    { status: code === "bad_headers" ? 400 : 401 },
  );
}

export async function GET(req: NextRequest) {
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return jsonError("bad_headers");

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return jsonError("bad_headers");

  const now = new Date();
  const auth = await authenticateFleetRequest(getDb(), headers, raw, {
    method: "GET",
    path: CANONICAL_PATH,
    now,
  });
  if (!auth.ok) return jsonError(auth.code);

  const catalogue = await buildDeviceCatalogue(getDb(), auth.auth.accountId);
  return NextResponse.json({
    protocol: FLEET_RELAY_PROTOCOL,
    revision: catalogue.revision,
    characters: catalogue.characters.map((c) => ({
      character_id: c.characterId,
      character_name: c.characterName,
    })),
  });
}
