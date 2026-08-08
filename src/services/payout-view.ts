import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import {
  account,
  character,
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
} from "@/db/schema";
import { hasPayments } from "@/services/payouts";
import { centsToIsk, iskToCents } from "@/core/payout-split";

export type PayoutOperationSummary = {
  id: string;
  name: string;
  occurredAt: Date;
  status: "draft" | "finalized";
  totalValue: string;
  participantCount: number;
  paidCount: number;
  /**
   * The viewer's own state on this operation — walkthrough finding 2.1, "the
   * list cannot answer 'was I paid?'". Present only when `viewerAccountId` was
   * passed to `listPayoutOperations`; absent (not `undefined`-valued, the key
   * itself is missing) otherwise, so a caller that never asked for it doesn't
   * see a field it must remember to ignore.
   *
   * Deliberately a STATE, never an amount. `listAccountPayouts` below is
   * finalized-only for exactly the reason documented there: `recalculate`
   * rewrites a draft's `amount` on every roster or pool edit, so an amount
   * shown mid-draft states a commitment the operation hasn't made. A state
   * ("paid"/"unpaid") carries no such commitment and is honest at any status,
   * which is why this field has no ISK figure beside it.
   *
   * Inherits the same known limitation as `listAccountPayouts`: a participant
   * whose name never resolved has `accountId = NULL` and cannot be matched to
   * any viewer (see the KNOWN LIMITATION paragraph on `listAccountPayouts`
   * below — named rather than cited by line, since the line moved once
   * already).
   */
  viewerState?: "paid" | "unpaid" | "excluded" | "absent";
};

export const PAYOUTS_PAGE_SIZE = 50;

/**
 * Composite by necessity. `occurredAt` is not unique and `payoutOperation.id`
 * is a random uuid, so neither column alone can resume a scan: a bare
 * timestamp cursor pages past every operation that shares a date with the last
 * row of the previous page. `auditLog`'s monotonic serial needs no such pair.
 */
export type PayoutListCursor = { occurredAt: Date; id: string };

export type PayoutListPage = {
  operations: PayoutOperationSummary[];
  /** Non-null exactly when a further page exists — derived by reading one row
   *  past the limit, so no COUNT(*) over the whole table is issued to answer
   *  "is there an Older button". */
  nextCursor: PayoutListCursor | null;
};

const CURSOR_SEPARATOR = "|";
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function encodePayoutCursor(cursor: PayoutListCursor): string {
  return `${cursor.occurredAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`;
}

/**
 * Defensive by contract: `before` arrives from a URL anyone can hand-edit, and
 * an unparseable date or a non-uuid tiebreak would otherwise reach Postgres as
 * an invalid comparison and take the list page down. Anything it cannot read
 * means "start from the top".
 */
export function decodePayoutCursor(
  raw: string | undefined,
): PayoutListCursor | undefined {
  if (!raw) return undefined;
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 2) return undefined;
  const [iso, id] = parts;
  if (!UUID_RE.test(id)) return undefined;
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime())) return undefined;
  return { occurredAt, id };
}

// `%`, `_` and the escape character itself, escaped so a user typing a literal
// percent sign (e.g. searching for a fleet named "100% Isk") gets a substring
// match rather than a wildcard. `ILIKE ... ESCAPE '\'` (below) is what makes
// the backslash here mean "escape", not "literal backslash".
function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * One row per operation for the /payouts list. Reads only — the list page has
 * nothing to protect, unlike setRoster/addAppraisedPool/etc, which is why this
 * lives outside the guarded service in src/services/payouts.ts.
 *
 * Three queries, all bounded. The child queries are scoped to this page's ids;
 * there is no payment query, because a participant's `paidAmount` already
 * answers what it used to be consulted for.
 */
export async function listPayoutOperations(
  dbx: Dbx,
  opts: {
    before?: PayoutListCursor;
    limit?: number;
    /** Collapses this account's own participant rows into one viewerState per
     *  operation on the returned summary. See PayoutOperationSummary.viewerState. */
    viewerAccountId?: string;
    /** Operation-name substring match, case-insensitive. Trimmed; an
     *  empty/whitespace-only value means no filter. */
    q?: string;
    status?: "draft" | "finalized";
  } = {},
): Promise<PayoutListPage> {
  const limit = Math.min(opts.limit ?? PAYOUTS_PAGE_SIZE, PAYOUTS_PAGE_SIZE);
  const before = opts.before;
  const trimmedQ = opts.q?.trim();

  // Every filter ANDs onto the cursor predicate rather than replacing it, so
  // keyset paging keeps working within the narrowed set — the correctness
  // rule the walkthrough doc pre-wrote at payouts/page.tsx:222-225 ("a filter
  // must DROP `before`") is about the caller resetting `before` to undefined
  // on a fresh filter, not about this query; here cursor and filters compose.
  const conditions = [];
  if (before) {
    conditions.push(
      or(
        lt(payoutOperation.occurredAt, before.occurredAt),
        and(
          eq(payoutOperation.occurredAt, before.occurredAt),
          lt(payoutOperation.id, before.id),
        ),
      ),
    );
  }
  if (opts.status) {
    conditions.push(eq(payoutOperation.status, opts.status));
  }
  if (trimmedQ) {
    // Explicit ESCAPE clause, not the bare `ilike` helper: drizzle's `ilike`
    // has no way to say "% and _ in this pattern are literal", so a search for
    // an operation literally named "100%" would otherwise match everything.
    const pattern = `%${escapeLikePattern(trimmedQ)}%`;
    conditions.push(sql`${payoutOperation.name} ILIKE ${pattern} ESCAPE '\\'`);
  }

  // Explicit column lists, not `select()`. A bare select on loot_pool drags
  // every operation's `raw_paste` — an entire pasted inventory window, per
  // pool — across the wire to compute one sum. Nothing below reads a column
  // that is not named here.
  //
  // One row past the limit: its presence is the "there is more" signal, and
  // the row itself is trimmed before anything downstream sees it.
  //
  // Deliberately unindexed: `docs/design-walkthrough.md` scopes this page at
  // roughly two hundred rows for this session, a migration is out of scope,
  // and the existing `(occurredAt desc, id desc)` ordering above is already
  // an unindexed sequential scan at this size. Filtering doesn't change that
  // budget.
  const page = await dbx
    .select({
      id: payoutOperation.id,
      name: payoutOperation.name,
      occurredAt: payoutOperation.occurredAt,
      status: payoutOperation.status,
    })
    .from(payoutOperation)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(payoutOperation.occurredAt), desc(payoutOperation.id))
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const ops = hasMore ? page.slice(0, limit) : page;
  const pageIds = ops.map((o) => o.id);

  type PoolRow = { operationId: string; totalValue: string };
  type ParticipantRow = {
    id: string;
    operationId: string;
    excluded: boolean;
    paidAmount: string | null;
    accountId: string | null;
  };
  const [pools, participants]: [PoolRow[], ParticipantRow[]] = pageIds.length
    ? await Promise.all([
        dbx
          .select({ operationId: lootPool.operationId, totalValue: lootPool.totalValue })
          .from(lootPool)
          .where(inArray(lootPool.operationId, pageIds)),
        dbx
          .select({
            id: payoutParticipant.id,
            operationId: payoutParticipant.operationId,
            excluded: payoutParticipant.excluded,
            paidAmount: payoutParticipant.paidAmount,
            // Added for viewerState (finding 2.1), NOT as a `where` on this
            // query: this same result also feeds participantCount/paidCount
            // below, so filtering these rows to one account would empty the
            // existing counts for everyone else. One extra column, computed
            // over in memory, keeps both readers of this query intact.
            accountId: payoutParticipant.accountId,
          })
          .from(payoutParticipant)
          .where(inArray(payoutParticipant.operationId, pageIds)),
      ])
    : [[], []];

  // bigint cents, not Number: numeric(20,2) holds values far past 2^53, and the
  // "no floats" constraint is not relaxed just because this is the read side.
  const totalByOp = new Map<string, bigint>();
  for (const p of pools) {
    totalByOp.set(
      p.operationId,
      (totalByOp.get(p.operationId) ?? 0n) + iskToCents(p.totalValue),
    );
  }
  const participantsByOp = new Map<string, ParticipantRow[]>();
  for (const p of participants) {
    const list = participantsByOp.get(p.operationId) ?? [];
    list.push(p);
    participantsByOp.set(p.operationId, list);
  }

  const operations = ops.map((op) => {
    // Excluded rows are not owed anything and are not part of "how many have
    // been paid" — an all-excluded roster reading as 0/0 rather than 0/N.
    const owed = (participantsByOp.get(op.id) ?? []).filter((p) => !p.excluded);

    // Same collapse rule account-payouts.tsx already relies on for the /account
    // history table (one row per operation, even though an account can hold
    // more than one participant row there — two of the viewer's characters in
    // one fleet). `viewerAccountId` is undefined for every caller that didn't
    // ask for it, in which case `viewerState` stays undefined and the key is
    // dropped from the returned object entirely, below.
    let viewerState: PayoutOperationSummary["viewerState"];
    if (opts.viewerAccountId) {
      const viewerRows = (participantsByOp.get(op.id) ?? []).filter(
        (p) => p.accountId === opts.viewerAccountId,
      );
      if (viewerRows.length === 0) {
        viewerState = "absent";
      } else {
        const nonExcluded = viewerRows.filter((p) => !p.excluded);
        viewerState =
          nonExcluded.length === 0
            ? "excluded"
            : nonExcluded.every((p) => p.paidAmount !== null)
              ? "paid"
              : "unpaid";
      }
    }

    return {
      id: op.id,
      name: op.name,
      occurredAt: op.occurredAt,
      status: op.status,
      totalValue: centsToIsk(totalByOp.get(op.id) ?? 0n),
      participantCount: owed.length,
      // paidAmount, not a payment row: revert clears it under the operation
      // lock, so a paid-then-reverted participant reads unpaid here without
      // this function folding an event history to find that out.
      paidCount: owed.filter((p) => p.paidAmount !== null).length,
      ...(viewerState !== undefined ? { viewerState } : {}),
    };
  });

  const last = ops[ops.length - 1];
  return {
    operations,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}

export type PayoutPoolView = typeof lootPool.$inferSelect & {
  items: Array<typeof lootItem.$inferSelect>;
};

export type ParticipantPaymentState = "excluded" | "unpaid" | "paid";

export type PayoutPaymentView = typeof payoutPayment.$inferSelect & {
  /** The operator who recorded this event, resolved to their main character's
   *  name — the same account-id → main-character → name rule
   *  `src/services/audit.ts` and `src/services/account-view.ts` already use, so
   *  one person is named identically wherever authGD names them.
   *
   *  Null in two cases this cannot tell apart, and does not try to: `actor` is
   *  `on delete set null`, so a deleted account leaves the row behind with
   *  nobody to name, and an account that never set a main character has no name
   *  to resolve to. The view layer words both, once. */
  actorName: string | null;
};

export type PayoutParticipantView = typeof payoutParticipant.$inferSelect & {
  paymentState: ParticipantPaymentState;
  /** Append-only history for this participant, `(at asc, id asc)`. Rendered,
   *  never folded — `paymentState` comes from `paidAmount`. */
  payments: PayoutPaymentView[];
};

export type PayoutOperationDetail = {
  operation: typeof payoutOperation.$inferSelect;
  pools: PayoutPoolView[];
  participants: PayoutParticipantView[];
  totalValue: string;
  /** Derived, not stored: totalValue minus every participant's amount. This is
   *  the corp's configured percentage plus all rounding remainders — the number
   *  that makes the displayed split add up to the total. */
  corpAmount: string;
  /** hasPayments(operationId) — once true, every edit action rejects via
   *  assertEditable; the page uses this to hide those controls instead of
   *  letting a member discover the rejection by submitting. */
  locked: boolean;
};

export async function getPayoutOperationDetail(
  dbx: Dbx,
  operationId: string,
): Promise<PayoutOperationDetail | null> {
  const [op] = await dbx
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.id, operationId));
  if (!op) return null;

  const [pools, participants, locked] = await Promise.all([
    // The page numbers pools positionally ("Pool 1", "Pool 2", ...) straight
    // off this array's index (src/app/payouts/[id]/page.tsx), so without an
    // ORDER BY an operator's edit to one pool's row can relocate its Postgres
    // tuple and silently renumber every heading. Neither pool type carries a
    // creation-order column that works for both: `appraisedAt` is set only on
    // appraised pools (addAppraisedPool) and stays null on flat ones
    // (addFlatPool), so it can't rank the two kinds against each other.
    // `id`, though a random uuid with no chronological meaning, is the one
    // column every pool has and never changes — ordering by it trades
    // "meaningful" for "stable", which is the property this bug is about.
    dbx
      .select()
      .from(lootPool)
      .where(eq(lootPool.operationId, operationId))
      .orderBy(asc(lootPool.id)),
    dbx
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId))
      .orderBy(asc(payoutParticipant.displayName)),
    hasPayments(dbx, operationId),
  ]);

  const poolIds = pools.map((p) => p.id);
  // Alphabetical by name, following the roster query's idiom above: the item
  // column is what an operator scans to find the line they're about to fix
  // (see the mispriced-item cost in the sweep item this fixes), and unlike
  // pool order there is no positional heading riding on it — so a meaningful
  // order costs nothing over an arbitrary one. `id` tie-breaks two lines that
  // share a name (a duplicated stack in the parsed paste) for the same
  // reason every other tie-break in this file exists: so they don't swap
  // between loads.
  const items = poolIds.length
    ? await dbx
        .select()
        .from(lootItem)
        .where(inArray(lootItem.poolId, poolIds))
        .orderBy(asc(lootItem.name), asc(lootItem.id))
    : [];
  const itemsByPool = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByPool.get(item.poolId) ?? [];
    list.push(item);
    itemsByPool.set(item.poolId, list);
  }

  const participantIds = participants.map((p) => p.id);
  const payments = participantIds.length
    ? await dbx
        .select()
        .from(payoutPayment)
        .where(inArray(payoutPayment.participantId, participantIds))
        .orderBy(asc(payoutPayment.at), asc(payoutPayment.id))
    : [];
  // Who did it. `payout_payment.actor` has been written since phase 1 and never
  // read, and the design defines history as who did what and when — an event
  // list with no actor answers two thirds of that. Resolved with the rule
  // src/services/audit.ts and src/services/account-view.ts already use:
  // account → mainCharacterId → character.name. A second naming rule here would
  // eventually disagree with the audit log about who someone is.
  //
  // Two extra round trips, both skipped when there is no history, and both
  // `inArray` over the handful of operators this one operation used. Not folded
  // into the payments query: it is two joins to fetch one string, on the page's
  // cheapest read.
  const actorIds = [...new Set(payments.map((p) => p.actor).filter((a) => a !== null))];
  const actorAccounts = actorIds.length
    ? await dbx
        .select({ id: account.id, mainCharacterId: account.mainCharacterId })
        .from(account)
        .where(inArray(account.id, actorIds))
    : [];
  const mainIds = actorAccounts.map((a) => a.mainCharacterId).filter((id) => id !== null);
  const mainCharacters = mainIds.length
    ? await dbx
        .select({ id: character.id, name: character.name })
        .from(character)
        .where(inArray(character.id, mainIds))
    : [];
  const nameByCharacterId = new Map(mainCharacters.map((c) => [c.id, c.name]));
  const actorNameById = new Map(
    actorAccounts.map((a) => [
      a.id,
      a.mainCharacterId === null
        ? null
        : (nameByCharacterId.get(a.mainCharacterId) ?? null),
    ]),
  );

  const paymentsByParticipant = new Map<string, PayoutPaymentView[]>();
  for (const payment of payments) {
    const list = paymentsByParticipant.get(payment.participantId) ?? [];
    list.push({
      ...payment,
      actorName:
        payment.actor === null ? null : (actorNameById.get(payment.actor) ?? null),
    });
    paymentsByParticipant.set(payment.participantId, list);
  }

  const totalCents = pools.reduce((sum, p) => sum + iskToCents(p.totalValue), 0n);
  // The corp's cut is not stored — storing it would be a second copy of a number
  // computeSplit already derives, and the two could drift. It is exactly the
  // part of the pot no participant was assigned: the configured percentage plus
  // every sub-ISK rounding remainder. Deriving it here means it always agrees
  // with what recalculate wrote, by construction.
  const assignedCents = participants.reduce((sum, p) => sum + iskToCents(p.amount), 0n);
  const corpAmount = centsToIsk(totalCents - assignedCents);

  return {
    operation: op,
    pools: pools.map((p) => ({ ...p, items: itemsByPool.get(p.id) ?? [] })),
    participants: participants.map((p) => ({
      ...p,
      paymentState: p.excluded ? "excluded" : p.paidAmount !== null ? "paid" : "unpaid",
      payments: paymentsByParticipant.get(p.id) ?? [],
    })),
    totalValue: centsToIsk(totalCents),
    corpAmount,
    locked,
  };
}

/**
 * How many character names the add-participant `<datalist>` ships inside the
 * page.
 *
 * The list is inert HTML the browser filters, which is what buys "no endpoint,
 * no client component, no new authorization surface, works without
 * JavaScript". The price is bytes on every operator's page load.
 *
 * ASSUMPTION, flagged rather than relied on silently: this alliance's character
 * count is in the hundreds, not tens of thousands. At a few hundred names this
 * is a few kilobytes. Past the cap the field degrades to plain free text —
 * still fully usable, just without suggestions — rather than breaking. If
 * production ever exceeds this, the replacement is a server action behind a
 * client component, NOT a larger cap.
 */
export const CHARACTER_NAME_CAP = 500;

/**
 * Every known character name for the add-participant datalist, or `null` when
 * there are more of them than the cap.
 *
 * `limit(CAP + 1)` answers both "are there too many?" and "what are they?" in
 * one query; a separate `count(*)` would be a second round trip to learn what
 * the first row set already implies.
 */
export async function listCharacterNames(dbx: Dbx): Promise<string[] | null> {
  const rows = await dbx
    .select({ name: character.name })
    .from(character)
    .orderBy(asc(character.name))
    .limit(CHARACTER_NAME_CAP + 1);
  if (rows.length > CHARACTER_NAME_CAP) return null;
  return rows.map((r) => r.name);
}

export type AccountPayoutRow = {
  operationId: string;
  operationName: string;
  occurredAt: Date;
  amount: string;
  paid: boolean;
};

/**
 * The viewer's own payout rows for the account page. Unguarded like every read
 * in this module, and safe to be: it is scoped to one `accountId` by its own
 * where clause, so there is nothing here a caller could widen.
 *
 * FINALIZED ONLY. A draft's `amount` is rewritten by `recalculate` on every
 * roster or pool change, so presenting it to a member under "amount owed"
 * states a commitment the operation has not made — and a member who checks
 * twice would see two different figures with no explanation. Finalization is
 * already where the numbers stop moving and already the precondition for
 * payment, so it is the honest cutoff. The cost is that a member cannot see a
 * payout coming before it is final, which is the correct trade: nothing is
 * owed yet.
 *
 * KNOWN LIMITATION, by construction: this matches on
 * `payout_participant.account_id`, which is NULL for anyone whose name did not
 * resolve at paste time. A member pasted under an unlinked alt spelling will
 * not see their own payout here. That is inherent to a model which must also
 * record people who have no authGD account at all; phase 2 does not change it.
 */
export async function listAccountPayouts(
  dbx: Dbx,
  accountId: string,
): Promise<AccountPayoutRow[]> {
  const rows = await dbx
    .select({
      operationId: payoutOperation.id,
      operationName: payoutOperation.name,
      occurredAt: payoutOperation.occurredAt,
      amount: payoutParticipant.amount,
      paidAmount: payoutParticipant.paidAmount,
    })
    .from(payoutParticipant)
    .innerJoin(payoutOperation, eq(payoutParticipant.operationId, payoutOperation.id))
    .where(
      and(
        eq(payoutParticipant.accountId, accountId),
        // Excluded means owed nothing. A 0.00 row under "amount owed" reads as
        // a payout that went wrong rather than one that never applied.
        eq(payoutParticipant.excluded, false),
        eq(payoutOperation.status, "finalized"),
      ),
    )
    // occurredAt is not unique — two operations can share a night — so it is
    // no stable sort on its own. The uuid tiebreak is arbitrary but stable,
    // which is all this needs to stop rows swapping between loads.
    .orderBy(desc(payoutOperation.occurredAt), desc(payoutOperation.id));

  return rows.map((r) => ({
    operationId: r.operationId,
    operationName: r.operationName,
    occurredAt: r.occurredAt,
    amount: r.amount,
    // Never Number(): amount stays the exact numeric(20,2) string the column
    // holds, all the way to the screen.
    paid: r.paidAmount !== null,
  }));
}
