import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  account,
  character,
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
} from "@/db/schema";
import { iskToCents } from "@/core/payout-split";
import {
  createOperation,
  finalizeOperation,
  recordPayment,
  revertPayment,
  setParticipantExcluded,
  setRoster,
  type RosterEntry,
} from "@/services/payouts";
import {
  CHARACTER_NAME_CAP,
  decodePayoutCursor,
  encodePayoutCursor,
  getPayoutOperationDetail,
  listAccountPayouts,
  listCharacterNames,
  listPayoutOperations,
  type PayoutListCursor,
} from "@/services/payout-view";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedOperator() {
  return seedAccount(ctx.db, { tier: "member", status: "active" });
}

function roster(names: string[]): RosterEntry[] {
  return names.map((displayName) => ({
    displayName,
    accountId: null,
    recipientCharacterId: null,
    sourceCharacters: [displayName],
    shares: "1",
    excluded: false,
  }));
}

/** One operation, one flat pool at the given total, and a roster of equal-
 *  share unresolved names. `setRoster`'s own `recalculate` call assigns
 *  `amount`. Returns everything a caller might need, keyed by displayName. */
async function seedOperation(opts: {
  corpSharePct?: string;
  totalValue: string;
  names: string[];
}) {
  const operator = await seedOperator();
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Test fight",
      occurredAt: new Date(),
      corpSharePct: opts.corpSharePct ?? "0",
    }),
  );
  const [pool] = await ctx.db
    .insert(lootPool)
    .values({
      operationId,
      valuationSource: "flat",
      totalValue: opts.totalValue,
      notes: "seeded directly",
    })
    .returning();
  await ctx.db.transaction((tx) =>
    setRoster(tx, operator.id, operationId, roster(opts.names)),
  );
  const rows = await ctx.db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  return { operator, operationId, poolId: pool.id, byName };
}

describe("listPayoutOperations", () => {
  it("excludes excluded participants from both participantCount and paidCount", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A", "B", "C"],
    });
    await ctx.db.transaction((tx) =>
      setParticipantExcluded(tx, operator.id, byName.get("A")!.id, true),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("B")!.id));

    const [summary] = (await listPayoutOperations(ctx.db)).operations.filter(
      (o) => o.id === operationId,
    );
    // A is excluded (not owed anything, not counted); B and C are owed, and
    // only B has been paid.
    expect(summary.participantCount).toBe(2);
    expect(summary.paidCount).toBe(1);
  });
});

describe("listPayoutOperations — viewerState (finding 2.1)", () => {
  it("omits the key entirely when no viewerAccountId is passed", async () => {
    const { operationId } = await seedOperation({ totalValue: "100.00", names: ["A"] });
    const [summary] = (await listPayoutOperations(ctx.db)).operations.filter(
      (o) => o.id === operationId,
    );
    expect(summary).not.toHaveProperty("viewerState");
  });

  it("reads unresolved when the viewer has no row but a roster name resolved to nobody", async () => {
    const viewer = await seedAccount(ctx.db, { tier: "member", status: "active" });
    // `roster()` seeds `accountId: null`, the same shape `resolveRosterNames`
    // produces for a pasted name matching no character. The viewer may BE one
    // of those names under an unlinked alt, so absence isn't provable here.
    const { operationId } = await seedOperation({ totalValue: "100.00", names: ["A"] });
    const [summary] = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.filter((o) => o.id === operationId);
    expect(summary.viewerState).toBe("unresolved");
  });

  it("reads absent only when every roster name resolved and none is the viewer", async () => {
    const viewer = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const other = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const { operationId, byName } = await seedOperation({
      totalValue: "100.00",
      names: ["A"],
    });
    // Resolve the whole roster to somebody who isn't the viewer: now the
    // negative is provable, and the page is entitled to state it.
    await ctx.db
      .update(payoutParticipant)
      .set({ accountId: other.id })
      .where(eq(payoutParticipant.id, byName.get("A")!.id));
    const [summary] = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.filter((o) => o.id === operationId);
    expect(summary.viewerState).toBe("absent");
  });

  it("reads excluded when every one of the viewer's rows is excluded", async () => {
    const viewer = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "100.00",
      names: ["Viewer"],
    });
    await ctx.db
      .update(payoutParticipant)
      .set({ accountId: viewer.id })
      .where(eq(payoutParticipant.id, byName.get("Viewer")!.id));
    await ctx.db.transaction((tx) =>
      setParticipantExcluded(tx, operator.id, byName.get("Viewer")!.id, true),
    );
    const [summary] = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.filter((o) => o.id === operationId);
    expect(summary.viewerState).toBe("excluded");
  });

  it("reads unpaid before payment and paid once recorded", async () => {
    const viewer = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "100.00",
      names: ["Viewer"],
    });
    await ctx.db
      .update(payoutParticipant)
      .set({ accountId: viewer.id })
      .where(eq(payoutParticipant.id, byName.get("Viewer")!.id));

    const unpaid = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.find((o) => o.id === operationId);
    expect(unpaid!.viewerState).toBe("unpaid");

    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) =>
      recordPayment(tx, operator.id, byName.get("Viewer")!.id),
    );
    const paid = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.find((o) => o.id === operationId);
    expect(paid!.viewerState).toBe("paid");
  });

  it("collapses two of the viewer's own characters in one operation into a single state", async () => {
    // Same reason src/app/account/account-payouts.tsx:26-29 collapses alts to
    // one row per operation: a fleet can carry two of the viewer's characters
    // as separate participant rows, and the viewer has exactly one relevant
    // question ("was I paid"), not one per character.
    const viewer = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "200.00",
      names: ["Alt1", "Alt2"],
    });
    await ctx.db
      .update(payoutParticipant)
      .set({ accountId: viewer.id })
      .where(
        inArray(payoutParticipant.id, [byName.get("Alt1")!.id, byName.get("Alt2")!.id]),
      );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) =>
      recordPayment(tx, operator.id, byName.get("Alt1")!.id),
    );

    // Only one of the two alt rows is paid — collapse rule says this reads
    // unpaid, not paid, until every non-excluded viewer row clears.
    const partial = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.find((o) => o.id === operationId);
    expect(partial!.viewerState).toBe("unpaid");

    await ctx.db.transaction((tx) =>
      recordPayment(tx, operator.id, byName.get("Alt2")!.id),
    );
    const full = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.find((o) => o.id === operationId);
    expect(full!.viewerState).toBe("paid");
  });

  it("leaves participantCount and paidCount unchanged when viewerAccountId is passed", async () => {
    const viewer = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A", "B", "C"],
    });
    await ctx.db
      .update(payoutParticipant)
      .set({ accountId: viewer.id })
      .where(eq(payoutParticipant.id, byName.get("A")!.id));
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("A")!.id));

    const without = (await listPayoutOperations(ctx.db)).operations.find(
      (o) => o.id === operationId,
    )!;
    const withViewer = (
      await listPayoutOperations(ctx.db, { viewerAccountId: viewer.id })
    ).operations.find((o) => o.id === operationId)!;
    expect(withViewer.participantCount).toBe(without.participantCount);
    expect(withViewer.paidCount).toBe(without.paidCount);
    expect(withViewer).not.toHaveProperty("amount");
  });
});

describe("listPayoutOperations — filters (finding 2.2)", () => {
  it("matches an operation name case-insensitively by substring", async () => {
    await seedOps([
      { name: "Thursday Roam", occurredAt: "2026-08-01T00:00:00Z" },
      { name: "Sunday Defense Fleet", occurredAt: "2026-08-02T00:00:00Z" },
    ]);
    const { operations } = await listPayoutOperations(ctx.db, { q: "roam" });
    expect(operations.map((o) => o.name)).toEqual(["Thursday Roam"]);
  });

  it("treats %, _ and the escape character as literal text, not wildcards", async () => {
    await seedOps([
      { name: "100% Isk Split", occurredAt: "2026-08-01T00:00:00Z" },
      { name: "Unrelated Fleet", occurredAt: "2026-08-02T00:00:00Z" },
    ]);
    // If % were treated as a SQL wildcard, this would match both operations.
    const { operations } = await listPayoutOperations(ctx.db, { q: "100%" });
    expect(operations.map((o) => o.name)).toEqual(["100% Isk Split"]);
  });

  it("trims q, treating whitespace-only as no filter", async () => {
    await seedOps([
      { name: "A", occurredAt: "2026-08-01T00:00:00Z" },
      { name: "B", occurredAt: "2026-08-02T00:00:00Z" },
    ]);
    const trimmed = await listPayoutOperations(ctx.db, { q: "  a  " });
    expect(trimmed.operations.map((o) => o.name)).toEqual(["A"]);

    const blank = await listPayoutOperations(ctx.db, { q: "   " });
    expect(blank.operations).toHaveLength(2);
  });

  it("filters by status", async () => {
    const draft = await seedOperation({ totalValue: "1.00", names: ["A"] });
    const { operator, operationId: finalizedId } = await seedOperation({
      totalValue: "1.00",
      names: ["B"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, finalizedId));

    const drafts = await listPayoutOperations(ctx.db, { status: "draft" });
    expect(drafts.operations.map((o) => o.id)).toEqual([draft.operationId]);

    const finalized = await listPayoutOperations(ctx.db, { status: "finalized" });
    expect(finalized.operations.map((o) => o.id)).toEqual([finalizedId]);
  });

  it("composes filters with a cursor, keeping keyset paging correct within the narrowed set", async () => {
    await seedOps([
      { name: "Roam One", occurredAt: "2026-08-04T00:00:00Z" },
      { name: "Roam Two", occurredAt: "2026-08-03T00:00:00Z" },
      { name: "Roam Three", occurredAt: "2026-08-02T00:00:00Z" },
      { name: "Defense Fleet", occurredAt: "2026-08-01T00:00:00Z" },
    ]);

    const first = await listPayoutOperations(ctx.db, { q: "roam", limit: 2 });
    expect(first.operations.map((o) => o.name)).toEqual(["Roam One", "Roam Two"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPayoutOperations(ctx.db, {
      q: "roam",
      before: first.nextCursor!,
      limit: 2,
    });
    // "Defense Fleet" is newer than nothing here, but it doesn't match "roam"
    // and must not leak into the filtered second page.
    expect(second.operations.map((o) => o.name)).toEqual(["Roam Three"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("getPayoutOperationDetail — paymentState", () => {
  it("maps excluded / unpaid / paid correctly per participant", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["Excluded", "Unpaid", "Paid"],
    });
    await ctx.db.transaction((tx) =>
      setParticipantExcluded(tx, operator.id, byName.get("Excluded")!.id, true),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) =>
      recordPayment(tx, operator.id, byName.get("Paid")!.id),
    );

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const states = new Map(
      detail!.participants.map((p) => [p.displayName, p.paymentState]),
    );
    expect(states.get("Excluded")).toBe("excluded");
    expect(states.get("Unpaid")).toBe("unpaid");
    expect(states.get("Paid")).toBe("paid");
  });
});

describe("getPayoutOperationDetail — exact money on the read side", () => {
  it("sums a pool total past 2^53 without precision loss", async () => {
    // 2^53 = 9,007,199,254,740,992. A float total would silently round this;
    // bigint cents must not. Two pools so the summation itself is exercised,
    // not just a single already-oversized string passing through unchanged.
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Absurd fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values([
      {
        operationId,
        valuationSource: "flat",
        totalValue: "9007199254740992.01",
        notes: "pool one",
      },
      {
        operationId,
        valuationSource: "flat",
        totalValue: "9007199254740992.01",
        notes: "pool two",
      },
    ]);
    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    expect(detail!.totalValue).toBe("18014398509481984.02");
    // listPayoutOperations sums the same pools in its own separate loop
    // (src/services/payout-view.ts) — a Number() regression there wouldn't
    // show up in getPayoutOperationDetail's assertion above.
    const [summary] = (await listPayoutOperations(ctx.db)).operations;
    expect(summary.totalValue).toBe("18014398509481984.02");
  });

  it("derives corp share as total minus the sum of participant amounts, remainder included", async () => {
    // 100.01 ISK / 3 equal shares at 10% corp share does not divide evenly;
    // the leftover cent must land on the corp (via the derivation), never
    // vanish or get double-counted. Comparing in bigint cents, not floats,
    // is the whole point of this test: it must catch a Number()-based
    // corpAmount = total * pct / 100 that ignores the rounding remainder.
    const CORP_SHARE_PCT = "10";
    const { operationId } = await seedOperation({
      corpSharePct: CORP_SHARE_PCT,
      totalValue: "100.01",
      names: ["A", "B", "C"],
    });
    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const assignedCents = detail!.participants.reduce(
      (sum, p) => sum + iskToCents(p.amount),
      0n,
    );
    const totalCents = iskToCents(detail!.totalValue);
    expect(iskToCents(detail!.corpAmount)).toBe(totalCents - assignedCents);
    // Reconciles exactly against what recalculate actually wrote — the whole
    // point of deriving rather than storing a second copy of the number.
    expect(assignedCents + iskToCents(detail!.corpAmount)).toBe(totalCents);
    // Literal anchors: every assertion above is relational only ("derived
    // corp equals total minus the amounts just read back"), so a regression
    // in recalculate itself would still reconcile and pass. 100.01 ISK split
    // 3 equal ways after a 10% corp share is 30.00 ISK per participant and
    // 10.01 ISK to the corp (the extra cent is the undistributed remainder).
    expect(detail!.corpAmount).toBe("10.01");
    expect(detail!.participants[0].amount).toBe("30.00");
    // A naive total * pct / 100 would give 10.00, not the derived remainder
    // that also swallows the assignment rounding — pin the two disagree.
    // Basis points derived from the same constant the fixture uses above, so
    // editing CORP_SHARE_PCT can't silently stop this from comparing against
    // the naive formula.
    const naiveBasisPoints = BigInt(Number(CORP_SHARE_PCT)) * 100n;
    expect(iskToCents(detail!.corpAmount)).not.toBe(
      (totalCents * naiveBasisPoints) / 10000n,
    );
  });
});

describe("getPayoutOperationDetail — pool and item ordering", () => {
  // Without an ORDER BY, the pool array's row order is whatever Postgres
  // happens to return, and the page numbers pools positionally off that
  // array's index ("Pool 1", "Pool 2", ...). Ordering by `id` doesn't make
  // the numbering meaningful, but it makes it STABLE: the same pool is always
  // "Pool N" across reads, which is the property the bug report is about.
  it("orders pools by id, not by insertion order", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Ordering fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    const inserted = await ctx.db
      .insert(lootPool)
      .values([
        { operationId, valuationSource: "flat", totalValue: "1.00", notes: "first" },
        { operationId, valuationSource: "flat", totalValue: "2.00", notes: "second" },
        { operationId, valuationSource: "flat", totalValue: "3.00", notes: "third" },
      ])
      .returning({ id: lootPool.id });

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const expected = [...inserted.map((p) => p.id)].sort();
    expect(detail!.pools.map((p) => p.id)).toEqual(expected);
  });

  // The item table is what an operator scans to find one mispriced line in a
  // long pool. Alphabetical order lets them find it predictably, and — unlike
  // pool order — nothing downstream is numbered off this array's index, so a
  // meaningful order costs nothing over an arbitrary one.
  it("orders a pool's items alphabetically by name, and an edit doesn't reshuffle them", async () => {
    const { operationId, poolId } = await seedOperation({
      totalValue: "300.00",
      names: ["A"],
    });
    const [zed, mike, alpha] = await ctx.db
      .insert(lootItem)
      .values([
        {
          poolId,
          name: "Zydrine",
          qty: 1,
          unitPrice: "1.00",
          totalValue: "1.00",
          priceSource: "triff",
        },
        {
          poolId,
          name: "Mercaba",
          qty: 1,
          unitPrice: "1.00",
          totalValue: "1.00",
          priceSource: "triff",
        },
        {
          poolId,
          name: "Alloyed Tritanium Bar",
          qty: 1,
          unitPrice: "1.00",
          totalValue: "1.00",
          priceSource: "triff",
        },
      ])
      .returning();

    const before = await getPayoutOperationDetail(ctx.db, operationId);
    expect(before!.pools[0].items.map((i) => i.name)).toEqual([
      "Alloyed Tritanium Bar",
      "Mercaba",
      "Zydrine",
    ]);

    // The exact scenario from the cost report: correcting one item's price
    // must not relocate it in the manifest.
    await ctx.db
      .update(lootItem)
      .set({ unitPrice: "5.00", totalValue: "5.00" })
      .where(eq(lootItem.id, mike.id));

    const after = await getPayoutOperationDetail(ctx.db, operationId);
    expect(after!.pools[0].items.map((i) => i.name)).toEqual([
      "Alloyed Tritanium Bar",
      "Mercaba",
      "Zydrine",
    ]);
    expect(zed).toBeTruthy();
    expect(alpha).toBeTruthy();
  });
});

describe("derived payment state comes from paidAmount, not from a paid row", () => {
  it("reports a paid-then-reverted participant as unpaid in both the list and the detail", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A", "B"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("A")!.id));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("B")!.id));
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, byName.get("A")!.id));

    // A still has a `paid` row in payout_payment; an existence check would
    // count it. paidAmount is null, and that is what decides.
    const [summary] = (await listPayoutOperations(ctx.db)).operations.filter(
      (o) => o.id === operationId,
    );
    expect(summary.paidCount).toBe(1);

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const states = new Map(
      detail!.participants.map((p) => [p.displayName, p.paymentState]),
    );
    expect(states.get("A")).toBe("unpaid");
    expect(states.get("B")).toBe("paid");
  });

  it("returns each participant's history oldest-first", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction(async (tx) => {
      await recordPayment(tx, operator.id, byName.get("A")!.id);
      await revertPayment(tx, operator.id, byName.get("A")!.id);
      await recordPayment(tx, operator.id, byName.get("A")!.id);
    });

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const a = detail!.participants.find((p) => p.displayName === "A")!;
    expect(a.payments.map((p) => p.kind)).toEqual(["paid", "reverted", "paid"]);
    expect(a.paymentState).toBe("paid");
  });
});

/** Operations with controlled `occurredAt` values, inserted directly: these
 *  tests are about ordering and query scoping, not about createOperation. */
async function seedOps(specs: Array<{ name: string; occurredAt: string }>) {
  return ctx.db
    .insert(payoutOperation)
    .values(specs.map((s) => ({ name: s.name, occurredAt: new Date(s.occurredAt) })))
    .returning({ id: payoutOperation.id, name: payoutOperation.name });
}

/** A second drizzle handle over the SAME pool that records every statement it
 *  issues. The point of this task is which rows are read, and the returned
 *  shape cannot tell a scoped query from an unscoped one that was filtered in
 *  memory afterwards. */
function recordingDb() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(ctx.pool, {
    schema,
    logger: { logQuery: (sql, params) => queries.push({ sql, params }) },
  });
  return { db, queries };
}

describe("listPayoutOperations — pagination", () => {
  it("pages through operations sharing an occurredAt without skipping or repeating", async () => {
    // Three operations share one date and two share another. A bare-timestamp
    // cursor pages past the whole tied group and loses the third, which a
    // "page 2 differs from page 1" assertion would not notice.
    await seedOps([
      { name: "A", occurredAt: "2026-08-01T00:00:00Z" },
      { name: "B", occurredAt: "2026-08-01T00:00:00Z" },
      { name: "C", occurredAt: "2026-08-01T00:00:00Z" },
      { name: "D", occurredAt: "2026-07-01T00:00:00Z" },
      { name: "E", occurredAt: "2026-07-01T00:00:00Z" },
    ]);

    const seen: string[] = [];
    let cursor: PayoutListCursor | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listPayoutOperations(ctx.db, { before: cursor, limit: 2 });
      seen.push(...page.operations.map((o) => o.name));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("never reads pools, participants or payments outside the requested page", async () => {
    const ops = await seedOps([
      { name: "Newest", occurredAt: "2026-08-03T00:00:00Z" },
      { name: "Middle", occurredAt: "2026-08-02T00:00:00Z" },
      { name: "Oldest", occurredAt: "2026-08-01T00:00:00Z" },
    ]);
    const idOf = new Map(ops.map((o) => [o.name, o.id]));

    const first = await listPayoutOperations(ctx.db, { limit: 1 });
    expect(first.operations.map((o) => o.name)).toEqual(["Newest"]);
    expect(first.nextCursor).not.toBeNull();

    const { db, queries } = recordingDb();
    const second = await listPayoutOperations(db, {
      before: first.nextCursor!,
      limit: 1,
    });
    expect(second.operations.map((o) => o.name)).toEqual(["Middle"]);

    // Only the child queries are inspected: the operation query legitimately
    // binds the cursor, which carries page 1's id.
    const childParams = queries
      .filter((q) => q.sql.includes("loot_pool") || q.sql.includes("payout_participant"))
      .flatMap((q) => q.params.map(String));
    expect(childParams).toContain(idOf.get("Middle"));
    expect(childParams).not.toContain(idOf.get("Newest"));
    expect(childParams).not.toContain(idOf.get("Oldest"));

    // The payment query is gone entirely, not merely narrowed.
    expect(queries.filter((q) => q.sql.includes("payout_payment"))).toHaveLength(0);
  });

  it("reads a paid-then-reverted participant as unpaid", async () => {
    // The exact case the deleted payment query got wrong: a `paid` row still
    // exists, so "has a paid row" answers 1/2 where paidAmount answers 0/2.
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A", "B"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("A")!.id));
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, byName.get("A")!.id));

    const { operations } = await listPayoutOperations(ctx.db);
    const summary = operations.find((o) => o.id === operationId)!;
    expect(summary.participantCount).toBe(2);
    expect(summary.paidCount).toBe(0);
  });
});

describe("payout list cursor encoding", () => {
  it("round-trips a cursor through the query param", () => {
    const cursor = {
      occurredAt: new Date("2026-08-01T12:34:56.000Z"),
      id: "11111111-2222-3333-4444-555555555555",
    };
    const decoded = decodePayoutCursor(encodePayoutCursor(cursor));
    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.occurredAt.toISOString()).toBe("2026-08-01T12:34:56.000Z");
  });

  it("returns undefined for anything malformed rather than throwing", () => {
    // `before` is a hand-editable URL param. A bad one must render page 1, not
    // reach Postgres as a non-uuid comparison and 500 the list.
    for (const raw of [
      undefined,
      "",
      "not-a-cursor",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z|not-a-uuid",
      "nonsense|11111111-2222-3333-4444-555555555555",
      "2026-08-01T00:00:00.000Z|11111111-2222-3333-4444-555555555555|extra",
    ]) {
      expect(decodePayoutCursor(raw)).toBeUndefined();
    }
  });
});

describe("listCharacterNames", () => {
  /**
   * `count` accounts, one character each, all mainless.
   *
   * Mainless on purpose. It bounds insert cost — `account.main_character_id`'s
   * composite FK is DEFERRED, so seeding a main means either a transaction per
   * account or a second pass of updates — and it exercises the fallback branch
   * at the scale the cap cares about. Main-preference is covered by the small
   * focused tests below.
   */
  async function seedAccountsWithOneCharacterEach(count: number) {
    const accounts = await ctx.db
      .insert(account)
      .values(
        Array.from({ length: count }, () => ({
          tier: "member" as const,
          status: "active" as const,
        })),
      )
      .returning();
    await ctx.db.insert(character).values(
      accounts.map((acc, i) => ({
        id: 5_000_000 + i,
        accountId: acc.id,
        // Zero-padded so alphabetical order is also numeric order, which is
        // what lets the cap test assert *which* names came back.
        name: `Pilot ${String(i).padStart(4, "0")}`,
        ownerHash: `oh-${5_000_000 + i}`,
        scopes: [],
      })),
    );
  }

  // "Aardvark Alt" sorts before the main, so this also pins that the main wins
  // over the alphabetical fallback rather than tying with it.
  it("returns the main's name and none of its alts", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", status: "active" });
    await ctx.db.insert(character).values([
      {
        id: 6_000_001,
        accountId: acc.id,
        name: "Aardvark Alt",
        ownerHash: "oh-6000001",
        scopes: [],
      },
      {
        id: 6_000_002,
        accountId: acc.id,
        name: "Main Pilot",
        ownerHash: "oh-6000002",
        scopes: [],
      },
      {
        id: 6_000_003,
        accountId: acc.id,
        name: "Zulu Alt",
        ownerHash: "oh-6000003",
        scopes: [],
      },
    ]);
    await ctx.db
      .update(account)
      .set({ mainCharacterId: 6_000_002 })
      .where(eq(account.id, acc.id));

    expect(await listCharacterNames(ctx.db)).toEqual(["Main Pilot"]);
  });

  // Ids run counter to the names so neither insertion order nor id order can
  // produce a passing result by accident.
  it("falls back to the alphabetically-first character when there is no main", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", status: "active" });
    await ctx.db.insert(character).values([
      {
        id: 6_100_002,
        accountId: acc.id,
        name: "Beta Pilot",
        ownerHash: "oh-6100002",
        scopes: [],
      },
      {
        id: 6_100_001,
        accountId: acc.id,
        name: "Alpha Pilot",
        ownerHash: "oh-6100001",
        scopes: [],
      },
    ]);

    expect(await listCharacterNames(ctx.db)).toEqual(["Alpha Pilot"]);
  });

  // `reclaimCharacter` deletes a transferred character and leaves the account
  // standing, so characterless accounts are a real state, not a hypothetical.
  it("skips accounts with no characters", async () => {
    await seedAccount(ctx.db, { tier: "member", status: "active" });
    const acc = await seedAccount(ctx.db, { tier: "member", status: "active" });
    await ctx.db.insert(character).values({
      id: 6_200_001,
      accountId: acc.id,
      name: "Only Pilot",
      ownerHash: "oh-6200001",
      scopes: [],
    });

    expect(await listCharacterNames(ctx.db)).toEqual(["Only Pilot"]);
  });

  it("returns one name per account, alphabetically across accounts", async () => {
    await seedAccountsWithOneCharacterEach(3);
    const names = await listCharacterNames(ctx.db);
    expect(names).toEqual(["Pilot 0000", "Pilot 0001", "Pilot 0002"]);
  });

  it("returns exactly the cap's worth at the cap", async () => {
    await seedAccountsWithOneCharacterEach(CHARACTER_NAME_CAP);
    expect(await listCharacterNames(ctx.db)).toHaveLength(CHARACTER_NAME_CAP);
  });

  // Past the cap the datalist is dropped entirely and the field degrades to
  // plain free text. Returning a truncated list instead would be worse than
  // none: an operator would type a real pilot's name, see no suggestion, and
  // reasonably conclude the name is unknown.
  it("returns null past the cap rather than a truncated list", async () => {
    await seedAccountsWithOneCharacterEach(CHARACTER_NAME_CAP + 1);
    expect(await listCharacterNames(ctx.db)).toBeNull();
  });
});

describe("listAccountPayouts", () => {
  async function seedForAccount(opts: { excluded?: boolean } = {}) {
    const member = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const { operationId, operator } = await seedOperation({
      totalValue: "100.00",
      names: ["Placeholder"],
    });
    await ctx.db
      .update(payoutParticipant)
      .set({ accountId: member.id, excluded: opts.excluded ?? false })
      .where(eq(payoutParticipant.operationId, operationId));
    return { member, operationId, operator };
  }

  // A draft's amount is rewritten by `recalculate` on every roster or pool
  // change, so showing it under "amount owed" states a commitment the
  // operation has not made — and a member who checks twice sees two different
  // figures. Finalization is where the numbers stop moving.
  it("hides a draft and reveals it once finalized", async () => {
    const { member, operationId, operator } = await seedForAccount();
    expect(await listAccountPayouts(ctx.db, member.id)).toEqual([]);
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const rows = await listAccountPayouts(ctx.db, member.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operationId, paid: false });
    expect(iskToCents(rows[0].amount)).toBe(10000n);
  });

  it("omits an excluded participant, who is owed nothing", async () => {
    const { member, operationId, operator } = await seedForAccount({ excluded: true });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    expect(await listAccountPayouts(ctx.db, member.id)).toEqual([]);
  });

  it("reports paid from paidAmount, and unpaid again after a revert", async () => {
    const { member, operationId, operator } = await seedForAccount();
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participant.id));
    expect((await listAccountPayouts(ctx.db, member.id))[0].paid).toBe(true);
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participant.id));
    expect((await listAccountPayouts(ctx.db, member.id))[0].paid).toBe(false);
  });

  it("never returns another member's rows", async () => {
    const { operationId, operator } = await seedForAccount();
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const stranger = await seedAccount(ctx.db, { tier: "member", status: "active" });
    expect(await listAccountPayouts(ctx.db, stranger.id)).toEqual([]);
  });

  it("orders newest first", async () => {
    const member = await seedAccount(ctx.db, { tier: "member", status: "active" });
    for (const day of ["2026-08-01", "2026-08-03", "2026-08-02"]) {
      const { operationId, operator } = await seedOperation({
        totalValue: "100.00",
        names: ["Placeholder"],
      });
      await ctx.db
        .update(payoutOperation)
        .set({ occurredAt: new Date(`${day}T00:00:00Z`) })
        .where(eq(payoutOperation.id, operationId));
      await ctx.db
        .update(payoutParticipant)
        .set({ accountId: member.id })
        .where(eq(payoutParticipant.operationId, operationId));
      await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    }
    const rows = await listAccountPayouts(ctx.db, member.id);
    expect(rows.map((r) => r.occurredAt.toISOString().slice(0, 10))).toEqual([
      "2026-08-03",
      "2026-08-02",
      "2026-08-01",
    ]);
  });
});

describe("payment history names the operator who recorded it", () => {
  it("resolves the actor to their main character's name", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A"],
    });
    // The same shape seedCharacter writes, inserted directly because this file
    // has no Config to hand that helper and needs no token here.
    await ctx.db.insert(character).values({
      id: 900001,
      accountId: operator.id,
      name: "FC Prime",
      ownerHash: "oh-900001",
      scopes: [],
    });
    await ctx.db
      .update(account)
      .set({ mainCharacterId: 900001 })
      .where(eq(account.id, operator.id));
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("A")!.id));
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, byName.get("A")!.id));

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const a = detail!.participants.find((p) => p.displayName === "A")!;
    expect(a.payments.map((ev) => [ev.kind, ev.actorName])).toEqual([
      ["paid", "FC Prime"],
      ["reverted", "FC Prime"],
    ]);
  });

  // Both nulls are reachable and neither is an error: `payout_payment.actor`
  // is `on delete set null`, and an account need not have a main character at
  // all. The row must still come back — history is append-only, and losing an
  // event because nobody can be named would be the worse failure.
  it("leaves actorName null when there is no main character to name the actor by", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("A")!.id));

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const a = detail!.participants.find((p) => p.displayName === "A")!;
    expect(a.payments).toHaveLength(1);
    expect(a.payments[0].actorName).toBeNull();
  });
});
