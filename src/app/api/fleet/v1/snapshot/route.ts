import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
  hasUnsignedQueryString,
} from "@/lib/fleet-route-auth";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";
import { canonicalFleetRequest, snapshotRequestBinding } from "@/lib/fleet-signature";
import {
  FLEET_RELAY_PROTOCOL,
  FLEET_RELAY_STATUS_BY_CODE,
  type PublishedRow,
  readFleetProjection,
  replaceDeviceProjection,
} from "@/services/fleet-relay";

// Never calls ESI, never reads a browser session cookie as a desktop
// credential — every mutation/read here is delegated to fleet-relay.ts,
// which re-authenticates the session independently inside its own
// transaction; this route only verifies the signed envelope beforehand.
export const dynamic = "force-dynamic";

const CANONICAL_PATH = "/api/fleet/v1/snapshot";
const PUBLICATION_FORMAT = "publication-v1";
// One HTTP token. Fetch joins repeated header lines with commas, which fail this
// shape just like explicit comma-joined values. Unknown tokens request an update.
const FORMAT_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Primary defense against an oversized wire body, measured on the RAW
 *  bytes before any `JSON.parse` — matches `fleet-relay.ts`'s own
 *  documented secondary bound (`MAX_BODY_BYTES`), duplicated here rather
 *  than imported: that constant is private to its module, and this route's
 *  copy exists to reject the request even earlier, before parsing. */
const MAX_PUT_BODY_BYTES = 8192;
/** A GET carries no telemetry payload; bounded generously above zero only to
 *  reject a device that (incorrectly) attaches one. */
const MAX_GET_BODY_BYTES = 1024;

const RowSchema = z
  .object({
    character_id: z.number().int().positive(),
    dps: z.number().int().min(0).max(10_000_000),
    ewar: z
      .array(z.literal("SCRAM/POINT"))
      .max(1)
      // Structurally unreachable at max(1) — a duplicate needs at least two
      // elements — kept as a defensive check for a future looser bound, the
      // same "not reachable today, kept for a shape that isn't this one"
      // reasoning fleet-relay.ts's own MAX_BODY_BYTES comment documents.
      .refine((ewar) => new Set(ewar).size === ewar.length, {
        message: "duplicate ewar tag",
      }),
  })
  .strict();

const BodySchema = z
  .object({
    protocol: z.literal(1),
    rows: z
      .array(RowSchema)
      .max(32)
      .refine((rows) => new Set(rows.map((r) => r.character_id)).size === rows.length, {
        message: "duplicate character_id",
      }),
  })
  .strict();

function jsonError(code: string, status: number) {
  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL, error: code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function authError(code: "bad_headers" | "unauthorized") {
  return jsonError(code, code === "bad_headers" ? 400 : 401);
}

function hasUnsupportedProtocol(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "protocol" in value &&
    (value as { protocol?: unknown }).protocol !== 1
  );
}

export async function PUT(req: NextRequest) {
  if (hasUnsignedQueryString(req)) return authError("bad_headers");
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return authError("bad_headers");

  const bodyResult = await readBoundedRequestBody(req, MAX_PUT_BODY_BYTES);
  // Read and size-checked before any JSON.parse: an oversized body is
  // refused as the same `invalid_batch` code the service layer would have
  // used for it, without ever paying to parse it.
  if (!bodyResult.ok) return jsonError("invalid_batch", 400);
  const raw = bodyResult.bytes;

  const now = new Date();
  const auth = await authenticateFleetRequest(getDb(), headers, raw, {
    method: "PUT",
    path: CANONICAL_PATH,
    now,
  });
  if (!auth.ok) return authError(auth.code);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return jsonError("bad_request", 400);
  }
  if (hasUnsupportedProtocol(parsed)) return jsonError("update_required", 400);

  const body = BodySchema.safeParse(parsed);
  if (!body.success) return jsonError("bad_request", 400);

  const rows: PublishedRow[] = body.data.rows.map((r) => ({
    characterId: r.character_id,
    dps: r.dps,
    // The Zod schema already bounds this to 0 or 1 literal "SCRAM/POINT"
    // entries, so this is a known-safe reshape into PublishedRow's own
    // 0-or-1-tuple type -- not a real type change, which is why it needs the
    // double cast (a plain array and a fixed-length tuple union don't
    // "sufficiently overlap" as far as TypeScript can prove on their own).
    ewar: r.ewar as unknown as PublishedRow["ewar"],
  }));

  const result = await replaceDeviceProjection(getDb(), {
    sessionId: auth.auth.sessionId,
    revision: headers.revision,
    rows,
  });
  if (!result.ok) {
    return jsonError(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
  }

  return NextResponse.json(
    { protocol: FLEET_RELAY_PROTOCOL },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(req: NextRequest) {
  if (hasUnsignedQueryString(req)) return authError("bad_headers");
  const headers = extractFleetAuthHeaders(req);
  if (!headers) return authError("bad_headers");

  // Next's Node adapter drops GET streams, but preserves framing headers. An
  // empty signed digest cannot authorize hidden wire bytes. Admit only absent
  // length or decimal zero (Node also accepts "00"), and no transfer framing;
  // malformed/duplicate framing rejected earlier by Node stays Node's concern.
  const contentLength = req.headers.get("content-length");
  if (
    (contentLength !== null && !/^0+$/.test(contentLength)) ||
    req.headers.has("transfer-encoding")
  )
    return authError("bad_headers");

  const bodyResult = await readBoundedRequestBody(req, MAX_GET_BODY_BYTES);
  if (!bodyResult.ok || bodyResult.bytes.byteLength !== 0)
    return authError("bad_headers");
  const raw = bodyResult.bytes;

  const now = new Date();
  const auth = await authenticateFleetRequest(getDb(), headers, raw, {
    method: "GET",
    path: CANONICAL_PATH,
    now,
  });
  if (!auth.ok) return authError(auth.code);

  const format = req.headers.get("x-fleet-snapshot-format");
  if (format !== null && !FORMAT_TOKEN.test(format)) return authError("bad_headers");
  if (format !== null && format !== PUBLICATION_FORMAT)
    return jsonError("update_required", 400);
  const publication = format === PUBLICATION_FORMAT;

  // The signed request's own revision is consumed here too, atomically
  // against the SAME per-session monotonic counter/cadence bucket a PUT
  // publish uses (fleet-relay.ts's gateSignedSession) — a captured-and-
  // replayed signed GET is exactly as inert as a replayed PUT.
  const result = await readFleetProjection(getDb(), {
    sessionId: auth.auth.sessionId,
    revision: headers.revision,
    requireSharedMode: publication,
  });
  if (!result.ok) {
    return jsonError(result.code, FLEET_RELAY_STATUS_BY_CODE[result.code] ?? 400);
  }

  return NextResponse.json(
    {
      protocol: FLEET_RELAY_PROTOCOL,
      rows: result.rows
        .filter((r) => !publication || r.publicationId !== null)
        .map((r) => ({
          character_id: r.characterId,
          character_name: r.characterName,
          dps: r.dps,
          ewar: r.ewar,
          state: r.state,
          age_ms: r.ageMs,
          ...(publication ? { publication_id: r.publicationId } : {}),
        })),
    },
    {
      headers: {
        "Cache-Control": "no-store",
        ...(publication
          ? {
              "X-Fleet-Snapshot-Format": PUBLICATION_FORMAT,
              "X-Fleet-Request-Binding": snapshotRequestBinding(
                canonicalFleetRequest({
                  protocol: 1,
                  method: "GET",
                  path: CANONICAL_PATH,
                  sessionId: auth.auth.sessionId,
                  issuedAt: headers.issuedAt,
                  revision: headers.revision,
                  bodySha256: headers.bodySha256,
                }),
              ),
            }
          : {}),
      },
    },
  );
}
