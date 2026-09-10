import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { FleetCode } from "@/core/fleet-sharing";
import { readBoundedRequestBody } from "@/lib/fleet-request-body";

export function recoveryJson(body: object, status = 200) {
  return NextResponse.json(
    { protocol: 1, ...body },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function recoveryError(code: FleetCode) {
  const status =
    code === "rate_limited"
      ? 429
      : code === "feature_disabled" || code === "service_unavailable"
        ? 503
        : 401;
  return recoveryJson({ error: code }, status);
}

/** Same 2KiB streaming bound/public-key wire alphabet as pairing. Strict bodies
 * are the only selectors; neither query nor caller Host/Origin chooses authority. */
export async function readRecoveryEnvelope<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
): Promise<{ value: T } | { response: NextResponse }> {
  if (req.nextUrl.search !== "")
    return { response: recoveryJson({ error: "bad_request" }, 400) };
  let parsed: unknown;
  try {
    const body = await readBoundedRequestBody(req, 2048);
    if (!body.ok) return { response: recoveryJson({ error: "bad_request" }, 400) };
    parsed = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return { response: recoveryJson({ error: "bad_request" }, 400) };
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "protocol" in parsed &&
    parsed.protocol !== 1
  )
    return { response: recoveryJson({ error: "update_required" }, 400) };
  const result = schema.safeParse(parsed);
  if (!result.success) return { response: recoveryJson({ error: "bad_request" }, 400) };
  return { value: result.data };
}
