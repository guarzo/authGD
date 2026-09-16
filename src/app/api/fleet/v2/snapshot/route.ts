import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { CombatPutSchema, FLEET_V2_BYTE_LIMITS } from "@/core/fleet-api-v2";
import { authenticateFleetRequest } from "@/lib/fleet-route-auth";
import {
  fleetV2Error,
  fleetV2RequestBinding,
  fleetV2Success,
  readFleetV2SignedEnvelope,
} from "@/lib/fleet-api-v2";
import { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay";

export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v2/snapshot";

async function handle(req: NextRequest, method: "GET" | "PUT") {
  const envelope = await readFleetV2SignedEnvelope(
    req,
    method,
    CombatPutSchema,
    FLEET_V2_BYTE_LIMITS.snapshotPut.requestBytes,
  );
  if (!envelope.ok) return fleetV2Error(envelope.code);
  const { headers, bytes, body } = envelope;
  const db = getDb();
  const auth = await authenticateFleetRequest(db, headers, bytes, {
    method,
    path: PATH,
    now: new Date(),
  });
  if (!auth.ok) return fleetV2Error(auth.code);
  const call = { sessionId: auth.auth.sessionId, revision: headers.revision };
  // Preflight time is NOT forwarded: service samples DB time after all locks.
  const result =
    method === "GET"
      ? await readFleetProjection(db, call)
      : await replaceDeviceProjection(db, {
          ...call,
          sampledAtMs: body!.sampled_at_ms,
          rows: body!.rows.map((row) => ({
            characterId: row.character_id,
            outgoingDps: row.outgoing_dps,
            incomingDps: row.incoming_dps,
            activityAgeMs: row.activity_age_ms,
            effects: row.effects.map((effect) => ({
              kind: effect.kind,
              observations: effect.observations.map((o) => ({
                name: o.name,
                ageMs: o.age_ms,
              })),
            })),
          })),
        });
  if (!result.ok) return fleetV2Error(result.code);
  return fleetV2Success(
    result.json,
    fleetV2RequestBinding({ method, path: PATH, ...headers }),
  );
}
export function GET(req: NextRequest) {
  return handle(req, "GET");
}
export function PUT(req: NextRequest) {
  return handle(req, "PUT");
}
export function POST() {
  return fleetV2Error("method_not_allowed", { allow: "GET, PUT" });
}
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export function HEAD() {
  return fleetV2Error("method_not_allowed", { head: true, allow: "GET, PUT" });
}
