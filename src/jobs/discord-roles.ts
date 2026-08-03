import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, discordLink } from "@/db/schema";
import { diffRoles, stripManagedRoles, validateRoleConfig } from "@/core/role-diff";
import { DiscordApiError, type DiscordClient } from "@/lib/discord/rest";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { runJob, type JobResult } from "@/services/sync-run";

export async function runDiscordRolesJob(
  deps: { db: Db; cfg: Config; discord: DiscordClient; fetchImpl?: typeof fetch },
  opts: { accountId?: string; discordUserId?: string } = {},
): Promise<JobResult> {
  const { db, cfg, discord } = deps;
  return runJob(db, "discord-roles", async () => {
    // Config validation FIRST, every run. A validation failure is
    // permanent-config: alert immediately and do NOT retry-loop. The same goes
    // for PERMANENT errors fetching the config data (401/403 = bad bot token
    // or missing access); only transient fetch errors throw → pg-boss retries.
    let guildRoles;
    let botMember;
    try {
      guildRoles = await discord.getGuildRoles();
      botMember = await discord.getGuildMember(await discord.getBotUserId());
    } catch (err) {
      if (err instanceof DiscordApiError && !err.transient) {
        const msg = `discord config check failed: ${err.message}`;
        await postOpsWebhook(cfg, `authGD: ${msg}`, deps.fetchImpl);
        return { status: "failed", errorSummary: msg };
      }
      throw err;
    }
    const validation = botMember
      ? validateRoleConfig({
          managed: cfg.discord.roleIds,
          guildRoles,
          botRoleIds: botMember.roles,
          everyoneRoleId: cfg.discord.guildId,
        })
      : ({ ok: false, error: "bot is not a member of the configured guild" } as const);
    if (!validation.ok) {
      await postOpsWebhook(
        cfg,
        `authGD: discord role sync config invalid — ${validation.error}`,
        deps.fetchImpl,
      );
      return { status: "failed", errorSummary: validation.error };
    }

    // {kind:"discord-user"} deprovision payload: strip managed roles from a
    // user who unlinked. If they re-linked meanwhile, the account path owns it.
    if (opts.discordUserId) {
      const links = await db
        .select()
        .from(discordLink)
        .where(eq(discordLink.discordUserId, opts.discordUserId));
      if (links.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: see the note on the final return in this function.
        return { status: "ok", counts: { skipped: 1 } as Record<string, number> };
      }
      let member;
      let remove: string[];
      try {
        member = await discord.getGuildMember(opts.discordUserId);
        if (!member) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: see the note on the final return in this function.
          return { status: "ok", counts: { notInGuild: 1 } as Record<string, number> };
        }
        remove = stripManagedRoles(cfg.discord.roleIds, member.roles);
        for (const roleId of remove) {
          await discord.removeMemberRole(opts.discordUserId, roleId);
        }
      } catch (err) {
        if (err instanceof DiscordApiError && !err.transient) {
          const msg = `discord role strip failed for ${opts.discordUserId}: ${err.message}`;
          return { status: "failed", errorSummary: msg };
        }
        throw err;
      }
      if (remove.length > 0) {
        await logAudit(db, {
          actor: "system",
          action: "discord.role_changed",
          target: opts.discordUserId,
          details: { removed: remove, cause: "discord unlinked" },
        });
      }
      // Last-writer race: a re-link may have landed (and its role sync run)
      // WHILE we stripped. Re-check; if linked now, hand ownership back to the
      // account path with a fresh outbox row so the roles are re-asserted.
      const relinked = await db
        .select()
        .from(discordLink)
        .where(eq(discordLink.discordUserId, opts.discordUserId));
      if (relinked.length > 0) {
        await enqueueSync(db, { kind: "account", accountId: relinked[0].accountId });
        return {
          status: "ok",
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: see the note on the final return in this function.
          counts: { removed: remove.length, relinkResync: 1 } as Record<string, number>,
        };
      }
      return {
        status: "ok",
        // These four `as Record<string, number>` assertions are load-bearing.
        // Without them the branches infer distinct object shapes, and their
        // union carries optional-undefined members (`notInGuild?: undefined`,
        // `relinkResync?: undefined`, ...) that fail the index signature on
        // JobResult["counts"]. The rule evaluates each assertion in isolation
        // and cannot see the widening, so it reports a false positive.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: see above.
        counts: { removed: remove.length } as Record<string, number>,
      };
    }

    const rows = await db
      .select({
        accountId: account.id,
        tier: account.tier,
        discordUserId: discordLink.discordUserId,
      })
      .from(discordLink)
      .innerJoin(account, eq(discordLink.accountId, account.id))
      .where(opts.accountId ? eq(account.id, opts.accountId) : undefined);

    const counts = { changed: 0, notInGuild: 0, failed: 0 };
    let transientFailures = 0;
    const errors: string[] = [];
    for (const row of rows) {
      try {
        const member = await discord.getGuildMember(row.discordUserId);
        if (!member) {
          counts.notInGuild++; // user not in guild → log and skip
          continue;
        }
        const diff = diffRoles({
          tier: row.tier,
          managed: cfg.discord.roleIds,
          memberRoleIds: member.roles,
        });
        for (const roleId of diff.add) {
          await discord.addMemberRole(row.discordUserId, roleId);
        }
        for (const roleId of diff.remove) {
          await discord.removeMemberRole(row.discordUserId, roleId);
        }
        if (diff.add.length + diff.remove.length > 0) {
          counts.changed++;
          await logAudit(db, {
            actor: "system",
            action: "discord.role_changed",
            target: row.discordUserId,
            details: { added: diff.add, removed: diff.remove, tier: row.tier },
          });
        }
      } catch (err) {
        if (err instanceof DiscordApiError && !err.transient) counts.failed++;
        else transientFailures++;
        errors.push(
          `${row.discordUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (transientFailures > 0 || counts.failed > 0) {
      return {
        status: "partial",
        errorSummary: errors.slice(0, 5).join("; "),
        counts,
        retry: transientFailures > 0,
      };
    }
    return { status: "ok", counts };
  });
}
