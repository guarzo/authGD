import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import {
  controlFleetSource,
  readFleetSourceState,
  type SourceView,
} from "@/services/fleet-source";
import { FLEET_RELAY_PROTOCOL, FLEET_RELAY_STATUS_BY_CODE } from "@/services/fleet-relay";
export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v1/sources";
const timestamp = z
  .string()
  .length(24)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
const BodySchema = z.discriminatedUnion("operation", [
  z
    .object({
      protocol: z.literal(1),
      operation: z.literal("start"),
      source_id: z.uuid(),
      expected_generation: z.literal(0),
      character_id: z.number().int().positive(),
      character_link_epoch: z.uuid(),
      intent_created_at: timestamp,
    })
    .strict(),
  z
    .object({
      protocol: z.literal(1),
      operation: z.literal("stop"),
      source_id: z.uuid(),
      expected_generation: z.number().int().min(0).max(2_147_483_646),
    })
    .strict(),
]);
function json(value: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL, ...value },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
function error(code: string, status = FLEET_RELAY_STATUS_BY_CODE[code] ?? 400) {
  return json({ error: code }, status);
}
function source(value: SourceView) {
  return {
    source_id: value.sourceId,
    generation: value.generation,
    character_id: value.characterId,
    state: value.state,
    reason: value.reason,
    pending_expires_at: value.pendingExpiresAt?.toISOString() ?? null,
  };
}
async function handle(req: NextRequest, method: "GET" | "PUT") {
  if (hasUnsignedQueryString(req)) return error("bad_headers");
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return error("bad_headers");
  const raw = await readBoundedRequestBody(req, 1024);
  if (!raw.ok) return error("bad_request");
  try {
    const auth = await authenticateFleetRequest(getDb(), headers, raw.bytes, {
      method,
      path: PATH,
      now: new Date(),
    });
    if (!auth.ok) return error(auth.code, auth.code === "bad_headers" ? 400 : 401);
    const call = { sessionId: auth.auth.sessionId, revision: headers.revision };
    if (method === "GET") {
      if (raw.bytes.length !== 0) return error("bad_request");
      const result = await readFleetSourceState(getDb(), call);
      if (!result.ok) return error(result.code);
      return json({
        sources: result.value.sources.map(source),
        characters: result.value.characters.map((ch) => ({
          character_id: ch.characterId,
          character_name: ch.characterName,
          character_link_epoch: ch.characterLinkEpoch,
          has_fleet_read: ch.hasFleetRead,
          token_usable: ch.tokenUsable,
        })),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw.bytes));
    } catch {
      return error("bad_request");
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "protocol" in parsed &&
      parsed.protocol !== 1
    )
      return error("update_required");
    const body = BodySchema.safeParse(parsed);
    if (!body.success) return error("bad_request");
    const value = body.data;
    const result = await controlFleetSource(getDb(), {
      ...call,
      command:
        value.operation === "start"
          ? {
              operation: "start",
              sourceId: value.source_id,
              expectedGeneration: 0,
              characterId: value.character_id,
              characterLinkEpoch: value.character_link_epoch,
              intentCreatedAt: new Date(value.intent_created_at),
            }
          : {
              operation: "stop",
              sourceId: value.source_id,
              expectedGeneration: value.expected_generation,
            },
    });
    return result.ok ? json({ source: source(result.value) }) : error(result.code);
  } catch {
    console.error("fleet_source_control_failed");
    return error("service_unavailable", 503);
  }
}
export async function GET(req: NextRequest) {
  return handle(req, "GET");
}
export async function PUT(req: NextRequest) {
  return handle(req, "PUT");
}
