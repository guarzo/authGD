import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, character } from "@/db/schema";
import { resolveAffiliations } from "@/core/affiliation";
import { decideTier } from "@/core/tier";
import type { EsiClient } from "@/lib/esi/client";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { runJob, type JobResult } from "@/services/sync-run";

export async function runMembershipJob(
  deps: { db: Db; cfg: Config; esi: Pick<EsiClient, "postAffiliation"> },
  opts: { accountId?: string; recheckInvalid?: boolean } = {},
): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  // F7: recheck runs get their own sync_run label so the admin sync page can
  // distinguish the weekly/on-demand invalid-affiliation recheck from the anchor.
  const jobType = opts.recheckInvalid ? "membership-recheck" : "membership";
  return runJob(db, jobType, async () => {
    const chars = await db
      .select({
        id: character.id,
        accountId: character.accountId,
        affiliationInvalid: character.affiliationInvalid,
      })
      .from(character)
      .where(opts.accountId ? eq(character.accountId, opts.accountId) : undefined);
    // affiliation_invalid ids are excluded from batches; the weekly recheck
    // (and the admin recheck button) pass recheckInvalid to include them.
    const eligible = chars.filter((c) => opts.recheckInvalid || !c.affiliationInvalid);
    const outcome = await resolveAffiliations(
      eligible.map((c) => c.id),
      (ids) => esi.postAffiliation(ids),
    );

    const checkedAt = new Date();
    for (const [id, aff] of outcome.resolved) {
      await db
        .update(character)
        .set({
          corporationId: aff.corporationId,
          allianceId: aff.allianceId,
          affiliationCheckedAt: checkedAt,
          affiliationInvalid: false,
        })
        .where(eq(character.id, id));
    }
    if (outcome.invalid.length > 0) {
      const alreadyFlagged = new Set(
        chars.filter((c) => c.affiliationInvalid).map((c) => c.id),
      );
      await db
        .update(character)
        .set({ affiliationInvalid: true, affiliationCheckedAt: checkedAt })
        .where(inArray(character.id, outcome.invalid));
      for (const id of outcome.invalid.filter((i) => !alreadyFlagged.has(i))) {
        await logAudit(db, {
          actor: "system",
          action: "character.affiliation_invalid",
          target: String(id),
        });
      }
    }

    // Tier pass: skip locked and null-main accounts; transition only on a
    // confirmed read of the MAIN in this run (an ESI outage can never demote).
    const accounts = await db
      .select()
      .from(account)
      .where(
        and(
          opts.accountId ? eq(account.id, opts.accountId) : undefined,
          eq(account.tierLocked, false),
          isNotNull(account.mainCharacterId),
        ),
      );
    let promoted = 0;
    let demoted = 0;
    for (const acc of accounts) {
      const mainAff =
        acc.mainCharacterId === null
          ? undefined
          : outcome.resolved.get(acc.mainCharacterId);
      const next = decideTier({
        tier: acc.tier,
        tierLocked: acc.tierLocked,
        mainConfirmed: mainAff !== undefined,
        mainInAlliance: mainAff?.allianceId === cfg.allianceId,
      });
      if (!next) continue;
      // State change + downstream job trigger commit in ONE transaction.
      const applied = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(account)
          .where(eq(account.id, acc.id))
          .for("update");
        if (
          !locked ||
          locked.tierLocked ||
          locked.tier === next ||
          locked.mainCharacterId !== acc.mainCharacterId
        ) {
          return false; // changed underneath us — leave it to the next run
        }
        await tx
          .update(account)
          .set({ tier: next, tierChangedAt: new Date(), tierChangedBy: "system" })
          .where(eq(account.id, acc.id));
        await logAudit(tx, {
          actor: "system",
          action: "tier.changed",
          target: acc.id,
          details: {
            from: locked.tier,
            to: next,
            cause: next === "flygd" ? "main joined alliance" : "main left alliance",
          },
        });
        await enqueueSync(tx, { kind: "account", accountId: acc.id });
        return true;
      });
      if (!applied) continue;
      if (next === "flygd") promoted++;
      else demoted++;
    }

    const counts = {
      checked: eligible.length,
      resolved: outcome.resolved.size,
      invalid: outcome.invalid.length,
      unresolved: outcome.unresolved.length,
      promoted,
      demoted,
    };
    if (outcome.unresolved.length > 0) {
      return {
        status: "partial",
        errorSummary: `${outcome.unresolved.length} characters unresolved (transient)`,
        counts,
        retry: true,
      };
    }
    return { status: "ok", counts };
  });
}
