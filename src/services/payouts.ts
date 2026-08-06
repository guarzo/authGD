import { and, eq, inArray, sql } from "drizzle-orm";
import type { Dbx, DbTx } from "@/db";
import {
  account,
  character,
  lootPool,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
} from "@/db/schema";
import { centsToIsk, computeSplit, iskToCents } from "@/core/payout-split";
import { logAudit } from "@/services/audit";
import { addAppraisedPool } from "@/services/payout-loot";
import type { AppraisalResult } from "@/services/appraisal";
import type { PricingMode } from "@/core/pricing";

export class PayoutForbiddenError extends Error {}
export class PayoutLockedError extends Error {}
/** The operation or participant an operation was asked to act on does not
 *  exist. Distinguishable by callers from a programming error, the same way
 *  PayoutForbiddenError and PayoutLockedError already are. */
export class PayoutNotFoundError extends Error {}
/** A manual roster addition names someone already on the roster. Named rather
 *  than a bare Error because `addParticipantAction` has to tell it from a real
 *  fault: the operator typed this name and can retype it, so it earns a message
 *  on the page rather than error.tsx's "a fault on this end". */
export class PayoutDuplicateParticipantError extends Error {}
/** Thrown by `deleteOperation` when any participant currently carries a
 *  `paidAmount` — see that function's doc for why this is not `hasPayments`. */
export class PayoutHasPaidError extends Error {}

/**
 * `getSessionAccount` (src/services/session.ts) resolves a session to an
 * accountId and deliberately checks neither tier nor status — every existing
 * caller that needs more does its own lookup. This is that lookup for
 * payouts: a cryo account (this project's representation of someone who has
 * stepped away) must not be able to move alliance ISK, even with a perfectly
 * valid session, and neither can anyone below member.
 */
export async function requirePayoutOperator(dbx: Dbx, accountId: string): Promise<void> {
  const [acc] = await dbx.select().from(account).where(eq(account.id, accountId));
  if (!acc || acc.tier !== "member" || acc.status !== "active") {
    throw new PayoutForbiddenError("payout mutation requires an active member account");
  }
}

/** Reading is far less restrictive than mutating: any member account, any status. */
export async function canReadPayouts(dbx: Dbx, accountId: string): Promise<boolean> {
  const [acc] = await dbx.select().from(account).where(eq(account.id, accountId));
  return acc?.tier === "member";
}

export async function lockOperation(
  dbtx: DbTx,
  operationId: string,
): Promise<typeof payoutOperation.$inferSelect> {
  const [op] = await dbtx
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.id, operationId))
    .for("update");
  if (!op) throw new PayoutNotFoundError("operation not found");
  return op;
}

export async function hasPayments(dbx: Dbx, operationId: string): Promise<boolean> {
  const rows = await dbx
    .select({ id: payoutPayment.id })
    .from(payoutPayment)
    .innerJoin(payoutParticipant, eq(payoutPayment.participantId, payoutParticipant.id))
    .where(eq(payoutParticipant.operationId, operationId))
    .limit(1);
  return rows.length > 0;
}

/**
 * The single gate every payout-affecting edit passes through. Two conditions,
 * for two different reasons:
 *
 *   1. status must be `draft`. Finalization is a commitment — if a finalized
 *      operation stayed editable, finalizing would mean nothing and
 *      `unlockOperation` would have no purpose. Correcting a
 *      finalized operation is legal, but it goes through an audited unlock.
 *   2. no payment may exist. This outlives the status check, because unlock is
 *      itself refused once money has moved. Checking it here as well means no
 *      path can reach an edit.
 *
 * Callers hold the operation row lock (via `lockOperation`) before calling this,
 * so neither condition can change underneath the edit that follows.
 */
export async function assertEditable(dbtx: DbTx, operationId: string): Promise<void> {
  const [op] = await dbtx
    .select({ status: payoutOperation.status })
    .from(payoutOperation)
    .where(eq(payoutOperation.id, operationId));
  if (!op) throw new PayoutNotFoundError("operation not found");
  if (op.status !== "draft") {
    throw new PayoutLockedError("operation is finalized; unlock it before editing");
  }
  if (await hasPayments(dbtx, operationId)) {
    throw new PayoutLockedError("operation has a payment and can no longer be edited");
  }
}

export async function createOperation(
  dbtx: DbTx,
  actor: string,
  input: {
    name: string;
    occurredAt: Date;
    battleReportUrl?: string | null;
    corpSharePct?: string;
    notes?: string | null;
  },
): Promise<{ id: string }> {
  await requirePayoutOperator(dbtx, actor);
  const [op] = await dbtx
    .insert(payoutOperation)
    .values({
      name: input.name,
      occurredAt: input.occurredAt,
      battleReportUrl: input.battleReportUrl ?? null,
      // No product default here. It used to be `?? "10"`, which became a
      // second source of truth the moment PAYOUT_CORP_SHARE_PCT arrived: a
      // deployment on 15% still got 10 from any caller that omitted the
      // field. The web tier states the policy once
      // (`createOperationAction` passes `getConfig().payoutCorpSharePct`),
      // and a caller that omits it falls to the column's own "0" (schema.ts)
      // — which states no policy, deliberately, since a bare DB insert (a
      // migration backfill, a script) should not silently commit anyone to a
      // number.
      corpSharePct: input.corpSharePct,
      notes: input.notes ?? null,
      createdBy: actor,
    })
    .returning();
  await logAudit(dbtx, { actor, action: "payout.created", target: op.id });
  return { id: op.id };
}

/**
 * The composer's entry point: create the operation, then thread its own
 * pastes through the SAME two functions the detail page's editors would call
 * one at a time — `addAppraisedPool` (src/services/payout-loot.ts) and
 * `setRoster` above — inside the ONE transaction the caller opened.
 *
 * Two things this deliberately does NOT do:
 *
 *   1. Appraise the loot itself. `appraisal` here is already-priced data — the
 *      network call to triff/ESI is a caller concern (`createOperationAction`)
 *      and must happen BEFORE this transaction opens, exactly like
 *      `addAppraisedPoolAction` already does for the detail-page path: an
 *      external call inside an open transaction holds the row lock (once
 *      taken below) for however long that call takes, and a slow or hung
 *      upstream would then block every other reader/writer of this operation
 *      for no reason.
 *   2. Collapse the audit trail. `payout.created`, `payout.pool_added` and
 *      `payout.roster_set` each fire from the function that owns that fact,
 *      the same three rows a three-click create-then-fill-in-later flow would
 *      have produced. One paste, one submit, but the log still reads as three
 *      distinct state changes, because it is three distinct state changes.
 *
 * The trailing `recalculate` is not redundant bookkeeping removed by
 * inlining: `addAppraisedPool` and `setRoster` each already recalculate after
 * their own write, so with both present the split is computed twice — set (0
 * participants against the fresh pool) then correct once wrestled. Kept
 * anyway, unconditionally, so the split is always correct regardless of which
 * of the two optional inputs is present, without this function having to
 * reason about which combination the caller passed.
 */
export async function createOperationWithContents(
  dbtx: DbTx,
  actor: string,
  input: {
    name: string;
    occurredAt: Date;
    battleReportUrl?: string | null;
    corpSharePct?: string;
    appraisal?: {
      rawPaste: string;
      pricingMode: PricingMode;
      stationId: number | null;
      regionId: number | null;
      appraisal: AppraisalResult;
    };
    rosterEntries?: RosterEntry[];
  },
): Promise<{ id: string }> {
  const { id } = await createOperation(dbtx, actor, {
    name: input.name,
    occurredAt: input.occurredAt,
    battleReportUrl: input.battleReportUrl,
    corpSharePct: input.corpSharePct,
  });
  if (input.appraisal) {
    await addAppraisedPool(dbtx, actor, id, input.appraisal);
  }
  if (input.rosterEntries) {
    await setRoster(dbtx, actor, id, input.rosterEntries);
  }
  await recalculate(dbtx, id);
  return { id };
}

/**
 * The corp share was previously set once at creation and never again: an
 * operator who left the field at its default committed every participant to a
 * 0% corp share, with no way back at all — there is no route to delete a
 * payout operation, only a loot pool within one, so nothing could undo the
 * mistake. This is the correction path.
 *
 * Same gate as every other edit — `assertEditable`, holding the row lock — and
 * it recalculates, because the percentage is an input to `computeSplit` and
 * changing it changes every participant's amount. Audited as a distinct action
 * rather than folded into `payout.created`, since "the split moved after the
 * roster saw it" is exactly the kind of thing the log exists to answer.
 */
export async function setCorpSharePct(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  corpSharePct: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutOperation)
    .set({ corpSharePct })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, {
    actor,
    action: "payout.corp_share_changed",
    // The operation uuid, never a sub-object id: audit.ts resolves every
    // `payout.*` target against payoutOperation, so anything else renders
    // as unresolved. Sub-object identity goes in `details`.
    target: operationId,
    details: { corpSharePct },
  });
  await recalculate(dbtx, operationId);
}

/**
 * Four separate editors for the fields the create form no longer collects up
 * front (name/date) plus the two that were always freeform (report link,
 * notes) — one function per field, matching `setParticipantShares` /
 * `setParticipantExcluded`'s split rather than one combined setter, so each
 * inline editor on the detail page saves independently and the audit log
 * keeps one action per actual fact changed instead of a single
 * "something about this operation changed" bucket.
 *
 * Same gate as `setCorpSharePct` -- `assertEditable`, holding the row lock --
 * but none of these feed `computeSplit`, so none of them recalculate.
 */
export async function setOperationName(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  name: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutOperation)
    .set({ name })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, {
    actor,
    action: "payout.name_changed",
    target: operationId,
    details: { name },
  });
}

export async function setOccurredAt(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  occurredAt: Date,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutOperation)
    .set({ occurredAt })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, {
    actor,
    action: "payout.occurred_at_changed",
    target: operationId,
    // yyyy-mm-dd, the same convention every occurredAt render already uses
    // (src/app/payouts/[id]/page.tsx, account-payouts.tsx) -- a full
    // timestamp would just be truncated back to this on the page anyway.
    details: { occurredAt: occurredAt.toISOString().slice(0, 10) },
  });
}

export async function setBattleReportUrl(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  battleReportUrl: string | null,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutOperation)
    .set({ battleReportUrl })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, {
    actor,
    action: "payout.battle_report_changed",
    target: operationId,
    details: { battleReportUrl },
  });
}

export async function setNotes(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  notes: string | null,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const op = await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutOperation)
    .set({ notes })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, {
    actor,
    action: "payout.notes_changed",
    target: operationId,
    // had/has, not the text itself -- the same choice status.note_changed
    // already made (summarize.ts's noteChange): the note lives on the
    // operation where it is current, not frozen into the log at write time.
    details: { had: Boolean(op.notes), has: Boolean(notes) },
  });
}

export type RosterEntry = {
  displayName: string;
  accountId: string | null;
  recipientCharacterId: number | null;
  sourceCharacters: string[];
  shares: string;
  excluded: boolean;
};

/**
 * name -> character -> account -> account.mainCharacterId. Alts of one
 * account collapse into ONE entry, keyed by accountId at first appearance in
 * paste order; every pasted name that mapped to it is appended to
 * sourceCharacters in the order it was seen. A name that resolves to no
 * character becomes its own entry with accountId/recipientCharacterId null —
 * unresolved names are NOT deduped against each other, since two independent
 * paste typos happening to match is not evidence they're the same person.
 */
export async function resolveRosterNames(
  dbx: Dbx,
  names: string[],
): Promise<RosterEntry[]> {
  if (names.length === 0) return [];

  const lowerNames = names.map((n) => n.toLowerCase());
  const chars = await dbx
    .select({ id: character.id, name: character.name, accountId: character.accountId })
    .from(character)
    .where(inArray(sql`lower(${character.name})`, lowerNames));
  const charByLowerName = new Map(chars.map((c) => [c.name.toLowerCase(), c]));

  const accountIds = [...new Set(chars.map((c) => c.accountId))];
  const accounts = accountIds.length
    ? await dbx
        .select({ id: account.id, mainCharacterId: account.mainCharacterId })
        .from(account)
        .where(inArray(account.id, accountIds))
    : [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const mainCharacterIds = [
    ...new Set(
      accounts.map((a) => a.mainCharacterId).filter((id): id is number => id !== null),
    ),
  ];
  const mainChars = mainCharacterIds.length
    ? await dbx
        .select({ id: character.id, name: character.name })
        .from(character)
        .where(inArray(character.id, mainCharacterIds))
    : [];
  const mainNameById = new Map(mainChars.map((c) => [c.id, c.name]));

  const entries: RosterEntry[] = [];
  const entryByAccountId = new Map<string, RosterEntry>();
  for (const raw of names) {
    const ch = charByLowerName.get(raw.toLowerCase());
    if (!ch) {
      entries.push({
        displayName: raw,
        accountId: null,
        recipientCharacterId: null,
        sourceCharacters: [raw],
        shares: "1",
        excluded: false,
      });
      continue;
    }
    const existing = entryByAccountId.get(ch.accountId);
    if (existing) {
      existing.sourceCharacters.push(raw);
      continue;
    }
    const acc = accountById.get(ch.accountId);
    const mainCharacterId = acc?.mainCharacterId ?? null;
    const displayName =
      (mainCharacterId !== null ? mainNameById.get(mainCharacterId) : undefined) ??
      ch.name;
    const entry: RosterEntry = {
      displayName,
      accountId: ch.accountId,
      recipientCharacterId: mainCharacterId ?? ch.id,
      sourceCharacters: [raw],
      shares: "1",
      excluded: false,
    };
    entryByAccountId.set(ch.accountId, entry);
    entries.push(entry);
  }
  return entries;
}

export async function setRoster(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  entries: RosterEntry[],
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .delete(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  if (entries.length > 0) {
    await dbtx.insert(payoutParticipant).values(
      entries.map((e) => ({
        operationId,
        accountId: e.accountId,
        recipientCharacterId: e.recipientCharacterId,
        displayName: e.displayName,
        sourceCharacters: e.sourceCharacters,
        shares: e.shares,
        excluded: e.excluded,
      })),
    );
  }
  await logAudit(dbtx, {
    actor,
    action: "payout.roster_set",
    target: operationId,
    details: { count: entries.length },
  });
  await recalculate(dbtx, operationId);
}

/**
 * Manual roster entry, one name at a time. Additive by necessity: `setRoster`
 * deletes the whole roster and reinserts it, which would discard every share
 * edit already made, so adding one person cannot go through it.
 *
 * The name goes through `resolveRosterNames` so alt-collapsing and main-naming
 * behave identically to the paste path — the difference is only that the
 * collapse is against rows already in the table rather than within one paste.
 */
export async function addParticipant(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  name: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  const [entry] = await resolveRosterNames(dbtx, [name]);
  if (!entry) throw new Error("a character name is required");

  const existing = await dbtx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  const twin =
    entry.accountId !== null
      ? existing.find((p) => p.accountId === entry.accountId)
      : undefined;

  if (twin) {
    // Same human, different character. Record the spelling that was typed and
    // leave the share count alone — a second row here is a second full share.
    const alreadyListed = twin.sourceCharacters.some(
      (c) => c.toLowerCase() === name.toLowerCase(),
    );
    if (!alreadyListed) {
      await dbtx
        .update(payoutParticipant)
        .set({ sourceCharacters: [...twin.sourceCharacters, name] })
        .where(eq(payoutParticipant.id, twin.id));
    }
    await logAudit(dbtx, {
      actor,
      action: "payout.participant_added",
      target: operationId,
      details: { participantId: twin.id, name, collapsedInto: twin.displayName },
    });
  } else {
    if (entry.accountId === null) {
      // Two unresolved rows sharing a name are two full shares going out under
      // one name, and nothing downstream can tell them apart. The detail page
      // has warned about this since phase 1 but could not prevent it, because
      // the paste path is itself deduped — manual entry is what makes the case
      // reachable, so manual entry is where it gets refused. The page warning
      // stays as a backstop for rosters written before this guard existed.
      const clash = existing.find(
        (p) =>
          p.accountId === null &&
          p.displayName.toLowerCase() === entry.displayName.toLowerCase(),
      );
      if (clash) {
        throw new PayoutDuplicateParticipantError(
          `"${clash.displayName}" is already on this roster`,
        );
      }
    }
    const [inserted] = await dbtx
      .insert(payoutParticipant)
      .values({
        operationId,
        accountId: entry.accountId,
        recipientCharacterId: entry.recipientCharacterId,
        displayName: entry.displayName,
        sourceCharacters: entry.sourceCharacters,
        shares: entry.shares,
        excluded: entry.excluded,
      })
      .returning();
    await logAudit(dbtx, {
      actor,
      action: "payout.participant_added",
      target: operationId,
      details: { participantId: inserted.id, name, displayName: entry.displayName },
    });
  }
  await recalculate(dbtx, operationId);
}

async function loadParticipantOperationId(
  dbtx: DbTx,
  participantId: string,
): Promise<string> {
  const [p] = await dbtx
    .select({ operationId: payoutParticipant.operationId })
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!p) throw new PayoutNotFoundError("participant not found");
  return p.operationId;
}

/**
 * `payout_participant.shares` is `numeric(6, 2)`, so 9999.99 is the largest
 * value the column holds and anything above it dies as a raw Postgres numeric
 * overflow. Mirrored here as a readable message, the same way `addFlatPool`
 * mirrors `loot_pool_total_ck` and `createOperationAction` mirrors
 * `payout_operation_corp_share_pct_ck`.
 *
 * Deliberately NOT a column widening: widening would mean a migration against
 * production data purely to improve an error message, and nobody in a fleet
 * draws ten thousand shares.
 *
 * Exported, unlike a plain module constant, because `setParticipantSharesAction`
 * bounds against the same number to produce a redirect instead of a throw. One
 * constant, two enforcement points, no drift.
 */
export const MAX_SHARES_HUNDREDTHS = 999999n; // 9999.99, in iskToCents' hundredths

export function assertSharesInRange(shares: string): void {
  const hundredths = iskToCents(shares); // also rejects "abc" / "1e5" outright
  if (hundredths <= 0n) throw new Error("shares must be a positive number");
  if (hundredths > MAX_SHARES_HUNDREDTHS) {
    throw new Error("shares cannot exceed 9999.99");
  }
}

export async function setParticipantShares(
  dbtx: DbTx,
  actor: string,
  participantId: string,
  shares: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  assertSharesInRange(shares);
  const operationId = await loadParticipantOperationId(dbtx, participantId);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutParticipant)
    .set({ shares })
    .where(eq(payoutParticipant.id, participantId));
  await logAudit(dbtx, {
    actor,
    action: "payout.participant_updated",
    target: operationId,
    details: { participantId, shares },
  });
  await recalculate(dbtx, operationId);
}

export async function setParticipantExcluded(
  dbtx: DbTx,
  actor: string,
  participantId: string,
  excluded: boolean,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const operationId = await loadParticipantOperationId(dbtx, participantId);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx
    .update(payoutParticipant)
    .set({ excluded })
    .where(eq(payoutParticipant.id, participantId));
  await logAudit(dbtx, {
    actor,
    action: "payout.participant_updated",
    target: operationId,
    details: { participantId, excluded },
  });
  await recalculate(dbtx, operationId);
}

export async function removeParticipant(
  dbtx: DbTx,
  actor: string,
  participantId: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const operationId = await loadParticipantOperationId(dbtx, participantId);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  await dbtx.delete(payoutParticipant).where(eq(payoutParticipant.id, participantId));
  await logAudit(dbtx, {
    actor,
    action: "payout.participant_removed",
    target: operationId,
    details: { participantId },
  });
  await recalculate(dbtx, operationId);
}

/**
 * Sums loot_pool.totalValue, runs computeSplit, UPDATEs payout_participant.amount
 * ONLY. Never touches paidAmount, never deletes anything: a recalculation must
 * never disturb money that has already moved. Deliberately takes no `actor`
 * (contract signature) and writes no audit row of its own; every caller above
 * already logged its own actor-attributed action before calling this.
 */
export async function recalculate(dbtx: DbTx, operationId: string): Promise<void> {
  const op = await lockOperation(dbtx, operationId);
  const pools = await dbtx
    .select({ totalValue: lootPool.totalValue })
    .from(lootPool)
    .where(eq(lootPool.operationId, operationId));
  const totalCents = pools.reduce((sum, p) => sum + iskToCents(p.totalValue), 0n);

  const participants = await dbtx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));

  const split = computeSplit({
    totalCents,
    corpSharePct: op.corpSharePct,
    participants: participants.map((p) => ({
      id: p.id,
      shares: p.shares,
      excluded: p.excluded,
    })),
  });

  for (const p of participants) {
    const cents = p.excluded ? 0n : (split.amounts.get(p.id) ?? 0n);
    await dbtx
      .update(payoutParticipant)
      .set({ amount: centsToIsk(cents) })
      .where(eq(payoutParticipant.id, p.id));
  }
}

export async function finalizeOperation(
  dbtx: DbTx,
  actor: string,
  operationId: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const op = await lockOperation(dbtx, operationId);
  if (op.status === "finalized") return; // idempotent
  await dbtx
    .update(payoutOperation)
    .set({ status: "finalized" })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, { actor, action: "payout.finalized", target: operationId });
}

/** Unlock (finalized -> draft) exists to correct an UNPAID operation; once any
 * payment exists there is no unlock. Restricted to the operation's `createdBy`
 * or an admin: unlock reopens a commitment someone else made, so it is not a
 * thing any operator should be able to do to any other operator's numbers. */
export async function unlockOperation(
  dbtx: DbTx,
  actor: string,
  operationId: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const op = await lockOperation(dbtx, operationId);
  if (op.status === "draft") return; // idempotent
  if (op.createdBy !== actor) {
    const [acc] = await dbtx
      .select({ isAdmin: account.isAdmin })
      .from(account)
      .where(eq(account.id, actor));
    if (!acc?.isAdmin) {
      throw new PayoutForbiddenError(
        "only the operation's creator or an admin may unlock it",
      );
    }
  }
  if (await hasPayments(dbtx, operationId)) {
    throw new PayoutLockedError("operation has a payment and cannot be unlocked");
  }
  await dbtx
    .update(payoutOperation)
    .set({ status: "draft" })
    .where(eq(payoutOperation.id, operationId));
  await logAudit(dbtx, { actor, action: "payout.unlocked", target: operationId });
}

/**
 * The `at` to stamp on this participant's next `payout_payment` row.
 *
 * `clock_timestamp()` on its own is not monotonic. It repeats at the clock's
 * resolution, and an NTP correction can step it backwards; either way two rows
 * can tie or invert, and `(at asc, id asc)` then breaks the tie on
 * `defaultRandom()` — arbitrarily, not causally. So the reading is clamped
 * forward past this participant's latest row, which makes `at` STRICTLY
 * increasing per participant.
 *
 * The subquery is safe because every writer of this table holds
 * `lockOperation`'s `SELECT … FOR UPDATE` on the parent operation and a
 * participant belongs to exactly one operation, so "the latest row for this
 * participant" cannot change under us. Scoped to the PARTICIPANT rather than
 * the operation on purpose: per-participant is the history the detail page
 * renders, and it is the property that has to hold.
 *
 * The accepted cost, stated rather than hidden: under a backwards clock step
 * `at` reads later than the true wall clock until the clock catches up. A
 * human reading a pay -> revert -> pay history is reconstructing ORDER, not
 * the instant, so a possibly-inaccurate instant is the better trade than an
 * inverted sequence. Ties at clock resolution — far likelier than an NTP step
 * — are fixed outright, and distort nothing beyond one microsecond.
 *
 * No migration and no column: `payout_payment.at` keeps its `defaultNow()`,
 * these two writers simply do not use it.
 */
function nextPaymentAt(participantId: string) {
  return sql`greatest(
    clock_timestamp(),
    coalesce(
      (select max(${payoutPayment.at}) from ${payoutPayment}
        where ${payoutPayment.participantId} = ${participantId}),
      'epoch'::timestamptz
    ) + interval '1 microsecond'
  )`;
}

export async function recordPayment(
  dbtx: DbTx,
  actor: string,
  participantId: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  // Read ONLY the operation id here. Every field this function decides on --
  // paidAmount above all -- must be read *after* the operation row lock, or two
  // concurrent "mark paid" clicks both observe paidAmount = null before either
  // takes the lock, then both proceed to insert once serialized. Locking first
  // and re-reading is what makes the idempotence check below actually hold.
  const [ref] = await dbtx
    .select({ operationId: payoutParticipant.operationId })
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!ref) throw new PayoutNotFoundError("participant not found");
  const op = await lockOperation(dbtx, ref.operationId);
  if (op.status !== "finalized") {
    throw new PayoutLockedError("operation must be finalized before paying");
  }
  const [participant] = await dbtx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!participant) throw new PayoutNotFoundError("participant not found");
  if (participant.excluded) {
    // Excluded participants carry amount = "0.00"; recording a payment for one
    // would still insert a payout_payment row, making hasPayments() true and
    // freezing the operation permanently (assertEditable and unlockOperation
    // both refuse forever once any payment exists).
    throw new PayoutLockedError("participant is excluded and cannot be paid");
  }
  if (participant.paidAmount !== null) return; // already paid: idempotent, no duplicate event
  await dbtx
    .update(payoutParticipant)
    .set({ paidAmount: participant.amount })
    .where(eq(payoutParticipant.id, participantId));
  await dbtx.insert(payoutPayment).values({
    participantId,
    kind: "paid",
    amount: participant.amount,
    actor,
    // NOT the column's defaultNow(): now() is TRANSACTION START time, so a
    // transaction that started earlier can take the operation lock later and
    // stamp an earlier time than an event that already happened. This reading
    // is taken after lockOperation, which every writer of this table holds,
    // and clamped past this participant's latest row. See nextPaymentAt above
    // and the phase-2 design, "Derived payment state".
    at: nextPaymentAt(participantId),
  });
  await logAudit(dbtx, {
    actor,
    action: "payout.paid",
    target: op.id,
    details: { participantId, amount: participant.amount },
  });
}

/**
 * The one place `paidAmount` is not immutable. Phase 1 called it immutable to
 * stop *recalculation* rewriting what was paid, and that still holds absolutely
 * — `recalculate` writes only `amount`. A revert is the deliberate, audited
 * case where "what was paid" genuinely changed, because it turned out nobody
 * was paid.
 *
 * Deliberately does NOT call `assertEditable`. A revert is not an edit, and the
 * gate would make it impossible: the first payment freezes the operation
 * permanently, so every participant who could ever need reverting is behind it.
 * Reverting does not lift that freeze either — `hasPayments` counts rows of any
 * kind, so loot, shares and corpSharePct stay frozen forever once money moved.
 * "I marked the wrong person paid" is fully served by reverting one participant
 * and paying another, both of which work while frozen.
 */
export async function revertPayment(
  dbtx: DbTx,
  actor: string,
  participantId: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  // Read ONLY the operation id before the lock, for the same reason
  // recordPayment does: `status` and `paidAmount` are what this decides on, and
  // two concurrent reverts that both read paidAmount first would both see it
  // set and both append a `reverted` row for one payment.
  const [ref] = await dbtx
    .select({ operationId: payoutParticipant.operationId })
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!ref) throw new PayoutNotFoundError("participant not found");
  const op = await lockOperation(dbtx, ref.operationId);
  if (op.status !== "finalized") {
    throw new PayoutLockedError("operation must be finalized to revert a payment");
  }
  const [participant] = await dbtx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!participant) throw new PayoutNotFoundError("participant not found");
  if (participant.paidAmount === null) {
    throw new PayoutLockedError("participant is not marked paid; nothing to revert");
  }
  const amount = participant.paidAmount;
  await dbtx
    .update(payoutParticipant)
    .set({ paidAmount: null })
    .where(eq(payoutParticipant.id, participantId));
  await dbtx.insert(payoutPayment).values({
    participantId,
    kind: "reverted",
    amount,
    // The SAME stamp recordPayment uses, and it has to be: a revert that keeps
    // the column's defaultNow() lands on transaction-start time and can sort
    // before the payment it reverts, and a bare clock_timestamp() can tie with
    // it at clock resolution. nextPaymentAt clamps past this participant's
    // latest row, so pay -> revert -> pay is strictly increasing.
    at: nextPaymentAt(participantId),
    actor,
  });
  await logAudit(dbtx, {
    actor,
    action: "payout.payment_reverted",
    target: op.id,
    details: { participantId, amount },
  });
}

/**
 * Deletes an operation and everything that hangs off it — every child table
 * (loot_pool, loot_item, payout_participant, payout_payment) cascades on
 * `operation_id` / `pool_id` / `participant_id` (schema.ts:244, :275, :297,
 * :324), so a single row delete is the whole tree; no migration needed.
 *
 * Deletable when NO participant currently carries a `paidAmount` — deliberately
 * not `hasPayments` (above), which counts `payout_payment` rows of any `kind`
 * including `reverted`. A finalized operation whose entire roster was paid and
 * then reverted has `hasPayments() === true` forever (reverting does not lift
 * the payment freeze — see `revertPayment`'s doc), which would make it
 * permanently undeletable even though nobody is currently owed a cent. Status
 * is irrelevant to this predicate for the same reason: a finalized operation
 * with a fully-reverted roster IS deletable.
 *
 * Authorization is re-checked here, not left to the caller: `requirePayoutOperator`
 * (the standard mutation gate) AND `account.isAdmin`, since destroying an
 * operation outright is a step beyond anything an ordinary operator mutation
 * does. `src/app/payouts/access.ts` states the rule this follows -- every
 * mutation re-checks itself.
 */
export async function deleteOperation(
  dbx: Dbx,
  actor: string,
  operationId: string,
): Promise<void> {
  await dbx.transaction(async (dbtx) => {
    await requirePayoutOperator(dbtx, actor);
    const [acc] = await dbtx.select().from(account).where(eq(account.id, actor));
    if (!acc?.isAdmin) {
      throw new PayoutForbiddenError("only an admin may delete a payout operation");
    }

    const op = await lockOperation(dbtx, operationId);

    const participants = await dbtx
      .select({
        paidAmount: payoutParticipant.paidAmount,
        excluded: payoutParticipant.excluded,
      })
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    if (participants.some((p) => p.paidAmount !== null)) {
      throw new PayoutHasPaidError(
        "operation has a currently-paid participant and cannot be deleted",
      );
    }

    // Read what the audit row needs to say BEFORE the delete removes the rows
    // it would otherwise join against. `participantCount` is the true roster
    // size that cascade-delete is about to destroy -- this audit row is the
    // only surviving evidence of that, so it states what was actually
    // destroyed, not who would have been paid. `payableCount` (excluding
    // rows nobody was ever going to pay) is kept alongside it because it
    // is still useful context, the same figure payout-view.ts's list page
    // shows, just never the headline.
    const pools = await dbtx
      .select({ totalValue: lootPool.totalValue })
      .from(lootPool)
      .where(eq(lootPool.operationId, operationId));
    const totalCents = pools.reduce((sum, p) => sum + iskToCents(p.totalValue), 0n);
    const participantCount = participants.length;
    const payableCount = participants.filter((p) => !p.excluded).length;

    await dbtx.delete(payoutOperation).where(eq(payoutOperation.id, operationId));

    await logAudit(dbtx, {
      actor,
      action: "payout.deleted",
      target: operationId,
      details: {
        name: op.name,
        occurredAt: op.occurredAt.toISOString().slice(0, 10),
        participantCount,
        payableCount,
        totalValue: centsToIsk(totalCents),
      },
    });
  });
}

/**
 * Resolves the character whose in-game information window an operator may open
 * for `participantId`, re-reading every condition server-side.
 *
 * Both ids arrive from a bound form action, so neither is trusted. Four
 * conditions, and the last one is the point: the ESI target is the STORED
 * `recipientCharacterId`, never a value the caller supplied, so a hand-made
 * request cannot aim the operator's own token at an arbitrary character.
 *
 *   1. the participant must belong to THIS operation — otherwise the operation
 *      id is decoration and any participant id in the database would work;
 *   2. the operation must be `finalized` — open-info is a payment-time control
 *      and the page only renders it then;
 *   3. the participant must not be excluded — they are owed nothing, so there
 *      is no one to pay and nothing to look up;
 *   4. the row must carry a recipient — an unresolved roster name has no
 *      character to open.
 *
 * Returns null rather than throwing for all four: every one of them is a stale
 * page away, and the action turns null into a message.
 *
 * No `lockOperation` here, deliberately: this reads state to decide whether to
 * make an external call that persists nothing. There is no write to serialize
 * against, and taking a row lock for a window-opening request would put `FOR
 * UPDATE` contention on the payout path for no gain.
 *
 * Takes no `actor` and calls no operator guard: the operator check is the
 * caller's job (`openInfoAction` calls `requireOperatorAccount` first), so any
 * future second caller must add its own gate rather than rely on this one.
 */
export async function getOpenInfoTarget(
  dbx: Dbx,
  operationId: string,
  participantId: string,
): Promise<number | null> {
  const [row] = await dbx
    .select({
      recipientCharacterId: payoutParticipant.recipientCharacterId,
      excluded: payoutParticipant.excluded,
      status: payoutOperation.status,
    })
    .from(payoutParticipant)
    .innerJoin(payoutOperation, eq(payoutOperation.id, payoutParticipant.operationId))
    .where(
      and(
        eq(payoutParticipant.id, participantId),
        eq(payoutParticipant.operationId, operationId),
      ),
    );
  if (!row || row.status !== "finalized" || row.excluded) return null;
  return row.recipientCharacterId;
}
