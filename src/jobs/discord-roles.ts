import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, discordLink } from "@/db/schema";
import { diffRoles, stripManagedRoles, validateRoleConfig } from "@/core/role-diff";
import { DiscordApiError, type DiscordClient } from "@/lib/discord/rest";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { isDryRun } from "@/lib/sync-mode";
import { logAudit, logAuditIfChanged } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { runJob, type JobResult } from "@/services/sync-run";

export async function runDiscordRolesJob(
  deps: { db: Db; cfg: Config; discord: DiscordClient; fetchImpl?: typeof fetch },
  opts: { accountId?: string; discordUserId?: string } = {},
): Promise<JobResult> {
  const { db, cfg, discord } = deps;
  // In dry-run the client's role methods return normally without issuing a
  // request, so this job cannot distinguish a suppressed write from a real one.
  // Audit rows would therefore record role changes that never happened, and
  // audit_log is the record an operator trusts when reconstructing what the
  // system did to someone's account. Suppress the rows and rename the counters
  // so neither can be mistaken for an applied change.
  const dry = isDryRun(cfg);
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
      // Defaulted, not left unassigned: the catch below reads `remove.length`
      // to tell a genuinely partial strip from "everything landed but the
      // audit write itself then failed" (see the `partial` computation
      // there), and it has to be safe to read even if the throw that sent us
      // there happened before `stripManagedRoles` ever ran.
      let remove: string[] = [];
      // Tracks which removal was in flight when a failure lands, so the audit
      // row (below) can say which role we were acting on rather than just
      // "something failed" — the whole point of writing it at all.
      let inFlightRoleId: string | undefined;
      // Tracks removals that actually landed before a mid-loop failure, so
      // the catch below can still write `discord.role_changed` for them —
      // two of three roles coming off and the third throwing is a real
      // change, not a no-op.
      const removedSoFar: string[] = [];
      try {
        member = await discord.getGuildMember(opts.discordUserId);
        if (!member) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: see the note on the final return in this function.
          return { status: "ok", counts: { notInGuild: 1 } as Record<string, number> };
        }
        remove = stripManagedRoles(cfg.discord.roleIds, member.roles);
        for (const roleId of remove) {
          inFlightRoleId = roleId;
          await discord.removeMemberRole(opts.discordUserId, roleId);
          removedSoFar.push(roleId);
        }
        // Written INSIDE the try, not after it: this used to sit below the
        // whole try/catch, unguarded, so a DB fault on this exact insert
        // (statement timeout, serialization conflict — precisely the moment
        // an audit write is most likely to fail) escaped straight to
        // `runJob` with every removal already landed and nothing recorded.
        // The retry that follows can't recover it either: `stripManagedRoles`
        // re-derives `remove` from the member's now-CURRENT roles, which by
        // then are already empty, so the retry sees nothing left to strip and
        // reports "ok, removed 0" — the real removals from this attempt never
        // appear in `audit_log` at all. Moving it inside the try routes a
        // failure here through the same catch (below) that already exists for
        // exactly this shape of loss.
        if (remove.length > 0 && !dry) {
          await logAudit(db, {
            actor: "system",
            action: "discord.role_changed",
            target: opts.discordUserId,
            details: { removed: remove, cause: "discord unlinked" },
          });
        }
      } catch (err) {
        // Runs for ANY error here — transient, permanent, or a DB fault —
        // not just the permanent-failure branch below. A retry re-derives
        // `remove` from the member's CURRENT roles (`stripManagedRoles`), so
        // a transient failure that gets retried only ever sees and audits
        // what's *left* to strip; the roles this attempt already removed
        // would otherwise never appear in `audit_log` at all, retried or
        // not. Mirrors the main sweep's catch below, which has the same
        // "any error" scope for the same reason.
        //
        // Also the landing spot when the loop above finished completely and
        // it was the success write itself that threw: `removedSoFar` and
        // `remove` are then equal, so `partial` below correctly reads false —
        // this is a complete strip whose FIRST audit attempt failed, retried
        // once more here, not a partial one.
        if (removedSoFar.length > 0 && !dry) {
          try {
            await logAudit(db, {
              actor: "system",
              action: "discord.role_changed",
              target: opts.discordUserId,
              details: {
                removed: removedSoFar,
                cause: "discord unlinked",
                partial: removedSoFar.length < remove.length,
              },
            });
          } catch (auditErr) {
            // Hoisting this above the permanence check widens what reaches
            // it to include DB faults — exactly the failure mode where this
            // write is also likely to throw. Swallowed (logged, not thrown):
            // this path handles ONE deprovision and always ends in either a
            // throw (below, for transient/other errors) or a
            // `logAuditIfChanged` write for the permanent branch — both
            // already produce a visible failure regardless of this guard, so
            // guarding costs nothing here and buys one thing: `err`, the
            // original Discord (or DB) failure that got us into this catch,
            // is what surfaces instead of being overwritten by a second,
            // less specific failure from the compensating write itself.
            //
            // The main sweep's equivalent write (below) is ALSO guarded, for
            // a related but stronger reason worth reading if touching either:
            // it sits inside a per-row loop, so an unguarded throw there
            // would abort every remaining member's role sync for the whole
            // tick, not just lose one audit row — see that guard's own
            // comment for the full account, including a correction to an
            // earlier version of this reasoning that had the comparison
            // backwards on both counts.
            //
            // `opts.discordUserId` and `removedSoFar` are logged alongside
            // the message rather than left to the caller to infer: this is
            // the one place that failure can go unrecorded with no exception
            // at all (see the permanent branch below), so the trace needs to
            // be correlatable to a member on its own.
            console.error(
              `discord.role_changed audit write failed for ${opts.discordUserId} (removed ${removedSoFar.join(", ")}): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            );
          }
        }
        if (err instanceof DiscordApiError && !err.transient) {
          const msg = `discord role strip failed for ${opts.discordUserId}: ${err.message}`;
          // A permanent failure here means an unlinked member keeps roles they
          // no longer qualify for, silently, until someone happens to notice.
          // Not dry-run-guarded: removeMemberRole itself is a no-op in dry-run
          // (src/lib/discord/rest.ts), so a DiscordApiError reaching here can
          // only be a real API rejection or a real read failure — never a
          // suppressed write masquerading as one.
          //
          // If the partial write above also failed, this branch still
          // RETURNS (not throws) a clean `{status:"failed"}` — no exception,
          // same as every other permanent-config failure in this file, which
          // deliberately does not retry-loop. A thrown/retried attempt could
          // not recover the lost row either (same non-recoverability as the
          // catch's own note above), so forcing a retry here would only
          // re-hit the same permanent Discord error again for no gain. The
          // console.error above, with both ids, is what's left to diagnose
          // it — `role_strip_failed` alone, with no matching `role_changed`,
          // is otherwise silently misread as "nothing came off".
          await logAuditIfChanged(db, {
            actor: "system",
            action: "discord.role_strip_failed",
            target: opts.discordUserId,
            details: { roleId: inFlightRoleId ?? null, error: err.message },
          });
          return { status: "failed", errorSummary: msg };
        }
        throw err;
      }
      // Last-writer race: a re-link may have landed (and its role sync run)
      // WHILE we stripped. Re-check; if linked now, hand ownership back to the
      // account path with a fresh outbox row so the roles are re-asserted.
      const relinked = await db
        .select()
        .from(discordLink)
        .where(eq(discordLink.discordUserId, opts.discordUserId));
      const removedKey = dry ? "wouldRemove" : "removed";
      if (relinked.length > 0) {
        await enqueueSync(db, { kind: "account", accountId: relinked[0].accountId });
        return {
          status: "ok",
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: see the note on the final return in this function.
          counts: { [removedKey]: remove.length, relinkResync: 1 } as Record<
            string,
            number
          >,
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
        counts: { [removedKey]: remove.length } as Record<string, number>,
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
      // Tracks which role call was in flight when a failure lands (below),
      // same reasoning as the strip path above.
      let inFlight: { op: "add" | "remove"; roleId: string } | null = null;
      // Tracks what actually landed before a mid-loop failure, so the catch
      // below can still write `discord.role_changed` for the roles that
      // really changed — the add loop finishing and the remove loop throwing
      // must not read to Discord as "nothing happened".
      const applied: { added: string[]; removed: string[] } = { added: [], removed: [] };
      // What the diff INTENDED, hoisted so the catch can tell "a role write
      // failed partway" from "everything landed and only the success audit
      // write itself then failed" — `diff` is declared inside the try below
      // and out of scope in the catch.
      let expectedAdd = 0;
      let expectedRemove = 0;
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
        expectedAdd = diff.add.length;
        expectedRemove = diff.remove.length;

        // Unguarded in dry-run, unlike every role write below. The same
        // distinction `wanderer.ts` draws when it records an ACL observation
        // during a suppressed run: this is what Discord told us, not something
        // we did to Discord. Suppressing it would make dry-run runs leave the
        // names permanently stale on an instance that never runs live.
        //
        // Written every cycle rather than once, which is also the backfill:
        // links created before these columns existed fill in on the account's
        // next roles run with no migration step and no extra API call, since
        // `getGuildMember` was already being called here for the role diff.
        const username = member.user?.username ?? null;
        const displayName = member.nick ?? member.user?.global_name ?? null;
        await db
          .update(discordLink)
          .set({ username, displayName })
          .where(eq(discordLink.discordUserId, row.discordUserId));

        for (const roleId of diff.add) {
          inFlight = { op: "add", roleId };
          await discord.addMemberRole(row.discordUserId, roleId);
          applied.added.push(roleId);
        }
        for (const roleId of diff.remove) {
          inFlight = { op: "remove", roleId };
          await discord.removeMemberRole(row.discordUserId, roleId);
          applied.removed.push(roleId);
        }
        inFlight = null;
        if (diff.add.length + diff.remove.length > 0) {
          // Written, THEN counted — not the other way around. If this write
          // throws (a DB fault, not a Discord one), `counts.changed++` must
          // not have already run: the catch below re-attempts the same write
          // from `applied` and does its own counting, and incrementing here
          // first would double both the counter and the audit row for a
          // change that only ever happened once.
          if (!dry) {
            await logAudit(db, {
              actor: "system",
              action: "discord.role_changed",
              target: row.discordUserId,
              details: { added: diff.add, removed: diff.remove, tier: row.tier },
            });
          }
          counts.changed++;
        }
      } catch (err) {
        const permanent = err instanceof DiscordApiError && !err.transient;
        if (permanent) counts.failed++;
        else transientFailures++;
        errors.push(
          `${row.discordUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // The role write(s) that landed before this failure are real changes
        // and must not vanish just because the ones after them didn't land.
        // Written unconditionally (plain logAudit, not the dedupe below) —
        // unlike a recurring identical failure, a partial change is a
        // distinct event each tick and must not be suppressed as a repeat.
        //
        // Also the landing spot when both loops above finished completely and
        // it was the success write itself that threw (counts.changed was NOT
        // yet incremented there — see the comment above): `applied` then
        // equals `expectedAdd`/`expectedRemove` exactly, so `partial` below
        // correctly reads false — a complete change whose first audit attempt
        // failed, retried once more here, not a partial one.
        if (applied.added.length > 0 || applied.removed.length > 0) {
          counts.changed++;
          if (!dry) {
            try {
              await logAudit(db, {
                actor: "system",
                action: "discord.role_changed",
                target: row.discordUserId,
                details: {
                  added: applied.added,
                  removed: applied.removed,
                  tier: row.tier,
                  partial:
                    applied.added.length < expectedAdd ||
                    applied.removed.length < expectedRemove,
                },
              });
            } catch (auditErr) {
              // Guarded, matching the strip path — this diverges from an
              // earlier version of this comment that argued the OPPOSITE for
              // exactly the opposite reason, and both halves of that argument
              // were wrong. It claimed leaving this unguarded protected
              // against the job "reporting success having lost every audit
              // row": it cannot report success from here — `counts.failed`/
              // `transientFailures` and `errors.push` above already ran for
              // THIS row, so the terminal branch below returns "partial",
              // never "ok", whether this write lands or not. So the real
              // comparison is narrower than "recover vs. lose the row" (a
              // retry recovers nothing either way — same reasoning as the
              // strip path's guard). It's "abort the rest of `rows` vs.
              // finish it": an unguarded throw here escapes this row's catch
              // entirely and aborts the `for` loop, so every member not yet
              // reached this tick gets no role sync attempted at all — not
              // even tried, not just failed — while `sync_run.errorSummary`
              // ends up holding this DB fault's message instead of the
              // accumulated per-member Discord errors already in `errors`.
              // Guarding costs this one row's audit trail and lets every
              // other member in `rows` still get processed. That cost is
              // permanent, not deferred — the same non-recoverability as
              // everywhere else in this file: the roles have already changed,
              // so the next tick's `diffRoles` comes back empty for this
              // member and never writes the row that was lost. What the next
              // tick does restore is the STATE (the member's roles are
              // correct either way), not the RECORD. Worth taking anyway,
              // because the alternative spends the rest of the tick's sweep
              // to save nothing. Logged, not silent, for the same reason the
              // strip path's guard is.
              console.error(
                `discord.role_changed audit write failed for ${row.discordUserId} (added ${applied.added.join(", ")}, removed ${applied.removed.join(", ")}): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
              );
            }
          }
        }
        // Only permanent failures get an audit row. Transient trouble already
        // retries the whole job (see `retry` on the returned JobResult below)
        // and, if genuinely transient, resolves without ever needing a
        // record; logging every retry attempt would multiply the flood this
        // is meant to avoid rather than diagnose one. Not dry-run-guarded:
        // addMemberRole/removeMemberRole are no-ops in dry-run, so a
        // DiscordApiError reaching here in dry-run is still a real read
        // failure (getGuildMember, a malformed body), never a suppressed
        // write pretending to be one.
        if (permanent) {
          await logAuditIfChanged(db, {
            actor: "system",
            action: "discord.role_sync_failed",
            target: row.discordUserId,
            details: {
              op: inFlight?.op ?? null,
              roleId: inFlight?.roleId ?? null,
              tier: row.tier,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    // Rename the applied-change counter in dry-run so a reader of sync_run
    // cannot mistake a suppressed run for an effective one.
    const { changed, ...rest } = counts;
    const reported: Record<string, number> = dry
      ? { wouldChangeRoles: changed, ...rest }
      : counts;
    if (transientFailures > 0 || counts.failed > 0) {
      return {
        status: "partial",
        errorSummary: errors.slice(0, 5).join("; "),
        counts: reported,
        retry: transientFailures > 0,
      };
    }
    return { status: "ok", counts: reported };
  });
}
