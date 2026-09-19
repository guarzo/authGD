import { createHash } from "node:crypto";
import type { z } from "zod";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import {
  API_VERSION,
  SIGNING_SCHEME_VERSION,
  ExistingUuidSchema,
  TokenSchema,
  FLEET_V2_STATUS_BY_CODE,
  type FleetV2Code,
} from "@/core/fleet-api-v2";
import { readBoundedRequestBody } from "./fleet-request-body";
import { canonicalFleetRequest, type FleetAuthHeaders } from "./fleet-signature";
import { extractFleetV2AuthHeaders } from "./fleet-route-auth";

type InvalidInput = { ok: false; code: "bad_request" };
type ParsedJson = { ok: true; value: unknown } | InvalidInput;
type BodyRequest = { headers: Headers; body: ReadableStream<Uint8Array> | null };

/** Version classification is separate from DTO validation. Only an explicit
 * integer version can request an update; malformed input is never negotiation.
 */
export function classifyFleetV2Version(
  value: unknown,
): "ok" | "bad_request" | "update_required" {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "protocol")
  )
    return "bad_request";
  const protocol = (value as { protocol: unknown }).protocol;
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) return "bad_request";
  return protocol === API_VERSION ? "ok" : "update_required";
}

/** Every v2 numeric field is integral, but its JSON spelling need not be.
 * For a nonzero significand, integrality requires exponent >= fraction digits
 * minus trailing zero digits. This tests the decimal value before Number can
 * round a fraction or underflow it to zero, without expanding powers of ten.
 */
function hasIntegralJsonValue(lexeme: string): boolean {
  if (!/[.eE]/.test(lexeme)) return true;
  const parts = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme);
  if (!parts) return false;
  const fraction = parts[2] ?? "";
  const digits = parts[1] + fraction;
  let lastNonzero = digits.length - 1;
  while (lastNonzero >= 0 && digits[lastNonzero] === "0") lastNonzero--;
  if (lastNonzero < 0) return true;
  const trailingZeros = digits.length - 1 - lastNonzero;
  // The comparison threshold is bounded by entity length, far below 2^53.
  // Exponents outside Number's exact range (even +/-Infinity) are necessarily
  // beyond that threshold; conversion cannot change this comparison's answer.
  const exponent = Number(parts[3] ?? "0");
  return exponent >= fraction.length - trailingZeros;
}

/** A lexical pass adds the properties JSON.parse does not provide:
 * duplicate-key rejection (after unescaping keys), exact integrality and finite
 * numbers. Native JSON.parse remains the grammar authority. Iterative scanning avoids an
 * untrusted nesting depth consuming the JS call stack, with storage bounded
 * by the already-bounded entity. Strings are never normalized or rewritten.
 */
function checkJsonTokens(text: string): void {
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      if (index >= text.length) throw new SyntaxError("unterminated string");
      const end = ++index;
      while (index < text.length && /[\t\n\r ]/.test(text[index])) index++;
      if (text[index] === ":") {
        const key = JSON.parse(text.slice(start, end)) as string;
        const keys = objects[objects.length - 1];
        if (!keys || keys.has(key)) throw new SyntaxError("duplicate or misplaced key");
        keys.add(key);
      }
    } else if (char === "{" || char === "[") {
      objects.push(char === "{" ? new Set() : null);
      index++;
    } else if (char === "}" || char === "]") {
      objects.pop();
      index++;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      const start = index++;
      while (index < text.length && /[0-9eE+.-]/.test(text[index])) index++;
      const lexeme = text.slice(start, index);
      if (!hasIntegralJsonValue(lexeme) || !Number.isFinite(Number(lexeme)))
        throw new SyntaxError("fractional or nonfinite number");
    } else {
      index++;
    }
  }
}

/** Raw decoded entity bytes are bounded BEFORE UTF-8 decoding or JSON parsing.
 * Fatal decoding rejects overlong encodings/surrogates; retaining the BOM lets
 * JSON's own grammar reject it instead of silently removing signed bytes.
 */
export function parseBoundedFleetV2Json(raw: Uint8Array, maxBytes: number): ParsedJson {
  if (raw.byteLength > maxBytes) return { ok: false, code: "bad_request" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    checkJsonTokens(text);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Syntax/UTF-8 failure is an untrusted wire error, never provider details.
    return { ok: false, code: "bad_request" };
  }
}

/** Retains exact accepted bytes for signature verification; never signs the
 * parsed/re-serialized value. The existing stream reader owns cancellation.
 * Callers must provide decoded entities, not a compressed-byte-only budget.
 */
export async function readFleetV2Json(
  req: BodyRequest,
  maxBytes: number,
): Promise<{ ok: true; value: unknown; bytes: Uint8Array } | InvalidInput> {
  try {
    if (!hasIdentityFleetV2Encoding(req.headers))
      return { ok: false, code: "bad_request" };
    const body = await readBoundedRequestBody(req, maxBytes);
    if (!body.ok) return { ok: false, code: "bad_request" };
    const parsed = parseBoundedFleetV2Json(body.bytes, maxBytes);
    return parsed.ok ? { ...parsed, bytes: body.bytes } : parsed;
  } catch {
    // A disconnected/failed incoming stream is a closed request refusal.
    return { ok: false, code: "bad_request" };
  }
}

/** Next passes raw compressed bytes, not a decoded entity. Reject unsupported
 * encodings instead of pretending their compressed size is the decoded budget. */
export function hasIdentityFleetV2Encoding(headers: Headers): boolean {
  const encoding = headers.get("content-encoding");
  return encoding === null || encoding.toLowerCase() === "identity";
}

/** Internal historical refusals never broaden the closed wire dictionary. */
export function closedFleetV2Code(code: string): FleetV2Code {
  const legacy: Record<string, FleetV2Code> = {
    invalid_session: "unauthorized",
    not_eligible: "forbidden",
    try_again: "service_unavailable",
  };
  return Object.hasOwn(legacy, code)
    ? legacy[code]
    : Object.hasOwn(FLEET_V2_STATUS_BY_CODE, code)
      ? (code as FleetV2Code)
      : "service_unavailable";
}

/** Closed errors have no binding or clock anchor. Explicit HEAD handlers avoid
 * Next's GET fallback, which would otherwise run admission and consume cadence. */
export function fleetV2Error(
  code: FleetV2Code,
  options: { head?: boolean; allow?: string } = {},
): Response {
  return new Response(
    options.head ? null : JSON.stringify({ protocol: API_VERSION, error: code }),
    {
      status: FLEET_V2_STATUS_BY_CODE[code],
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        ...(options.allow ? { Allow: options.allow } : {}),
      },
    },
  );
}

/** The service already validated and bounded this exact compact JSON before
 * commit. Do not parse/re-serialize it at the route (or add format selectors). */
export function fleetV2Success(json: string, binding: string): Response {
  return new Response(json, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Content-Encoding": "identity",
      "X-Fleet-Request-Binding": binding,
    },
  });
}

/** NextRequest.url is NextURL's normalized spelling and drops a bare '?'.
 * Its native Request base retains the original URL (Next 16.3 Node adapter).
 * Check both, without depending on private NextURL symbols or normalized search. */
export function hasFleetV2Query(req: { url: string }): boolean {
  return (
    req.url.includes("?") ||
    (req instanceof Request && Reflect.get(Request.prototype, "url", req).includes("?"))
  );
}

/** Also checks headers: Next's Node adapter can drop GET streams while
 * preserving their framing. Plain request doubles must supply their raw URL.
 */
export function hasEmptyFleetV2GetFraming(
  req: { headers: Headers; url: string },
  raw: Uint8Array,
): boolean {
  const length = req.headers.get("content-length");
  return (
    !hasFleetV2Query(req) &&
    raw.byteLength === 0 &&
    (length === null || /^0+$/.test(length)) &&
    !req.headers.has("transfer-encoding")
  );
}

/** Shared framing for signed GET/PUT routes only. No DB/service entry until
 * headers, exact decoded bytes, version and the closed body schema pass. */
export async function readFleetV2SignedEnvelope<T>(
  req: BodyRequest & { url: string },
  method: "GET" | "PUT",
  schema: z.ZodType<T>,
  putBytes: number,
  path: string,
): Promise<
  | { ok: true; headers: FleetAuthHeaders; bytes: Uint8Array; body: T | null }
  | { ok: false; code: FleetV2Code }
> {
  if (new URL(req.url).pathname !== path) return { ok: false, code: "bad_request" };
  if (hasFleetV2Query(req)) return { ok: false, code: "bad_headers" };
  const headers = extractFleetV2AuthHeaders(req);
  if (!headers) return { ok: false, code: "bad_headers" };
  if (!hasIdentityFleetV2Encoding(req.headers)) return { ok: false, code: "bad_request" };
  if (method === "GET") {
    if (!hasEmptyFleetV2GetFraming(req, new Uint8Array()))
      return { ok: false, code: "bad_headers" };
    try {
      const raw = await readBoundedRequestBody(req, 0);
      if (!raw.ok || !hasEmptyFleetV2GetFraming(req, raw.bytes))
        return { ok: false, code: "bad_headers" };
      return { ok: true, headers, bytes: raw.bytes, body: null };
    } catch {
      // Incoming stream failure supplies neither admission nor a clock anchor.
      return { ok: false, code: "bad_request" };
    }
  }
  const raw = await readFleetV2Json(req, putBytes);
  if (!raw.ok) return raw;
  const version = classifyFleetV2Version(raw.value);
  if (version !== "ok") return { ok: false, code: version };
  const body = safeParseFleetV2Dto(schema, raw.value);
  return body.success
    ? { ok: true, headers, bytes: raw.bytes, body: body.data }
    : { ok: false, code: "bad_request" };
}

/** Correlation over trusted TLS, NOT authentication or a server signature.
 * Only call with the exact request fields that authentication accepted. This
 * does not issue permission, consume a revision, or establish a clock anchor.
 */
export function fleetV2RequestBinding(
  request: Omit<Parameters<typeof canonicalFleetRequest>[0], "protocol">,
): string {
  return createHash("sha256")
    .update("fleet-api-v2\n", "utf8")
    .update(canonicalFleetRequest({ ...request, protocol: SIGNING_SCHEME_VERSION }))
    .digest("hex");
}

/** Fetch joins duplicate header lines with commas; Token rejects those too.
 * A response-binding supplied by the caller is never an attempt substitute.
 */
export function extractFleetV2Attempt(headers: Headers): string | null {
  if (headers.has("x-fleet-request-binding")) return null;
  const parsed = TokenSchema.safeParse(headers.get("x-fleet-attempt"));
  return parsed.success ? parsed.data : null;
}

/** The four pre-session POSTs only. Use configured canonical origin, never
 * Host/redirect/response data; preserve existing UUID spelling in literal paths.
 * This hash changes per HTTP attempt, not the deployed immutable proof domains.
 */
export function fleetV2PreSessionBinding(input: {
  origin: string;
  path: string;
  attempt: string;
  rawBody: Uint8Array;
}): string | null {
  if (!TokenSchema.safeParse(input.attempt).success) return null;
  try {
    const origin = new URL(input.origin);
    if (origin.protocol !== "https:" || origin.origin !== input.origin) return null;
  } catch {
    return null;
  }
  const path =
    /^\/api\/fleet\/v2\/(?:pairing-requests|recovery-challenges)(?:\/([^/]+)\/complete)?$/.exec(
      input.path,
    );
  if (!path || (path[1] !== undefined && !ExistingUuidSchema.safeParse(path[1]).success))
    return null;
  return createHash("sha256")
    .update(
      [
        "fleet-api-v2-pre-session",
        input.origin,
        "POST",
        input.path,
        input.attempt,
        createHash("sha256").update(input.rawBody).digest("hex"),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

/** Validate the COMPLETE service DTO with its closed, non-transforming schema
 * before issuing/committing authority. Return the exact compact JSON string so
 * routes can use Response(json), not a second serializer/ASCII/HTML recoder.
 * Invalid or oversized output fails atomically; no dropping rows or clamping.
 */
export function serializeFleetV2Json<T>(
  value: unknown,
  schema: z.ZodType<T>,
  maxBytes: number,
): { ok: true; json: string } | { ok: false; code: "service_unavailable" } {
  const parsed = safeParseFleetV2Dto(schema, value);
  if (!parsed.success) return { ok: false, code: "service_unavailable" };
  const json = JSON.stringify(parsed.data);
  if (Buffer.byteLength(json, "utf8") > maxBytes)
    return { ok: false, code: "service_unavailable" };
  return { ok: true, json };
}
