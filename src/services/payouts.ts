import { eq, inArray, sql } from "drizzle-orm";
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

export class PayoutForbiddenError extends Error {}
export class PayoutLockedError extends Error {}
/** The operation or participant an operation was asked to act on does not
 *  exist. Distinguishable by callers from a programming error, the same way
 *  PayoutForbiddenError and PayoutLockedError already are. */
export class PayoutNotFoundError extends Error {}

/**
 * `getSessionAccount` (src/services/session.ts) resolves a session to an
 * accountId and deliberately checks neither tier nor status — every existing
 * caller that needs more does its own lookup. This is that lookup for
 * payouts: a cryo account (this project's representation of someone who has
 * stepped away) must not be able to move alliance ISK, even with a perfectly
 * valid session, and neither can anyone below flygd.
 */
export async function requirePayoutOperator(dbx: Dbx, accountId: string): Promise<void> {
  const [acc] = await dbx.select().from(account).where(eq(account.id, accountId));
  if (!acc || acc.tier !== "flygd" || acc.status !== "active") {
    throw new PayoutForbiddenError("payout mutation requires an active flygd account");
  }
}

/** Reading is far less restrictive than mutating: any flygd member, any status. */
export async function canReadPayouts(dbx: Dbx, accountId: string): Promise<boolean> {
  const [acc] = await dbx.select().from(account).where(eq(account.id, accountId));
  return acc?.tier === "flygd";
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
 *   1. status must be `draft`. Finalization is a commitment ("Lifecycle" in the
 *      design doc) — if a finalized operation stayed editable, finalizing would
 *      mean nothing and `unlockOperation` would have no purpose. Correcting a
 *      finalized operation is legal, but it goes through an audited unlock.
 *   2. no payment may exist. This outlives the status check, because unlock is
 *      itself refused once money has moved — mechanism 3 in "Recalculation
 *      safety". Checking it here as well means no path can reach an edit.
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
    corpSharePct: string;
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
      corpSharePct: input.corpSharePct,
      notes: input.notes ?? null,
      createdBy: actor,
    })
    .returning();
  await logAudit(dbtx, { actor, action: "payout.created", target: op.id });
  return { id: op.id };
}

/**
 * The corp share was previously set once at creation and never again: an
 * operator who left the field at its default committed every participant to a
 * 0% corp share, with no way back short of deleting the operation and rebuilding
 * it. This is the correction path.
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

export async function setParticipantShares(
  dbtx: DbTx,
  actor: string,
  participantId: string,
  shares: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
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
 * ONLY. Never touches paidAmount, never deletes anything — see "Recalculation
 * safety" in the design doc. Deliberately takes no `actor` (contract signature)
 * and writes no audit row of its own; every caller above already logged its own
 * actor-attributed action before calling this.
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
 * payment exists there is no unlock, per "Recalculation safety" mechanism 3.
 * Restricted to the operation's `createdBy` or an admin ("Lifecycle" in the
 * design doc): unlock reopens a commitment someone else made, so it is not a
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
