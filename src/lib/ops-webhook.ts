import type { Config } from "@/config";
import type { DiscordEmbed } from "@/core/structure-event";
import { isDryRun, logSuppressedWrite } from "@/lib/sync-mode";

export class OpsWebhookError extends Error {}

/**
 * The empty form — `{parse: [], users: [], roles: []}` — is what makes a
 * message containing attacker-controlled text (a structure name, an alliance
 * name) safe to post. Discord's webhook default when `allowed_mentions` is
 * OMITTED is `{parse: ["users"]}` — NOT `["everyone"]`, that default applies
 * only to regular user/bot messages — so the hazard this closes is not
 * `@everyone`, it's a `<@123456789012345678>` USER mention hidden in text a
 * hostile in-game corp or alliance name can contain. Every post this file
 * makes sets an explicit `allowed_mentions`: the ops/dead-letter path always
 * uses this empty form, and postStructureWebhook substitutes a role-only form
 * when a role is configured (still empty `parse`, so the conclusion still
 * holds — nothing that reaches this file can ping by accident).
 */
const NO_MENTIONS = { parse: [], users: [], roles: [] } as const;

type AllowedMentions = {
  parse: readonly [];
  users: readonly [];
  roles: readonly string[];
};
type WebhookBody = {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: AllowedMentions;
};

/** Posts an already-built JSON body. THROWS OpsWebhookError on failure. */
async function postWebhookBody(
  url: string,
  body: WebhookBody,
  fetchImpl: typeof fetch,
  label: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new OpsWebhookError(
      `${label} post failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new OpsWebhookError(`${label} post failed (${res.status})`);
}

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
  await postWebhookBody(
    url,
    { content: content.slice(0, 1900), allowed_mentions: NO_MENTIONS },
    fetchImpl,
    "ops webhook",
  );
}

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
 * Posts a structure alert embed, THROWING when there is no webhook
 * configured.
 *
 * The throw is the point: unlike the ops alerts, a dropped structure alert is
 * the failure this whole feature exists to prevent. Callers must have checked
 * resolveStructureWebhookUrl first and recorded the event as `seeded` if it
 * returned undefined; reaching here with no url is a bug, not a configuration.
 *
 * Reads `cfg.discord.structureRoleId` itself, rather than taking it as a
 * parameter, because the role mention has one legal home: the top-level
 * `content` string. Discord does NOT fire notifications for a mention placed
 * inside an embed, so it can never move there no matter how this function's
 * caller is refactored. `allowed_mentions.roles` is populated ONLY with that
 * same id — never the empty-but-present `content`-less case — so a role
 * mention always has an explicit, matching allowlist entry.
 */
export async function postStructureWebhook(
  cfg: Config,
  embed: DiscordEmbed,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = resolveStructureWebhookUrl(cfg);
  if (!url) throw new OpsWebhookError("structure webhook not configured");
  // Checked BEFORE building the body: silent dry-run success is safe here
  // ONLY because the caller (runStructureEventsJob) flips the event's
  // alertStatus pending -> sent solely on this function's successful return —
  // a silent no-op success would mark an alert delivered that was never sent.
  // It is unreachable today: getFreshAccessToken returns `dry_run` and the
  // job returns long before the post loop. postOpsWebhookOrThrow's reasoning
  // for the same pattern (throwing would make the dead-letter handler retry
  // forever) does NOT transfer here — there is no dead-letter handler
  // downstream of a pending structure alert.
  if (isDryRun(cfg)) {
    logSuppressedWrite("structure-webhook", embed.title);
    return;
  }
  const roleId = cfg.discord.structureRoleId;
  const body: WebhookBody = {
    ...(roleId ? { content: `<@&${roleId}>` } : {}),
    embeds: [embed],
    allowed_mentions: roleId ? { parse: [], users: [], roles: [roleId] } : NO_MENTIONS,
  };
  await postWebhookBody(url, body, fetchImpl, "structure webhook");
}
