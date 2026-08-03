import type { Config } from "@/config";
import { isDryRun, logSuppressedWrite } from "@/lib/sync-mode";

export class OpsWebhookError extends Error {}

/**
 * Posts to the optional Discord ops webhook and THROWS OpsWebhookError on
 * failure. Used by the dead-letter handler, where a lost alert must retry.
 * No-op when no webhook is configured.
 */
export async function postOpsWebhookOrThrow(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = cfg.discord.opsWebhookUrl;
  if (!url) return;
  // Dry-run suppression (spec D9). Returns SUCCESSFULLY rather than throwing:
  // the dead-letter handler treats a throw as "retry the alert", so throwing
  // here would spin forever. A local worker must never page the real ops
  // channel with alerts about someone's laptop.
  if (isDryRun(cfg)) {
    logSuppressedWrite("ops-webhook", content.slice(0, 200));
    return;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new OpsWebhookError(
      `ops webhook post failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new OpsWebhookError(`ops webhook post failed (${res.status})`);
}

/** Best-effort variant for ordinary jobs — alerting must not break them. */
export async function postOpsWebhook(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await postOpsWebhookOrThrow(cfg, content, fetchImpl);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}
