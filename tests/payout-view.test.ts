import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  account,
  character,
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
  return seedAccount(ctx.db, { tier: "flygd", status: "active" });
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
  async function seedCharacters(count: number) {
    const acc = await seedAccount(ctx.db, { tier: "flygd", status: "active" });
    await ctx.db.insert(character).values(
      Array.from({ length: count }, (_, i) => ({
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

  it("returns every name, alphabetically, under the cap", async () => {
    await seedCharacters(3);
    const names = await listCharacterNames(ctx.db);
    expect(names).toEqual(["Pilot 0000", "Pilot 0001", "Pilot 0002"]);
  });

  it("returns exactly the cap's worth at the cap", async () => {
    await seedCharacters(CHARACTER_NAME_CAP);
    expect(await listCharacterNames(ctx.db)).toHaveLength(CHARACTER_NAME_CAP);
  });

  // Past the cap the datalist is dropped entirely and the field degrades to
  // plain free text. Returning a truncated list instead would be worse than
  // none: an operator would type a real pilot's name, see no suggestion, and
  // reasonably conclude the name is unknown.
  it("returns null past the cap rather than a truncated list", async () => {
    await seedCharacters(CHARACTER_NAME_CAP + 1);
    expect(await listCharacterNames(ctx.db)).toBeNull();
  });
});

describe("listAccountPayouts", () => {
  async function seedForAccount(opts: { excluded?: boolean } = {}) {
    const member = await seedAccount(ctx.db, { tier: "flygd", status: "active" });
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
    const stranger = await seedAccount(ctx.db, { tier: "flygd", status: "active" });
    expect(await listAccountPayouts(ctx.db, stranger.id)).toEqual([]);
  });

  it("orders newest first", async () => {
    const member = await seedAccount(ctx.db, { tier: "flygd", status: "active" });
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
