import { z } from "zod";
import type { Config } from "@/config";

export class DiscordOAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
// Snowflake ids are decimal digit strings; this value feeds the unique
// discord_user_id identity column, so anything else is rejected outright.
const userResponseSchema = z.object({
  id: z.string().regex(/^\d+$/),
  username: z.string().min(1),
});

export function buildDiscordAuthorizeUrl(
  cfg: Config,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", cfg.discord.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${cfg.appBaseUrl}/auth/discord/callback`);
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeDiscordCode(
  cfg: Config,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string }> {
  const res = await fetchImpl("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.discord.clientId,
      client_secret: cfg.discord.clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: `${cfg.appBaseUrl}/auth/discord/callback`,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new DiscordOAuthError(
      `discord token exchange failed (${res.status})`,
      res.status,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new DiscordOAuthError("discord token response malformed");
  return { accessToken: parsed.data.access_token };
}

export async function fetchDiscordUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; username: string }> {
  const res = await fetchImpl("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new DiscordOAuthError(`discord user fetch failed (${res.status})`, res.status);
  }
  const parsed = userResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new DiscordOAuthError("discord user response malformed");
  return { id: parsed.data.id, username: parsed.data.username };
}
