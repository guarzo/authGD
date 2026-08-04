# Fight Payout Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a flygd member record a fight's loot, paste the fleet roster, and get an exact, auditable ISK split they can pay out and mark off.

**Architecture:** Five new tables (`payout_operation`, `loot_pool`, `loot_item`, `payout_participant`, `payout_payment`) hang off the existing account/character graph. Pure arithmetic and parsing live in `src/core/`, external pricing in `src/lib/triff/`, all database mutation behind `src/services/payouts.ts` and `src/services/payout-loot.ts`, and the UI in `src/app/payouts/`. Money is exact: native `bigint` ISK-cents against `numeric(20,2)`, floor division everywhere, remainder to the corp. Payments are immutable events, so recalculating a split can never rewrite what was already paid.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Drizzle ORM on Postgres, vitest + msw for unit/integration, Playwright for e2e, triff.tools for market pricing, ESI `/universe/ids/` for type-id resolution.

**Reference:** `docs/superpowers/specs/2026-08-03-fight-payout-tracking-design.md`

## Global Constraints

- **Migrations are generated, never hand-written.** Run `npm run db:generate` after a schema edit. Never edit a migration that has already been applied — `fly.toml` runs them as a release command on every deploy.
- **Money is exact.** ISK is stored as `numeric(20, 2)` and computed as native `bigint` cents. No floats, no new decimal dependency. Every division rounds down; the remainder goes to the corp.
- **`src/core/` stays pure.** No database, no network, no `Date.now()` inside a calculation — callers pass values in.
- **Enqueue, don't execute** — with exactly one documented exception. Web code enqueues; the worker executes. The appraisal server action calls triff.tools directly because it is read-only, idempotent, and interactive. That call site carries a comment saying so. Nothing else in this feature may widen the exception.
- **Every state change writes an audit row.** `payout.*` actions always target the operation uuid, never a participant or pool id.
- **Identity FKs are `ON DELETE SET NULL`, never `CASCADE` or `RESTRICT`.** `unlinkCharacter` hard-deletes character rows; a paid participant row must survive that with its `displayName` and amounts intact.
- **Mutation requires tier `flygd` AND status `active`; reading any operation requires tier `flygd`.** Every mutating service function calls `requirePayoutOperator` as its first statement, inside the caller's transaction — not only in the server action. An action-only check leaves a TOCTOU window (the tier can change between check and write) and leaves any other caller unguarded. Layouts do not protect server actions either; each action gates itself as well.
- **Finalization freezes an operation.** `assertEditable` refuses on `status !== "draft"` *and* on the existence of any payment. Correcting a finalized operation goes through an audited `unlockOperation`, which is available only to the operation's `createdBy` or an admin, and only while no payment exists.
- **Anything that decides based on a row must read that row after taking the lock.** `recordPayment` locks the operation first and re-reads the participant, or two concurrent clicks both see `paidAmount === null` and each write a payment event.
- **Exact money on the read side too.** View/summary code sums with `iskToCents`/`centsToIsk`, never `Number()` — `numeric(20,2)` holds values well past 2^53.
- **Cite test output.** Never claim `npm test`, `npm run typecheck`, or `npm run test:e2e` passed without running it and quoting the result.
- **`npm test` needs a private database in a worktree:** `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npm test`. `npm run test:e2e` isolates itself and needs nothing.
- **Stay in scope.** No renaming, restructuring, or cleaning up files these tasks do not name.

## Scope: PR 1 only

This plan builds the spec's **PR 1 — usable core**: schema and migration, split
math, the triff client, create operation, paste roster, appraise, compute,
finalize, mark paid with copy-amount, plus the `MANAGED_TABLES` and audit-resolver
updates (both fail existing tests if skipped).

Explicitly **not** in this plan, and not to be added opportunistically: manual /
type-ahead participant entry, per-item price override, reverting a payment, the
account-page "your payouts" section, and the ESI open-information express path.
The express path is gated on an unresolved `EVE_SSO_SCOPES` decision — do not
touch `src/config.ts` or read `character.scopes` in any task here.

Multiple loot pools per operation fall out of the schema for free and the service
layer supports them; the PR 1 UI adds one pool at a time and does not need a
multi-pool editor.

## Task Map

| # | Deliverable | Files |
|---|---|---|
| 1 | Schema, CHECK constraints, generated migration | `src/db/schema.ts`, `src/db/tables.ts`, `drizzle/` |
| 2 | Exact money arithmetic and the split | `src/core/payout-split.ts` |
| 3 | Roster and loot paste parsers | `src/core/roster-paste.ts`, `src/core/loot-paste.ts` |
| 4 | Price selection and the triff client | `src/core/pricing.ts`, `src/lib/triff/client.ts` |
| 5 | ESI name → type-id resolution | `src/lib/esi/client.ts` |
| 6 | `payout` as an audit target kind | `src/services/audit.ts` |
| 7 | Payout service: guard, lifecycle, roster, recalculation, payment | `src/services/payouts.ts` |
| 8 | Loot pools and appraisal | `src/services/payout-loot.ts`, `src/services/appraisal.ts` |
| 9 | Pages and server actions | `src/app/payouts/**` |
| 10 | End-to-end coverage | `e2e/payouts.spec.ts` |

Tasks 1–5 are independent of each other after Task 1. Tasks 6–8 depend on Task 1; Task 8 depends on Tasks 3–5. Task 9 depends on 7–8. Task 10 depends on 9.

---

### Task 1: Payout schema, constraints, and migration

**Files:**
- Modify: `src/db/schema.ts` (append after the `auditLog` export; add `check` and
  `numeric` to the `drizzle-orm/pg-core` import at the top of the file)
- Modify: `src/db/tables.ts:13-25` (append five names to `MANAGED_TABLES`)
- Create: `drizzle/0004_<generated>.sql` (via `npm run db:generate`, never hand-written)
- Test: `tests/payout-schema.test.ts`

**Interfaces:**
- Consumes: `account` and `character` tables already exported from `src/db/schema.ts`.
- Produces (exact export names, consumed by Task 2 and later service-layer tasks):
  `payoutOperationStatusEnum`, `lootValuationSourceEnum`, `lootPriceSourceEnum`,
  `payoutPaymentKindEnum`, `payoutOperation`, `lootPool`, `lootItem`,
  `payoutParticipant`, `payoutPayment` — each a `pgTable`/`pgEnum` export from
  `src/db/schema.ts`, columns and check-constraint names exactly as below.

- [ ] **Step 1: Write the failing test**

```ts
// tests/payout-schema.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lootPool, payoutOperation, payoutParticipant } from "@/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("payout schema", () => {
  it("creates an operation, a pool, and a participant with defaults", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Thursday roam", occurredAt: new Date() })
      .returning();
    expect(op.status).toBe("draft");
    expect(op.corpSharePct).toBe("0.00");

    const [pool] = await ctx.db
      .insert(lootPool)
      .values({
        operationId: op.id,
        valuationSource: "flat",
        totalValue: "1000.00",
        notes: "sold privately",
      })
      .returning();
    expect(pool.totalValue).toBe("1000.00");

    const [participant] = await ctx.db
      .insert(payoutParticipant)
      .values({ operationId: op.id, displayName: "Some Pilot" })
      .returning();
    expect(participant.shares).toBe("1.00");
    expect(participant.excluded).toBe(false);
    expect(participant.paidAmount).toBeNull();
  });

  it("rejects a negative share count", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expect(
      ctx.db
        .insert(payoutParticipant)
        .values({ operationId: op.id, displayName: "Bad Share", shares: "-1" }),
    ).rejects.toThrow();
  });

  it("rejects a corpSharePct over 100", async () => {
    await expect(
      ctx.db
        .insert(payoutOperation)
        .values({ name: "Op", occurredAt: new Date(), corpSharePct: "101" }),
    ).rejects.toThrow();
  });

  it("rejects a flat pool with no note", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expect(
      ctx.db.insert(lootPool).values({
        operationId: op.id,
        valuationSource: "flat",
        totalValue: "500.00",
      }),
    ).rejects.toThrow();
  });

  it("rejects an appraised pool with both stationId and regionId set", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expect(
      ctx.db.insert(lootPool).values({
        operationId: op.id,
        valuationSource: "appraised",
        pricingMode: "sell_best",
        stationId: 60003760,
        regionId: 10000002,
        totalValue: "500.00",
      }),
    ).rejects.toThrow();
  });

  it("rejects an appraised pool with neither stationId nor regionId set", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expect(
      ctx.db.insert(lootPool).values({
        operationId: op.id,
        valuationSource: "appraised",
        pricingMode: "sell_best",
        totalValue: "500.00",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/payout-schema.test.ts`
Expected: FAIL — `@/db/schema` has no exported member `payoutOperation` (and the
other two names), a TypeScript/module resolution error, since none of the five
tables exist yet.

- [ ] **Step 3: Implement**

Add `check` and `numeric` to the existing `drizzle-orm/pg-core` import list at
the top of `src/db/schema.ts` (alongside `bigint`, `boolean`, `index`, `jsonb`,
`pgEnum`, `pgTable`, `serial`, `text`, `timestamp`, `unique`, `uuid`). Then
append the following after the `auditLog` export (order matters only in that it
must come after `account` and `character`, which it references):

```ts
export const payoutOperationStatusEnum = pgEnum("payout_operation_status", [
  "draft",
  "finalized",
]);
export const lootValuationSourceEnum = pgEnum("loot_valuation_source", ["appraised", "flat"]);
export const lootPriceSourceEnum = pgEnum("loot_price_source", [
  "triff",
  "manual",
  "unresolved",
]);
export const payoutPaymentKindEnum = pgEnum("payout_payment_kind", ["paid", "reverted"]);

export const payoutOperation = pgTable(
  "payout_operation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    battleReportUrl: text("battle_report_url"),
    createdBy: uuid("created_by").references(() => account.id, { onDelete: "set null" }),
    corpSharePct: numeric("corp_share_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    status: payoutOperationStatusEnum("status").notNull().default("draft"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "payout_operation_corp_pct_ck",
      sql`${t.corpSharePct} >= 0 AND ${t.corpSharePct} <= 100`,
    ),
  ],
);

export const lootPool = pgTable(
  "loot_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => payoutOperation.id, { onDelete: "cascade" }),
    rawPaste: text("raw_paste"),
    valuationSource: lootValuationSourceEnum("valuation_source").notNull(),
    pricingMode: text("pricing_mode"),
    stationId: bigint("station_id", { mode: "number" }),
    regionId: bigint("region_id", { mode: "number" }),
    totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    appraisedAt: timestamp("appraised_at", { withTimezone: true }),
  },
  (t) => [
    check("loot_pool_total_ck", sql`${t.totalValue} >= 0`),
    check(
      "loot_pool_flat_note_ck",
      sql`${t.valuationSource} <> 'flat' OR (${t.notes} IS NOT NULL AND ${t.notes} <> '')`,
    ),
    check(
      "loot_pool_appraised_fields_ck",
      sql`${t.valuationSource} <> 'appraised' OR (${t.pricingMode} IS NOT NULL AND (${t.stationId} IS NOT NULL) <> (${t.regionId} IS NOT NULL))`,
    ),
  ],
);

export const lootItem = pgTable(
  "loot_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => lootPool.id, { onDelete: "cascade" }),
    typeId: bigint("type_id", { mode: "number" }),
    name: text("name").notNull(),
    qty: bigint("qty", { mode: "number" }).notNull(),
    unitPrice: numeric("unit_price", { precision: 20, scale: 2 }).notNull().default("0"),
    totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull().default("0"),
    priceSource: lootPriceSourceEnum("price_source").notNull(),
  },
  (t) => [
    check("loot_item_qty_ck", sql`${t.qty} > 0`),
    check("loot_item_price_ck", sql`${t.unitPrice} >= 0 AND ${t.totalValue} >= 0`),
  ],
);

export const payoutParticipant = pgTable(
  "payout_participant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => payoutOperation.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => account.id, { onDelete: "set null" }),
    recipientCharacterId: bigint("recipient_character_id", { mode: "number" }).references(
      () => character.id,
      { onDelete: "set null" },
    ),
    displayName: text("display_name").notNull(),
    sourceCharacters: jsonb("source_characters").$type<string[]>().notNull().default([]),
    shares: numeric("shares", { precision: 6, scale: 2 }).notNull().default("1"),
    excluded: boolean("excluded").notNull().default(false),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull().default("0"),
    paidAmount: numeric("paid_amount", { precision: 20, scale: 2 }),
  },
  (t) => [
    check("payout_participant_shares_ck", sql`${t.shares} > 0`),
    check("payout_participant_amount_ck", sql`${t.amount} >= 0`),
    check(
      "payout_participant_paid_amount_ck",
      sql`${t.paidAmount} IS NULL OR ${t.paidAmount} >= 0`,
    ),
  ],
);

export const payoutPayment = pgTable("payout_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  participantId: uuid("participant_id")
    .notNull()
    .references(() => payoutParticipant.id, { onDelete: "cascade" }),
  kind: payoutPaymentKindEnum("kind").notNull(),
  amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: uuid("actor").references(() => account.id, { onDelete: "set null" }),
  note: text("note"),
});
```

In `src/db/tables.ts`, append the five names at the end of `MANAGED_TABLES`,
after `"audit_log"`:

```ts
  "wanderer_acl_observation",
  "audit_log",
  "payout_operation",
  "loot_pool",
  "loot_item",
  "payout_participant",
  "payout_payment",
] as const;
```

Then generate the migration — do not hand-write it:

```bash
npm run db:generate
```

This produces `drizzle/000N_<two-random-words>.sql` (drizzle-kit picks the
adjective-noun pair; running it in this task's own worktree produced
`drizzle/0004_furry_crystal.sql` — the next open sequence number, whatever that
is by the time this task runs) plus a matching `drizzle/meta/000N_snapshot.json`
and an updated `drizzle/meta/_journal.json`. All three generated files are
committed as-is. Confirm the generated SQL contains all nine named CHECK
constraints and that every participant/payment foreign key to `account`/
`character` reads `ON DELETE set null`, and every intra-feature foreign key
(`loot_item→loot_pool`, `loot_pool→payout_operation`,
`payout_participant→payout_operation`, `payout_payment→payout_participant`)
reads `ON DELETE cascade` — this is the deletion-behaviour invariant the design
depends on, so a generated migration that gets an `onDelete` wrong here is a
bug in Step 3 above, not something to patch by hand in the SQL file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/payout-schema.test.ts tests/seed-dev.test.ts tests/db-schema.test.ts`
Expected: all pass, including `tests/seed-dev.test.ts`'s
`MANAGED_TABLES` > "matches every table actually in the database" assertion —
this is what proves `src/db/tables.ts` was updated, not merely the schema.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/tables.ts drizzle/ tests/payout-schema.test.ts
git commit -m "feat(db): add payout schema, constraints, and migration"
```

### Task 2: Exact money arithmetic and the split

**Files:**
- Create: `src/core/payout-split.ts`
- Test: `tests/payout-split.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — this module is pure and has no DB dependency,
  by design (see spec, *The split*).
- Produces (exact signatures, consumed by `src/services/payouts.ts`'s
  `recalculate` in a later task):
  ```ts
  export function iskToCents(value: string): bigint;
  export function centsToIsk(cents: bigint): string;
  export type SplitParticipant = { id: string; shares: string; excluded: boolean };
  export type SplitResult = {
    corpAmountCents: bigint;
    perShareCents: bigint;
    amounts: Map<string, bigint>;
  };
  export function computeSplit(input: {
    totalCents: bigint;
    corpSharePct: string;
    participants: SplitParticipant[];
  }): SplitResult;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/payout-split.test.ts
import { describe, expect, it } from "vitest";
import { centsToIsk, computeSplit, iskToCents } from "@/core/payout-split";

describe("iskToCents / centsToIsk", () => {
  it("round-trips whole and fractional amounts", () => {
    for (const [str, cents] of [
      ["0", 0n],
      ["0.00", 0n],
      ["1", 100n],
      ["1.50", 150n],
      ["1234.56", 123456n],
      ["1000000.01", 100000001n],
    ] as const) {
      expect(iskToCents(str)).toBe(cents);
      expect(centsToIsk(cents)).toBe(centsToIsk(iskToCents(centsToIsk(cents))));
    }
  });

  it("formats cents back to a canonical 2dp string", () => {
    expect(centsToIsk(0n)).toBe("0.00");
    expect(centsToIsk(100n)).toBe("1.00");
    expect(centsToIsk(150n)).toBe("1.50");
    expect(centsToIsk(5n)).toBe("0.05");
  });

  it("pads a single decimal digit", () => {
    expect(iskToCents("1.5")).toBe(150n);
    expect(iskToCents("1.05")).toBe(105n);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "1.234", "1,000", "1.", ".5", "1e5", "  "]) {
      expect(() => iskToCents(bad)).toThrow();
    }
  });
});

describe("computeSplit", () => {
  const cases: Array<{
    name: string;
    totalCents: bigint;
    corpSharePct: string;
    participants: Array<{ id: string; shares: string; excluded: boolean }>;
    expectAmounts: Record<string, bigint>;
    expectCorp: bigint;
  }> = [
    {
      name: "zero participants: everything to corp, no division",
      totalCents: 100000n,
      corpSharePct: "10.00",
      participants: [],
      expectAmounts: {},
      expectCorp: 100000n,
    },
    {
      name: "every participant excluded: same as zero participants",
      totalCents: 100000n,
      corpSharePct: "10.00",
      participants: [
        { id: "a", shares: "1", excluded: true },
        { id: "b", shares: "2", excluded: true },
      ],
      expectAmounts: { a: 0n, b: 0n },
      expectCorp: 100000n,
    },
    {
      name: "corpSharePct of 0.00: corp gets only the rounding remainder",
      totalCents: 100n, // 1.00 ISK, 3 equal shares -> 33/33/33 + 1 remainder
      corpSharePct: "0.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "b", shares: "1", excluded: false },
        { id: "c", shares: "1", excluded: false },
      ],
      expectAmounts: { a: 33n, b: 33n, c: 33n },
      expectCorp: 1n,
    },
    {
      name: "corpSharePct of 100.00: corp takes everything, no split",
      totalCents: 100000n,
      corpSharePct: "100.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "b", shares: "1", excluded: false },
      ],
      expectAmounts: { a: 0n, b: 0n },
      expectCorp: 100000n,
    },
    {
      name: "a pool smaller than the participant count: some get 0.00, remainder to corp",
      totalCents: 3n, // 0.03 ISK across 5 equal-share participants
      corpSharePct: "0.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "b", shares: "1", excluded: false },
        { id: "c", shares: "1", excluded: false },
        { id: "d", shares: "1", excluded: false },
        { id: "e", shares: "1", excluded: false },
      ],
      // pool=3, totalSharesH=500, perShare = 3*100/500 = 0 (floor) -> everyone 0
      expectAmounts: { a: 0n, b: 0n, c: 0n, d: 0n, e: 0n },
      expectCorp: 3n,
    },
    {
      name: "a scout at 1.50 shares gets one and a half times a normal share",
      totalCents: 25000n, // 250.00 ISK
      corpSharePct: "0.00",
      participants: [
        { id: "scout", shares: "1.50", excluded: false },
        { id: "line1", shares: "1", excluded: false },
        { id: "line2", shares: "1", excluded: false },
      ],
      // totalSharesH = 150+100+100 = 350, pool=25000
      // perShare = 25000*100/350 = 7142 (floor)
      // scout = 7142*150/100 = 10713
      // line1 = line2 = 7142*100/100 = 7142
      // distributed = 10713+7142+7142 = 24997, remainder 3 to corp
      expectAmounts: { scout: 10713n, line1: 7142n, line2: 7142n },
      expectCorp: 3n,
    },
    {
      name: "an excluded participant is omitted from the split entirely",
      totalCents: 20000n,
      corpSharePct: "10.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "afk", shares: "1", excluded: true },
      ],
      // corpBase = 20000*1000/10000 = 2000, pool = 18000
      // totalSharesH = 100 (only "a"), perShare = 18000*100/100 = 18000
      // amount(a) = 18000*100/100 = 18000, distributed = 18000, remainder 0
      expectAmounts: { a: 18000n, afk: 0n },
      expectCorp: 2000n,
    },
  ];

  it.each(cases)("$name", ({ totalCents, corpSharePct, participants, expectAmounts, expectCorp }) => {
    const result = computeSplit({ totalCents, corpSharePct, participants });

    for (const [id, expected] of Object.entries(expectAmounts)) {
      const p = participants.find((x) => x.id === id)!;
      if (p.excluded) {
        expect(result.amounts.has(id)).toBe(false);
      } else {
        expect(result.amounts.get(id)).toBe(expected);
      }
    }
    expect(result.corpAmountCents).toBe(expectCorp);

    // Invariant: nothing is created or destroyed by the split, for every case.
    const sumAmounts = [...result.amounts.values()].reduce((sum, a) => sum + a, 0n);
    expect(result.corpAmountCents + sumAmounts).toBe(totalCents);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/payout-split.test.ts`
Expected: FAIL — `Cannot find module '@/core/payout-split'` (the file does not
exist yet).

- [ ] **Step 3: Implement**

```ts
// src/core/payout-split.ts
/**
 * ISK-cent arithmetic for the fight-payout split. Native bigint, no decimal
 * library: the split needs only +, -, x, and floor division, which bigint
 * does exactly. Drizzle returns numeric(20,2) as a string, so this module is
 * the only place strings become bigint cents and back.
 */

/** Parses a decimal ISK string (up to 2dp) into integer cents. */
export function iskToCents(value: string): bigint {
  const m = /^-?\d+(\.\d{1,2})?$/.exec(value.trim());
  if (!m) throw new Error(`not a valid ISK amount: ${value}`);
  const negative = value.trim().startsWith("-");
  const abs = negative ? value.trim().slice(1) : value.trim();
  const [whole, frac = ""] = abs.split(".");
  const paddedFrac = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(paddedFrac);
  return negative ? -cents : cents;
}

/** Formats integer cents back into a 2dp decimal string, e.g. "1234.56". */
export function centsToIsk(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const sign = negative && abs !== 0n ? "-" : "";
  return `${sign}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

export type SplitParticipant = { id: string; shares: string; excluded: boolean };

export type SplitResult = {
  corpAmountCents: bigint;
  perShareCents: bigint;
  amounts: Map<string, bigint>;
};

export function computeSplit(input: {
  totalCents: bigint;
  corpSharePct: string;
  participants: SplitParticipant[];
}): SplitResult {
  const pctBp = iskToCents(input.corpSharePct); // "10.00" -> 1000n basis points
  const corpBase = (input.totalCents * pctBp) / 10000n;
  const pool = input.totalCents - corpBase;

  const included = input.participants.filter((p) => !p.excluded);
  const sharesH = new Map(included.map((p) => [p.id, iskToCents(p.shares)]));
  const totalSharesH = [...sharesH.values()].reduce((sum, s) => sum + s, 0n);

  const perShare = totalSharesH === 0n ? 0n : (pool * 100n) / totalSharesH;

  const amounts = new Map<string, bigint>();
  let distributed = 0n;
  for (const p of included) {
    const amount = (perShare * (sharesH.get(p.id) ?? 0n)) / 100n;
    amounts.set(p.id, amount);
    distributed += amount;
  }

  const corpAmountCents = corpBase + (pool - distributed);
  return { corpAmountCents, perShareCents: perShare, amounts };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/payout-split.test.ts`
Expected: all pass, including the round-trip, malformed-input, and
`corpAmountCents + sum(amounts) === totalCents` invariant checks in every
table row.

- [ ] **Step 5: Commit**

```bash
git add src/core/payout-split.ts tests/payout-split.test.ts
git commit -m "feat(core): add exact ISK-cent split math"
```

---

### Task 3: Paste parsers (pure)

**Files:**
- Create: `src/core/roster-paste.ts`
- Create: `src/core/loot-paste.ts`
- Test: `tests/payout-parse.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no dependencies)
- Produces: `parseRosterPaste(raw: string): string[]` and
  `parseLootPaste(raw: string): ParsedLootLine[]` / `type ParsedLootLine = { name: string; qty: number }`,
  consumed later by `src/services/payouts.ts` (`resolveRosterNames`) and
  `src/services/appraisal.ts` (`appraiseLoot`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/payout-parse.test.ts
import { describe, expect, it } from "vitest";
import { parseRosterPaste } from "@/core/roster-paste";
import { parseLootPaste, type ParsedLootLine } from "@/core/loot-paste";

describe("parseRosterPaste", () => {
  const cases: Array<{ label: string; input: string; expected: string[] }> = [
    {
      label: "the real slash-separated fleet paste",
      input:
        "Brain Tartare / Gustav Oswaldo / Stealthbot / Tnklstheredneck Yaken / Zodicar",
      expected: [
        "Brain Tartare",
        "Gustav Oswaldo",
        "Stealthbot",
        "Tnklstheredneck Yaken",
        "Zodicar",
      ],
    },
    {
      label: "newline-separated names",
      input: "Brain Tartare\nGustav Oswaldo\nStealthbot",
      expected: ["Brain Tartare", "Gustav Oswaldo", "Stealthbot"],
    },
    {
      label: "mixed slash and newline separators",
      input: "Brain Tartare / Gustav Oswaldo\nStealthbot / Zodicar",
      expected: ["Brain Tartare", "Gustav Oswaldo", "Stealthbot", "Zodicar"],
    },
    {
      label: "stray whitespace around names",
      input: "  Brain Tartare  /   Gustav Oswaldo  ",
      expected: ["Brain Tartare", "Gustav Oswaldo"],
    },
    {
      label: "empty segments from doubled separators are dropped",
      input: "Brain Tartare // Gustav Oswaldo /// Zodicar",
      expected: ["Brain Tartare", "Gustav Oswaldo", "Zodicar"],
    },
    {
      label: "case-insensitive dedupe keeps the first spelling seen",
      input: "Brain Tartare / brain tartare / BRAIN TARTARE",
      expected: ["Brain Tartare"],
    },
    {
      label: "empty input yields no names",
      input: "",
      expected: [],
    },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    expect(parseRosterPaste(input)).toEqual(expected);
  });
});

describe("parseLootPaste", () => {
  const cases: Array<{ label: string; input: string; expected: ParsedLootLine[] }> = [
    {
      label: "qty-prefix format",
      input: "12x Foo",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      label: "qty-suffix format",
      input: "Foo x12",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      label: "tab-separated name and qty",
      input: "Foo\t12",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      // EVE's inventory window copies a price column too. The quantity is
      // column two; reading the last numeric column would take 500,000 as the
      // quantity and overvalue this line 5000x.
      label: "tab-separated with a trailing price column",
      input: "Tritanium\t100\t500,000",
      expected: [{ name: "Tritanium", qty: 100 }],
    },
    {
      label: "tab-separated with several trailing columns",
      input: "Nyx\t1\tSupercarrier\tShip\t1,300,000.00 m3\t22,000,000,000",
      expected: [{ name: "Nyx", qty: 1 }],
    },
    {
      label: "comma-separated name and qty",
      input: "Foo, 12",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      label: "a bare name defaults to qty 1",
      input: "Foo",
      expected: [{ name: "Foo", qty: 1 }],
    },
    {
      label: "a comma-grouped quantity parses as a single number",
      input: "1,234x Foo",
      expected: [{ name: "Foo", qty: 1234 }],
    },
    {
      label: "duplicate names across lines sum their quantities",
      input: "12x Foo\nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      label: "blank lines are skipped",
      input: "12x Foo\n\nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      label: "a whitespace-only line is skipped",
      input: "12x Foo\n   \nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    expect(parseLootPaste(input)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/payout-parse.test.ts`
Expected: FAIL with `Cannot find module '@/core/roster-paste'` (neither module exists yet).

- [ ] **Step 3: Implement**

```ts
// src/core/roster-paste.ts

/**
 * Splits the real fleet-composition paste ("A / B / C") or a newline-per-name
 * paste into names. Empty segments from doubled separators or stray
 * whitespace are dropped. Dedupe is case-insensitive but the first spelling
 * seen is kept, because that's the one the FC actually typed.
 */
export function parseRosterPaste(raw: string): string[] {
  const seen = new Map<string, string>(); // lowercase key -> first spelling
  const order: string[] = [];
  for (const segment of raw.split(/[/\n]+/)) {
    const name = segment.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, name);
      order.push(key);
    }
  }
  return order.map((key) => seen.get(key)!);
}
```

```ts
// src/core/loot-paste.ts

export type ParsedLootLine = { name: string; qty: number };

// "12x Foo", "12 Foo" — qty (with optional comma grouping) leads the line.
const QTY_PREFIX = /^(\d[\d,]*)\s*x?\s+(.+)$/i;
// "Foo x12" — qty trails the line behind a literal "x".
const QTY_SUFFIX = /^(.+?)\s+x\s*(\d[\d,]*)$/i;
// "Foo, 12" — qty trails behind a comma.
const QTY_COMMA = /^(.+),\s*(\d[\d,]*)$/;

function parseQty(text: string): number {
  return Number(text.replace(/,/g, ""));
}

/**
 * Accepts the loot-paste shapes PayGD accepted: "12x Foo", "Foo x12",
 * tab-separated "Foo\t12", comma-separated "Foo, 12", and a bare name
 * (qty 1). Quantities may use comma grouping ("1,234"). Duplicate names
 * (exact string match, matching the source tool's dict-keyed behavior) sum
 * their quantities; order of first appearance is preserved.
 */
export function parseLootPaste(raw: string): ParsedLootLine[] {
  const totals = new Map<string, number>();
  const order: string[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let qty = 1;
    let name = line;

    const prefixMatch = line.match(QTY_PREFIX);
    if (prefixMatch) {
      qty = parseQty(prefixMatch[1]);
      name = prefixMatch[2];
    } else {
      const suffixMatch = line.match(QTY_SUFFIX);
      if (suffixMatch) {
        name = suffixMatch[1];
        qty = parseQty(suffixMatch[2]);
      } else {
        const tabParts = line.split(/\t+/);
        // The SECOND field, never the last. EVE's inventory window copies more
        // than two tab-separated columns (Name / Qty / Est. Price, and wider
        // variants), so reading the last numeric field takes a price as the
        // quantity — "Tritanium\t100\t500,000" would parse as qty 500000 and
        // overvalue the line 5000x, silently, with no unresolved-item warning
        // to catch it. Column two is the quantity in every layout EVE emits.
        const secondTabPart = tabParts[1]?.trim() ?? "";
        if (tabParts.length >= 2 && /^[\d,]+$/.test(secondTabPart)) {
          qty = parseQty(secondTabPart);
          name = tabParts[0];
        } else {
          const commaMatch = line.match(QTY_COMMA);
          if (commaMatch) {
            name = commaMatch[1];
            qty = parseQty(commaMatch[2]);
          }
        }
      }
    }

    name = name.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (!totals.has(name)) order.push(name);
    totals.set(name, (totals.get(name) ?? 0) + qty);
  }

  return order.map((name) => ({ name, qty: totals.get(name)! }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/payout-parse.test.ts`
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/roster-paste.ts src/core/loot-paste.ts tests/payout-parse.test.ts
git commit -m "feat(payouts): add pure roster and loot paste parsers"
```

### Task 4: Pricing selection and the triff client

**Files:**
- Create: `src/core/pricing.ts`
- Create: `src/lib/triff/client.ts`
- Test: `tests/pricing.test.ts`
- Test: `tests/triff-client.test.ts`

**Interfaces:**
- Consumes: nothing (both pure/injectable, no dependency on Task 3 or 5).
- Produces: `PricingMode`, `PRICING_MODES`, `QuoteSides`, `selectPrice` (from
  `src/core/pricing.ts`) and `createTriffClient`, `TriffQuote`, `TriffError`,
  `TriffClientOptions` (from `src/lib/triff/client.ts`), all consumed later by
  `src/services/appraisal.ts` (`appraiseLoot`). `TriffQuote` is structurally
  assignable to `QuoteSides` (both have `sell`/`buy` `{ best, p05 }` of
  `number | null`) — `appraiseLoot` passes a `TriffQuote` straight into
  `selectPrice` with no mapping step.

- [ ] **Step 1: Write the failing test**

```ts
// tests/pricing.test.ts
import { describe, expect, it } from "vitest";
import { selectPrice, PRICING_MODES, type PricingMode, type QuoteSides } from "@/core/pricing";

describe("PRICING_MODES", () => {
  it("lists all four modes", () => {
    expect(PRICING_MODES).toEqual(["sell_best", "sell_p05", "buy_best", "buy_p05"]);
  });
});

describe("selectPrice", () => {
  const full: QuoteSides = {
    sell: { best: 5.1, p05: 5.44 },
    buy: { best: 4.9, p05: 4.61 },
  };

  const cases: Array<{
    label: string;
    quote: QuoteSides | undefined;
    mode: PricingMode;
    expected: number | null;
  }> = [
    { label: "sell_best reads sell.best", quote: full, mode: "sell_best", expected: 5.1 },
    { label: "sell_p05 reads sell.p05", quote: full, mode: "sell_p05", expected: 5.44 },
    { label: "buy_best reads buy.best", quote: full, mode: "buy_best", expected: 4.9 },
    { label: "buy_p05 reads buy.p05", quote: full, mode: "buy_p05", expected: 4.61 },
    {
      label: "sell_p05 falls back to sell.best when p05 is null",
      quote: { sell: { best: 5.1, p05: null }, buy: { best: 4.9, p05: 4.61 } },
      mode: "sell_p05",
      expected: 5.1,
    },
    {
      label: "buy_p05 falls back to buy.best when p05 is null",
      quote: { sell: { best: 5.1, p05: 5.44 }, buy: { best: 4.9, p05: null } },
      mode: "buy_p05",
      expected: 4.9,
    },
    {
      label: "sell_best returns null when sell.best is null (no further fallback)",
      quote: { sell: { best: null, p05: 5.44 }, buy: { best: 4.9, p05: 4.61 } },
      mode: "sell_best",
      expected: null,
    },
    {
      label: "both sell fields null returns null",
      quote: { sell: { best: null, p05: null }, buy: { best: 4.9, p05: 4.61 } },
      mode: "sell_p05",
      expected: null,
    },
    { label: "undefined quote returns null", quote: undefined, mode: "sell_best", expected: null },
  ];

  it.each(cases)("$label", ({ quote, mode, expected }) => {
    expect(selectPrice(quote, mode)).toBe(expected);
  });
});
```

```ts
// tests/triff-client.test.ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTriffClient, TriffError } from "@/lib/triff/client";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://triff.tools/api/market/quote";

describe("createTriffClient", () => {
  it("sends the correct query parameters for a station lookup", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(BASE, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ types: [] });
      }),
    );
    const triff = createTriffClient();
    await triff.quote([34], { stationId: 60003760 });
    expect(capturedUrl?.searchParams.get("type_ids")).toBe("34");
    expect(capturedUrl?.searchParams.get("include_aggregates")).toBe("true");
    expect(capturedUrl?.searchParams.get("include_orders")).toBe("false");
    expect(capturedUrl?.searchParams.get("station_id")).toBe("60003760");
    expect(capturedUrl?.searchParams.has("region_id")).toBe(false);
  });

  it("sends region_id instead of station_id for a region lookup", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(BASE, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ types: [] });
      }),
    );
    const triff = createTriffClient();
    await triff.quote([34], { regionId: 10000002 });
    expect(capturedUrl?.searchParams.get("region_id")).toBe("10000002");
    expect(capturedUrl?.searchParams.has("station_id")).toBe(false);
  });

  it("chunks type_ids at 900 per request", async () => {
    const requestSizes: number[] = [];
    server.use(
      http.get(BASE, ({ request }) => {
        const ids = new URL(request.url).searchParams.get("type_ids") ?? "";
        requestSizes.push(ids.split(",").length);
        return HttpResponse.json({ types: [] });
      }),
    );
    const triff = createTriffClient();
    const ids = Array.from({ length: 901 }, (_, i) => i + 1);
    await triff.quote(ids, { stationId: 60003760 });
    expect(requestSizes).toEqual([900, 1]);
  });

  it("maps the types array into a Map keyed by type id", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({
          types: [
            { type_id: 34, sell: { best: 5.1, p05: 5.44 }, buy: { best: 4.9, p05: 4.61 } },
            { type_id: 35, sell: { best: 10, p05: 10.5 }, buy: { best: 9.5, p05: 9.1 } },
          ],
        }),
      ),
    );
    const triff = createTriffClient();
    const quotes = await triff.quote([34, 35], { stationId: 60003760 });
    expect(quotes.get(34)).toEqual({
      typeId: 34,
      sell: { best: 5.1, p05: 5.44 },
      buy: { best: 4.9, p05: 4.61 },
    });
    expect(quotes.get(35)?.typeId).toBe(35);
  });

  it("throws TriffError on a non-2xx response", async () => {
    server.use(http.get(BASE, () => HttpResponse.json({ error: "boom" }, { status: 500 })));
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
    expect((err as TriffError).status).toBe(500);
  });

  it("throws TriffError on a malformed response body", async () => {
    server.use(http.get(BASE, () => HttpResponse.json({ nope: true })));
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
  });

  it("throws TriffError when neither stationId nor regionId is given", async () => {
    const triff = createTriffClient();
    await expect(triff.quote([34], {})).rejects.toBeInstanceOf(TriffError);
  });

  it("throws TriffError when both stationId and regionId are given", async () => {
    const triff = createTriffClient();
    await expect(
      triff.quote([34], { stationId: 60003760, regionId: 10000002 }),
    ).rejects.toBeInstanceOf(TriffError);
  });

  it("leaves a type id out of the map when triff has no quote for it", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({
          types: [{ type_id: 34, sell: { best: 5, p05: 5 }, buy: { best: 4, p05: 4 } }],
        }),
      ),
    );
    const triff = createTriffClient();
    const quotes = await triff.quote([34, 99], { stationId: 60003760 });
    expect(quotes.has(34)).toBe(true);
    expect(quotes.has(99)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/pricing.test.ts tests/triff-client.test.ts`
Expected: FAIL with `Cannot find module '@/core/pricing'` and `Cannot find module '@/lib/triff/client'` (neither module exists yet).

- [ ] **Step 3: Implement**

```ts
// src/core/pricing.ts

export type PricingMode = "sell_best" | "sell_p05" | "buy_best" | "buy_p05";

export const PRICING_MODES: readonly PricingMode[] = [
  "sell_best",
  "sell_p05",
  "buy_best",
  "buy_p05",
];

export type QuoteSides = {
  sell: { best: number | null; p05: number | null };
  buy: { best: number | null; p05: number | null };
};

/**
 * Mirrors PayGD's choose_price: pick the requested side/field, and if a p05
 * request comes back null fall back to that side's best (triff sometimes has
 * too few orders to compute a percentile). A missing "best" has nothing left
 * to fall back to and stays null — callers turn that into an unresolved item,
 * never a silently smaller total.
 */
export function selectPrice(q: QuoteSides | undefined, mode: PricingMode): number | null {
  if (!q) return null;
  const side = mode.startsWith("sell") ? q.sell : q.buy;
  const field = mode.endsWith("p05") ? "p05" : "best";
  const primary = side[field];
  if (primary !== null) return primary;
  if (field === "p05") return side.best;
  return null;
}
```

```ts
// src/lib/triff/client.ts
import { z } from "zod";
import { chunk } from "@/core/chunk";

const TRIFF_QUOTE_URL = "https://triff.tools/api/market/quote";
const QUOTE_CHUNK = 900;

export class TriffError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface TriffClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export type TriffQuote = {
  typeId: number;
  sell: { best: number | null; p05: number | null };
  buy: { best: number | null; p05: number | null };
};

const sideSchema = z
  .object({
    best: z.number().nullable().optional(),
    p05: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const quoteResponseSchema = z.object({
  types: z.array(
    z.object({
      type_id: z.number().int(),
      sell: sideSchema,
      buy: sideSchema,
    }),
  ),
});

export function createTriffClient(opts: TriffClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  function safeParse(data: unknown, status: number): z.infer<typeof quoteResponseSchema> {
    const parsed = quoteResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new TriffError("triff quote: malformed response body", status);
    }
    return parsed.data;
  }

  async function quoteChunk(
    typeIds: number[],
    loc: { stationId?: number; regionId?: number },
  ): Promise<Map<number, TriffQuote>> {
    const params = new URLSearchParams({
      type_ids: typeIds.join(","),
      include_aggregates: "true",
      include_orders: "false",
    });
    if (loc.stationId !== undefined) params.set("station_id", String(loc.stationId));
    if (loc.regionId !== undefined) params.set("region_id", String(loc.regionId));

    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.userAgent) headers["user-agent"] = opts.userAgent;

    let res: Response;
    try {
      res = await fetchImpl(`${TRIFF_QUOTE_URL}?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TriffError(
        `triff quote request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new TriffError(`triff quote failed (${res.status})`, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TriffError("triff quote: malformed response body", res.status);
    }
    const parsed = safeParse(body, res.status);

    const out = new Map<number, TriffQuote>();
    for (const t of parsed.types) {
      out.set(t.type_id, {
        typeId: t.type_id,
        sell: { best: t.sell?.best ?? null, p05: t.sell?.p05 ?? null },
        buy: { best: t.buy?.best ?? null, p05: t.buy?.p05 ?? null },
      });
    }
    return out;
  }

  async function quote(
    typeIds: number[],
    loc: { stationId?: number; regionId?: number },
  ): Promise<Map<number, TriffQuote>> {
    const hasStation = loc.stationId !== undefined;
    const hasRegion = loc.regionId !== undefined;
    if (hasStation === hasRegion) {
      throw new TriffError("triff quote: exactly one of stationId or regionId is required");
    }
    if (typeIds.length === 0) return new Map();

    const result = new Map<number, TriffQuote>();
    for (const ids of chunk(typeIds, QUOTE_CHUNK)) {
      const partial = await quoteChunk(ids, loc);
      for (const [id, q] of partial) result.set(id, q);
    }
    return result;
  }

  return { quote };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/pricing.test.ts tests/triff-client.test.ts`
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pricing.ts src/lib/triff/client.ts tests/pricing.test.ts tests/triff-client.test.ts
git commit -m "feat(payouts): add pricing selection and the triff market client"
```

### Task 5: ESI resolveIds

**Files:**
- Modify: `src/lib/esi/client.ts:9` (add `RESOLVE_IDS_CHUNK` beside `AFFILIATION_MAX`)
- Modify: `src/lib/esi/client.ts:31-38` (add `universeIdsSchema` beside the other response schemas)
- Modify: `src/lib/esi/client.ts:160-161` (add the `resolveIds` function after `postAffiliation`)
- Modify: `src/lib/esi/client.ts:261-263` (add `resolveIds` to the returned object)
- Test: `tests/esi-client.test.ts` (new `describe("resolveIds", ...)` block appended)

**Interfaces:**
- Consumes: `chunk` from `src/core/chunk.ts` (existing), the existing `request`/`safeParse` closures in `createEsiClient`.
- Produces: `resolveIds(names: string[]): Promise<Map<string, number>>` on the object returned by `createEsiClient`, consumed later by `src/services/appraisal.ts` (`appraiseLoot`'s `deps.esi`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/esi-client.test.ts — append this describe block (file already imports
// http, HttpResponse, setupServer, and the vitest describe/it/expect/beforeAll
// etc. used below; BASE is already defined as
// "https://esi.evetech.net/latest")

describe("resolveIds", () => {
  it("maps lowercased names to their inventory type id", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, async ({ request }) => {
        expect(await request.json()).toEqual(["Tritanium", "Pyerite"]);
        return HttpResponse.json({
          inventory_types: [
            { id: 34, name: "Tritanium" },
            { id: 35, name: "Pyerite" },
          ],
        });
      }),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["Tritanium", "Pyerite"]);
    expect(map.get("tritanium")).toBe(34);
    expect(map.get("pyerite")).toBe(35);
  });

  it("omits names ESI does not know", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, () =>
        HttpResponse.json({ inventory_types: [{ id: 34, name: "Tritanium" }] }),
      ),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["Tritanium", "Not A Real Item"]);
    expect(map.has("tritanium")).toBe(true);
    expect(map.has("not a real item")).toBe(false);
  });

  it("chunks names at 500 per request", async () => {
    const requestSizes: number[] = [];
    server.use(
      http.post(`${BASE}/universe/ids/`, async ({ request }) => {
        const body = (await request.json()) as string[];
        requestSizes.push(body.length);
        return HttpResponse.json({ inventory_types: [] });
      }),
    );
    const esi = createEsiClient();
    const names = Array.from({ length: 501 }, (_, i) => `Item ${i}`);
    await esi.resolveIds(names);
    expect(requestSizes).toEqual([500, 1]);
  });

  it("returns an empty map when the response has no inventory_types key", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, () => HttpResponse.json({ ships: [] })),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["Tritanium"]);
    expect(map.size).toBe(0);
  });

  it("keys the map case-insensitively", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, () =>
        HttpResponse.json({ inventory_types: [{ id: 34, name: "TRITANIUM" }] }),
      ),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["tritanium"]);
    expect(map.get("tritanium")).toBe(34);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/esi-client.test.ts -t "resolveIds"`
Expected: FAIL with `esi.resolveIds is not a function` (TypeError — the method doesn't exist on the returned client yet).

- [ ] **Step 3: Implement**

Add the chunk size constant beside `AFFILIATION_MAX`:

```ts
const AFFILIATION_MAX = 500;
const RESOLVE_IDS_CHUNK = 500; // ESI POST /universe/ids/ body limit
```

Add the response schema beside `contactsSchema`:

```ts
const universeIdsSchema = z.object({
  inventory_types: z
    .array(z.object({ id: z.number().int(), name: z.string() }))
    .optional(),
});
```

Add the function after `postAffiliation`, inside `createEsiClient`:

```ts
  /**
   * Unauthenticated. Names ESI doesn't recognize are simply absent from the
   * map — appraiseLoot turns that into a visible "unresolved" line, never a
   * thrown error, so a partial paste never blocks the rest of it.
   */
  async function resolveIds(names: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const namesChunk of chunk(names, RESOLVE_IDS_CHUNK)) {
      const res = await request("/universe/ids/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(namesChunk),
      });
      const parsed = safeParse(
        universeIdsSchema,
        await res.json(),
        "POST",
        "/universe/ids/",
        res.status,
      );
      for (const t of parsed.inventory_types ?? []) {
        out.set(t.name.toLowerCase(), t.id);
      }
    }
    return out;
  }
```

Add it to the returned object, alongside `postAffiliation`:

```ts
  return {
    postAffiliation,
    resolveIds,
    getContactLabels,
    getAllContacts,
    // ...existing addContacts / editContacts / deleteContacts unchanged
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/esi-client.test.ts`
Expected: all cases pass, including the pre-existing ones (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/esi/client.ts tests/esi-client.test.ts
git commit -m "feat(esi): add resolveIds for payout loot type resolution"
```

---

### Task 6: Audit resolution for payout actions

**Files:**
- Modify: `src/services/audit.ts:19-63`, `src/services/audit.ts:77-193`
- Test: `tests/audit-resolve.test.ts` (append a `describe` block; do not rewrite the file)
- No change needed: `src/app/admin/audit/page.tsx` — `ActorCell`/`TargetCell` never
  branch on a specific `targetKind` value other than testing `targetKind === "literal"`
  and checking whether `targetName`/`targetName` is set; a fourth resolvable kind
  ("payout") falls through the same generic "has a name → show it, else show the raw
  id in mono" logic with no new branch required. Confirmed by reading both components
  in full before writing this task.

**Interfaces:**
- Consumes: `payoutOperation` table (`src/db/schema.ts`, Task 1) — reads only `id`, `name`.
- Produces: `ResolvedAuditRow["targetKind"]` including `"payout"`, consumed by
  `src/services/payouts.ts` (Task 7) and `src/services/payout-loot.ts` (Task 8)
  indirectly (they write `payout.*` actions; this task is what makes those rows
  render with names instead of raw uuids).

- [ ] **Step 1: Write the failing test**

Append this `describe` block to the end of `tests/audit-resolve.test.ts`, inside the
existing file (add `payoutOperation` to the existing `@/db/schema` import at the top:
`import { auditLog, discordLink, payoutOperation } from "@/db/schema";`):

```ts
describe("resolveAuditIdentities: payout target kind", () => {
  it("resolves a payout.paid row's target to the operation's name", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Thursday roam", occurredAt: new Date(), corpSharePct: "10.00" })
      .returning();
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.paid",
      target: op.id,
      details: { participantId: "irrelevant-here" },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("payout");
    expect(row.targetName).toBe("Thursday roam");
    expect(row.target).toBe(op.id); // raw uuid preserved
  });

  it("leaves an unknown operation uuid unresolved, raw target preserved", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.finalized",
      target: fakeUuid,
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("unresolved");
    expect(row.targetName).toBeNull();
    expect(row.target).toBe(fakeUuid);
  });

  it("does not misclassify a payout row as an account, even though both target uuids", async () => {
    // Same uuid shape as an account id, seeded as a payout operation only —
    // if targetKindFromAction ever fell back to "account" for payout.* this
    // would spuriously resolve via the account/character join instead.
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90101,
      accountId: acc.id,
      name: "Should Not Appear",
      main: true,
    });
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Roster test", occurredAt: new Date(), corpSharePct: "0" })
      .returning();
    await logAudit(ctx.db, { actor: "system", action: "payout.roster_set", target: op.id });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("payout");
    expect(row.targetName).toBe("Roster test");
    expect(row.targetName).not.toBe("Should Not Appear");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/audit-resolve.test.ts -t "payout target kind"`
Expected: FAIL — `payoutOperation` is not (yet) exported from `@/db/schema` in this
worktree state / `targetKind` never returns `"payout"` (`expect(row.targetKind).toBe("payout")` fails, actual `"unresolved"`).

- [ ] **Step 3: Implement**

Replace the comment + `targetKindFromAction` (currently `src/services/audit.ts:29-63`):

```ts
/**
 * Every target is written by exactly one call site shape in this codebase
 * (grep `logAudit(` across src/), so the *action* namespace is a reliable,
 * intentional signal for what a target string means — unlike its shape. An
 * EVE character id and a Discord snowflake are both bare digit strings, so
 * shape alone (or a magnitude heuristic, since snowflakes are ~18-19 digits
 * and character ids are ~9-10) would work only by coincidence today and
 * silently rot the day either numbering scheme changes. `discord.*` actions
 * only ever target a Discord user id; `character.*` / `token.*` /
 * `wanderer.*` only ever target an EVE character id; `payout.*` actions only
 * ever target a `payout_operation` uuid; everything else (`tier.*`,
 * `status.*`, `account.*`, `admin.*`, `sync.*`) targets an account. The
 * literal broadcast target `"all"` (used by `sync.*`) is short-circuited by
 * the caller before this function is consulted, so `sync.*` reaching here
 * always means the account-uuid form.
 */
function targetKindFromAction(
  action: string,
): "account" | "character" | "discord" | "payout" | null {
  if (action.startsWith("discord.")) return "discord";
  if (
    action.startsWith("character.") ||
    action.startsWith("token.") ||
    action.startsWith("wanderer.")
  )
    return "character";
  if (action.startsWith("payout.")) return "payout";
  if (
    action.startsWith("tier.") ||
    action.startsWith("status.") ||
    action.startsWith("account.") ||
    action.startsWith("admin.") ||
    action.startsWith("sync.")
  )
    return "account";
  return null;
}
```

Update the import (top of file) and `ResolvedAuditRow`:

```ts
import type { Dbx } from "@/db";
import { account, auditLog, character, discordLink, payoutOperation } from "@/db/schema";
import { and, desc, eq, inArray, like, lt } from "drizzle-orm";
```

```ts
export type ResolvedAuditRow = typeof auditLog.$inferSelect & {
  actorName: string | null;
  actorKind: "system" | "account" | "unresolved";
  targetName: string | null;
  targetKind: "account" | "character" | "discord" | "payout" | "literal" | "unresolved";
};
```

Replace `resolveAuditIdentities` (currently `src/services/audit.ts:77-193`) to add one more
batched query, in parallel with the existing two, and one more resolution branch:

```ts
/**
 * Resolves actor/target ids to human (main character) names in a fixed,
 * small number of batched queries, independent of row count:
 *   1. accounts referenced directly (as actor or an account-shaped target)
 *      + discord links referenced as a target + payout operations referenced
 *      as a target, all in parallel
 *   2. accounts reached only via a discord link (to get *their*
 *      mainCharacterId) — skipped entirely if no discord targets resolved
 *   3. every character name needed (target characters + all main characters
 *      collected above), in one shot
 * Anything that doesn't resolve is left as `null`/`"unresolved"`; the raw
 * `actor`/`target` strings on the row are always preserved unchanged.
 */
export async function resolveAuditIdentities(
  dbx: Dbx,
  rows: Array<typeof auditLog.$inferSelect>,
): Promise<ResolvedAuditRow[]> {
  if (rows.length === 0) return [];

  const accountIds = new Set<string>();
  const targetCharacterIds = new Set<number>();
  const targetDiscordIds = new Set<string>();
  const targetPayoutIds = new Set<string>();

  for (const r of rows) {
    if (r.actor !== "system" && UUID_RE.test(r.actor)) accountIds.add(r.actor);
    if (r.target === "all") continue;
    const kind = targetKindFromAction(r.action);
    if (kind === "account" && UUID_RE.test(r.target)) accountIds.add(r.target);
    else if (kind === "character" && DIGITS_RE.test(r.target))
      targetCharacterIds.add(Number(r.target));
    else if (kind === "discord" && DIGITS_RE.test(r.target))
      targetDiscordIds.add(r.target);
    else if (kind === "payout" && UUID_RE.test(r.target)) targetPayoutIds.add(r.target);
  }

  const [directAccounts, links, payoutOperations] = await Promise.all([
    accountIds.size
      ? dbx
          .select({ id: account.id, mainCharacterId: account.mainCharacterId })
          .from(account)
          .where(inArray(account.id, [...accountIds]))
      : Promise.resolve([]),
    targetDiscordIds.size
      ? dbx
          .select({
            accountId: discordLink.accountId,
            discordUserId: discordLink.discordUserId,
          })
          .from(discordLink)
          .where(inArray(discordLink.discordUserId, [...targetDiscordIds]))
      : Promise.resolve([]),
    targetPayoutIds.size
      ? dbx
          .select({ id: payoutOperation.id, name: payoutOperation.name })
          .from(payoutOperation)
          .where(inArray(payoutOperation.id, [...targetPayoutIds]))
      : Promise.resolve([]),
  ]);

  const accountById = new Map(directAccounts.map((a) => [a.id, a]));
  const discordAccountIds = links
    .map((l) => l.accountId)
    .filter((id) => !accountById.has(id));
  const discordAccounts = discordAccountIds.length
    ? await dbx
        .select({ id: account.id, mainCharacterId: account.mainCharacterId })
        .from(account)
        .where(inArray(account.id, discordAccountIds))
    : [];
  for (const a of discordAccounts) accountById.set(a.id, a);

  const discordUserToAccountId = new Map(
    links.map((l) => [l.discordUserId, l.accountId]),
  );
  const nameByPayoutId = new Map(payoutOperations.map((o) => [o.id, o.name]));

  const characterIds = new Set<number>(targetCharacterIds);
  for (const a of accountById.values()) {
    if (a.mainCharacterId !== null) characterIds.add(a.mainCharacterId);
  }
  const characters = characterIds.size
    ? await dbx
        .select({ id: character.id, name: character.name })
        .from(character)
        .where(inArray(character.id, [...characterIds]))
    : [];
  const nameByCharacterId = new Map(characters.map((c) => [c.id, c.name]));

  const mainNameOf = (accountId: string): string | null => {
    const acc = accountById.get(accountId);
    if (!acc || acc.mainCharacterId === null) return null;
    return nameByCharacterId.get(acc.mainCharacterId) ?? null;
  };

  return rows.map((r) => {
    let actorName: string | null = null;
    let actorKind: ResolvedAuditRow["actorKind"] = "unresolved";
    if (r.actor === "system") {
      actorKind = "system";
    } else if (UUID_RE.test(r.actor)) {
      const name = mainNameOf(r.actor);
      if (name !== null) {
        actorName = name;
        actorKind = "account";
      }
    }

    let targetName: string | null = null;
    let targetKind: ResolvedAuditRow["targetKind"] = "unresolved";
    if (r.target === "all") {
      targetKind = "literal";
    } else {
      const kind = targetKindFromAction(r.action);
      if (kind === "account" && UUID_RE.test(r.target)) {
        const name = mainNameOf(r.target);
        if (name !== null) {
          targetName = name;
          targetKind = "account";
        }
      } else if (kind === "character" && DIGITS_RE.test(r.target)) {
        const name = nameByCharacterId.get(Number(r.target)) ?? null;
        if (name !== null) {
          targetName = name;
          targetKind = "character";
        }
      } else if (kind === "discord" && DIGITS_RE.test(r.target)) {
        const accId = discordUserToAccountId.get(r.target);
        const name = accId !== undefined ? mainNameOf(accId) : null;
        if (name !== null) {
          targetName = name;
          targetKind = "discord";
        }
      } else if (kind === "payout" && UUID_RE.test(r.target)) {
        const name = nameByPayoutId.get(r.target) ?? null;
        if (name !== null) {
          targetName = name;
          targetKind = "payout";
        }
      }
    }

    return { ...r, actorName, actorKind, targetName, targetKind };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/audit-resolve.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/audit.ts tests/audit-resolve.test.ts
git commit -m "feat(audit): resolve payout.* targets to operation names"
```

---

### Task 7: Payout service — guard, lifecycle, roster, recalculation, payment

**Files:**
- Create: `src/services/payouts.ts`
- Modify: `tests/helpers/seed.ts` (add a `status` option to `seedAccount`, needed to
  seed a `cryo` account for the operator-guard test — no existing caller passes it,
  so this is additive and does not change any existing test's behavior)
- Test: `tests/payouts-service.test.ts`

**Interfaces:**
- Consumes: `payoutOperation`, `lootPool`, `payoutParticipant`, `payoutPayment`,
  `account`, `character` tables (Task 1); `Dbx`/`DbTx` (`src/db/index.ts`);
  `iskToCents`/`centsToIsk`/`computeSplit` (`src/core/payout-split.ts`, an earlier
  task); `logAudit` (`src/services/audit.ts`); `unlinkCharacter` (`src/services/accounts.ts`,
  unmodified, exercised as-is by this task's test).
- Produces: every export named in the contract's `src/services/payouts.ts` block —
  `PayoutForbiddenError`, `PayoutLockedError`, `requirePayoutOperator`, `canReadPayouts`,
  `lockOperation`, `hasPayments`, `assertEditable`, `createOperation`, `RosterEntry`,
  `resolveRosterNames`, `setRoster`, `setParticipantShares`, `setParticipantExcluded`,
  `removeParticipant`, `recalculate`, `finalizeOperation`, `unlockOperation`,
  `recordPayment` — consumed by `src/services/payout-loot.ts` (Task 8: `lockOperation`,
  `assertEditable`, `recalculate`) and by `src/app/payouts/actions.ts` (a later task,
  everything else).

**Design note carried into the code as a comment:** `getSessionAccount`
(`src/services/session.ts`) resolves a session to an `accountId` and checks neither
tier nor status by design — every existing caller that needs more does its own
lookup (see its own file header reasoning). `requirePayoutOperator` is that lookup
for payouts, not a change to the shared function.

**Design note on `recalculate`'s missing `actor` parameter:** the contract's
signature is `recalculate(dbtx, operationId)` — no actor. `recalculate` therefore
writes no audit row of its own; every caller that has an actor (`setRoster`,
`setParticipantShares`, `setParticipantExcluded`, `removeParticipant`,
`addAppraisedPool`, `addFlatPool`, `deletePool`) already writes its own
actor-attributed audit row for the actual change before calling `recalculate`.
`payout.recalculated` in the action list is reserved for a possible future
explicit "re-price" trigger with its own actor; nothing in PR 1 emits it.

- [ ] **Step 1: Write the failing test**

First, in `tests/helpers/seed.ts`, extend `seedAccount`'s options with `status`
and `isAdmin` (this is the only change to that file; both are additive and
default to today's behaviour, so no existing caller changes):

```ts
export async function seedAccount(
  db: Db,
  opts: {
    tier?: "flygd" | "blue" | "green";
    tierLocked?: boolean;
    status?: "active" | "cryo";
    isAdmin?: boolean;
    discordUserId?: string;
  } = {},
) {
  const [acc] = await db
    .insert(account)
    .values({
      tier: opts.tier ?? "green",
      tierLocked: opts.tierLocked ?? false,
      status: opts.status ?? "active",
      isAdmin: opts.isAdmin ?? false,
    })
    .returning();
  if (opts.discordUserId) {
    await db
      .insert(discordLink)
      .values({ accountId: acc.id, discordUserId: opts.discordUserId });
  }
  return acc;
}
```

Then create `tests/payouts-service.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/config";
import { lootPool, payoutOperation, payoutParticipant, payoutPayment } from "@/db/schema";
import { unlinkCharacter } from "@/services/accounts";
import {
  PayoutForbiddenError,
  PayoutLockedError,
  createOperation,
  finalizeOperation,
  recalculate,
  recordPayment,
  removeParticipant,
  requirePayoutOperator,
  resolveRosterNames,
  setParticipantExcluded,
  setParticipantShares,
  setRoster,
  unlockOperation,
  type RosterEntry,
} from "@/services/payouts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "https://auth.example",
    ALLIANCE_ID: "99000001",
    BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_ACL_ID: "a",
    ESI_CONTACT: "ops@example.com",
    SYNC_MODE: "live",
  } as NodeJS.ProcessEnv);
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedOperator() {
  return seedAccount(ctx.db, { tier: "flygd", status: "active" });
}

/** A finalized operation with one unpaid participant owed the whole 1000.00.
 *  The pool is inserted directly rather than through `addFlatPool` so the
 *  helper does not depend on Task 8; `setRoster` runs afterwards and its
 *  `recalculate` is what assigns the amount. */
async function seedFightWithOneUnpaidParticipant() {
  const operator = await seedOperator();
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Thursday roam",
      occurredAt: new Date(),
      corpSharePct: "0",
    }),
  );
  const [pool] = await ctx.db
    .insert(lootPool)
    .values({
      operationId,
      valuationSource: "flat",
      totalValue: "1000.00",
      notes: "sold privately",
    })
    .returning();
  const roster: RosterEntry[] = [
    {
      displayName: "Line Member",
      accountId: null,
      recipientCharacterId: null,
      sourceCharacters: ["Line Member"],
      shares: "1",
      excluded: false,
    },
  ];
  await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, roster));
  const [participant] = await ctx.db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
  return { operator, operationId, participantId: participant.id, poolId: pool.id };
}

async function seedFightWithOnePaidParticipant() {
  const seeded = await seedFightWithOneUnpaidParticipant();
  await ctx.db.transaction((tx) =>
    recordPayment(tx, seeded.operator.id, seeded.participantId),
  );
  return seeded;
}

describe("requirePayoutOperator", () => {
  it("refuses a cryo flygd account", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", status: "cryo" });
    await expect(requirePayoutOperator(ctx.db, acc.id)).rejects.toThrow(
      PayoutForbiddenError,
    );
  });

  it("refuses an active green account", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(requirePayoutOperator(ctx.db, acc.id)).rejects.toThrow(
      PayoutForbiddenError,
    );
  });

  it("allows an active flygd account", async () => {
    const acc = await seedOperator();
    await expect(requirePayoutOperator(ctx.db, acc.id)).resolves.toBeUndefined();
  });
});

describe("resolveRosterNames", () => {
  it("collapses two alts of one account into one entry named for the main", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 500001,
      accountId: acc.id,
      name: "Main Guy",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 500002, accountId: acc.id, name: "Alt Guy" });

    const entries = await resolveRosterNames(ctx.db, ["Alt Guy", "Unknown Pilot", "Main Guy"]);

    expect(entries).toHaveLength(2);
    const known = entries.find((e) => e.accountId === acc.id)!;
    expect(known.displayName).toBe("Main Guy");
    expect(known.recipientCharacterId).toBe(500001);
    expect(known.sourceCharacters).toEqual(["Alt Guy", "Main Guy"]);
    expect(known.shares).toBe("1");
    expect(known.excluded).toBe(false);

    const unknown = entries.find((e) => e.accountId === null)!;
    expect(unknown.displayName).toBe("Unknown Pilot");
    expect(unknown.recipientCharacterId).toBeNull();
    expect(unknown.sourceCharacters).toEqual(["Unknown Pilot"]);
  });
});

describe("recalculation safety", () => {
  it("recalculating after a payment leaves paidAmount untouched while amount moves", async () => {
    const { operationId, participantId, poolId, operator } =
      await seedFightWithOnePaidParticipant();
    const [paid] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(paid.amount).toBe("1000.00");
    expect(paid.paidAmount).toBe("1000.00");

    // Simulate the underlying loot value changing after payment (an operator
    // correcting a mis-typed flat total) and recalculate being invoked again.
    await ctx.db
      .update(lootPool)
      .set({ totalValue: "1200.00" })
      .where(eq(lootPool.id, poolId));
    await ctx.db.transaction((tx) => recalculate(tx, operationId));

    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(after.amount).toBe("1200.00"); // moved
    expect(after.paidAmount).toBe("1000.00"); // untouched
    void operator;
  });

  it("rejects a payout-affecting edit once a payment exists", async () => {
    const { operationId, participantId, operator } = await seedFightWithOnePaidParticipant();
    await expect(
      ctx.db.transaction((tx) => setParticipantShares(tx, operator.id, participantId, "2")),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => setParticipantExcluded(tx, operator.id, participantId, true)),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => removeParticipant(tx, operator.id, participantId)),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("unlinking a character in a paid operation leaves the participant row intact and readable", async () => {
    const operator = await seedOperator();
    const member = await seedAccount(ctx.db, { tier: "blue", status: "active" });
    await seedCharacter(ctx.db, cfg, {
      id: 600001,
      accountId: member.id,
      name: "Payee Main",
      main: true,
    });
    // second character so unlinkCharacter doesn't refuse as last_character
    await seedCharacter(ctx.db, cfg, { id: 600002, accountId: member.id, name: "Payee Spare" });

    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Fight with a payee",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db
      .insert(lootPool)
      .values({
        operationId,
        valuationSource: "flat",
        totalValue: "500.00",
        notes: "sold privately",
      });
    const roster: RosterEntry[] = [
      {
        displayName: "Payee Main",
        accountId: member.id,
        recipientCharacterId: 600001,
        sourceCharacters: ["Payee Main"],
        shares: "1",
        excluded: false,
      },
    ];
    await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, roster));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participant.id));

    const result = await ctx.db.transaction((tx) =>
      unlinkCharacter(tx, cfg, member.id, 600001),
    );
    expect(result).toEqual({ ok: true });

    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(after.displayName).toBe("Payee Main");
    expect(after.amount).toBe("500.00");
    expect(after.paidAmount).toBe("500.00");
    expect(after.recipientCharacterId).toBeNull();
  });
});

describe("recordPayment", () => {
  it("refuses a draft operation", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Draft fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db
      .insert(lootPool)
      .values({ operationId, valuationSource: "flat", totalValue: "100.00", notes: "n" });
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          displayName: "Someone",
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: ["Someone"],
          shares: "1",
          excluded: false,
        },
      ]),
    );
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await expect(
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participant.id)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("is idempotent: paying twice writes one payment row and doesn't move paidAmount", async () => {
    const { participantId, operator, operationId } = await seedFightWithOnePaidParticipant();
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId));
    const payments = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId));
    expect(payments).toHaveLength(1);
    void operationId;
  });

  /**
   * Two operators double-clicking "mark paid" at the same moment. Sequential
   * idempotence (the test above) does NOT cover this: if `paidAmount` is read
   * before the operation row lock, both transactions see null, then serialize,
   * then both insert — one payment event per click, for one payment.
   * `recordPayment` therefore locks first and re-reads the participant after.
   *
   * `vitest.config.ts` sets `fileParallelism: false`, but that is about test
   * FILES; two transactions inside one test still run concurrently against the
   * same Postgres, which is exactly what this needs.
   */
  it("two concurrent payments produce one payment row, not two", async () => {
    const { participantId, operator } = await seedFightWithOneUnpaidParticipant();

    const results = await Promise.allSettled([
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId)),
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId)),
    ]);
    // Both should succeed — the second is a no-op, not an error. If one rejects
    // with a serialization failure that is also acceptable behaviour, but the
    // row count below is the assertion that actually matters.
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);

    const payments = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId));
    expect(payments).toHaveLength(1);

    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(participant.paidAmount).toBe(payments[0].amount);
  });
});

describe("unlockOperation", () => {
  it("refuses once a payment exists", async () => {
    const { operationId, operator } = await seedFightWithOnePaidParticipant();
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("succeeds on a finalized operation with no payments", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Unpaid fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId));
    const [op] = await ctx.db
      .select()
      .from((await import("@/db/schema")).payoutOperation)
      .where(eq((await import("@/db/schema")).payoutOperation.id, operationId));
    expect(op.status).toBe("draft");
  });

  it("refuses an operator who did not create the operation and is not an admin", async () => {
    const creator = await seedOperator();
    const other = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, creator.id, {
        name: "Someone else's fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, creator.id, operationId));
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, other.id, operationId)),
    ).rejects.toThrow(PayoutForbiddenError);
  });

  it("allows an admin who did not create the operation", async () => {
    const creator = await seedOperator();
    const admin = await seedAccount(ctx.db, {
      tier: "flygd",
      status: "active",
      isAdmin: true,
    });
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, creator.id, {
        name: "Admin unlock",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, creator.id, operationId));
    await ctx.db.transaction((tx) => unlockOperation(tx, admin.id, operationId));
    const [op] = await ctx.db
      .select()
      .from(payoutOperation)
      .where(eq(payoutOperation.id, operationId));
    expect(op.status).toBe("draft");
  });
});

describe("finalization freezes the operation", () => {
  /**
   * Without this, finalizing means nothing: the numbers stay editable, and
   * `unlockOperation` has no job to do. `assertEditable` refuses on status, not
   * only on payments — see "Lifecycle" in the design doc.
   */
  it("rejects payout-affecting edits on a finalized, UNPAID operation", async () => {
    const operator = await seedOperator();
    const member = await seedAccount(ctx.db, { tier: "blue", status: "active" });
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Frozen fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          accountId: member.id,
          recipientCharacterId: null,
          displayName: "Pilot",
          sourceCharacters: ["Pilot"],
          shares: "1.00",
          excluded: false,
        },
      ]),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));

    await expect(
      ctx.db.transaction((tx) => setParticipantShares(tx, operator.id, participant.id, "2")),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, [])),
    ).rejects.toThrow(PayoutLockedError);

    // …and unlocking restores editability, which is the point of having it.
    await ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) =>
      setParticipantShares(tx, operator.id, participant.id, "2"),
    );
    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(after.shares).toBe("2.00");
  });
});

describe("the service layer is the authorization boundary", () => {
  /**
   * Server actions gate themselves, but they are not the only possible caller,
   * and a gate in the action leaves a TOCTOU window: the tier could change
   * between the action's check and the transaction's write. Each mutation
   * re-checks inside its own transaction. If any of these stop throwing, the
   * guard was dropped from that function.
   */
  it("rejects every mutation when the actor is not an active flygd account", async () => {
    const operator = await seedOperator();
    const green = await seedAccount(ctx.db, { tier: "green", status: "active" });
    const cryo = await seedAccount(ctx.db, { tier: "flygd", status: "cryo" });
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Guarded",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );

    for (const actor of [green.id, cryo.id]) {
      await expect(
        ctx.db.transaction((tx) =>
          createOperation(tx, actor, {
            name: "Nope",
            occurredAt: new Date(),
            corpSharePct: "0",
          }),
        ),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => setRoster(tx, actor, operationId, [])),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => finalizeOperation(tx, actor, operationId)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => unlockOperation(tx, actor, operationId)),
      ).rejects.toThrow(PayoutForbiddenError);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/payouts-service.test.ts`
Expected: FAIL — `Cannot find module '@/services/payouts'` (the file does not exist yet).

- [ ] **Step 3: Implement**

Create `src/services/payouts.ts`:

```ts
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
  if (!op) throw new Error("operation not found");
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
  if (!op) throw new Error("operation not found");
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
export async function resolveRosterNames(dbx: Dbx, names: string[]): Promise<RosterEntry[]> {
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
      (mainCharacterId !== null ? mainNameById.get(mainCharacterId) : undefined) ?? ch.name;
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
  await dbtx.delete(payoutParticipant).where(eq(payoutParticipant.operationId, operationId));
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

async function loadParticipantOperationId(dbtx: DbTx, participantId: string): Promise<string> {
  const [p] = await dbtx
    .select({ operationId: payoutParticipant.operationId })
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!p) throw new Error("participant not found");
  return p.operationId;
}

export async function setParticipantShares(
  dbtx: DbTx,
  actor: string,
  participantId: string,
  shares: string,
): Promise<void> {
  const operationId = await loadParticipantOperationId(dbtx, participantId);
  await requirePayoutOperator(dbtx, actor);
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
  const operationId = await loadParticipantOperationId(dbtx, participantId);
  await requirePayoutOperator(dbtx, actor);
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
  const operationId = await loadParticipantOperationId(dbtx, participantId);
  await requirePayoutOperator(dbtx, actor);
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
    const cents = p.excluded ? 0n : split.amounts.get(p.id) ?? 0n;
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
      throw new PayoutForbiddenError("only the operation's creator or an admin may unlock it");
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
  if (!ref) throw new Error("participant not found");
  const op = await lockOperation(dbtx, ref.operationId);
  if (op.status !== "finalized") {
    throw new PayoutLockedError("operation must be finalized before paying");
  }
  const [participant] = await dbtx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.id, participantId));
  if (!participant) throw new Error("participant not found");
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
  });
  await logAudit(dbtx, {
    actor,
    action: "payout.paid",
    target: op.id,
    details: { participantId, amount: participant.amount },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/payouts-service.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/payouts.ts tests/payouts-service.test.ts tests/helpers/seed.ts
git commit -m "feat(payouts): add operation/roster/split/payment service layer"
```

---

### Task 8: Loot pool service

**Files:**
- Create: `src/services/payout-loot.ts`
- Create: `src/services/appraisal.ts`
- Test: `tests/payout-loot.test.ts`
- Test: `tests/appraisal.test.ts`

**Interfaces:**
- Consumes: `lootPool`, `lootItem` tables (Task 1); `lockOperation`, `assertEditable`,
  `recalculate`, `createOperation`, `setRoster`, `finalizeOperation`, `recordPayment`,
  `PayoutLockedError`, `RosterEntry` (`src/services/payouts.ts`, Task 7);
  `logAudit` (`src/services/audit.ts`); `PricingMode`, `selectPrice`
  (`src/core/pricing.ts`, earlier task); `parseLootPaste` (`src/core/loot-paste.ts`,
  earlier task); `iskToCents`/`centsToIsk` (`src/core/payout-split.ts`, earlier task);
  `createEsiClient`'s `resolveIds` and `createTriffClient`'s `quote`
  (`src/lib/esi/client.ts` / `src/lib/triff/client.ts`, earlier tasks — this task only
  consumes their exact signatures via injected fakes, it does not implement them).
- Produces: `addAppraisedPool`, `addFlatPool`, `deletePool` (`src/services/payout-loot.ts`)
  and `appraiseLoot`, `AppraisedItem`, `AppraisalResult` (`src/services/appraisal.ts`) —
  consumed by `src/app/payouts/actions.ts` (a later task).

- [ ] **Step 1: Write the failing test**

Create `tests/appraisal.test.ts` (hand-rolled fakes for the two injectable clients —
no msw needed since both are plain injected objects):

```ts
import { describe, expect, it } from "vitest";
import { appraiseLoot } from "@/services/appraisal";

function fakeEsi(idByLowerName: Record<string, number>) {
  return {
    resolveIds: async (names: string[]) => {
      const out = new Map<string, number>();
      for (const n of names) {
        const id = idByLowerName[n.toLowerCase()];
        if (id !== undefined) out.set(n.toLowerCase(), id);
      }
      return out;
    },
  };
}

type FakeQuote = {
  sell?: { best?: number | null; p05?: number | null };
  buy?: { best?: number | null; p05?: number | null };
};

function fakeTriff(quotesByTypeId: Record<number, FakeQuote>) {
  return {
    quote: async (typeIds: number[]) => {
      const map = new Map();
      for (const id of typeIds) {
        const q = quotesByTypeId[id];
        if (q) {
          map.set(id, {
            typeId: id,
            sell: { best: q.sell?.best ?? null, p05: q.sell?.p05 ?? null },
            buy: { best: q.buy?.best ?? null, p05: q.buy?.p05 ?? null },
          });
        }
      }
      return map;
    },
  };
}

describe("appraiseLoot", () => {
  it("prices a resolved item at the chosen pricing mode", async () => {
    const result = await appraiseLoot(
      "10x Tritanium",
      { pricingMode: "sell_best", stationId: 60003760 },
      { esi: fakeEsi({ tritanium: 34 }), triff: fakeTriff({ 34: { sell: { best: 5.1 } } }) },
    );
    expect(result.items).toEqual([
      {
        typeId: 34,
        name: "Tritanium",
        qty: 10,
        unitPrice: "5.10",
        totalValue: "51.00",
        priceSource: "triff",
      },
    ]);
    expect(result.totalValue).toBe("51.00");
  });

  it("keeps an item with no known type id as a visible zero-priced row, not dropped", async () => {
    const raw = "3x Unknown Junk\n2x Tritanium";
    const result = await appraiseLoot(
      raw,
      { pricingMode: "sell_best", stationId: 60003760 },
      { esi: fakeEsi({ tritanium: 34 }), triff: fakeTriff({ 34: { sell: { best: 5 } } }) },
    );
    expect(result.items).toHaveLength(2);
    const junk = result.items.find((i) => i.name === "Unknown Junk")!;
    expect(junk).toEqual({
      typeId: null,
      name: "Unknown Junk",
      qty: 3,
      unitPrice: "0.00",
      totalValue: "0.00",
      priceSource: "unresolved",
    });
    const tri = result.items.find((i) => i.name === "Tritanium")!;
    expect(tri.totalValue).toBe("10.00");
    // The unresolved row contributes 0 to the total, but the item is present.
    expect(result.totalValue).toBe("10.00");
  });

  it("treats a type id with no price for the chosen mode as unresolved, not zero-quality data", async () => {
    const result = await appraiseLoot(
      "1x Plex",
      { pricingMode: "buy_best", stationId: 60003760 },
      { esi: fakeEsi({ plex: 44992 }), triff: fakeTriff({ 44992: { sell: { best: 3000 } } }) },
    );
    expect(result.items[0]).toMatchObject({
      typeId: 44992,
      priceSource: "unresolved",
      unitPrice: "0.00",
      totalValue: "0.00",
    });
  });

  it("sums many lines in exact cents rather than accumulating float error", async () => {
    const raw = ["1x A", "1x B", "1x C"].join("\n");
    const result = await appraiseLoot(
      raw,
      { pricingMode: "sell_best", stationId: 1 },
      {
        esi: fakeEsi({ a: 1, b: 2, c: 3 }),
        triff: fakeTriff({
          1: { sell: { best: 0.1 } },
          2: { sell: { best: 0.2 } },
          3: { sell: { best: 0.3 } },
        }),
      },
    );
    expect(result.totalValue).toBe("0.60");
  });
});
```

Create `tests/payout-loot.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lootItem, lootPool, payoutParticipant } from "@/db/schema";
import {
  PayoutForbiddenError,
  PayoutLockedError,
  createOperation,
  finalizeOperation,
  recordPayment,
  setRoster,
  type RosterEntry,
} from "@/services/payouts";
import { addAppraisedPool, addFlatPool, deletePool } from "@/services/payout-loot";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedOperation() {
  const operator = await seedAccount(ctx.db, { tier: "flygd", status: "active" });
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Fight",
      occurredAt: new Date(),
      corpSharePct: "0",
    }),
  );
  const roster: RosterEntry[] = [
    {
      displayName: "Line Member",
      accountId: null,
      recipientCharacterId: null,
      sourceCharacters: ["Line Member"],
      shares: "1",
      excluded: false,
    },
  ];
  await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, roster));
  return { operatorId: operator.id, operationId };
}

async function soleParticipantAmount(operationId: string) {
  const [p] = await ctx.db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  return p.amount;
}

describe("addAppraisedPool", () => {
  it("keeps an unresolved item as a visible zero-priced row and still totals the resolved lines", async () => {
    const { operatorId, operationId } = await seedOperation();
    await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operatorId, operationId, {
        rawPaste: "3x Unknown Junk\n2x Tritanium",
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: {
          items: [
            {
              typeId: null,
              name: "Unknown Junk",
              qty: 3,
              unitPrice: "0.00",
              totalValue: "0.00",
              priceSource: "unresolved",
            },
            {
              typeId: 34,
              name: "Tritanium",
              qty: 2,
              unitPrice: "5.00",
              totalValue: "10.00",
              priceSource: "triff",
            },
          ],
          totalValue: "10.00",
        },
      }),
    );
    const items = await ctx.db.select().from(lootItem);
    expect(items).toHaveLength(2);
    const junk = items.find((i) => i.name === "Unknown Junk")!;
    expect(junk.priceSource).toBe("unresolved");
    expect(junk.totalValue).toBe("0.00");
    expect(await soleParticipantAmount(operationId)).toBe("10.00");
  });
});

describe("addFlatPool", () => {
  it("requires a note", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, { totalValue: "500.00", notes: "" }),
      ),
    ).rejects.toThrow(/note/);
  });

  it("sums with an appraised pool into the operation total", async () => {
    const { operatorId, operationId } = await seedOperation();
    await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operatorId, operationId, {
        rawPaste: "1x Tritanium",
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: {
          items: [
            {
              typeId: 34,
              name: "Tritanium",
              qty: 1,
              unitPrice: "100.00",
              totalValue: "100.00",
              priceSource: "triff",
            },
          ],
          totalValue: "100.00",
        },
      }),
    );
    await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, {
        totalValue: "50.00",
        notes: "capital sold privately",
      }),
    );
    const pools = await ctx.db.select().from(lootPool).where(eq(lootPool.operationId, operationId));
    expect(pools).toHaveLength(2);
    expect(await soleParticipantAmount(operationId)).toBe("150.00");
  });
});

describe("deletePool", () => {
  it("triggers recalculation, taking its value back out of the total", async () => {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "200.00", notes: "note" }),
    );
    expect(await soleParticipantAmount(operationId)).toBe("200.00");

    await ctx.db.transaction((tx) => deletePool(tx, operatorId, poolId));
    expect(await soleParticipantAmount(operationId)).toBe("0.00");
    expect(await ctx.db.select().from(lootPool).where(eq(lootPool.id, poolId))).toHaveLength(0);
  });
});

describe("payment lock", () => {
  it("rejects adding a pool once the operation has a payment", async () => {
    const { operatorId, operationId } = await seedOperation();
    await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "100.00", notes: "note" }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operatorId, operationId));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operatorId, participant.id));

    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, { totalValue: "999.00", notes: "too late" }),
      ),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("rejects adding or deleting a pool once the operation is finalized", async () => {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "100.00", notes: "note" }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operatorId, operationId));

    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, { totalValue: "50.00", notes: "late" }),
      ),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => deletePool(tx, operatorId, poolId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("rejects a non-operator actor at the service layer, not just in the action", async () => {
    const { operationId } = await seedOperation();
    const green = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, green.id, operationId, { totalValue: "1.00", notes: "n" }),
      ),
    ).rejects.toThrow(PayoutForbiddenError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/appraisal.test.ts tests/payout-loot.test.ts`
Expected: FAIL — `Cannot find module '@/services/appraisal'` / `Cannot find module '@/services/payout-loot'`.

- [ ] **Step 3: Implement**

Create `src/services/appraisal.ts`:

```ts
import type { createEsiClient } from "@/lib/esi/client";
import type { createTriffClient } from "@/lib/triff/client";
import { centsToIsk, iskToCents } from "@/core/payout-split";
import { parseLootPaste } from "@/core/loot-paste";
import { selectPrice, type PricingMode } from "@/core/pricing";

export type AppraisedItem = {
  typeId: number | null;
  name: string;
  qty: number;
  unitPrice: string; // "12.34"
  totalValue: string; // "1234.00"
  priceSource: "triff" | "unresolved";
};
export type AppraisalResult = { items: AppraisedItem[]; totalValue: string };

const ZERO_PRICE = { unitPrice: "0.00", totalValue: "0.00" } as const;

/**
 * Orchestrates esi.resolveIds -> triff.quote -> parseLootPaste -> selectPrice.
 * No database access (contract: appraisal is a pure orchestration layer over
 * two injected clients so it can run interactively, see design doc "An
 * architectural exception, stated plainly"). An item with no type id, or a
 * type id with no price for the chosen mode, becomes `priceSource:
 * "unresolved"` at "0.00" — it is NEVER dropped from `items`, only from the
 * money side of the total.
 */
export async function appraiseLoot(
  raw: string,
  opts: { pricingMode: PricingMode; stationId?: number; regionId?: number },
  deps: {
    esi: Pick<ReturnType<typeof createEsiClient>, "resolveIds">;
    triff: ReturnType<typeof createTriffClient>;
  },
): Promise<AppraisalResult> {
  const lines = parseLootPaste(raw);
  const idByLowerName = await deps.esi.resolveIds(lines.map((l) => l.name));
  const typeIds = [...new Set(idByLowerName.values())];
  const quotes = typeIds.length
    ? await deps.triff.quote(typeIds, { stationId: opts.stationId, regionId: opts.regionId })
    : new Map<number, Awaited<ReturnType<typeof deps.triff.quote>> extends Map<number, infer V> ? V : never>();

  const items: AppraisedItem[] = lines.map((line) => {
    const typeId = idByLowerName.get(line.name.toLowerCase()) ?? null;
    const price = typeId !== null ? selectPrice(quotes.get(typeId), opts.pricingMode) : null;
    if (typeId === null || price === null) {
      return {
        typeId,
        name: line.name,
        qty: line.qty,
        priceSource: "unresolved",
        ...ZERO_PRICE,
      };
    }
    // Round ONCE, at the line total. Rounding the per-unit price to cents
    // first commits the error per unit and then multiplies it by qty, so it
    // scales with quantity instead of staying bounded at half a cent per
    // line: 5.005 ISK x 2,000,000,000 units loses 10,000,000 ISK, and
    // 0.004 ISK x 10,000,000 units stores 0.00 for a line genuinely worth
    // 40,000 ISK. p05 is an interpolated percentile, so sub-cent and
    // half-cent unit prices are ordinary, not hypothetical.
    // What is left is IEEE-754's ~1.1e-16 RELATIVE error on the product —
    // under a cent for any line total below ~9e13 ISK, well inside
    // numeric(20,2).
    const totalCents = BigInt(Math.round(price * line.qty * 100));
    // The stored unit price stays 2dp because that is the column's type. It
    // is a DISPLAY value: unitPrice * qty deliberately need not equal
    // totalValue, and for a sub-cent price it will not. A row where
    // unitPrice is "0.00" while totalValue is not is exactly that case, and
    // the detail page marks it rather than showing a bare 0.00 — derivable
    // from the persisted row, so no column and no migration are needed.
    const unitCents = iskToCents(price.toFixed(2));
    return {
      typeId,
      name: line.name,
      qty: line.qty,
      unitPrice: centsToIsk(unitCents),
      totalValue: centsToIsk(totalCents),
      priceSource: "triff",
    };
  });

  const totalCents = items.reduce((sum, it) => sum + iskToCents(it.totalValue), 0n);
  return { items, totalValue: centsToIsk(totalCents) };
}
```

Create `src/services/payout-loot.ts`:

```ts
import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { lootItem, lootPool } from "@/db/schema";
import type { PricingMode } from "@/core/pricing";
import { logAudit } from "@/services/audit";
import {
  assertEditable,
  lockOperation,
  recalculate,
  requirePayoutOperator,
} from "@/services/payouts";
import type { AppraisalResult } from "@/services/appraisal";

export async function addAppraisedPool(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  input: {
    rawPaste: string;
    pricingMode: PricingMode;
    stationId?: number | null;
    regionId?: number | null;
    appraisal: AppraisalResult;
  },
): Promise<{ poolId: string }> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  const [pool] = await dbtx
    .insert(lootPool)
    .values({
      operationId,
      rawPaste: input.rawPaste,
      valuationSource: "appraised",
      pricingMode: input.pricingMode,
      stationId: input.stationId ?? null,
      regionId: input.regionId ?? null,
      totalValue: input.appraisal.totalValue,
      appraisedAt: new Date(),
    })
    .returning();
  if (input.appraisal.items.length > 0) {
    await dbtx.insert(lootItem).values(
      input.appraisal.items.map((it) => ({
        poolId: pool.id,
        typeId: it.typeId,
        name: it.name,
        qty: it.qty,
        unitPrice: it.unitPrice,
        totalValue: it.totalValue,
        // "manual" (a per-item price override) is a PR2 concern; appraiseLoot
        // only ever emits "triff" or "unresolved".
        priceSource: it.priceSource,
      })),
    );
  }
  await logAudit(dbtx, {
    actor,
    action: "payout.pool_added",
    target: operationId,
    details: { poolId: pool.id, valuationSource: "appraised" },
  });
  await recalculate(dbtx, operationId);
  return { poolId: pool.id };
}

export async function addFlatPool(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  input: { rawPaste?: string | null; totalValue: string; notes: string },
): Promise<{ poolId: string }> {
  // Mirrors the DB CHECK (loot_pool_flat_note_ck) with a friendlier message,
  // checked before taking any lock since it needs no operation state.
  if (!input.notes.trim()) {
    throw new Error("a flat pool requires a note explaining the negotiated total");
  }
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  const [pool] = await dbtx
    .insert(lootPool)
    .values({
      operationId,
      rawPaste: input.rawPaste ?? null,
      valuationSource: "flat",
      totalValue: input.totalValue,
      notes: input.notes,
    })
    .returning();
  await logAudit(dbtx, {
    actor,
    action: "payout.pool_added",
    target: operationId,
    details: { poolId: pool.id, valuationSource: "flat" },
  });
  await recalculate(dbtx, operationId);
  return { poolId: pool.id };
}

export async function deletePool(dbtx: DbTx, actor: string, poolId: string): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const [pool] = await dbtx.select().from(lootPool).where(eq(lootPool.id, poolId));
  if (!pool) throw new Error("pool not found");
  await lockOperation(dbtx, pool.operationId);
  await assertEditable(dbtx, pool.operationId);
  await dbtx.delete(lootPool).where(eq(lootPool.id, poolId)); // cascades loot_item
  await logAudit(dbtx, {
    actor,
    action: "payout.pool_deleted",
    target: pool.operationId,
    details: { poolId },
  });
  await recalculate(dbtx, pool.operationId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npx vitest run tests/appraisal.test.ts tests/payout-loot.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/payout-loot.ts src/services/appraisal.ts tests/payout-loot.test.ts tests/appraisal.test.ts
git commit -m "feat(payouts): add loot pool persistence and appraisal orchestration"
```

---

### Task 9: Payout pages and server actions

**Files:**
- Create: `src/services/payout-view.ts`
- Create: `src/app/payouts/access.ts`
- Create: `src/app/payouts/actions.ts`
- Create: `src/app/payouts/page.tsx`
- Create: `src/app/payouts/new/page.tsx`
- Create: `src/app/payouts/[id]/copy-amount-button.tsx`
- Create: `src/app/payouts/[id]/page.tsx`
- Test: none — `page.tsx` files are not vitest-covered in this repo (route
  handlers are; pages aren't). Coverage is `npm run typecheck` here and the
  Playwright spec in Task 10.

**Interfaces:**
- Consumes: `src/services/payouts.ts` (`PayoutForbiddenError`,
  `PayoutLockedError`, `requirePayoutOperator`, `canReadPayouts`,
  `hasPayments`, `createOperation`, `RosterEntry`, `resolveRosterNames`,
  `setRoster`, `setParticipantShares`, `setParticipantExcluded`,
  `removeParticipant`, `finalizeOperation`, `unlockOperation`,
  `recordPayment`); `src/services/payout-loot.ts` (`addAppraisedPool`,
  `addFlatPool`, `deletePool`); `src/services/appraisal.ts` (`appraiseLoot`,
  `AppraisalResult`); `src/core/pricing.ts` (`PricingMode`, `PRICING_MODES`);
  `src/core/roster-paste.ts` (`parseRosterPaste`); `src/lib/triff/client.ts`
  (`createTriffClient`, `TriffError`); `src/lib/esi/client.ts`
  (`createEsiClient`); `src/db/schema.ts` (`payoutOperation`, `lootPool`,
  `lootItem`, `payoutParticipant`, `payoutPayment`); `src/db` (`getDb`, `Dbx`);
  `src/config.ts` (`getConfig`); `src/services/session.ts`
  (`getSessionAccount`).
- Produces: `src/services/payout-view.ts` exports
  `listPayoutOperations(dbx): Promise<PayoutOperationSummary[]>` and
  `getPayoutOperationDetail(dbx, operationId): Promise<PayoutOperationDetail | null>`
  — new read-only helpers, not in CONTRACT.md, filling the gap between the
  contract's write-oriented `src/services/payouts.ts` and what the list/detail
  pages need to render. `src/app/payouts/access.ts` exports
  `requirePayoutReader(): Promise<PayoutAccess | null>` (`PayoutAccess = {
  accountId: string; isOperator: boolean; isAdmin: boolean }`), used by every
  page in this task and by Task 10's e2e spec indirectly (through the pages).
  `src/app/payouts/actions.ts` exports `createOperationAction`,
  `addAppraisedPoolAction`, `addFlatPoolAction`, `deletePoolAction`,
  `setRosterAction`, `setParticipantSharesAction`,
  `setParticipantExcludedAction`, `removeParticipantAction`, `finalizeAction`,
  `unlockAction`, `markPaidAction` — the exact set Task 10's spec drives
  through the rendered forms (Task 10 never imports these directly; it clicks
  buttons).

- [ ] **Step 1: Add the read-only view service**

`src/services/payouts.ts` (built in an earlier task) only exposes the
mutation-and-guard surface CONTRACT.md lists — there is deliberately no
"list all operations" or "get one with its pools/roster" query in it, because
those are pure reads with no invariant to protect. Following the same split
the codebase already uses for `account-view.ts` / `admin-accounts.ts` next to
the mutating `accounts.ts`, this file is the read side for payouts.

```ts
// src/services/payout-view.ts
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Dbx } from "@/db";
import {
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
};

/**
 * One row per operation for the /payouts list. Reads only — the list page has
 * nothing to protect, unlike setRoster/addAppraisedPool/etc, which is why this
 * lives outside the guarded service in src/services/payouts.ts.
 */
export async function listPayoutOperations(
  dbx: Dbx,
): Promise<PayoutOperationSummary[]> {
  const [ops, pools, participants, payments] = await Promise.all([
    dbx.select().from(payoutOperation).orderBy(desc(payoutOperation.occurredAt)),
    dbx.select().from(lootPool),
    dbx.select().from(payoutParticipant),
    dbx.select().from(payoutPayment),
  ]);

  // bigint cents, not Number: numeric(20,2) holds values far past 2^53, and the
  // "no floats" constraint is not relaxed just because this is the read side.
  const totalByOp = new Map<string, bigint>();
  for (const p of pools) {
    totalByOp.set(p.operationId, (totalByOp.get(p.operationId) ?? 0n) + iskToCents(p.totalValue));
  }
  const participantsByOp = new Map<string, typeof participants>();
  for (const p of participants) {
    const list = participantsByOp.get(p.operationId) ?? [];
    list.push(p);
    participantsByOp.set(p.operationId, list);
  }
  // PR 1 only ever writes payout_payment.kind = 'paid' (reverted is schema-only
  // until PR 2), so "has a paid row" and "last event is paid" agree. The fold
  // in the design doc only diverges from a plain existence check once
  // 'reverted' rows exist.
  const paidParticipantIds = new Set(
    payments.filter((p) => p.kind === "paid").map((p) => p.participantId),
  );

  return ops.map((op) => {
    // Excluded rows are not owed anything and are not part of "how many have
    // been paid" — an all-excluded roster reading as 0/0 rather than 0/N.
    const owed = (participantsByOp.get(op.id) ?? []).filter((p) => !p.excluded);
    return {
      id: op.id,
      name: op.name,
      occurredAt: op.occurredAt,
      status: op.status,
      totalValue: centsToIsk(totalByOp.get(op.id) ?? 0n),
      participantCount: owed.length,
      paidCount: owed.filter((p) => paidParticipantIds.has(p.id)).length,
    };
  });
}

export type PayoutPoolView = typeof lootPool.$inferSelect & {
  items: Array<typeof lootItem.$inferSelect>;
};

export type ParticipantPaymentState = "excluded" | "unpaid" | "paid";

export type PayoutParticipantView = typeof payoutParticipant.$inferSelect & {
  paymentState: ParticipantPaymentState;
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
    dbx.select().from(lootPool).where(eq(lootPool.operationId, operationId)),
    dbx
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId))
      .orderBy(asc(payoutParticipant.displayName)),
    hasPayments(dbx, operationId),
  ]);

  const poolIds = pools.map((p) => p.id);
  const items = poolIds.length
    ? await dbx.select().from(lootItem).where(inArray(lootItem.poolId, poolIds))
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
        .orderBy(asc(payoutPayment.at))
    : [];
  const paidParticipantIds = new Set(
    payments.filter((p) => p.kind === "paid").map((p) => p.participantId),
  );

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
      paymentState: p.excluded
        ? "excluded"
        : paidParticipantIds.has(p.id)
          ? "paid"
          : "unpaid",
    })),
    totalValue: centsToIsk(totalCents),
    corpAmount,
    locked,
  };
}
```

- [ ] **Step 2: Add the shared read-access helper**

Every page in this feature needs the same gate — `canReadPayouts` or redirect
— and the list/new pages additionally need to know whether the signed-in
account may mutate, to decide whether to render a control at all (the action
re-checks regardless; this is only about not showing a button that will
reject). This is not a `"use server"` file: it is plain server-side code
imported by pages, kept separate from `actions.ts` so that file stays
exclusively the `"use server"` export surface.

```ts
// src/app/payouts/access.ts
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { account } from "@/db/schema";
import { canReadPayouts, requirePayoutOperator } from "@/services/payouts";
import { getSessionAccount } from "@/services/session";

export type PayoutAccess = {
  accountId: string;
  /** tier flygd AND status active — the requirePayoutOperator gate, mirrored
   *  here only to decide what to render; every mutation re-checks itself. */
  isOperator: boolean;
  isAdmin: boolean;
};

/**
 * Session → payout read access, or null when there is no session or the
 * account is not tier `flygd` (canReadPayouts is tier-only, any status —
 * a cryo flygd member still reads everything, per the design's "Access and
 * visibility" section). Pages redirect on null; they do not render a partial
 * page and hide pieces of it.
 */
export async function requirePayoutReader(): Promise<PayoutAccess | null> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) return null;
  const db = getDb();
  const sess = await getSessionAccount(db, sid);
  if (!sess) return null;
  if (!(await canReadPayouts(db, sess.accountId))) return null;

  const [acc] = await db.select().from(account).where(eq(account.id, sess.accountId));
  const isOperator = await requirePayoutOperator(db, sess.accountId)
    .then(() => true)
    .catch(() => false);
  return { accountId: sess.accountId, isOperator, isAdmin: acc?.isAdmin ?? false };
}
```

- [ ] **Step 3: Add the server actions**

Every action re-derives the session and re-asserts `requirePayoutOperator`
itself — the pages hide controls a non-operator can't use, but the action is
the actual boundary, per this feature's "authorization is enforced in the
service layer, not only in the server action" rule extended one layer up: the
action layer doesn't trust the page either.

```ts
// src/app/payouts/actions.ts
"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { appraiseLoot } from "@/services/appraisal";
import { addAppraisedPool, addFlatPool, deletePool } from "@/services/payout-loot";
import {
  createOperation,
  finalizeOperation,
  recordPayment,
  removeParticipant,
  requirePayoutOperator,
  resolveRosterNames,
  setParticipantExcluded,
  setParticipantShares,
  setRoster,
  unlockOperation,
} from "@/services/payouts";
import { getSessionAccount } from "@/services/session";
import { createEsiClient } from "@/lib/esi/client";
import { createTriffClient, TriffError } from "@/lib/triff/client";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { parseRosterPaste } from "@/core/roster-paste";

async function requireOperatorAccount(): Promise<string> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) throw new Error("not signed in");
  const sess = await getSessionAccount(getDb(), sid);
  if (!sess) throw new Error("not signed in");
  // Throws PayoutForbiddenError for anyone not flygd+active — a cryo flygd
  // member reaches every action here and is rejected right here, not by a
  // guard the page merely hoped was upstream.
  await requirePayoutOperator(getDb(), sess.accountId);
  return sess.accountId;
}

function revalidateOperation(operationId: string): void {
  revalidatePath(`/payouts/${operationId}`);
  revalidatePath("/payouts");
}

export async function createOperationAction(formData: FormData): Promise<void> {
  const actor = await requireOperatorAccount();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("name is required");
  const occurredAt = new Date(String(formData.get("occurredAt") ?? ""));
  if (Number.isNaN(occurredAt.getTime())) throw new Error("invalid date");
  const battleReportUrl = String(formData.get("battleReportUrl") ?? "").trim() || null;
  const corpSharePct = String(formData.get("corpSharePct") ?? "0").trim() || "0";
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const { id } = await getDb().transaction((dbtx) =>
    createOperation(dbtx, actor, {
      name,
      occurredAt,
      battleReportUrl,
      corpSharePct,
      notes,
    }),
  );
  revalidatePath("/payouts");
  redirect(`/payouts/${id}`);
}

export async function addAppraisedPoolAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const rawPaste = String(formData.get("rawPaste") ?? "");
  const pricingModeRaw = String(formData.get("pricingMode") ?? "");
  if (!PRICING_MODES.includes(pricingModeRaw as PricingMode)) {
    throw new Error("invalid pricing mode");
  }
  const pricingMode = pricingModeRaw as PricingMode;
  const stationRaw = String(formData.get("stationId") ?? "").trim();
  const regionRaw = String(formData.get("regionId") ?? "").trim();
  const stationId = stationRaw ? Number(stationRaw) : undefined;
  const regionId = regionRaw ? Number(regionRaw) : undefined;
  if ((stationId === undefined) === (regionId === undefined)) {
    // triff accepts exactly one of station_id/region_id; this mirrors
    // loot_pool_appraised_fields_ck so the operator sees the same rule the
    // database would otherwise enforce with a much less useful error.
    throw new Error("provide exactly one of station or region");
  }

  // ARCHITECTURAL EXCEPTION to "enqueue, don't execute" (see the design doc's
  // "An architectural exception, stated plainly"): appraisal is interactive —
  // the operator pastes loot and waits for a number, adjusts the pricing mode,
  // and pastes again — and this call is read-only and idempotent, so a lost or
  // duplicated call is a re-click, not a corrupted record. That is what makes
  // calling triff/ESI directly from the web tier safe here and nowhere else.
  const cfg = getConfig();
  const esi = createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` });
  const triff = createTriffClient();

  try {
    const appraisal = await appraiseLoot(
      rawPaste,
      { pricingMode, stationId, regionId },
      { esi, triff },
    );
    await getDb().transaction((dbtx) =>
      addAppraisedPool(dbtx, actor, operationId, {
        rawPaste,
        pricingMode,
        stationId: stationId ?? null,
        regionId: regionId ?? null,
        appraisal,
      }),
    );
  } catch (err) {
    if (err instanceof TriffError) {
      // Visible error on the appraisal form, pool left unvalued — never a
      // silent partial total, per the design's Pricing/Failure handling.
      redirect(`/payouts/${operationId}?error=appraisal_failed`);
    }
    throw err;
  }
  revalidateOperation(operationId);
}

export async function addFlatPoolAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const totalValue = String(formData.get("totalValue") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!notes) throw new Error("a flat pool requires a note explaining the number");
  const rawPaste = String(formData.get("rawPaste") ?? "").trim() || null;

  await getDb().transaction((dbtx) =>
    addFlatPool(dbtx, actor, operationId, { rawPaste, totalValue, notes }),
  );
  revalidateOperation(operationId);
}

export async function deletePoolAction(
  operationId: string,
  poolId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => deletePool(dbtx, actor, poolId));
  revalidateOperation(operationId);
}

export async function setRosterAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const raw = String(formData.get("paste") ?? "");
  const names = parseRosterPaste(raw);
  await getDb().transaction(async (dbtx) => {
    const entries = await resolveRosterNames(dbtx, names);
    await setRoster(dbtx, actor, operationId, entries);
  });
  revalidateOperation(operationId);
}

export async function setParticipantSharesAction(
  operationId: string,
  participantId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const shares = String(formData.get("shares") ?? "").trim();
  if (!shares) throw new Error("shares is required");
  await getDb().transaction((dbtx) =>
    setParticipantShares(dbtx, actor, participantId, shares),
  );
  revalidateOperation(operationId);
}

export async function setParticipantExcludedAction(
  operationId: string,
  participantId: string,
  excluded: boolean,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) =>
    setParticipantExcluded(dbtx, actor, participantId, excluded),
  );
  revalidateOperation(operationId);
}

export async function removeParticipantAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => removeParticipant(dbtx, actor, participantId));
  revalidateOperation(operationId);
}

export async function finalizeAction(operationId: string): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => finalizeOperation(dbtx, actor, operationId));
  revalidateOperation(operationId);
}

export async function unlockAction(operationId: string): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => unlockOperation(dbtx, actor, operationId));
  revalidateOperation(operationId);
}

export async function markPaidAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => recordPayment(dbtx, actor, participantId));
  revalidateOperation(operationId);
}
```

- [ ] **Step 4: Add the list page**

```tsx
// src/app/payouts/page.tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { listPayoutOperations } from "@/services/payout-view";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { requirePayoutReader } from "./access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payouts",
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function PayoutsPage() {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const ops = await listPayoutOperations(getDb());

  const nav = [
    { key: "account", href: "/account", label: "Account" },
    { key: "payouts", href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ key: "admin", href: "/admin/accounts", label: "Admin" }] : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="payouts" />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          <h1>Payouts</h1>
          <p className="page__lede">
            Every fight operation authGD has recorded: what it was worth, who was in
            it, and who has been paid.
          </p>
        </div>

        {/* Any flygd member reads every operation (transparency is the cheapest
            reconciliation mechanism the design has); only an operator — flygd
            AND active — gets the control that starts a new one. A cryo flygd
            member sees the list with no button here, and the action rejects
            regardless if they reach it another way. */}
        {access.isOperator && (
          <p className="btn-row pager">
            <a className="btn btn--primary" href="/payouts/new">
              New operation
            </a>
          </p>
        )}

        <RuleHead as="h2">
          {ops.length === 1 ? "1 operation" : `${ops.length} operations`}
        </RuleHead>
        <Scroller label="Operations">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Date</th>
                <th scope="col">Status</th>
                <th scope="col">Total</th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op) => (
                <tr key={op.id}>
                  <td>
                    <a href={`/payouts/${op.id}`}>{op.name}</a>
                  </td>
                  <td className="mono nowrap">{fmtDate(op.occurredAt)}</td>
                  <td>
                    {op.status === "finalized" ? (
                      <Status tone="ok">finalized</Status>
                    ) : (
                      <Status tone="off">draft</Status>
                    )}
                  </td>
                  <td className="mono nowrap">{op.totalValue} ISK</td>
                  <td className="mono nowrap">
                    {op.paidCount}/{op.participantCount}
                  </td>
                </tr>
              ))}
              {ops.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={5}>
                    No operations recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Scroller>
      </main>
    </>
  );
}
```

- [ ] **Step 5: Add the create-operation page**

```tsx
// src/app/payouts/new/page.tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { requirePayoutReader } from "../access";
import { createOperationAction } from "../actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New payout operation",
};

export default async function NewPayoutPage() {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  // A cryo flygd member (or any non-operator flygd reader) can reach this URL
  // directly; the list page hides the link, this page hides the form, and the
  // action rejects anyway. Reading a form that will only reject on submit is
  // worse than not being handed the form.
  if (!access.isOperator) redirect("/payouts");

  const nav = [
    { key: "account", href: "/account", label: "Account" },
    { key: "payouts", href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ key: "admin", href: "/admin/accounts", label: "Admin" }] : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="payouts" measure="narrow" />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>New operation</h1>
          <p className="page__lede">
            One row per fight. Loot, roster, and the split are added on the
            operation once it exists.
          </p>
        </div>

        <form action={createOperationAction} className="stack">
          <label className="stack">
            Name
            <input className="field" name="name" required />
          </label>
          <label className="stack">
            Date
            <input className="field" type="date" name="occurredAt" required />
          </label>
          <label className="stack">
            Battle report URL (optional)
            <input className="field" type="url" name="battleReportUrl" />
          </label>
          <label className="stack">
            Corp share %
            <input
              className="field"
              type="number"
              name="corpSharePct"
              min="0"
              max="100"
              step="0.01"
              defaultValue="0"
              required
            />
          </label>
          <label className="stack">
            Notes (optional)
            <textarea className="field" name="notes" rows={3} />
          </label>
          <Submit className="btn btn--primary">Create operation</Submit>
        </form>
      </main>
    </>
  );
}
```

- [ ] **Step 6: Add the copy-amount client leaf**

```tsx
// src/app/payouts/[id]/copy-amount-button.tsx
"use client";

import { useState } from "react";

/**
 * The only client affordance PR 1's pay flow needs. No `esi-ui.open_window.v1`
 * scope, no window — the design defers that decision to a later PR. What
 * actually goes wrong today is transcribing a twelve-digit ISK figure by hand;
 * this removes exactly that step and nothing else.
 */
export function CopyAmountButton({ amount }: { amount: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--quiet btn--micro"
      onClick={async () => {
        await navigator.clipboard.writeText(amount);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "copied" : "copy amount"}
    </button>
  );
}
```

- [ ] **Step 7: Add the operation detail page**

```tsx
// src/app/payouts/[id]/page.tsx
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { getPayoutOperationDetail } from "@/services/payout-view";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { requirePayoutReader } from "../access";
import {
  addAppraisedPoolAction,
  addFlatPoolAction,
  createOperationAction as _unused, // re-exported only for Task 10's readability; not called here
  deletePoolAction,
  finalizeAction,
  markPaidAction,
  removeParticipantAction,
  setParticipantExcludedAction,
  setParticipantSharesAction,
  setRosterAction,
  unlockAction,
} from "../actions";
import { CopyAmountButton } from "./copy-amount-button";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payout operation",
};

const PRICING_LABELS: Record<PricingMode, string> = {
  sell_best: "Sell (best)",
  sell_p05: "Sell (5th percentile)",
  buy_best: "Buy (best)",
  buy_p05: "Buy (5th percentile)",
};

const ERRORS: Record<string, string> = {
  appraisal_failed:
    "Could not price that paste right now (triff.tools did not answer). Nothing was saved — adjust and try again, or use a flat pool.",
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function PayoutOperationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const { id } = await params;
  const { error } = await searchParams;
  const detail = await getPayoutOperationDetail(getDb(), id);
  if (!detail) notFound();
  const { operation, pools, participants, totalValue, corpAmount, locked } = detail;

  const nav = [
    { key: "account", href: "/account", label: "Account" },
    { key: "payouts", href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ key: "admin", href: "/admin/accounts", label: "Admin" }] : []),
  ];
  // Mirrors `assertEditable` exactly, so an operator discovers the freeze by the
  // controls being absent rather than by a failed submit. Both halves matter:
  // finalizing freezes the numbers (unlock reopens them), and a payment freezes
  // them permanently. Drifting from the service check here would put buttons on
  // screen that can only reject.
  const canEdit = access.isOperator && operation.status === "draft" && !locked;
  // Mirrors `unlockOperation`'s creator-or-admin check. Unlock reopens someone
  // else's committed numbers, so it is not shown to every operator.
  const canUnlock =
    access.isOperator && (operation.createdBy === access.accountId || access.isAdmin);

  return (
    <>
      <SiteHeader items={nav} current="payouts" />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          <h1>{operation.name}</h1>
          <p className="page__lede">
            {fmtDate(operation.occurredAt)}
            {operation.battleReportUrl && (
              <>
                {" · "}
                <a href={operation.battleReportUrl}>battle report</a>
              </>
            )}
          </p>
        </div>

        {error && ERRORS[error] && (
          <p className="notice notice--bad" data-glyph="!" role="alert">
            {ERRORS[error]}
          </p>
        )}

        <RuleHead as="h2">Operation</RuleHead>
        <dl className="facts">
          <dt>Status</dt>
          <dd>
            {operation.status === "finalized" ? (
              <Status tone="ok">finalized</Status>
            ) : (
              <Status tone="off">draft</Status>
            )}
          </dd>
          <dt>Corp share</dt>
          <dd className="mono">
            {corpAmount} ISK <span className="dim">({operation.corpSharePct}% + remainder)</span>
          </dd>
          <dt>Total loot</dt>
          <dd className="mono">{totalValue} ISK</dd>
          {operation.notes && (
            <>
              <dt>Notes</dt>
              <dd>{operation.notes}</dd>
            </>
          )}
        </dl>

        {access.isOperator && (
          <p className="btn-row btn-row--tight">
            {operation.status === "draft" && (
              <form action={finalizeAction.bind(null, operation.id)}>
                <Submit className="btn btn--primary">Finalize</Submit>
              </form>
            )}
            {operation.status === "finalized" && !locked && canUnlock && (
              <form action={unlockAction.bind(null, operation.id)}>
                <Submit className="btn btn--quiet">Unlock</Submit>
              </form>
            )}
          </p>
        )}

        <RuleHead as="h2" aside={<span className="dim mono">{totalValue} ISK</span>}>
          Loot pools
        </RuleHead>
        <Scroller label="Loot pools">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Value</th>
                <th scope="col">Notes</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pools.map((pool) => {
                // An unresolved item priced at 0.00 is the one thing on this page
                // an operator MUST see before finalizing: it means the total is
                // quietly low and everyone is about to be underpaid. Naming the
                // items is the whole safeguard — a count alone doesn't tell you
                // whether it's a junk module or the faction battleship.
                const unresolved = pool.items.filter((i) => i.priceSource === "unresolved");
                return (
                  <tr key={pool.id}>
                    <td>
                      {pool.valuationSource === "appraised" ? (
                        <Status tone="ok">
                          appraised
                          {pool.pricingMode && ` · ${pool.pricingMode}`}
                        </Status>
                      ) : (
                        <Status tone="warn">flat (manual)</Status>
                      )}
                    </td>
                    <td className="mono nowrap">{pool.totalValue} ISK</td>
                    <td>
                      {pool.notes}
                      {unresolved.length > 0 && (
                        <p className="notice notice--warn" data-glyph="!">
                          <span>
                            <strong>
                              {unresolved.length} item
                              {unresolved.length === 1 ? "" : "s"} priced at 0.00
                            </strong>{" "}
                            — not found, or no market data for the chosen pricing.
                            The pool total is short by whatever they are worth.
                            <br />
                            <span className="dim">
                              {unresolved.map((i) => `${i.name} ×${i.qty}`).join(", ")}
                            </span>
                          </span>
                        </p>
                      )}
                    </td>
                    <td>
                      {canEdit && (
                        <form action={deletePoolAction.bind(null, operation.id, pool.id)}>
                          <Submit className="btn btn--quiet btn--micro btn--danger-quiet">
                            delete
                          </Submit>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
              {pools.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={4}>
                    No loot recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Scroller>

        {canEdit && (
          <div className="stack">
            <form action={addFlatPoolAction.bind(null, operation.id)} className="stack">
              <RuleHead as="h3">Add a flat-valued pool</RuleHead>
              <label className="stack">
                Total value (ISK)
                <input className="field" type="number" step="0.01" min="0" name="totalValue" required />
              </label>
              <label className="stack">
                Note (required — why this number)
                <input className="field" name="notes" required />
              </label>
              <label className="stack">
                What was in it (optional)
                <textarea className="field" name="rawPaste" rows={2} />
              </label>
              <Submit className="btn">Add flat pool</Submit>
            </form>

            <form
              action={addAppraisedPoolAction.bind(null, operation.id)}
              className="stack"
            >
              <RuleHead as="h3">Appraise a loot paste</RuleHead>
              <label className="stack">
                Loot paste
                <textarea className="field" name="rawPaste" rows={6} required />
              </label>
              <label className="stack">
                Pricing
                <select className="field" name="pricingMode" defaultValue="sell_best">
                  {PRICING_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {PRICING_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack">
                Station ID (e.g. Jita 4-4: 60003760)
                <input className="field" name="stationId" defaultValue="60003760" />
              </label>
              <label className="stack">
                Region ID (leave blank if using a station)
                <input className="field" name="regionId" />
              </label>
              <Submit className="btn" pendingLabel="Pricing…">
                Appraise
              </Submit>
            </form>
          </div>
        )}

        <RuleHead as="h2">Roster</RuleHead>
        {canEdit && (
          <form action={setRosterAction.bind(null, operation.id)} className="stack">
            <label className="stack">
              Paste (names separated by /)
              <textarea className="field" name="paste" rows={3} required />
            </label>
            <Submit className="btn">Set roster</Submit>
          </form>
        )}

        <Scroller label="Participants">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Shares</th>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.displayName}
                    {p.sourceCharacters.length > 1 && (
                      <span className="dim"> ({p.sourceCharacters.join(", ")})</span>
                    )}
                  </td>
                  <td>
                    {canEdit ? (
                      <form
                        action={setParticipantSharesAction.bind(
                          null,
                          operation.id,
                          p.id,
                        )}
                        className="inline-form"
                      >
                        <input
                          className="field"
                          name="shares"
                          defaultValue={p.shares}
                          aria-label={`Shares for ${p.displayName}`}
                        />
                        <Submit className="btn btn--micro">save</Submit>
                      </form>
                    ) : (
                      <span className="mono">{p.shares}</span>
                    )}
                  </td>
                  <td className="mono nowrap">{p.amount} ISK</td>
                  <td>
                    {p.paymentState === "excluded" && <Status tone="off">excluded</Status>}
                    {p.paymentState === "unpaid" && <Status tone="warn">unpaid</Status>}
                    {p.paymentState === "paid" && <Status tone="ok">paid</Status>}
                  </td>
                  <td>
                    <div className="btn-row btn-row--tight btn-row--end">
                      {operation.status === "finalized" &&
                        p.paymentState !== "excluded" && (
                          <>
                            <CopyAmountButton amount={p.amount} />
                            {p.paymentState !== "paid" && access.isOperator && (
                              <form
                                action={markPaidAction.bind(null, operation.id, p.id)}
                              >
                                <Submit className="btn btn--micro">mark paid</Submit>
                              </form>
                            )}
                          </>
                        )}
                      {canEdit && (
                        <>
                          <form
                            action={setParticipantExcludedAction.bind(
                              null,
                              operation.id,
                              p.id,
                              !p.excluded,
                            )}
                          >
                            <Submit className="btn btn--quiet btn--micro">
                              {p.excluded ? "include" : "exclude"}
                            </Submit>
                          </form>
                          <form
                            action={removeParticipantAction.bind(
                              null,
                              operation.id,
                              p.id,
                            )}
                          >
                            <Submit className="btn btn--quiet btn--micro btn--danger-quiet">
                              remove
                            </Submit>
                          </form>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {participants.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={5}>
                    No roster set yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Scroller>
      </main>
    </>
  );
}
```

The unused `createOperationAction` re-import above is a mistake to avoid, not
to ship: drop it. The detail page never creates operations, so it must import
only the ten actions it actually calls (`addAppraisedPoolAction`,
`addFlatPoolAction`, `deletePoolAction`, `setRosterAction`,
`setParticipantSharesAction`, `setParticipantExcludedAction`,
`removeParticipantAction`, `finalizeAction`, `unlockAction`,
`markPaidAction`) — an unused import fails `npm run lint`.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit` (or `npm run typecheck`)
Expected: no errors. Fix any drift between the `payoutOperation` /
`lootPool` / `lootItem` / `payoutParticipant` / `payoutPayment` column names
used above and the actual `$inferSelect` shapes from Task 1's schema (e.g. if
a column ends up named slightly differently than assumed here, TypeScript
will point at the exact line).

- [ ] **Step 9: Lint and format**

Run: `npm run lint`
Expected: no errors — in particular no unused imports (the stray
`createOperationAction` note above) and no missing `key` props.

Run: `npm run format:check`
Expected: passes; run `npm run format` first if not.

- [ ] **Step 10: Commit**

```bash
git add src/services/payout-view.ts src/app/payouts
git commit -m "feat(payouts): add operation pages and server actions"
```

---

### Task 10: End-to-end coverage

**Files:**
- Create: `e2e/payouts.spec.ts`
- Modify: `e2e/helpers.ts` — `resetDb`'s `TRUNCATE` list gains the five payout
  tables, or every payout e2e test after the first leaks rows into the next.

**Interfaces:**
- Consumes: `e2e/helpers.ts` (`testDb`, `resetDb`, `seedMember`,
  `sessionCookieFor`), and every page/action from Task 9 — this spec drives
  them exclusively through rendered HTML (`page.goto`, `getByRole`,
  `getByLabel`, form fills, button clicks), never by importing `actions.ts`
  functions directly.
- Produces: nothing further downstream — this is the last task in the plan.

- [ ] **Step 1: Extend `resetDb` for the new tables**

`resetDb` truncates a fixed table list; Task 1 adds five tables that don't
exist yet in that list, so every payout e2e test after the first would see
the previous test's rows.

```ts
// e2e/helpers.ts — inside resetDb's TRUNCATE statement, add the five payout
// tables to the existing list (order doesn't matter under CASCADE):
export async function resetDb(db: ReturnType<typeof testDb>["db"]) {
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log, payout_operation, loot_pool,
      loot_item, payout_participant, payout_payment RESTART IDENTITY CASCADE
  `);
}
```

- [ ] **Step 2: Write the spec**

```ts
// e2e/payouts.spec.ts
import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { lootItem, lootPool, payoutOperation } from "../src/db/schema";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("a green member is denied /payouts", async ({ page, context }) => {
  const acc = await seedMember(db, { name: "Green Pilot", tier: "green" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/payouts");
  await expect(page).toHaveURL(/\/account/);
});

test("a cryo flygd member can read but not mutate", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "Active Operator",
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Thursday roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("10");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  const opUrl = page.url();

  const cryo = await seedMember(db, {
    name: "Cryo Pilot",
    tier: "flygd",
    status: "cryo",
  });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, cryo.id)]);

  // Read: the list and the detail both render for a cryo flygd member.
  await page.goto("/payouts");
  await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
  await expect(page.getByText("Thursday roam")).toBeVisible();
  // No create control for a non-operator reader.
  await expect(page.getByRole("link", { name: "New operation" })).toHaveCount(0);

  // Mutate: /payouts/new redirects a cryo flygd member straight back out.
  await page.goto("/payouts/new");
  await expect(page).toHaveURL(/\/payouts$/);

  // The operation page itself renders (read access) with no edit forms.
  await page.goto(opUrl);
  await expect(page.getByRole("heading", { name: "Thursday roam" })).toBeVisible();
  await expect(page.getByLabel("Paste (names separated by /)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finalize" })).toHaveCount(0);
});

test("create, add a flat pool, paste a roster, finalize, mark paid", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Thursday roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("10");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Thursday roam" })).toBeVisible();

  // A flat pool needs no external pricing service, which is what makes this
  // the deterministic path for e2e — the appraised path depends on triff.tools
  // being reachable and is exercised by msw-backed integration tests instead.
  await page.getByLabel("Total value (ISK)").fill("1000000");
  await page.getByLabel("Note (required — why this number)").fill("sold privately");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await expect(page.getByText("1000000.00 ISK")).toBeVisible();
  await expect(page.getByText("flat (manual)")).toBeVisible();

  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Set roster" }).click();
  await expect(page.getByText("Brain Tartare")).toBeVisible();
  await expect(page.getByText("Gustav Oswaldo")).toBeVisible();

  // 1,000,000 total, 10% corp share -> 900,000 pool, split evenly two ways
  // (both unresolved names get shares "1" and no account) -> 450,000.00 each.
  await expect(page.getByText("450000.00 ISK")).toHaveCount(2);
  // The corp's actual cut is shown, not just the percentage — 10% of 1,000,000
  // plus whatever the per-share floor left behind (nothing, here).
  await expect(page.getByText("100000.00 ISK")).toBeVisible();

  await page.getByRole("button", { name: "Finalize" }).click();
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize" })).toHaveCount(0);
  // Finalizing freezes the numbers: the edit affordances go away until unlock.
  // This is the UI half of assertEditable's status check.
  await expect(page.getByLabel("Paste (names separated by /)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add flat pool" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "delete" })).toHaveCount(0);

  await page
    .getByRole("button", { name: "mark paid" })
    .first()
    .click();
  await expect(page.getByText("paid")).toBeVisible();
  await expect(page.getByRole("button", { name: "mark paid" })).toHaveCount(1);
});

test("pasting two alts of one account collapses them into one participant row", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  await seedMember(db, {
    name: "Stealthbot",
    tier: "green",
    alts: ["Stealthbot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Roam with an alt");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("0");
  await page.getByRole("button", { name: "Create operation" }).click();

  await page.getByLabel("Total value (ISK)").fill("200");
  await page.getByLabel("Note (required — why this number)").fill("flat test value");
  await page.getByRole("button", { name: "Add flat pool" }).click();

  // The pasted fleet has two names, one main and one of its own alts.
  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Stealthbot / Stealthbot Alt");
  await page.getByRole("button", { name: "Set roster" }).click();

  // One row, not two: the alt collapses into its main's row, and the alt
  // spelling is retained alongside it rather than silently dropped.
  const rows = page.getByRole("row").filter({ hasText: "Stealthbot" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Stealthbot Alt");
});

/**
 * An appraised pool with an item triff could not price is the one condition an
 * operator must not miss: the pool total is quietly short, so everyone is about
 * to be underpaid. The pool row is written directly here rather than through
 * the appraise form, because the form calls triff.tools and this suite must not
 * depend on an external service — `tests/appraisal.test.ts` covers the fetching.
 */
test("an unresolved loot item is named on the page, not silently priced at zero", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Short appraisal",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const [pool] = await db
    .insert(lootPool)
    .values({
      operationId: op.id,
      valuationSource: "appraised",
      pricingMode: "sell_best",
      stationId: 60003760,
      totalValue: "100.00",
    })
    .returning();
  await db.insert(lootItem).values([
    {
      poolId: pool.id,
      typeId: 34,
      name: "Tritanium",
      qty: 10,
      unitPrice: "10.00",
      totalValue: "100.00",
      priceSource: "triff",
    },
    {
      poolId: pool.id,
      typeId: null,
      name: "Nyx",
      qty: 1,
      unitPrice: "0.00",
      totalValue: "0.00",
      priceSource: "unresolved",
    },
  ]);

  await page.goto(`/payouts/${op.id}`);
  await expect(page.getByText("1 item priced at 0.00")).toBeVisible();
  // The name matters — "1 item" alone doesn't tell you it's a supercarrier.
  await expect(page.getByText("Nyx ×1")).toBeVisible();
});
```

- [ ] **Step 3: Run the full suite**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payout npm test`
Expected: PASS. (`npm test` shares one database across worktrees; this
override, per `docs/ops.md`, gives this worktree's run its own.)

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run test:e2e`
Expected: PASS. The harness isolates itself (its own port and database
derived from the worktree path, per `e2e/env.ts`) and needs no
`TEST_DATABASE_URL` override.

- [ ] **Step 4: Commit**

```bash
git add e2e/payouts.spec.ts e2e/helpers.ts
git commit -m "test(e2e): cover the payout create-to-paid path, access tiers, and alt collapsing"
```
