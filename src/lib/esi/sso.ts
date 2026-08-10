import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "@/config";

const AUTHORIZE_URL = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
const JWKS_URL = "https://login.eveonline.com/oauth/jwks";
const ISSUER = "https://login.eveonline.com";
const AUDIENCE = "EVE Online";

export class EveSsoError extends Error {
  oauthError?: string;
  status?: number;
  constructor(message: string, opts: { oauthError?: string; status?: number } = {}) {
    super(message);
    this.oauthError = opts.oauthError;
    this.status = opts.status;
  }
}

export interface EveIdentity {
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
}

/**
 * `extraScopes` is unioned with the configured set rather than replacing it:
 * the callback stores whatever EVE grants, so a request that dropped the
 * standing scopes would silently downgrade the character.
 *
 * This CANNOT target a specific character. EVE's picker runs after this URL is
 * built, so the grant attaches to whichever character the operator chooses —
 * identity is learned only from the callback JWT. Callers detect the resulting
 * scope state; they cannot guarantee it.
 */
export function buildEveAuthorizeUrl(
  cfg: Config,
  state: string,
  codeChallenge: string,
  extraScopes: string[] = [],
): string {
  const url = new URL(AUTHORIZE_URL);
  const scopes = [...new Set([...cfg.eveSso.scopes, ...extraScopes])];
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${cfg.appBaseUrl}/auth/eve/callback`);
  url.searchParams.set("client_id", cfg.eveSso.clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function tokenRequest(
  cfg: Config,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; refreshToken: string }> {
  const basic = Buffer.from(`${cfg.eveSso.clientId}:${cfg.eveSso.clientSecret}`).toString(
    "base64",
  );
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new EveSsoError(`EVE SSO token request failed (${res.status})`, {
      oauthError: typeof json.error === "string" ? json.error : undefined,
      status: res.status,
    });
  }
  // fail closed: these values feed ownership logic and token storage
  const accessToken = json.access_token;
  const refreshToken = json.refresh_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    throw new EveSsoError("EVE SSO token response missing tokens");
  }
  return { accessToken, refreshToken };
}

export function exchangeEveCode(
  cfg: Config,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    cfg,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
    }),
    fetchImpl,
  );
}

export function refreshEveToken(
  cfg: Config,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    cfg,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    fetchImpl,
  );
}

let remoteJwks: JWTVerifyGetKey | undefined;

export async function verifyEveAccessToken(
  accessToken: string,
  getKey?: JWTVerifyGetKey,
): Promise<EveIdentity> {
  remoteJwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(accessToken, getKey ?? remoteJwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const sub = String(payload.sub ?? "");
  const match = /^CHARACTER:EVE:(\d+)$/.exec(sub);
  if (!match) throw new EveSsoError(`unexpected subject: ${sub}`);
  // fail closed: ownerHash drives transfer reclaim — never coerce missing claims
  const { name, owner, scp } = payload as {
    name?: unknown;
    owner?: unknown;
    scp?: unknown;
  };
  if (typeof name !== "string" || name.length === 0) {
    throw new EveSsoError("EVE JWT missing name claim");
  }
  if (typeof owner !== "string" || owner.length === 0) {
    throw new EveSsoError("EVE JWT missing owner claim");
  }
  return {
    characterId: Number(match[1]),
    characterName: name,
    ownerHash: owner,
    scopes: Array.isArray(scp) ? scp.map(String) : typeof scp === "string" ? [scp] : [],
  };
}
