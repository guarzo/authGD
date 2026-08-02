import type { Config } from "@/config";

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
  });
  if (!res.ok) throw new Error(`discord token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token: string };
  return { accessToken: json.access_token };
}

export async function fetchDiscordUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; username: string }> {
  const res = await fetchImpl("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`discord user fetch failed (${res.status})`);
  const json = (await res.json()) as { id: string; username: string };
  return { id: json.id, username: json.username };
}
