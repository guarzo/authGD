export type OAuthErrorClass = "permanent" | "transient";
export type EsiErrorClass = "needs_reauth" | "permanent" | "transient";

const PERMANENT_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "access_denied",
]);
const TRANSIENT_OAUTH_ERRORS = new Set(["temporarily_unavailable", "server_error"]);

export function classifyOAuthError(
  oauthError: string | undefined,
  status: number | undefined,
): OAuthErrorClass {
  if (oauthError && TRANSIENT_OAUTH_ERRORS.has(oauthError)) return "transient";
  if (oauthError && PERMANENT_OAUTH_ERRORS.has(oauthError)) return "permanent";
  if (oauthError && (status === 400 || status === 401)) return "permanent";
  return "transient";
}

export function classifyEsiError(
  status: number,
  body?: { error?: string },
): EsiErrorClass {
  if (status === 420 || status === 429) return "transient";
  if (status >= 500) return "transient";
  if (status === 403 && body?.error && /scope|token|authorization/i.test(body.error)) {
    return "needs_reauth";
  }
  return "permanent";
}
