import type { NextRequest } from "next/server";
import type { z } from "zod";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import { getConfig } from "@/config";
import { ExistingUuidSchema, FLEET_V2_BYTE_LIMITS } from "@/core/fleet-api-v2";
import {
  classifyFleetV2Version,
  extractFleetV2Attempt,
  fleetV2Error,
  fleetV2PreSessionBinding,
  hasFleetV2Query,
  readFleetV2Json,
} from "@/lib/fleet-api-v2";

/** All four pre-session POSTs share framing, not proof or intent identity.
 * The configured origin is independent of Host/Origin/forwarded headers. */
export async function readFleetV2PreSessionEnvelope<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
  path: string,
  completionId?: string,
): Promise<{ value: T; binding: string } | { response: Response }> {
  if (completionId !== undefined && !ExistingUuidSchema.safeParse(completionId).success)
    return { response: fleetV2Error("not_found") };
  if (req.method !== "POST")
    return {
      response: fleetV2Error("method_not_allowed", {
        allow: "POST",
        head: req.method === "HEAD",
      }),
    };
  if (hasFleetV2Query(req) || new URL(req.url).pathname !== path)
    return { response: fleetV2Error("bad_request") };
  const attempt = extractFleetV2Attempt(req.headers);
  if (
    !attempt ||
    [...req.headers.keys()].some(
      (name) => name.startsWith("x-fleet-") && name !== "x-fleet-attempt",
    )
  )
    return { response: fleetV2Error("bad_request") };
  const raw = await readFleetV2Json(
    req,
    FLEET_V2_BYTE_LIMITS.preSessionPost.requestBytes,
  );
  if (!raw.ok) return { response: fleetV2Error(raw.code) };
  const version = classifyFleetV2Version(raw.value);
  if (version !== "ok") return { response: fleetV2Error(version) };
  const body = safeParseFleetV2Dto(schema, raw.value);
  if (!body.success) return { response: fleetV2Error("bad_request") };
  try {
    const binding = fleetV2PreSessionBinding({
      origin: new URL(getConfig().appBaseUrl).origin,
      path,
      attempt,
      rawBody: raw.bytes,
    });
    if (!binding) return { response: fleetV2Error("service_unavailable") };
    return { value: body.data, binding };
  } catch {
    // Configuration is not a proof outcome, and must not become a Next HTML error.
    return { response: fleetV2Error("service_unavailable") };
  }
}
