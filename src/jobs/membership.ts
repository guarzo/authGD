import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, character } from "@/db/schema";
import { resolveAffiliations } from "@/core/affiliation";
import { decideTier } from "@/core/tier";
import type { EsiClient } from "@/lib/esi/client";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { runJob, type JobResult } from "@/services/sync-run";

/**
 * Applies one system tier transition. Exported so tests can pin the
 * supersession window directly: a CAS win in the write phase is only
 * momentary, so this transaction re-verifies — under lock, character row
 * BEFORE account row per the LOCK ORDER comment in src/services/accounts.ts —
 * that the run's affiliation write is STILL the latest before transitioning
 * on it. Returns true when the transition was applied.
 */
export async function applyTierTransition(
  db: Db,
  input: {
    accountId: string;
    mainCharacterId: number;
    next: "flygd" | "green";
    checkedAt: Date;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [mainRow] = await tx
      .select()
      .from(character)
      .where(eq(character.id, input.mainCharacterId))
      .for("update");
    if (
      !mainRow ||
      mainRow.affiliationCheckedAt?.getTime() !== input.checkedAt.getTime()
    ) {
      return false; // superseded — the newer run owns this decision
    }
    const [locked] = await tx
      .select()
      .from(account)
      .where(eq(account.id, input.accountId))
      .for("update");
    if (
      !locked ||
      locked.tierLocked ||
      locked.tier === input.next ||
      locked.mainCharacterId !== input.mainCharacterId
    ) {
      return false; // changed underneath us — leave it to the next run
    }
    await tx
      .update(account)
      .set({ tier: input.next, tierChangedAt: new Date(), tierChangedBy: "system" })
      .where(eq(account.id, input.accountId));
    await logAudit(tx, {
      actor: "system",
      action: "tier.changed",
      target: input.accountId,
      details: {
        from: locked.tier,
        to: input.next,
        cause: input.next === "flygd" ? "main joined alliance" : "main left alliance",
      },
    });
    await enqueueSync(tx, { kind: "account", accountId: input.accountId });
    return true;
  });
}

export async function runMembershipJob(
  deps: { db: Db; cfg: Config; esi: Pick<EsiClient, "postAffiliation"> },
  opts: { accountId?: string; recheckInvalid?: boolean } = {},
): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  // F7: recheck runs get their own sync_run label so the admin sync page can
  // distinguish the weekly/on-demand invalid-affiliation recheck from the anchor.
  const jobType = opts.recheckInvalid ? "membership-recheck" : "membership";
  return runJob(db, jobType, async () => {
    // Ordering token for this run, captured BEFORE any external work and from
    // the DATABASE clock: "short" queues allow two overlapping runs, and a
    // slower, older run must never beat a newer one just by finishing last
    // (a post-ESI `new Date()` would give the older run the LATER stamp).
    const tokenResult = await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    // node-postgres returns raw driver rows as strings for this query shape;
    // normalize to a real Date so drizzle's timestamp bind params work.
    const checkedAt = new Date(tokenResult.rows[0].now);

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

    // CAS on affiliation_checked_at: only rows whose write WON are confirmed
    // for the tier pass; a lost write means a newer run owns this character.
    const confirmed = new Set<number>();
    let stale = 0;
    const tokenGuard = (id: number) =>
      and(
        eq(character.id, id),
        or(
          isNull(character.affiliationCheckedAt),
          lt(character.affiliationCheckedAt, checkedAt),
        ),
      );
    for (const [id, aff] of outcome.resolved) {
      const won = await db
        .update(character)
        .set({
          corporationId: aff.corporationId,
          allianceId: aff.allianceId,
          affiliationCheckedAt: checkedAt,
          affiliationInvalid: false,
        })
        .where(tokenGuard(id))
        .returning({ id: character.id });
      if (won.length > 0) confirmed.add(id);
      else stale++;
    }
    for (const id of outcome.invalid) {
      // ONE transaction per character: lock, check token AND current flag
      // under the lock, update, audit — a read-then-write across statements
      // would let an interleaved run cause duplicate audit rows.
      const outcome2 = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(character)
          .where(eq(character.id, id))
          .for("update");
        if (!row) return "gone";
        if (
          row.affiliationCheckedAt &&
          row.affiliationCheckedAt.getTime() >= checkedAt.getTime()
        ) {
          return "stale"; // a newer run owns this row
        }
        await tx
          .update(character)
          .set({ affiliationInvalid: true, affiliationCheckedAt: checkedAt })
          .where(eq(character.id, id));
        if (!row.affiliationInvalid) {
          await logAudit(tx, {
            actor: "system",
            action: "character.affiliation_invalid",
            target: String(id),
          });
        }
        return "won";
      });
      if (outcome2 === "stale") stale++;
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
      const mainConfirmed =
        mainAff !== undefined &&
        acc.mainCharacterId !== null &&
        confirmed.has(acc.mainCharacterId);
      const next = decideTier({
        tier: acc.tier,
        tierLocked: acc.tierLocked,
        mainConfirmed,
        mainInAlliance: mainAff?.allianceId === cfg.allianceId,
      });
      if (!next) continue;
      const applied = await applyTierTransition(db, {
        accountId: acc.id,
        mainCharacterId: acc.mainCharacterId!,
        next,
        checkedAt,
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
      stale,
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
