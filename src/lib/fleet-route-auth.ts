import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { fleetDevice, fleetDeviceSession } from "@/db/schema";
import {
  decodeDevicePublicKeyB64,
  verifyFleetRequest,
  type FleetAuthHeaders,
} from "@/lib/fleet-signature";

/**
 * The route-layer half of the `fleet-v1` signed-request contract
 * (`src/lib/fleet-signature.ts`, `src/services/fleet-relay.ts`): extracting
 * the five `X-Fleet-*` headers from a live `NextRequest` and authenticating
 * the calling device against the database, shared by every route that
 * requires all signed headers (`GET /catalogue`, `PUT`/`GET /snapshot`,
 * `PUT /session`). Not itself a route or page file — extracted here rather
 * than duplicated across each one, since every route needs the identical
 * extract-then-verify-then-look-up-the-device flow, mirroring
 * `src/lib/request-session.ts`'s existing role as a shared helper multiple
 * routes import rather than reimplement.
 */

const SESSION_HEADER = "x-fleet-session";
const ISSUED_AT_HEADER = "x-fleet-issued-at";
const REVISION_HEADER = "x-fleet-revision";
const BODY_SHA256_HEADER = "x-fleet-body-sha256";
const SIGNATURE_HEADER = "x-fleet-signature";

/**
 * Canonical base-10 text only: no leading zero (other than the bare literal
 * "0"), no leading `+`/`-`, no decimal point, no whitespace. This is the
 * ONLY shape `Number(...)` may safely parse into `FleetAuthHeaders.revision`
 * (a `number`, per `FleetAuthHeaders`'s contract).
 *
 * This is also where a duplicate `X-Fleet-Revision` header is rejected.
 * `NextRequest.headers` is a Fetch `Headers` object, which per spec joins a
 * repeated raw header line into one comma-separated string
 * (`headers.get("x-fleet-revision")` returns `"5, 7"` for two lines `5` and
 * `7`) — that string fails this regex outright, well before it could reach
 * `Number(...)` and silently coerce to `NaN` or (worse, with `parseInt`) to
 * the first duplicate's value. The other four headers need no equivalent
 * check here: every one of their shapes in `fleet-signature.ts`
 * (`SESSION_ID_RE`, `ISSUED_AT_RE`, `BODY_SHA256_RE`, `SIGNATURE_RE`) already
 * excludes a raw comma, so a duplicated raw header line fails
 * `verifyFleetRequest`'s own `hasWellFormedHeaders` check the same way.
 */
const CANONICAL_INTEGER_RE = /^(0|[1-9][0-9]*)$/;

/**
 * A signed fleet route accepts NO query string at all: the canonical `path`
 * every route signs (each route's own hardcoded `CANONICAL_PATH` literal) is
 * a bare path with no query component, so anything a caller appended to the
 * live request's query string is never covered by the signature. Rejecting
 * it outright, before any other check, closes that gap rather than
 * silently accepting and ignoring a query string today's handlers happen
 * not to read — a future change that DOES read one would otherwise inherit
 * an unauthenticated input by default.
 */
export function hasUnsignedQueryString(req: { nextUrl: { search: string } }): boolean {
  return req.nextUrl.search !== "";
}

/**
 * Extracts and shape-validates the five `X-Fleet-*` headers. Returns `null`
 * for anything missing or malformed — never throws, and never partially
 * accepts a request whose `revision` cannot be parsed into a canonical,
 * lossless `number`.
 */
export function extractFleetAuthHeaders(req: {
  headers: Headers;
}): FleetAuthHeaders | null {
  const sessionId = req.headers.get(SESSION_HEADER);
  const issuedAt = req.headers.get(ISSUED_AT_HEADER);
  const revisionRaw = req.headers.get(REVISION_HEADER);
  const bodySha256 = req.headers.get(BODY_SHA256_HEADER);
  const signature = req.headers.get(SIGNATURE_HEADER);
  if (!sessionId || !issuedAt || !revisionRaw || !bodySha256 || !signature) return null;
  if (!CANONICAL_INTEGER_RE.test(revisionRaw)) return null;
  const revision = Number(revisionRaw);
  if (!Number.isSafeInteger(revision)) return null;
  return { sessionId, issuedAt, revision, bodySha256, signature };
}

// Mirrors fleet-signature.ts's own SESSION_ID_RE — a cheap, pure pre-check so
// an obviously malformed session id never triggers a DB lookup at all.
const SESSION_ID_SHAPE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Every call site hardcodes its own literal `path` (each route's own
 * `CANONICAL_PATH` constant), never one derived from the live request URL —
 * Next.js only ever dispatches a matching request to that route's handler in
 * the first place, so there is no live path for a control character to hide
 * in today. This is a second, explicit guard on that invariant rather than
 * bare trust in the call sites: a control character (0x00-0x1F, 0x7F)
 * anywhere in `request.path` can only mean a caller passed something other
 * than its own hardcoded literal, and is refused here, before that string
 * ever reaches `canonicalFleetRequest`/`verifyFleetRequest`.
 */
// eslint-disable-next-line no-control-regex -- deliberate: this is exactly the character class being rejected (see above).
const PATH_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function sessionKey(rawSessionId: string): string {
  return createHash("sha256").update(rawSessionId).digest("base64url");
}

export type FleetRouteAuth = {
  deviceId: string;
  accountId: string;
  /** The raw (unhashed) session id the caller presented, for the relay
   *  service call that follows — those services independently re-resolve
   *  and re-validate the session themselves (defense in depth); this is not
   *  a shortcut around that. */
  sessionId: string;
};

export type FleetRouteAuthResult =
  | { ok: true; auth: FleetRouteAuth }
  | { ok: false; code: "bad_headers" | "unauthorized" };

/**
 * Route-level authentication for every signed fleet relay route. Resolves
 * the calling device's own Ed25519 public key (which no relay service
 * exposes — `replaceDeviceProjection`/`readFleetProjection` take only an
 * opaque `sessionId` and authenticate it again, independently, inside their
 * own transaction) and verifies the request's signature against it.
 *
 * Every refusal past a pure, self-evident header-shape problem collapses to
 * the SAME generic `"unauthorized"` code: an unknown session id, an expired
 * session, a revoked device, and a signature that fails to verify for a
 * perfectly real session are all indistinguishable in the response. This
 * mirrors `readFleetProjection`'s own generic `"forbidden"` ruling — a
 * caller must not be able to use this boundary to learn
 * whether a guessed session id exists.
 */
export async function authenticateFleetRequest(
  dbx: Dbx,
  headers: FleetAuthHeaders,
  rawBody: Uint8Array,
  request: { method: "GET" | "PUT"; path: string; now: Date },
): Promise<FleetRouteAuthResult> {
  if (PATH_CONTROL_CHAR_RE.test(request.path)) return { ok: false, code: "bad_headers" };
  if (!SESSION_ID_SHAPE_RE.test(headers.sessionId))
    return { ok: false, code: "bad_headers" };

  const [session] = await dbx
    .select()
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.id, sessionKey(headers.sessionId)));
  if (!session || session.expiresAt.getTime() <= request.now.getTime()) {
    return { ok: false, code: "unauthorized" };
  }

  const [device] = await dbx
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.id, session.deviceId));
  if (!device || device.revokedAt !== null) {
    return { ok: false, code: "unauthorized" };
  }

  const spki = decodeDevicePublicKeyB64(device.publicKeySpkiB64);
  const verdict = verifyFleetRequest(spki, headers, rawBody, request);
  if (verdict !== "ok") return { ok: false, code: "unauthorized" };

  return {
    ok: true,
    auth: {
      deviceId: device.id,
      accountId: device.accountId,
      sessionId: headers.sessionId,
    },
  };
}
