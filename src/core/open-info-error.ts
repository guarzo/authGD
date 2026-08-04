import { EsiError } from "@/lib/esi/client";

/** Every distinguishable way opening an in-game window can fail. Each one gets
 *  different advice on the page, which is the whole reason they are separate:
 *  "they are not logged in" and "EVE rate-limited us" are not the same problem
 *  and do not have the same fix. */
export type OpenInfoFailure = "reauth" | "offline" | "busy" | "timeout" | "failed";

/**
 * ESI's own words for "there is no client to open a window on". This is the
 * ONLY evidence we accept for the offline message: the official Swagger does
 * not define a status code that means "character not online", so inferring it
 * from a bare 403 would put a confident, wrong sentence in front of the
 * operator every time a scope or a session actually broke.
 */
const OFFLINE_BODY = /not online|offline/i;

/**
 * Classifies a failure from `openInformationWindow`, or returns null for
 * anything we cannot honestly describe — the caller rethrows those, because a
 * bug deserves a stack trace and not a soothing message.
 *
 * The timeout branch is not decoration: `request` in src/lib/esi/client.ts
 * passes `AbortSignal.timeout(30_000)`, which rejects with a DOMException named
 * "TimeoutError" that is NOT an EsiError. Without this branch a slow ESI is the
 * one failure mode that escapes the action entirely and reaches the operator as
 * a raw 500.
 */
export function classifyOpenInfoFailure(err: unknown): OpenInfoFailure | null {
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return "timeout";
  }
  if (!(err instanceof EsiError)) return null;
  // classifyEsiError already resolved 403-with-a-scope/token/authorization body
  // into needs_reauth; anything else at 403 is NOT evidence of being offline.
  if (err.kind === "needs_reauth") return "reauth";
  if (OFFLINE_BODY.test(err.message)) return "offline";
  if (err.status === 420 || err.status === 429) return "busy";
  return "failed";
}
