import type { Config } from "@/config";

/** Posts to the optional Discord ops webhook. Never throws — alerting must not break jobs. */
export async function postOpsWebhook(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = cfg.discord.opsWebhookUrl;
  if (!url) return;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`ops webhook post failed (${res.status})`);
  } catch (err) {
    console.error("ops webhook post failed", err);
  }
}
