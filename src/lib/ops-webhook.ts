import type { Config } from "@/config";
import { isDryRun, logSuppressedWrite } from "@/lib/sync-mode";

export class OpsWebhookError extends Error {}

/**
 * Posts to an ops webhook URL directly, with no Config and therefore no
 * dry-run guard. THROWS OpsWebhookError on failure.
 *
 * Only one caller should need this: the worker's boot-failure handler. Every
 * other path has a validated Config and must use postOpsWebhookOrThrow /
 * postOpsWebhook so dry-run suppression applies. The boot-failure path cannot,
 * because the failure it reports is frequently `getConfig()` itself throwing —
 * there is no Config to pass. It compensates by checking SYNC_MODE from the
 * raw environment at the call site.
 */
export async function postOpsWebhookUrl(
  url: string,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
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

/**
 * Posts to the optional Discord ops webhook and THROWS OpsWebhookError on
 * failure. Used by the dead-letter handler, where a lost alert must retry.
 * No-op when no webhook is configured.
 *
 * `url` defaults to the ops webhook so every existing caller is unaffected;
 * postStructureWebhook passes its own resolved url through instead.
 */
export async function postOpsWebhookOrThrow(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
  url: string | undefined = cfg.discord.opsWebhookUrl,
): Promise<void> {
  if (!url) return;
  // Dry-run suppression. Returns SUCCESSFULLY rather than throwing:
  // the dead-letter handler treats a throw as "retry the alert", so throwing
  // here would spin forever. A local worker must never page the real ops
  // channel with alerts about someone's laptop.
  if (isDryRun(cfg)) {
    logSuppressedWrite("ops-webhook", content.slice(0, 200));
    return;
  }
  await postOpsWebhookUrl(url, content, fetchImpl);
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

/**
 * Where a structure alert goes: the dedicated webhook, else the ops one.
 *
 * Exposed rather than resolved inside the poster because both the job and the
 * page need to know the answer BEFORE anything is posted. A post's return
 * value cannot distinguish "delivered" from "nowhere to deliver" —
 * postOpsWebhookOrThrow returns successfully when no url is set — so a job that
 * inferred delivery from it would mark every owed alert `sent` on a deployment
 * with no webhook configured at all.
 */
export function resolveStructureWebhookUrl(cfg: Config): string | undefined {
  return cfg.discord.structureWebhookUrl ?? cfg.discord.opsWebhookUrl;
}

/**
 * Posts a structure alert, THROWING when there is no webhook configured.
 *
 * The throw is the point: unlike the ops alerts, a dropped structure alert is
 * the failure this whole feature exists to prevent. Callers must have checked
 * resolveStructureWebhookUrl first and recorded the event as `seeded` if it
 * returned undefined; reaching here with no url is a bug, not a configuration.
 */
export async function postStructureWebhook(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = resolveStructureWebhookUrl(cfg);
  if (!url) throw new OpsWebhookError("structure webhook not configured");
  await postOpsWebhookOrThrow(cfg, content, fetchImpl, url);
}
