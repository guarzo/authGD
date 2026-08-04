# Fight Payout Tracking Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the payout tool usable end to end — operators can see and reprice the loot they pasted, add participants by hand, revert a mistaken payment, and open a recipient's info window in-game; members can see what they are owed; and the list page stops reading the whole table.

**Architecture:** No new subsystems and no migration. Phase 2 works inside the boundaries phase 1 drew: `src/core/` stays pure, `src/services/payouts.ts` stays the authorization boundary (`requirePayoutOperator` first, then `lockOperation`, then re-read), `src/services/payout-view.ts` stays the unguarded read layer, and pages stay server components driving server actions through progressive-enhancement forms. Three things change shape. Derived payment state moves from "has a paid row" to the `paidAmount` column, which is what makes revert expressible at all. `payout_payment.at` is written as `clock_timestamp()` from inside the operation lock instead of defaulting to `now()`, which makes the event history causally ordered without a sequence column. And `listPayoutOperations` drops one query and scopes the other two behind a keyset cursor.

**Tech Stack:** Next.js 15 (App Router, server components, server actions), TypeScript, Drizzle ORM, PostgreSQL, pg-boss, Vitest, Playwright, msw, Zod.

**Spec:** `docs/superpowers/specs/2026-08-04-fight-payout-tracking-phase-2-design.md` — the source of truth. Where this plan and the spec disagree, the spec wins; stop and say so rather than guessing.

## Global Constraints

Every task's requirements implicitly include this section.

**No migration.** This PR generates none. `loot_price_source` already has `"manual"` and `payout_payment_kind` already has `"reverted"`; phase 1 added both in anticipation. If a task appears to need a schema change, **stop and ask** — migrations are generated with `npm run db:generate`, never hand-written, and `fly.toml` runs them as a release command on every deploy, so an applied migration is not editable.

**Stop and ask** before touching persisted data, an already-applied migration, `TOKEN_ENCRYPTION_KEY` handling, or the OAuth state flow. These are the irreversible surfaces.

**Money is exact.** ISK is `numeric(20,2)` in the database and native `bigint` cents in TypeScript, converted with `iskToCents` / `centsToIsk` from `src/core/payout-split.ts`. `Number()` never touches a money value, on the write side or the read side. `MAX_MONEY_CENTS = 10n ** 20n - 1n` is the largest value the column holds.

**Round once, at the line total.** Never round a per-unit price before multiplying by quantity — the error would scale with quantity instead of staying bounded at half a cent per line. A manual price is already at cent precision, so for manual items per-unit and line-total rounding coincide and the product is exact.

**`src/core/` is pure.** No database, no network, no imports outside `src/core/`.

**Authorization order in the guarded service.** Every mutating export in `src/services/payouts.ts` and `src/services/payout-loot.ts` calls `requirePayoutOperator` as its first statement, then `lockOperation`, then re-reads anything it decides on. Lock-then-read is the point: a value read before the lock is a value that can be stale by the time it is acted on. `tests/payouts-service.test.ts` has a loop asserting this over every mutating export — new exports go in it.

**Audit every state change.** `logAudit` targeting the **operation** uuid, not the participant or item uuid. New actions this PR: `payout.payment_reverted`, `payout.participant_added`, `payout.item_repriced`.

**Pages mirror the service's checks.** A control the service would reject is absent, not present-and-rejecting. `canEdit` in `src/app/payouts/[id]/page.tsx` mirrors `assertEditable`; keep them in step.

**Revert never un-freezes.** Once any payment row exists, `hasPayments` stays true forever, so loot, shares and `corpSharePct` stay frozen. A revert clears `paidAmount` and appends a `reverted` event; it does not reopen editing. The UI must say so.

**Enqueue, don't execute — with two documented exceptions.** Interactive appraisal is the first (`src/app/payouts/actions.ts`). Open-info is the second, added by this PR. Both are interactive, both are pointless to queue, and both carry the justification in a code comment so a reviewer does not read them as rule violations.

**Accessibility.** Every control inside a table row carries an accessible name naming the row it acts on (``aria-label={`Unit price for ${item.name}`}``). Every surface operates at 320px width. The repo has prior commits on both.

**Tests.** Vitest for unit and integration, Playwright for e2e, msw for HTTP clients. Run the unit suite against a worktree-private database — the default is shared across worktrees and will collide:

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npm test
```

**Environment hazards.** Running the dev server — including the one Playwright boots — rewrites `tsconfig.json` and `AGENTS.md`. Both are **tracked**. Recover with `git checkout <file>`, never delete them, and never `git add -A` after an e2e run.

**Cite test output.** Never claim `npm test`, `npm run typecheck`, `npm run test:e2e`, or `npm run format:check` passed without running it and quoting the result. CI runs `prettier --check .` over the whole repo, so checking only changed files passes locally and fails in CI — run `npm run format:check` per task, not only at the final gate.

**Prettier does not check this plan.** `.prettierignore` excludes `*.md` deliberately (its comment explains why: prettier's only change to these docs is padding table cells, 1920 lines of churn for nothing) and also excludes `tmp/`. So a code block in this document is **never** verified by any automated check — it is verified when you paste it into a `.ts`/`.tsx` file and run `npm run format:check`. Every block here was checked by extracting it to a scratch file under `src/`, dedenting it to column zero, and running prettier on it individually. If you edit a block, re-check it the same way; a block that looks fine here can still fail CI at its paste site, because prettier's 90-column limit counts the indentation the block will land at.

**Stay in scope.** Don't rename, restructure, or clean up files the task didn't ask about. Note the improvement instead.

---

### Task 1: `computeSplit` input validation, drop `perShareCents`, add `MAX_MONEY_CENTS`

**Files:**

- Modify: `src/core/payout-split.ts:20-63`
- Test: `tests/payout-split.test.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `export const MAX_MONEY_CENTS = 10n ** 20n - 1n;` in `@/core/payout-split` — the
    largest value `numeric(20,2)` holds, in cents. Task B's `setItemPrice` and the
    pool-total bound compare against it.
  - `export type SplitResult = { corpAmountCents: bigint; amounts: Map<string, bigint> }`
    — `perShareCents` is **gone**; no later task may read it.
  - `computeSplit` now throws `Error` on `totalCents < 0n` or a `corpSharePct`
    outside 0–100 inclusive.

Grep evidence for the deletion (run before editing, expect only the two lines inside
`payout-split.ts` itself):

```
rg -n "perShareCents" src tests e2e
```

- [ ] **Step 1: Write the failing test**

Append to `tests/payout-split.test.ts` (after the closing `});` of the existing
`describe("computeSplit", …)` block), and add `MAX_MONEY_CENTS` to the import on
line 2 so it reads:

```ts
import {
  MAX_MONEY_CENTS,
  centsToIsk,
  computeSplit,
  iskToCents,
} from "@/core/payout-split";
```

```ts
describe("MAX_MONEY_CENTS", () => {
  /**
   * numeric(20,2) is 20 significant digits with 2 after the point, so 18
   * integer digits. Asserting the rendered string rather than the bigint is
   * what actually pins that shape — a wrong exponent still looks like a
   * plausible constant.
   */
  it("is the largest value numeric(20,2) can hold", () => {
    expect(centsToIsk(MAX_MONEY_CENTS)).toBe("999999999999999999.99");
    expect(centsToIsk(MAX_MONEY_CENTS).replace(".", "")).toHaveLength(20);
    expect(iskToCents("999999999999999999.99")).toBe(MAX_MONEY_CENTS);
  });
});

describe("computeSplit input validation", () => {
  /**
   * Defence in depth. payout_operation_corp_share_pct_ck and
   * payout_participant_amount_ck already reject these at persist time, but by
   * then computeSplit has already produced a plausible-looking split from
   * nonsense, and the operator sees a raw Postgres error instead of a sentence.
   */
  it("rejects a negative total", () => {
    expect(() =>
      computeSplit({ totalCents: -1n, corpSharePct: "10.00", participants: [] }),
    ).toThrow(/total cannot be negative/);
  });

  it("rejects a corp share above 100", () => {
    expect(() =>
      computeSplit({ totalCents: 100n, corpSharePct: "100.01", participants: [] }),
    ).toThrow(/corp share must be between 0 and 100/);
  });

  it("rejects a negative corp share", () => {
    expect(() =>
      computeSplit({ totalCents: 100n, corpSharePct: "-0.01", participants: [] }),
    ).toThrow(/corp share must be between 0 and 100/);
  });

  it("accepts both ends of the corp-share range and a zero total", () => {
    expect(() =>
      computeSplit({ totalCents: 0n, corpSharePct: "0.00", participants: [] }),
    ).not.toThrow();
    expect(() =>
      computeSplit({ totalCents: 100n, corpSharePct: "100.00", participants: [] }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-split.test.ts
```

Expected: FAIL. `MAX_MONEY_CENTS` fails at import/type level with
`"MAX_MONEY_CENTS" is not exported by "src/core/payout-split.ts"`, and the three
validation cases fail with `expected [Function] to throw error matching /…/ but it
didn't throw`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/payout-split.ts`, insert after `centsToIsk` (line 28) and before
`SplitParticipant`:

```ts
/**
 * The largest value `numeric(20,2)` holds: 20 significant digits with 2 after
 * the point leaves 18 integer digits, so 999999999999999999.99 — which is
 * 10^20 - 1 in cents. Callers computing a money value (a line total, a pool
 * total) compare against this before it reaches the column, so an overflow is
 * a readable message rather than a raw Postgres numeric-field-overflow.
 */
export const MAX_MONEY_CENTS = 10n ** 20n - 1n;
```

Replace `SplitResult` (lines 32-36) with:

```ts
export type SplitResult = {
  corpAmountCents: bigint;
  amounts: Map<string, bigint>;
};
```

Replace the head of `computeSplit` (lines 43-44) with:

```ts
  // Defence in depth: the DB check constraints catch both of these at persist
  // time, but only after this function has already produced a plausible-looking
  // split from them, and only as an unreadable Postgres error.
  if (input.totalCents < 0n) {
    throw new Error(`total cannot be negative: ${centsToIsk(input.totalCents)}`);
  }
  const pctBp = iskToCents(input.corpSharePct); // "10.00" -> 1000n basis points
  if (pctBp < 0n || pctBp > 10000n) {
    throw new Error(`corp share must be between 0 and 100: ${input.corpSharePct}`);
  }
  const corpBase = (input.totalCents * pctBp) / 10000n;
```

Replace the return (line 62) with:

```ts
  return { corpAmountCents, amounts };
```

`perShare` stays a local — it is still how the split is computed, it is just no
longer returned.

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-split.test.ts
npx tsc --noEmit
npx prettier --check src/core/payout-split.ts tests/payout-split.test.ts
```

Expected: all `payout-split.test.ts` tests pass; `tsc` clean (proving nothing read
`perShareCents`).

- [ ] **Step 5: Commit**

```
git add src/core/payout-split.ts tests/payout-split.test.ts
git commit -m "fix(payouts): reject a nonsense split before it looks like a real one

computeSplit accepted a negative total and a corp share outside 0-100,
producing a plausible split that only died later as a raw check-constraint
error. Also drops perShareCents, which nothing read, and adds
MAX_MONEY_CENTS for the callers that have to keep money inside numeric(20,2).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: loot paste reports the lines it dropped, and bounds absurd quantities

**Files:**

- Modify: `src/core/loot-paste.ts:1-78` (whole file)
- Modify: `src/services/appraisal.ts:4`, `:15`, `:36-37`, `:88`
- Modify: `tests/payout-loot.test.ts:96`, `:134`, `:209`, `:383`, `:410` (add
  `dropped: []` to each `appraisal:` literal)
- Modify: `tests/payouts-service.test.ts:610`, `:654` (same)
- Test: `tests/payout-parse.test.ts`, `tests/appraisal.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces:

```ts
// @/core/loot-paste
export type ParsedLootLine = { name: string; qty: number };
export type DroppedLootLine = {
  line: string;
  reason: "zero-quantity" | "quantity-only" | "quantity-too-large";
};
export type LootPasteResult = { items: ParsedLootLine[]; dropped: DroppedLootLine[] };
export const MAX_LOOT_QTY = Number.MAX_SAFE_INTEGER;
export function parseLootPaste(raw: string): LootPasteResult;
```

```ts
// @/services/appraisal
export type AppraisalResult = {
  items: AppraisedItem[];
  totalValue: string;
  dropped: DroppedLootLine[];
};
```

The UI task in Part C renders `appraisal.dropped` — the exact type name it consumes is
`DroppedLootLine` from `@/core/loot-paste`, one entry per dropped **item**, carrying the
first raw line that produced it. `addAppraisedPool` does **not** persist dropped lines;
the pool total stays derived from `appraisal.items` only (`payout-loot.ts:35-37`,
unchanged by this task).

- [ ] **Step 1: Write the failing test**

Replace the whole `describe("parseLootPaste", …)` block in
`tests/payout-parse.test.ts` (lines 56-134) with:

```ts
describe("parseLootPaste", () => {
  it("bounds quantity at the largest integer JavaScript represents exactly", () => {
    // lootItem.qty is bigint(… { mode: "number" }), so past 2^53 the value is
    // already wrong before Postgres sees it. This is a correctness bound.
    expect(MAX_LOOT_QTY).toBe(Number.MAX_SAFE_INTEGER);
  });

  const cases: Array<{
    label: string;
    input: string;
    expected: ParsedLootLine[];
    expectedDropped?: DroppedLootLine[];
  }> = [
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
      label: "blank lines are skipped, and are not reported as dropped",
      input: "12x Foo\n\nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      label: "a whitespace-only line is skipped, and is not reported as dropped",
      input: "12x Foo\n   \nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      // A DB row with qty 0 would violate loot_item_qty_ck; still dropped,
      // same as any other junk line, but now reported so the page can name it.
      label: "a zero quantity line is dropped and reported",
      input: "0x Foo\n12x Bar",
      expected: [{ name: "Bar", qty: 12 }],
      expectedDropped: [{ line: "0x Foo", reason: "zero-quantity" }],
    },
    {
      label: "a name whose lines all sum to zero is reported once, on its first line",
      input: "0x Foo\n0x Foo",
      expected: [],
      expectedDropped: [{ line: "0x Foo", reason: "zero-quantity" }],
    },
    {
      // Zero is dropped per ITEM, not per line: a 0x line followed by a real
      // one is just a sum, and the item survives with nothing reported.
      label: "a zero line that a later line makes positive is not dropped at all",
      input: "0x Foo\n2x Foo",
      expected: [{ name: "Foo", qty: 2 }],
    },
    {
      // Previously absorbed as an item literally NAMED "12", which became a
      // zero-priced unresolved row rather than an obvious mistake.
      label: "a line that is only a quantity is dropped and reported",
      input: "12\n12x Foo",
      expected: [{ name: "Foo", qty: 12 }],
      expectedDropped: [{ line: "12", reason: "quantity-only" }],
    },
    {
      label: "a comma-grouped quantity-only line is dropped and reported",
      input: "1,234",
      expected: [],
      expectedDropped: [{ line: "1,234", reason: "quantity-only" }],
    },
    {
      label: "a quantity at exactly MAX_LOOT_QTY is kept",
      input: "9007199254740991x Foo",
      expected: [{ name: "Foo", qty: 9007199254740991 }],
    },
    {
      label: "a quantity past MAX_LOOT_QTY is dropped and reported",
      input: "9007199254740992x Foo\n3x Bar",
      expected: [{ name: "Bar", qty: 3 }],
      expectedDropped: [{ line: "9007199254740992x Foo", reason: "quantity-too-large" }],
    },
    {
      label: "quantities that only together exceed MAX_LOOT_QTY drop the item",
      input: "9007199254740991x Foo\n1x Foo",
      expected: [],
      expectedDropped: [{ line: "9007199254740991x Foo", reason: "quantity-too-large" }],
    },
    {
      // DELIBERATE: "12xFoo" with no separator stays a literal name. Reading
      // it as "12 of Foo" guesses at intent, and an "x" with no separator is
      // genuinely ambiguous against real EVE type names. Nobody "fix" this.
      label: "a qty prefix with no separator stays a literal name",
      input: "12xFoo",
      expected: [{ name: "12xFoo", qty: 1 }],
    },
  ];

  it.each(cases)("$label", ({ input, expected, expectedDropped }) => {
    expect(parseLootPaste(input)).toEqual({
      items: expected,
      dropped: expectedDropped ?? [],
    });
  });
});
```

Change the import on `tests/payout-parse.test.ts:3` to:

```ts
import {
  MAX_LOOT_QTY,
  parseLootPaste,
  type DroppedLootLine,
  type ParsedLootLine,
} from "@/core/loot-paste";
```

Append to `tests/appraisal.test.ts` inside `describe("appraiseLoot", …)`:

```ts
  it("carries the parser's dropped lines through and still appraises the rest", async () => {
    // "12" alone is dropped; "0x Tritanium" is NOT, because the later line
    // makes that item's total positive. Nothing is rejected wholesale.
    const result = await appraiseLoot(
      "12\n0x Tritanium\n2x Tritanium",
      { pricingMode: "sell_best", stationId: 60003760 },
      {
        esi: fakeEsi({ tritanium: 34 }),
        triff: fakeTriff({ 34: { sell: { best: 5 } } }),
      },
    );
    expect(result.dropped).toEqual([{ line: "12", reason: "quantity-only" }]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "Tritanium", qty: 2 });
    expect(result.totalValue).toBe("10.00");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-parse.test.ts tests/appraisal.test.ts
```

Expected: FAIL. `payout-parse.test.ts` fails at import with `"MAX_LOOT_QTY" is not
exported by "src/core/loot-paste.ts"`; once that is added, every case fails with
`expected [ { name: 'Foo', qty: 12 } ] to deeply equal { items: [ … ], dropped: [] }`
because `parseLootPaste` still returns a bare array. `appraisal.test.ts` fails with
`expected undefined to deeply equal [ { line: '12', reason: 'quantity-only' } ]`.

- [ ] **Step 3: Write minimal implementation**

Replace `src/core/loot-paste.ts` entirely with:

```ts
export type ParsedLootLine = { name: string; qty: number };

/** A line the parser refused, and why, so the page can name what it ignored
 *  instead of the operator discovering it as a missing item later. */
export type DroppedLootLine = {
  line: string;
  reason: "zero-quantity" | "quantity-only" | "quantity-too-large";
};

export type LootPasteResult = { items: ParsedLootLine[]; dropped: DroppedLootLine[] };

/**
 * `lootItem.qty` is `bigint("qty", { mode: "number" })` (src/db/schema.ts), so
 * past 2^53 the quantity is already the wrong number in JavaScript before
 * Postgres ever sees it. This is a correctness bound, not a taste bound —
 * which is why it is this number and not a game-flavoured cap.
 */
export const MAX_LOOT_QTY = Number.MAX_SAFE_INTEGER;

// "12x Foo", "12 Foo" — qty (with optional comma grouping) leads the line.
const QTY_PREFIX = /^(\d[\d,]*)\s*x?\s+(.+)$/i;
// "Foo x12" — qty trails the line behind a literal "x".
const QTY_SUFFIX = /^(.+?)\s+x\s*(\d[\d,]*)$/i;
// "Foo, 12" — qty trails behind a comma.
const QTY_COMMA = /^(.+),\s*(\d[\d,]*)$/;
// "12", "1,234" — a line that is nothing but a quantity, with no item at all.
const QTY_ONLY = /^[\d,]+$/;

function parseQty(text: string): number {
  return Number(text.replace(/,/g, ""));
}

/**
 * Accepts the loot-paste shapes PayGD accepted: "12x Foo", "Foo x12",
 * tab-separated "Foo\t12", comma-separated "Foo, 12", and a bare name
 * (qty 1). Quantities may use comma grouping ("1,234"). Duplicate names
 * (exact string match, matching the source tool's dict-keyed behavior) sum
 * their quantities; order of first appearance is preserved.
 *
 * Junk is dropped rather than rejected — one bad line must not cost the
 * operator a 200-line paste — but it is REPORTED, so "N lines ignored" can be
 * shown next to the total. Blank lines are the exception: they are noise from
 * copying, not a mistake worth naming.
 */
export function parseLootPaste(raw: string): LootPasteResult {
  const totals = new Map<string, number>();
  const order: string[] = [];
  // Quantity problems are only knowable after summing, so a dropped item is
  // reported against the first line that introduced it.
  const firstLineByName = new Map<string, string>();
  const dropped: DroppedLootLine[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // A bare "12" used to be absorbed as an item literally NAMED "12", which
    // landed as a zero-priced unresolved row: a silent wrong answer rather
    // than an obvious mistake.
    if (QTY_ONLY.test(line)) {
      dropped.push({ line, reason: "quantity-only" });
      continue;
    }

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
    if (!totals.has(name)) {
      order.push(name);
      firstLineByName.set(name, line);
    }
    totals.set(name, (totals.get(name) ?? 0) + qty);
  }

  const items: ParsedLootLine[] = [];
  for (const name of order) {
    const qty = totals.get(name)!;
    const line = firstLineByName.get(name)!;
    // "0x Foo" (and any name whose lines all sum to zero) is dropped rather
    // than rejected, matching this parser's lenience toward junk lines. A
    // qty-0 row would otherwise reach loot_item as a genuine value-carrying
    // line and die on the raw loot_item_qty_ck constraint.
    if (qty <= 0) {
      dropped.push({ line, reason: "zero-quantity" });
      continue;
    }
    // Checked on the SUM, which is >= every contributing line's quantity (the
    // regexes match digits only, so no quantity is ever negative). One check
    // therefore covers both a single absurd line and a run that adds up to
    // one. Today such a line dies downstream as a raw Postgres error.
    if (qty > MAX_LOOT_QTY) {
      dropped.push({ line, reason: "quantity-too-large" });
      continue;
    }
    items.push({ name, qty });
  }

  return { items, dropped };
}
```

In `src/services/appraisal.ts`, change the import on line 4 to:

```ts
import { parseLootPaste, type DroppedLootLine } from "@/core/loot-paste";
```

Replace line 15 with:

```ts
export type AppraisalResult = {
  items: AppraisedItem[];
  totalValue: string;
  /** Lines the parser refused. Carried, never persisted: the pool total comes
   *  from `items` alone, and the form names these back to the operator. */
  dropped: DroppedLootLine[];
};
```

Replace line 36 with:

```ts
  const { items: lines, dropped } = parseLootPaste(raw);
```

Replace line 88 with:

```ts
  return { items, totalValue: centsToIsk(totalCents), dropped };
```

Then add `dropped: []` to each existing `appraisal:` object literal in the DB tests, so
each reads `…, totalValue: "10.00", dropped: [] },`:
`tests/payout-loot.test.ts:96`, `:134`, `:209`, `:383`, `:410`; and
`tests/payouts-service.test.ts:610` and `:654` become:

```ts
        appraisal: { items: [], totalValue: "0.00", dropped: [] },
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-parse.test.ts tests/appraisal.test.ts tests/payout-loot.test.ts tests/payouts-service.test.ts
npx tsc --noEmit
npx prettier --check src/core/loot-paste.ts src/services/appraisal.ts tests/payout-parse.test.ts tests/appraisal.test.ts tests/payout-loot.test.ts tests/payouts-service.test.ts
```

Expected: all pass. `tsc` clean confirms every `AppraisalResult` literal gained
`dropped`.

- [ ] **Step 5: Commit**

```
git add src/core/loot-paste.ts src/services/appraisal.ts tests/payout-parse.test.ts tests/appraisal.test.ts tests/payout-loot.test.ts tests/payouts-service.test.ts
git commit -m "fix(payouts): say which paste lines were ignored, and bound the absurd ones

A zero-quantity line vanished with no signal, a bare quantity became an item
literally named \"12\", and a 30-digit quantity died downstream as a raw
Postgres error. parseLootPaste now returns those lines with a reason, and
appraiseLoot carries them to the caller. Nothing is rejected wholesale: a
mostly-good paste still appraises.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `PayoutNotFoundError`, and causally-ordered payment timestamps

**Files:**

- Modify: `src/services/payouts.ts:14-15` (add the class), `:47`, `:81`, `:251`, `:423`,
  `:432` (throw it), `:445-450` (explicit `at`)
- Test: `tests/payouts-service.test.ts`

**Interfaces:**

- Consumes: nothing from Tasks 1-2.
- Produces:
  - `export class PayoutNotFoundError extends Error {}` in `@/services/payouts`.
    Part B's `revertPayment` throws it for a missing participant, and Part C's
    actions/pages discriminate it from a programming error the same way they
    already discriminate `PayoutForbiddenError` / `PayoutLockedError`.
  - `recordPayment` writes `payout_payment.at` as `sql\`clock_timestamp()\`` from
    inside the operation row lock, so any two payment rows on one operation are
    ordered as they happened. **Part B extends the test below to a
    pay → revert → pay sequence on ONE participant** (three rows, strictly
    increasing `at`), and `revertPayment` must supply `at` the same way — a revert
    that keeps `defaultNow()` reintroduces exactly the inversion this fixes.
  - Display order everywhere is `(at asc, id asc)`; among exact ties it is arbitrary.

- [ ] **Step 1: Write the failing test**

Add `PayoutNotFoundError` to the `@/services/payouts` import block in
`tests/payouts-service.test.ts` (line 7-23), add `asc, inArray` to the `drizzle-orm`
import on line 1 so it reads `import { asc, eq, inArray, sql } from "drizzle-orm";`,
and append these two `describe` blocks:

```ts
describe("PayoutNotFoundError", () => {
  /**
   * A bare Error here is indistinguishable from a programming mistake, so a
   * caller has to either swallow everything or nothing. These are the same
   * discriminable-failure contract PayoutForbiddenError and PayoutLockedError
   * already give callers.
   */
  const MISSING = "00000000-0000-0000-0000-000000000000";

  it("is thrown for a missing operation", async () => {
    const operator = await seedOperator();
    await expect(
      ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, MISSING)),
    ).rejects.toThrow(PayoutNotFoundError);
  });

  it("is thrown for a missing participant", async () => {
    const operator = await seedOperator();
    await expect(
      ctx.db.transaction((tx) => setParticipantShares(tx, operator.id, MISSING, "2")),
    ).rejects.toThrow(PayoutNotFoundError);
    await expect(
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, MISSING)),
    ).rejects.toThrow(PayoutNotFoundError);
  });
});

describe("payment history is ordered as it happened", () => {
  /**
   * payout_payment.at defaults to now(), which is TRANSACTION START time. Two
   * writers serialize on the operation row lock, but a transaction that
   * started earlier can take the lock later and stamp an earlier time than an
   * event that actually happened first — so a fold or a display ordered by
   * `at` reads the sequence backwards.
   *
   * Inside ONE transaction now() is frozen, which is what makes this test
   * discriminate: under defaultNow() both rows carry the identical instant.
   * clock_timestamp(), read after the lock, strictly increases.
   *
   * The comparison is done in Postgres because `at` has microsecond
   * resolution and a JS Date does not — two inserts a few microseconds apart
   * would compare equal after truncation to milliseconds, making the
   * assertion pass or fail by luck.
   */
  it("stamps two payments in one transaction with strictly increasing at", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Two payees",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values({
      operationId,
      valuationSource: "flat",
      totalValue: "1000.00",
      notes: "sold privately",
    });
    await ctx.db.transaction((tx) =>
      setRoster(
        tx,
        operator.id,
        operationId,
        ["First Payee", "Second Payee"].map((displayName) => ({
          displayName,
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: [displayName],
          shares: "1",
          excluded: false,
        })),
      ),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const participants = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    const first = participants.find((p) => p.displayName === "First Payee")!;
    const second = participants.find((p) => p.displayName === "Second Payee")!;

    await ctx.db.transaction(async (tx) => {
      await recordPayment(tx, operator.id, first.id);
      await recordPayment(tx, operator.id, second.id);
    });

    const ids = [first.id, second.id];
    const [span] = await ctx.db
      .select({
        strictlyIncreasing: sql<boolean>`min(${payoutPayment.at}) < max(${payoutPayment.at})`,
      })
      .from(payoutPayment)
      .where(inArray(payoutPayment.participantId, ids));
    expect(span.strictlyIncreasing).toBe(true);

    // …and the order the page will render is the order the payments happened.
    const history = await ctx.db
      .select({ participantId: payoutPayment.participantId })
      .from(payoutPayment)
      .where(inArray(payoutPayment.participantId, ids))
      .orderBy(asc(payoutPayment.at), asc(payoutPayment.id));
    expect(history.map((h) => h.participantId)).toEqual([first.id, second.id]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts -t "PayoutNotFoundError"
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts -t "strictly increasing"
```

Expected: the first fails at import with `"PayoutNotFoundError" is not exported by
"src/services/payouts.ts"`. The second fails with
`expected false to be true` — both rows carry the frozen transaction-start `now()`, so
`min(at) < max(at)` is false.

- [ ] **Step 3: Write minimal implementation**

In `src/services/payouts.ts`, after line 15:

```ts
/** The operation or participant an operation was asked to act on does not
 *  exist. Distinguishable by callers from a programming error, the same way
 *  PayoutForbiddenError and PayoutLockedError already are. */
export class PayoutNotFoundError extends Error {}
```

Replace line 47 (`lockOperation`):

```ts
  if (!op) throw new PayoutNotFoundError("operation not found");
```

Replace line 81 (`assertEditable`):

```ts
  if (!op) throw new PayoutNotFoundError("operation not found");
```

Replace line 251 (`loadParticipantOperationId`):

```ts
  if (!p) throw new PayoutNotFoundError("participant not found");
```

Replace lines 423 and 432 (both in `recordPayment`):

```ts
  if (!ref) throw new PayoutNotFoundError("participant not found");
```

```ts
  if (!participant) throw new PayoutNotFoundError("participant not found");
```

Replace the insert at lines 445-450 with:

```ts
  await dbtx.insert(payoutPayment).values({
    participantId,
    kind: "paid",
    amount: participant.amount,
    actor,
    // NOT the column's defaultNow(): now() is TRANSACTION START time, so a
    // transaction that started earlier can take the operation lock later and
    // stamp an earlier time than an event that already happened. This reading
    // is taken after lockOperation, which every writer of this table holds, so
    // any two rows on one operation are ordered as they occurred. See the
    // phase-2 design, "Derived payment state".
    at: sql`clock_timestamp()`,
  });
```

`sql` is already imported at `src/services/payouts.ts:1`. No migration: `defaultNow()`
stays as the column default and is simply not used by this writer.

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts tests/payout-loot.test.ts tests/payout-view.test.ts tests/payout-schema.test.ts
npx tsc --noEmit
npx prettier --check src/services/payouts.ts tests/payouts-service.test.ts
```

Expected: all pass. The neighbouring payout suites are run because
`PayoutNotFoundError` replaces `Error`s they may assert on.

- [ ] **Step 5: Commit**

```
git add src/services/payouts.ts tests/payouts-service.test.ts
git commit -m "fix(payouts): name the not-found failures, and timestamp payments causally

recordPayment and loadParticipantOperationId threw bare Errors that callers
could not tell from a programming mistake; they now throw PayoutNotFoundError
alongside the existing forbidden/locked pair.

payout_payment.at defaulted to now(), which is transaction START time, so a
transaction that took the operation lock later could still record an earlier
instant than the event before it. The insert now supplies clock_timestamp()
from inside the lock, which makes the history orderable. No migration: the
column default is untouched, it is simply not what the writer uses.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `revertPayment`, and `paidAmount` as the source of derived payment state

**Files:**

- Modify: `src/services/payouts.ts` (new export after `recordPayment`, ends the file)
- Modify: `src/services/payout-view.ts:28-95` (`listPayoutOperations`), `:101-120`
  (`PayoutParticipantView`), `:152-184` (`getPayoutOperationDetail`)
- Test: `tests/payouts-service.test.ts`
- Test: `tests/payout-view.test.ts`

**Interfaces:**

- Consumes: `PayoutNotFoundError` (Task A), `recordPayment` writing
  `at: sql`clock_timestamp()`` (Task A), `lockOperation(dbtx, operationId)`,
  `hasPayments(dbx, operationId)`, `assertEditable(dbtx, operationId)`,
  `logAudit(dbx, { actor, action, target, details? })`
- Produces:
  - `export async function revertPayment(dbtx: DbTx, actor: string, participantId: string): Promise<void>`
  - `PayoutParticipantView = typeof payoutParticipant.$inferSelect & { paymentState: ParticipantPaymentState; payments: Array<typeof payoutPayment.$inferSelect> }`
    — `payments` is that participant's history in `(at asc, id asc)` order, which is
    what the detail page's history list renders.
  - `listPayoutOperations` no longer issues a `payout_payment` query at all.

- [ ] **Step 1: Write the failing test**

Append to `tests/payouts-service.test.ts`:

```ts
describe("revertPayment", () => {
  it("clears paidAmount, appends a reverted row, and lets the participant be paid again", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();

    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId));

    const [reverted] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(reverted.paidAmount).toBeNull();
    expect(reverted.amount).toBe("1000.00"); // what is owed did not change

    const history = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId))
      .orderBy(asc(payoutPayment.at), asc(payoutPayment.id));
    expect(history.map((h) => h.kind)).toEqual(["paid", "reverted"]);
    expect(history[1].amount).toBe("1000.00");
    expect(history[1].actor).toBe(operator.id);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payout.payment_reverted"));
    expect(audits).toHaveLength(1);
    expect(audits[0].target).toBe(operationId); // the operation uuid, not the participant

    // The whole point of clearing paidAmount: recordPayment's idempotence
    // check is `paidAmount !== null`, so a reverted participant is payable.
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId));
    const [repaid] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(repaid.paidAmount).toBe("1000.00");
  });

  it("refuses a participant who is not currently paid", async () => {
    const { participantId, operator } = await seedFightWithOneUnpaidParticipant();
    await expect(
      ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("refuses a draft operation", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();
    // Reach draft without going through unlockOperation, which refuses once a
    // payment exists — this is testing revertPayment's own status guard.
    await ctx.db
      .update(payoutOperation)
      .set({ status: "draft" })
      .where(eq(payoutOperation.id, operationId));
    await expect(
      ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  /**
   * The decision this test exists to pin: reverting corrects the record of who
   * was paid, it does NOT reopen the numbers. `hasPayments` counts every
   * payout_payment row regardless of kind, so the operation stays frozen
   * forever. A later change that makes hasPayments a fold has to argue with
   * this test rather than quietly enabling a paid operation's loot total to be
   * rewritten afterwards.
   */
  it("does not un-freeze the operation", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId));

    // unlockOperation's refusal IS the hasPayments check, so this is the
    // assertion that proves the freeze survived rather than merely observing
    // that the operation is still `finalized`.
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId)),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participantId, "2"),
      ),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("leaves paidAmount null when recalculate runs after a revert", async () => {
    const { operationId, participantId, poolId, operator } =
      await seedFightWithOnePaidParticipant();
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId));

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
    expect(after.paidAmount).toBeNull(); // recalculate writes ONLY amount
  });

  /**
   * Inside one transaction Postgres freezes `now()`, so under `defaultNow()`
   * all three rows would carry one identical instant. That is what makes this
   * a pin on `clock_timestamp()` rather than a restatement of it.
   */
  it("pay -> revert -> pay in one transaction yields three distinct instants", async () => {
    const { participantId, operator } = await seedFightWithOneUnpaidParticipant();

    await ctx.db.transaction(async (tx) => {
      await recordPayment(tx, operator.id, participantId);
      await revertPayment(tx, operator.id, participantId);
      await recordPayment(tx, operator.id, participantId);
    });

    // Compared in SQL, deliberately. `at` is microsecond resolution and a JS
    // Date truncates to milliseconds, so three inserts microseconds apart read
    // as equal through `.getTime()` and the assertion would pass or fail by
    // luck. Under `defaultNow()` the distinct count here is 1, not 3.
    const res = await ctx.db.execute(sql`
      select count(*)::int as rows, count(distinct at)::int as instants
      from payout_payment
      where participant_id = ${participantId}`);
    const counts = res.rows[0] as { rows: number; instants: number };
    expect(counts.rows).toBe(3);
    expect(counts.instants).toBe(3);

    // Companion, not the discriminator: with three distinct instants the
    // ordering below is forced, but under defaultNow() the tie would fall back
    // to random-uuid order and land on the right sequence half the time.
    const history = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId))
      .orderBy(asc(payoutPayment.at), asc(payoutPayment.id));
    expect(history.map((h) => h.kind)).toEqual(["paid", "reverted", "paid"]);
  });
});
```

Extend that file's imports: add `asc` and `sql` to the `drizzle-orm` import,
`auditLog` to the `@/db/schema` import, and `revertPayment` to the
`@/services/payouts` import.

Add `revertPayment` to the authorization loop in the same file. Inside
`for (const actor of [green.id, cryo.id]) { … }`, after the `recordPayment` case:

```ts
      await expect(
        ctx.db.transaction((tx) => revertPayment(tx, actor, participant.id)),
      ).rejects.toThrow(PayoutForbiddenError);
```

and update that describe block's doc comment count from "All eleven mutating
exports" to "All twelve mutating exports", naming `revertPayment`.

Append to `tests/payout-view.test.ts`:

```ts
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
    const [summary] = (await listPayoutOperations(ctx.db)).filter(
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
```

Extend that file's `@/services/payouts` import with `revertPayment`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts tests/payout-view.test.ts
```

Expected: FAIL at import resolution —
`SyntaxError: The requested module '@/services/payouts' does not provide an export named 'revertPayment'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/payouts.ts` (after `recordPayment`):

```ts
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
    // Taken from inside the lock, so it is necessarily later than the reading
    // any already-committed payment on this operation took from inside the
    // same lock. `now()` is transaction-start time and would not be.
    at: sql`clock_timestamp()`,
    actor,
  });
  await logAudit(dbtx, {
    actor,
    action: "payout.payment_reverted",
    target: op.id,
    details: { participantId, amount },
  });
}
```

In `src/services/payout-view.ts`, replace the `Promise.all` destructure at `:33-56`
with a three-query version — the `payout_payment` query has nothing left to
contribute once state comes from `paidAmount`:

```ts
  const [ops, pools, participants] = await Promise.all([
    dbx
      .select({
        id: payoutOperation.id,
        name: payoutOperation.name,
        occurredAt: payoutOperation.occurredAt,
        status: payoutOperation.status,
      })
      .from(payoutOperation)
      .orderBy(desc(payoutOperation.occurredAt)),
    dbx
      .select({ operationId: lootPool.operationId, totalValue: lootPool.totalValue })
      .from(lootPool),
    dbx
      .select({
        id: payoutParticipant.id,
        operationId: payoutParticipant.operationId,
        excluded: payoutParticipant.excluded,
        paidAmount: payoutParticipant.paidAmount,
      })
      .from(payoutParticipant),
  ]);
```

Replace the `paidParticipantIds` block at `:73-79` with the rule it now follows:

```ts
  // `paidAmount` is the source of truth for derived payment state, not a fold
  // of payout_payment: it is one column, written under the same operation row
  // lock that decides on it, so it cannot disagree with itself. The event log
  // stays append-only history — displayed, never folded into a decision.
```

and change the summary's `paidCount` at `:92` to:

```ts
      paidCount: owed.filter((p) => p.paidAmount !== null).length,
```

Extend `PayoutParticipantView` at `:103-105`:

```ts
export type PayoutParticipantView = typeof payoutParticipant.$inferSelect & {
  paymentState: ParticipantPaymentState;
  /** Append-only history for this participant, `(at asc, id asc)`. Rendered,
   *  never folded — `paymentState` comes from `paidAmount`. */
  payments: Array<typeof payoutPayment.$inferSelect>;
};
```

In `getPayoutOperationDetail`, order the payments query by both columns (`:159`)
and group it instead of folding it (`:161-163`):

```ts
        .orderBy(asc(payoutPayment.at), asc(payoutPayment.id))
    : [];
  const paymentsByParticipant = new Map<string, typeof payments>();
  for (const payment of payments) {
    const list = paymentsByParticipant.get(payment.participantId) ?? [];
    list.push(payment);
    paymentsByParticipant.set(payment.participantId, list);
  }
```

and the participant mapping at `:177-184`:

```ts
    participants: participants.map((p) => ({
      ...p,
      paymentState: p.excluded ? "excluded" : p.paidAmount !== null ? "paid" : "unpaid",
      payments: paymentsByParticipant.get(p.id) ?? [],
    })),
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts tests/payout-view.test.ts
```

Expected: PASS, all cases in both files.

- [ ] **Step 5: Commit**

```
git add src/services/payouts.ts src/services/payout-view.ts tests/payouts-service.test.ts tests/payout-view.test.ts
git commit -m "feat(payouts): let an operator take back a payment they recorded wrong

paidAmount, not the payment log, is now what says whether someone has been
paid — one column written under the same lock that reads it. Reverting does
not reopen the operation's numbers."
```

---

### Task 5: Reject `shares` above the column's range

**Files:**

- Modify: `src/services/payouts.ts:255-276` (`setParticipantShares`, plus a new
  exported guard above it)
- Modify: `src/app/payouts/actions.ts:213-231` (`setParticipantSharesAction`)
- Test: `tests/payouts-service.test.ts`

**Interfaces:**

- Consumes: `iskToCents` from `@/core/payout-split`
- Produces: `export function assertSharesInRange(shares: string): void` — throws a
  plain `Error` for `<= 0` or `> 9999.99`. `setParticipantSharesAction` calls it
  instead of its inline `iskToCents(shares) <= 0n` check.

- [ ] **Step 1: Write the failing test**

Append to `tests/payouts-service.test.ts`:

```ts
describe("setParticipantShares bounds", () => {
  it("rejects a share count above the column's range with a readable error", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Big shares",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          displayName: "Greedy Pilot",
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: ["Greedy Pilot"],
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
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participant.id, "10000"),
      ),
    ).rejects.toThrow(/9999\.99/);
    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participant.id, "0"),
      ),
    ).rejects.toThrow(/positive/);

    // 9999.99 is the largest the numeric(6,2) column holds, and must still be
    // accepted — the guard is a bound, not an off-by-one narrowing.
    await ctx.db.transaction((tx) =>
      setParticipantShares(tx, operator.id, participant.id, "9999.99"),
    );
    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(after.shares).toBe("9999.99");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts -t "rejects a share count above the column's range"
```

Expected: FAIL — the `"10000"` case rejects with Drizzle's generic
`Failed query` wrapper over Postgres' `numeric field overflow`, which does not
match `/9999\.99/`.

- [ ] **Step 3: Write minimal implementation**

In `src/services/payouts.ts`, insert above `setParticipantShares`:

```ts
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
 */
const MAX_SHARES_HUNDREDTHS = 999999n; // 9999.99, in the hundredths iskToCents returns

export function assertSharesInRange(shares: string): void {
  const hundredths = iskToCents(shares); // also rejects "abc" / "1e5" outright
  if (hundredths <= 0n) throw new Error("shares must be a positive number");
  if (hundredths > MAX_SHARES_HUNDREDTHS) {
    throw new Error("shares cannot exceed 9999.99");
  }
}
```

and add the call to `setParticipantShares`, after the authorization guard so a
forbidden actor still sees the authorization error first:

```ts
export async function setParticipantShares(
  dbtx: DbTx,
  actor: string,
  participantId: string,
  shares: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  assertSharesInRange(shares);
  const operationId = await loadParticipantOperationId(dbtx, participantId);
```

In `src/app/payouts/actions.ts`, replace the inline guard at `:221-226`:

```ts
  // Mirrors payout_participant_shares_ck (shares > 0) and the numeric(6,2)
  // column's own range with readable messages, before the raw string reaches
  // the database — "abc", "1e5" and "10000" would each otherwise surface as a
  // raw Postgres error. Same guard the service runs, so neither caller can
  // drift from the other.
  assertSharesInRange(shares);
```

Add `assertSharesInRange` to that file's `@/services/payouts` import (alphabetically
first in the list), and drop the now-unused
`import { iskToCents } from "@/core/payout-split";` at `:27`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts
npx tsc --noEmit
```

Expected: PASS, and no unused-import type error from `actions.ts`.

- [ ] **Step 5: Commit**

```
git add src/services/payouts.ts src/app/payouts/actions.ts tests/payouts-service.test.ts
git commit -m "fix(payouts): say what the share limit is instead of leaking a numeric overflow

shares is numeric(6,2); 10000 was a raw Postgres error. Bounded with a
readable message in the service and the action rather than widening the
column, which would cost a migration for the sake of a sentence."
```

---

### Task 6: `addParticipant` — additive manual roster entry

**Files:**

- Modify: `src/services/payouts.ts` (new export after `setRoster`)
- Modify: `src/app/payouts/actions.ts` (new action after `setRosterAction`)
- Test: `tests/payouts-service.test.ts`

**Interfaces:**

- Consumes: `resolveRosterNames(dbx, names): Promise<RosterEntry[]>`,
  `assertEditable`, `lockOperation`, `recalculate`, `field(formData, name)`,
  `requireOperatorAccount()`, `revalidateOperation(operationId)`
- Produces:
  - `export async function addParticipant(dbtx: DbTx, actor: string, operationId: string, name: string): Promise<void>`
  - `export async function addParticipantAction(operationId: string, formData: FormData): Promise<void>`
    — the form field is named `name`.

- [ ] **Step 1: Write the failing test**

Append to `tests/payouts-service.test.ts`:

```ts
describe("addParticipant", () => {
  async function seedDraftWithRoster(names: string[]) {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Manual entry",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values({
      operationId,
      valuationSource: "flat",
      totalValue: "300.00",
      notes: "sold privately",
    });
    if (names.length > 0) {
      const entries = await resolveRosterNames(ctx.db, names);
      await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, entries));
    }
    return { operator, operationId };
  }

  it("adds a new unresolved name as its own participant and recalculates", async () => {
    const { operator, operationId } = await seedDraftWithRoster(["Pilot One"]);

    await ctx.db.transaction((tx) =>
      addParticipant(tx, operator.id, operationId, "Pilot Two"),
    );

    const rows = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    expect(rows).toHaveLength(2);
    // 300.00 over two equal shares — proof recalculate ran, not just that the
    // row landed.
    expect(rows.map((r) => r.amount).sort()).toEqual(["150.00", "150.00"]);
    const added = rows.find((r) => r.displayName === "Pilot Two")!;
    expect(added.accountId).toBeNull();
    expect(added.sourceCharacters).toEqual(["Pilot Two"]);
    expect(added.shares).toBe("1.00");

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payout.participant_added"));
    expect(audits).toHaveLength(1);
    expect(audits[0].target).toBe(operationId);
  });

  /**
   * The paste path collapses alts inside one paste via entryByAccountId. Manual
   * entry has to reproduce that against rows already in the table, or one human
   * pasted as their main and typed in as their alt draws two full shares.
   */
  it("collapses an alt into the existing participant rather than adding a second share", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 700001,
      accountId: acc.id,
      name: "Fleet Main",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 700002,
      accountId: acc.id,
      name: "Fleet Alt",
    });
    const { operator, operationId } = await seedDraftWithRoster(["Fleet Main"]);

    await ctx.db.transaction((tx) =>
      addParticipant(tx, operator.id, operationId, "Fleet Alt"),
    );

    const rows = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Fleet Main");
    expect(rows[0].sourceCharacters).toEqual(["Fleet Main", "Fleet Alt"]);
    expect(rows[0].amount).toBe("300.00"); // one share, not two
  });

  it("rejects a case-insensitively duplicate unresolved name", async () => {
    const { operator, operationId } = await seedDraftWithRoster(["Pilot One"]);
    await expect(
      ctx.db.transaction((tx) =>
        addParticipant(tx, operator.id, operationId, "pilot one"),
      ),
    ).rejects.toThrow(/already on this roster/);
    const rows = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    expect(rows).toHaveLength(1);
  });

  it("refuses once the operation is finalized", async () => {
    const { operator, operationId } = await seedDraftWithRoster(["Pilot One"]);
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await expect(
      ctx.db.transaction((tx) =>
        addParticipant(tx, operator.id, operationId, "Latecomer"),
      ),
    ).rejects.toThrow(PayoutLockedError);
  });
});
```

Extend that file's `@/services/payouts` import with `addParticipant`, and add it to
the authorization loop inside `for (const actor of [green.id, cryo.id]) { … }`:

```ts
      await expect(
        ctx.db.transaction((tx) => addParticipant(tx, actor, operationId, "Nope")),
      ).rejects.toThrow(PayoutForbiddenError);
```

Update the describe block's doc comment to "All thirteen mutating exports",
naming `addParticipant`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts -t "addParticipant"
```

Expected: FAIL —
`SyntaxError: The requested module '@/services/payouts' does not provide an export named 'addParticipant'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/payouts.ts`, after `setRoster`:

```ts
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
        throw new Error(`"${clash.displayName}" is already on this roster`);
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
```

Append to `src/app/payouts/actions.ts`, after `setRosterAction`:

```ts
export async function addParticipantAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) throw new Error("a character name is required");
  await getDb().transaction((dbtx) => addParticipant(dbtx, actor, operationId, name));
  revalidateOperation(operationId);
}
```

Add `addParticipant` to that file's `@/services/payouts` import.

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payouts-service.test.ts
```

Expected: PASS, including the authorization loop.

- [ ] **Step 5: Commit**

```
git add src/services/payouts.ts src/app/payouts/actions.ts tests/payouts-service.test.ts
git commit -m "feat(payouts): add one pilot to a roster without retyping the fleet

Additive, unlike setRoster, so share edits survive. Resolves through the same
path the paste does, so an alt collapses into their main instead of drawing a
second share, and a repeated unresolved name is refused rather than warned
about after the fact."
```

---

### Task 7: `setItemPrice` — manual per-item price override, and money bounds

**Files:**

- Modify: `src/services/payout-loot.ts:15-74` (`addAppraisedPool` bounds) and a new
  export after `addFlatPool`
- Modify: `src/app/payouts/actions.ts` (new action after `deletePoolAction`)
- Test: `tests/payout-loot.test.ts`
- Test: `tests/payout-schema.test.ts`

**Interfaces:**

- Consumes: `MAX_MONEY_CENTS` from `@/core/payout-split` (Task A),
  `PayoutNotFoundError` (Task A), `iskToCents`, `centsToIsk`, `assertEditable`,
  `lockOperation`, `recalculate`, `expectCheckViolation` from
  `tests/helpers/constraints`
- Produces:
  - `export async function setItemPrice(dbtx: DbTx, actor: string, itemId: string, unitPrice: string): Promise<void>`
  - `export async function setItemPriceAction(operationId: string, itemId: string, formData: FormData): Promise<void>`
    — the form field is named `unitPrice`.

- [ ] **Step 1: Write the failing test**

Append to `tests/payout-loot.test.ts`:

```ts
describe("setItemPrice", () => {
  /** One appraised pool holding a single Tritanium line, priced by triff. */
  async function seedPricedItem(qty: number) {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operatorId, operationId, {
        rawPaste: `${qty}x Tritanium`,
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: {
          items: [
            {
              typeId: 34,
              name: "Tritanium",
              qty,
              unitPrice: "5.00",
              totalValue: centsToIsk(500n * BigInt(qty)),
              priceSource: "triff",
            },
          ],
          dropped: [],
          totalValue: centsToIsk(500n * BigInt(qty)),
        },
      }),
    );
    const [item] = await ctx.db
      .select()
      .from(lootItem)
      .where(eq(lootItem.poolId, poolId));
    return { operatorId, operationId, poolId, itemId: item.id };
  }

  it("computes the line total as an exact bigint product at a quantity floats would drift on", async () => {
    // 12,345,678,901 x 7.77 ISK = 95,925,925,060.77 ISK. In cents that product
    // is 9,592,592,506,077 — past nothing on its own, but the float route
    // (12345678901 * 7.77) yields 95925925060.76999..., which renders as a
    // different line total. bigint has nothing to drift.
    const QTY = 12345678901;
    const { operatorId, operationId, poolId, itemId } = await seedPricedItem(QTY);

    await ctx.db.transaction((tx) => setItemPrice(tx, operatorId, itemId, "7.77"));

    const [item] = await ctx.db.select().from(lootItem).where(eq(lootItem.id, itemId));
    expect(item.unitPrice).toBe("7.77");
    expect(item.totalValue).toBe("95925925060.77");
    expect(item.priceSource).toBe("manual");
    // A manual price is already at cent precision, so unit x qty reproduces
    // the line total exactly — unlike an appraised item, whose unitPrice is a
    // lossy 2dp rendering of a sub-cent market price.
    expect(iskToCents(item.unitPrice) * BigInt(item.qty)).toBe(
      iskToCents(item.totalValue),
    );

    // The pool total is re-derived from its item rows, and recalculate ran.
    const [pool] = await ctx.db.select().from(lootPool).where(eq(lootPool.id, poolId));
    expect(pool.totalValue).toBe("95925925060.77");
    expect(await soleParticipantAmount(operationId)).toBe("95925925060.77");
  });

  it("keeps rawPaste verbatim so the pool can still be re-appraised", async () => {
    const { operatorId, poolId, itemId } = await seedPricedItem(3);
    await ctx.db.transaction((tx) => setItemPrice(tx, operatorId, itemId, "10.00"));
    const [pool] = await ctx.db.select().from(lootPool).where(eq(lootPool.id, poolId));
    expect(pool.rawPaste).toBe("3x Tritanium");
  });

  it("rejects a line total past what numeric(20,2) can hold, with a readable error", async () => {
    const { operatorId, itemId } = await seedPricedItem(1000);
    // 1000 x 999999999999999.99 is ~1e18, past the column's range.
    await expect(
      ctx.db.transaction((tx) =>
        setItemPrice(tx, operatorId, itemId, "999999999999999.99"),
      ),
    ).rejects.toThrow(/largest value this system can record/);
  });

  it("rejects a negative unit price before it reaches the column", async () => {
    const { operatorId, itemId } = await seedPricedItem(2);
    await expect(
      ctx.db.transaction((tx) => setItemPrice(tx, operatorId, itemId, "-1.00")),
    ).rejects.toThrow(/cannot be negative/);
  });

  it("refuses once the operation is finalized, because it moves money", async () => {
    const { operatorId, operationId, itemId } = await seedPricedItem(2);
    await ctx.db.transaction((tx) => finalizeOperation(tx, operatorId, operationId));
    await expect(
      ctx.db.transaction((tx) => setItemPrice(tx, operatorId, itemId, "9.00")),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("rejects a non-operator actor at the service layer", async () => {
    const { itemId } = await seedPricedItem(2);
    const green = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(
      ctx.db.transaction((tx) => setItemPrice(tx, green.id, itemId, "9.00")),
    ).rejects.toThrow(PayoutForbiddenError);
  });
});

describe("addAppraisedPool money bounds", () => {
  it("rejects a pool total past numeric(20,2) with a readable error, not a Postgres one", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expect(
      ctx.db.transaction((tx) =>
        addAppraisedPool(tx, operatorId, operationId, {
          rawPaste: "2x Absurd",
          pricingMode: "sell_best",
          stationId: 60003760,
          appraisal: {
            items: [
              {
                typeId: 34,
                name: "Absurd",
                qty: 1,
                unitPrice: "0.00",
                totalValue: "999999999999999999.99",
                priceSource: "triff",
              },
              {
                typeId: 35,
                name: "Absurd Two",
                qty: 1,
                unitPrice: "0.00",
                totalValue: "999999999999999999.99",
                priceSource: "triff",
              },
            ],
            dropped: [],
            totalValue: "0.00",
          },
        }),
      ),
    ).rejects.toThrow(/largest value this system can record/);
  });
});
```

Extend that file's imports: add `centsToIsk, iskToCents` from `@/core/payout-split`,
and `setItemPrice` to the `@/services/payout-loot` import.

Add `setItemPrice` to the authorization loop in `tests/payouts-service.test.ts`.
Immediately after the existing `addAppraisedPool` call that produces `poolId`
(before `finalizeOperation`), insert an item to point at:

```ts
    const [loopItem] = await ctx.db
      .insert(lootItem)
      .values({
        poolId,
        typeId: 34,
        name: "Tritanium",
        qty: 1,
        unitPrice: "1.00",
        totalValue: "1.00",
        priceSource: "triff",
      })
      .returning();
```

and inside `for (const actor of [green.id, cryo.id]) { … }`:

```ts
      await expect(
        ctx.db.transaction((tx) => setItemPrice(tx, actor, loopItem.id, "2.00")),
      ).rejects.toThrow(PayoutForbiddenError);
```

Extend that file's `@/db/schema` import with `lootItem` and its
`@/services/payout-loot` import with `setItemPrice`; update the describe block's
doc comment to "All fourteen mutating exports", naming `setItemPrice`.

Append to `tests/payout-schema.test.ts`, inside the existing `describe("payout schema")`:

```ts
  it("rejects a non-positive loot item qty (loot_item_qty_ck)", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    const [pool] = await ctx.db
      .insert(lootPool)
      .values({
        operationId: op.id,
        valuationSource: "flat",
        totalValue: "0",
        notes: "note",
      })
      .returning();
    await expectCheckViolation(
      ctx.db
        .insert(lootItem)
        .values({ poolId: pool.id, name: "Nothing", qty: 0, priceSource: "unresolved" }),
      "loot_item_qty_ck",
    );
  });

  it("rejects a negative loot item unit price or total (loot_item_price_ck)", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    const [pool] = await ctx.db
      .insert(lootPool)
      .values({
        operationId: op.id,
        valuationSource: "flat",
        totalValue: "0",
        notes: "note",
      })
      .returning();
    await expectCheckViolation(
      ctx.db.insert(lootItem).values({
        poolId: pool.id,
        name: "Owed",
        qty: 1,
        unitPrice: "-1.00",
        priceSource: "manual",
      }),
      "loot_item_price_ck",
    );
    // The constraint covers totalValue as well, and no service-level test
    // reaches that half of it.
    await expectCheckViolation(
      ctx.db.insert(lootItem).values({
        poolId: pool.id,
        name: "Owed",
        qty: 1,
        unitPrice: "1.00",
        totalValue: "-1.00",
        priceSource: "manual",
      }),
      "loot_item_price_ck",
    );
  });
```

Extend that file's `@/db/schema` import with `lootItem`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-loot.test.ts tests/payout-schema.test.ts
```

Expected: `payout-loot.test.ts` FAILs at import —
`SyntaxError: The requested module '@/services/payout-loot' does not provide an export named 'setItemPrice'`.
`payout-schema.test.ts` FAILs only on the `totalValue: "-1.00"` half if the
constraint were wrong; the qty and unitPrice halves are expected to pass
immediately, since they assert an existing constraint that had no direct test.

- [ ] **Step 3: Write minimal implementation**

In `src/services/payout-loot.ts`, add to the `@/core/payout-split` import
`MAX_MONEY_CENTS`, and to the `@/services/payouts` import `PayoutNotFoundError`.
Insert above `addAppraisedPool`:

```ts
/**
 * `numeric(20, 2)` holds up to 999999999999999999.99 ISK. Past that, an insert
 * dies as a Drizzle "Failed query" wrapper around a Postgres numeric overflow,
 * which tells the operator nothing about which line was absurd. This is the
 * same failure defect 9's quantity bound reaches from the other side.
 */
function assertWithinMoneyRange(cents: bigint, what: string): void {
  if (cents > MAX_MONEY_CENTS) {
    throw new Error(`${what} exceeds the largest value this system can record`);
  }
}
```

In `addAppraisedPool`, replace the `computedTotal` assignment at `:35-37` with a
bounded version:

```ts
  let totalCents = 0n;
  for (const it of input.appraisal.items) {
    const lineCents = iskToCents(it.totalValue);
    assertWithinMoneyRange(lineCents, `the line total for ${it.name}`);
    totalCents += lineCents;
  }
  assertWithinMoneyRange(totalCents, "this pool's total");
  const computedTotal = centsToIsk(totalCents);
```

Append after `addFlatPool`:

```ts
/**
 * A manual per-item price override, for the items an appraisal could not
 * resolve. Lives here rather than in payouts.ts because it has to keep the
 * pool's derived `totalValue` consistent with its item rows, which is
 * `addAppraisedPool`'s job too.
 *
 * Calls `assertEditable`: this moves money.
 *
 * Precision. `unitPrice` is `numeric(20, 2)`, so a manual price is exactly two
 * decimals; the action refuses a third rather than silently rounding a number
 * someone typed deliberately. The payoff is that invariant 2 ("round once at
 * the line total") has nothing to round here — `unitPriceCents * qty` is an
 * exact bigint product, and because the price is already at cent precision,
 * per-unit and line-total rounding coincide. This is not a forgotten rounding
 * step.
 *
 * The deliberate inconsistency, named so nobody "fixes" it: for an APPRAISED
 * item, `unitPrice` is a lossy 2dp rendering of a sub-cent market price while
 * `totalValue` came from the full-precision one, so `unitPrice * qty` does NOT
 * reproduce `totalValue` — that gap is what the detail page's sub-cent warning
 * reports. For a MANUAL item the two agree exactly, by the paragraph above.
 *
 * `rawPaste` is untouched: phase 1 keeps it verbatim precisely so the pool can
 * be re-appraised later, and an override must not cost that.
 */
export async function setItemPrice(
  dbtx: DbTx,
  actor: string,
  itemId: string,
  unitPrice: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const [ref] = await dbtx.select().from(lootItem).where(eq(lootItem.id, itemId));
  if (!ref) throw new PayoutNotFoundError("loot item not found");
  const [pool] = await dbtx.select().from(lootPool).where(eq(lootPool.id, ref.poolId));
  if (!pool) throw new PayoutNotFoundError("loot pool not found");
  await lockOperation(dbtx, pool.operationId);
  await assertEditable(dbtx, pool.operationId);
  // Re-read after the lock: `qty` is what the line total is computed from, and
  // a concurrent re-appraisal could have replaced it since the read above.
  const [item] = await dbtx.select().from(lootItem).where(eq(lootItem.id, itemId));
  if (!item) throw new PayoutNotFoundError("loot item not found");

  const unitPriceCents = iskToCents(unitPrice);
  // iskToCents' regex admits a leading minus, so this is the guard that keeps a
  // negative price from dying on loot_item_price_ck instead.
  if (unitPriceCents < 0n) throw new Error("a unit price cannot be negative");
  const lineCents = unitPriceCents * BigInt(item.qty);
  assertWithinMoneyRange(lineCents, `the line total for ${item.name}`);

  await dbtx
    .update(lootItem)
    .set({
      unitPrice: centsToIsk(unitPriceCents),
      totalValue: centsToIsk(lineCents),
      priceSource: "manual",
    })
    .where(eq(lootItem.id, itemId));

  // Re-derive the pool total from the item rows, never from a running sum or a
  // caller-supplied number — same rule addAppraisedPool follows.
  const siblings = await dbtx
    .select({ totalValue: lootItem.totalValue })
    .from(lootItem)
    .where(eq(lootItem.poolId, item.poolId));
  const poolCents = siblings.reduce((sum, it) => sum + iskToCents(it.totalValue), 0n);
  assertWithinMoneyRange(poolCents, "this pool's total");
  await dbtx
    .update(lootPool)
    .set({ totalValue: centsToIsk(poolCents) })
    .where(eq(lootPool.id, item.poolId));

  await logAudit(dbtx, {
    actor,
    action: "payout.item_repriced",
    target: pool.operationId,
    details: {
      itemId,
      poolId: item.poolId,
      name: item.name,
      unitPrice: centsToIsk(unitPriceCents),
    },
  });
  await recalculate(dbtx, pool.operationId);
}
```

Append to `src/app/payouts/actions.ts`, after `deletePoolAction`:

```ts
export async function setItemPriceAction(
  operationId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const unitPrice = field(formData, "unitPrice").trim();
  // Two decimals is what numeric(20,2) holds. A third is refused rather than
  // rounded: an operator who typed 0.004 meant something specific, and a
  // silent round to 0.01 would inflate the line 2.5x with no sign of it. The
  // escape hatch for genuinely sub-cent heaps is the flat-total pool, which
  // takes a pool value directly and skips per-item pricing.
  if (!/^\d+(\.\d{1,2})?$/.test(unitPrice)) {
    throw new Error("a price must be a plain number with at most 2 decimals, like 12.34");
  }
  await getDb().transaction((dbtx) => setItemPrice(dbtx, actor, itemId, unitPrice));
  revalidateOperation(operationId);
}
```

Add `setItemPrice` to that file's `@/services/payout-loot` import.

- [ ] **Step 4: Run test to verify it passes**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-loot.test.ts tests/payout-schema.test.ts tests/payouts-service.test.ts
npx tsc --noEmit
npx prettier --check .
```

Expected: PASS on all three files, clean typecheck, clean format check.

- [ ] **Step 5: Commit**

```
git add src/services/payout-loot.ts src/app/payouts/actions.ts tests/payout-loot.test.ts tests/payout-schema.test.ts tests/payouts-service.test.ts
git commit -m "feat(payouts): let an operator price the items the appraisal could not

Manual prices are exact to the cent, so the line total is a bigint product
with nothing to round. Line and pool totals past numeric(20,2) now say so
instead of surfacing a Postgres overflow, and the loot_item constraints get
tests that name them."
```

---

### Task 8: `listPayoutOperations` — three scoped queries and a composite keyset cursor

**Files:**

- Modify: `src/services/payout-view.ts:1-95`
- Test: `tests/payout-view.test.ts`

**Interfaces:**

- Consumes: `revertPayment(dbtx, actor, participantId)` from `src/services/payouts.ts` (Task 5); the `paidAmount !== null` derived state Task 4 installed at both call sites in `payout-view.ts` — the one inside `listPayoutOperations` (currently `:73-79`, rewritten wholesale by this task) and the one inside `getPayoutOperationDetail` (currently `:161-163`, which Task 4 edits in place; expect its line number to have moved by the time you get here, since Task 4 also regroups the payment rows into `PayoutParticipantView`).
- Produces:
  ```ts
  export const PAYOUTS_PAGE_SIZE = 50;
  export type PayoutListCursor = { occurredAt: Date; id: string };
  export type PayoutListPage = {
    operations: PayoutOperationSummary[];
    nextCursor: PayoutListCursor | null;
  };
  export async function listPayoutOperations(
    dbx: Dbx,
    opts?: { before?: PayoutListCursor; limit?: number },
  ): Promise<PayoutListPage>;
  export function encodePayoutCursor(cursor: PayoutListCursor): string;
  export function decodePayoutCursor(raw: string | undefined): PayoutListCursor | undefined;
  ```

**Why this shape.** Today the function issues four queries in one `Promise.all`, and three of them have no `where` clause at all: every `loot_pool`, every `payout_participant`, and every `payout_payment` row in the database, folded in memory. Two changes fix it:

(a) The `payout_payment` query is **deleted, not scoped.** Once list state comes from `paidAmount` (Part B), the participant rows already carry the answer. That is also the convenient outcome: `payout_payment` has no `operationId` column (verified — `src/db/schema.ts:319-330` references only `participantId`), so scoping it would have meant a join back through participants to bound a query nothing reads.

(b) The two remaining child queries take `inArray(operationId, pageIds)`, and keyset pagination is what makes `pageIds` bounded.

`src/services/audit.ts:388-394` is the repo's pagination precedent — keyset, `lt(auditLog.id, beforeId)`, `orderBy(desc(id))`, a `before` param, a page-size constant. Follow it; do not introduce offset pagination alongside it. One difference is load-bearing: `auditLog.id` is a monotonic serial, so a single-column cursor is sound there. `payoutOperation.id` is `defaultRandom()` (`schema.ts:217`) and this list orders by `occurredAt desc` (`payout-view.ts:42`), which is **not unique** — a bare `occurredAt` cursor skips every operation that shares a date across a page boundary. Hence the composite comparison and the `desc(occurredAt), desc(id)` order. Postgres' uuid ordering is arbitrary but stable, which is all a tiebreak needs.

Keep the existing "explicit column lists, not `select()`" discipline and its comment: a bare select on `loot_pool` drags every operation's `raw_paste` across the wire to compute one sum.

- [ ] **Step 1: Write the failing tests**

Add to `tests/payout-view.test.ts`. Extend the existing imports at the top of the file — the new symbols are `drizzle`, `schema`, `payoutOperation`, `revertPayment`, and the four new `payout-view` exports:

```ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { lootPool, payoutOperation, payoutParticipant } from "@/db/schema";
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
  decodePayoutCursor,
  encodePayoutCursor,
  getPayoutOperationDetail,
  listPayoutOperations,
  type PayoutListCursor,
} from "@/services/payout-view";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
```

Then append these two `describe` blocks to the end of the file, and add the two helpers just above them:

```ts
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
```

Also update the file's two existing `listPayoutOperations` call sites, which now return a page object rather than an array — `tests/payout-view.test.ts:88` and `:154`:

```ts
    const [summary] = (await listPayoutOperations(ctx.db)).operations.filter(
      (o) => o.id === operationId,
    );
```

```ts
    const [summary] = (await listPayoutOperations(ctx.db)).operations;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-view.test.ts`

Expected: FAIL at import/type-check time — `"@/services/payout-view" has no exported member 'decodePayoutCursor'` (and `encodePayoutCursor`, `PayoutListCursor`), and `listPayoutOperations` rejects a second argument.

- [ ] **Step 3: Write the implementation**

Replace `src/services/payout-view.ts:1-95` (imports through the end of `listPayoutOperations`) with:

```ts
import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
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
  opts: { before?: PayoutListCursor; limit?: number } = {},
): Promise<PayoutListPage> {
  const limit = Math.min(opts.limit ?? PAYOUTS_PAGE_SIZE, PAYOUTS_PAGE_SIZE);
  const before = opts.before;

  // Explicit column lists, not `select()`. A bare select on loot_pool drags
  // every operation's `raw_paste` — an entire pasted inventory window, per
  // pool — across the wire to compute one sum. Nothing below reads a column
  // that is not named here.
  //
  // One row past the limit: its presence is the "there is more" signal, and
  // the row itself is trimmed before anything downstream sees it.
  const page = await dbx
    .select({
      id: payoutOperation.id,
      name: payoutOperation.name,
      occurredAt: payoutOperation.occurredAt,
      status: payoutOperation.status,
    })
    .from(payoutOperation)
    .where(
      before
        ? or(
            lt(payoutOperation.occurredAt, before.occurredAt),
            and(
              eq(payoutOperation.occurredAt, before.occurredAt),
              lt(payoutOperation.id, before.id),
            ),
          )
        : undefined,
    )
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
    };
  });

  const last = ops[ops.length - 1];
  return {
    operations,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
}
```

`payoutPayment` and `asc` are still imported and still used by `getPayoutOperationDetail` further down the file — leave that import list as written above. **The deletion is scoped to the list function, not to the module.** Task 4 deliberately *keeps* the `payoutPayment` query inside `getPayoutOperationDetail` and regroups its rows into `PayoutParticipantView.payments`, because the detail page renders that history. If you find yourself removing a `payoutPayment` reference below `getPayoutOperationDetail`, you have gone too far.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-view.test.ts`

Expected: PASS, all suites in the file including the two pre-existing ones.

Then confirm nothing else consumed the old array return — `src/app/payouts/page.tsx` is the only other caller and Task 9 fixes it, so a typecheck here is expected to fail on exactly that one line:

Run: `npx tsc --noEmit`

Expected: one error at `src/app/payouts/page.tsx:56`, `Property 'length' does not exist on type 'PayoutListPage'`. No others.

- [ ] **Step 5: Commit**

```bash
git add src/services/payout-view.ts tests/payout-view.test.ts
git commit -m "perf(payouts): bound the payout list to one page of rows

listPayoutOperations issued four queries, three unbounded: every loot_pool,
payout_participant and payout_payment row in the database, folded in memory.
The payment query is deleted rather than scoped -- paidAmount already answers
what it was consulted for, and payout_payment has no operationId to scope by.
The other two are scoped to the page, which keyset pagination now bounds.

The cursor is composite (occurredAt, id): occurredAt is not unique and the id
is a random uuid, so a single-column cursor skips every operation sharing a
date across a page boundary."
```

---

### Task 9: `/payouts` — wire up the pager

**Files:**

- Modify: `src/app/payouts/page.tsx:1-102`
- Test: `e2e/payouts.spec.ts`

**Interfaces:**

- Consumes: `listPayoutOperations(dbx, { before?, limit? })`, `PAYOUTS_PAGE_SIZE`, `encodePayoutCursor`, `decodePayoutCursor` (Task 8).
- Produces: nothing other tasks import. The URL contract is `/payouts?before=<encoded cursor>`.

**No unit test, deliberately, and this was checked rather than assumed.** There is no precedent in `tests/` for rendering a page component: `tests/account-page.test.ts` renders a leaf component (`ContactRemedy`) through `renderToStaticMarkup`, and `tests/admin-accounts.test.ts` is a service test that never touches `src/app/`. Pages here call `cookies()` and `getDb()`, which neither harness supports. Page behaviour in this repo is covered by Playwright, so the test below is an e2e spec in `e2e/payouts.spec.ts` — that file already exists and already seeds operations directly.

**The heading count.** `ops.length` is now a page count, not a total, and presenting it as "51 operations" when the page holds 50 of an unknown number would be a plain falsehood. The count is kept **only when this page provably is the entire list** — no cursor in and no cursor out — and the heading reads "Operations" otherwise. This keeps the number for the common small-corp case, which is the case it was useful in, and drops it exactly where it would lie.

- [ ] **Step 1: Write the failing test**

Append to `e2e/payouts.spec.ts`. `payoutOperation` is already imported there; add nothing to the import block:

```ts
test("the payouts list pages with an Older link", async ({ page, context }) => {
  const reader = await seedMember(db, { name: "List Reader", tier: "flygd" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);

  // 51 operations: one more than PAYOUTS_PAGE_SIZE, newest first by date.
  await db.insert(payoutOperation).values(
    Array.from({ length: 51 }, (_, i) => ({
      name: `Op ${String(i).padStart(2, "0")}`,
      occurredAt: new Date(Date.UTC(2026, 6, 1) - i * 86_400_000),
    })),
  );

  await page.goto("/payouts");
  // The count is a page count now, so the heading must not claim a total.
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 00", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 49", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 50", exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/\/payouts\?before=/);
  await expect(page.getByRole("link", { name: "Op 50", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 00", exact: true })).toHaveCount(0);
  // Last page: nothing further to walk to.
  await expect(page.getByRole("link", { name: "Older" })).toHaveCount(0);
});

test("a malformed before param renders page 1 instead of failing", async ({
  page,
  context,
}) => {
  const reader = await seedMember(db, { name: "Cursor Reader", tier: "flygd" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  await db.insert(payoutOperation).values({
    name: "Only fight",
    occurredAt: new Date("2026-07-01T00:00:00Z"),
  });

  await page.goto("/payouts?before=garbage");
  await expect(page.getByRole("link", { name: "Only fight" })).toBeVisible();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test e2e/payouts.spec.ts -g "pages with an Older link"`

Expected: FAIL. The page still calls `listPayoutOperations(getDb())` with no options and reads `ops.length`, so the build fails to compile with `Property 'length' does not exist on type 'PayoutListPage'` (the Task 8 typecheck error), and the spec never reaches its first assertion.

- [ ] **Step 3: Write the implementation**

Replace `src/app/payouts/page.tsx` in full:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  decodePayoutCursor,
  encodePayoutCursor,
  listPayoutOperations,
} from "@/services/payout-view";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { requirePayoutReader } from "./access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payouts",
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Collapses a possibly-repeated query param to one value, last wins — the
 *  same helper the audit page uses, for the same reason: a repeated param
 *  reaching code that declared only `string` took that page down with a 500. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const raw = await searchParams;
  // A hand-edited or stale cursor decodes to undefined and renders page 1,
  // rather than reaching Postgres as an invalid uuid comparison.
  const cursor = decodePayoutCursor(one(raw.before));
  const { operations: ops, nextCursor } = await listPayoutOperations(getDb(), {
    before: cursor,
  });

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];

  // `ops.length` is a PAGE count, not a total. It is shown only when this page
  // provably IS the whole list — nothing paged into it, nothing left after it.
  // Anywhere else "50 operations" would read as a total the moment a 51st
  // exists, and the pager below is what tells the reader there is more.
  const complete = cursor === undefined && nextCursor === null;
  const heading = complete
    ? ops.length === 1
      ? "1 operation"
      : `${ops.length} operations`
    : "Operations";

  // A cursor past the end is not an empty list, and without this the reader
  // lands on "No operations recorded yet" with no way back — the exit-link
  // lesson from src/app/admin/audit/page.tsx:286-294.
  const pastEnd = cursor !== undefined && ops.length === 0;

  return (
    <>
      <SiteHeader items={nav} current="/payouts" />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          <h1>Payouts</h1>
          <p className="page__lede">
            Every fight operation authGD has recorded: what it was worth, who was in it,
            and who has been paid.
          </p>
        </div>

        {/* Any flygd member reads every operation (transparency is the cheapest
            reconciliation mechanism the design has); only an operator — flygd
            AND active — gets the control that starts a new one. A cryo flygd
            member sees the list with no button here, and the action rejects
            regardless if they reach it another way. */}
        {access.isOperator && (
          <p className="btn-row pager">
            <Link className="btn btn--primary" href="/payouts/new">
              New operation
            </Link>
          </p>
        )}

        <RuleHead as="h2">{heading}</RuleHead>
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
                    <Link href={`/payouts/${op.id}`}>{op.name}</Link>
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
                    {pastEnd ? (
                      <>
                        Nothing older than this point.{" "}
                        <a href="/payouts">Back to the latest operations</a>
                      </>
                    ) : (
                      "No operations recorded yet."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Scroller>

        {/* The cursor is the only param this URL carries today. If a filter is
            ever added to this list, it must DROP `before` the way
            src/app/admin/audit/page.tsx:33-38 does: a cursor taken from a wider
            query pages into the middle of the narrower one. */}
        {nextCursor && (
          <div className="btn-row pager">
            <a
              className="btn"
              href={`/payouts?before=${encodeURIComponent(encodePayoutCursor(nextCursor))}`}
            >
              Older <span aria-hidden="true">→</span>
            </a>
          </div>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test e2e/payouts.spec.ts`

Expected: PASS, including the two new specs and the seven that already existed.

Then, because a Playwright run rewrites the tracked `tsconfig.json` and `AGENTS.md`:

Run: `git status --short` then `git checkout -- tsconfig.json AGENTS.md` if either shows as modified. Never delete them, and never `git add -A` after an e2e run.

- [ ] **Step 5: Commit**

```bash
git add src/app/payouts/page.tsx e2e/payouts.spec.ts
git commit -m "feat(payouts): page the operations list

An Older link carrying the composite cursor, matching the audit pager. The
heading no longer states a count unless the page provably holds every
operation -- a page count presented as a total is wrong the moment a 51st
operation exists. A cursor past the end gets an exit link rather than looking
like an empty database."
```

---

### Task 10: `openInformationWindow`, the `esi-ui.open_window.v1` scope, and the operator gate

**Files:**

- Modify: `src/lib/esi/client.ts:1-11` (constants), `:294-333` (the returned object)
- Modify: `src/services/tokens.ts:1-10` (imports), end of file
- Modify: `src/app/payouts/actions.ts:1-27` (imports), end of file
- Modify: `docs/ops.md:21`, `docs/ops.md:172`
- Modify: `.env.example:41`
- Test: `tests/esi-client.test.ts`, `tests/tokens.test.ts`

**Interfaces:**

- Consumes: `getFreshAccessToken(db, cfg, ch, fetchImpl?)` and `AccessTokenResult` from `src/services/tokens.ts`; `requireOperatorAccount()` (module-private in `src/app/payouts/actions.ts:37-48`).
- Produces:
  ```ts
  // src/lib/esi/client.ts
  export const OPEN_WINDOW_SCOPE = "esi-ui.open_window.v1";
  // on the object createEsiClient returns:
  openInformationWindow(
    characterId: number,
    accessToken: string,
    targetId: number,
  ): Promise<void>;

  // src/services/tokens.ts
  export async function getMainCharacterWithScope(
    dbx: Dbx,
    accountId: string,
    scope: string,
  ): Promise<CharacterTokenRow | null>;

  // src/app/payouts/actions.ts
  export async function openInfoAction(
    operationId: string,
    characterId: number,
  ): Promise<void>;
  ```

**ROLLOUT CONSEQUENCE — read before starting, this is the surprising part.** Adding `esi-ui.open_window.v1` to the deployed `EVE_SSO_SCOPES` flips **every existing character** to `needs_reauth` on the day it deploys, and the token-health job writes one `token.needs_reauth` audit row per character. Verified against the current source, the comparison sites are:

- `src/services/accounts.ts:106` — `tokenFields`' `hasAllScopes`, which decides `valid` vs `needs_reauth` at login.
- `src/jobs/token-health.ts:103` — `covered`, writing the audit row at `:115-121`.
- `src/services/account-view.ts:169` and `:182` — the member's own account page.
- `src/services/account-view.ts:250` and `:275` — the admin accounts table.

That is **four** comparison sites, not the three the design doc names (`account-view.ts` carries two independent ones, for the member view and the admin view). The doc's third bullet cites `src/app/admin/accounts/page.tsx:279`; that file only *renders* the `needsReauthForScopes` field computed in `account-view.ts`, and the render is at `:285`. No behavioural difference — the set of things that light up is the same.

**This is noise, not an outage, and that was verified too.** `src/jobs/contacts.ts:13-29` gates per job on `CONTACT_SCOPES` only, and `tests/contacts-job.test.ts:90-92` and `:203-210` pin that a `needs_reauth` character with both contact scopes granted still syncs. It self-heals as members log back in. The user was shown this cost and chose it. **Do not plan or build a required-vs-optional scope split.**

**Scope gating is on the persisted column, never on config.** `cfg.eveSso.scopes` says what we *ask* for; `character.scopes` (`src/db/schema.ts:69`) says what this operator actually *granted*. An operator who authorized before the scope existed has a perfectly valid session and no `open_window` scope, and a config-based gate would show them a control that always fails.

**Second documented exception to "enqueue, don't execute".** The first is interactive appraisal (`src/app/payouts/actions.ts:128-133`). Opening a window in the operator's own client is interactive and pointless to queue: a lost call is a re-click, a duplicated call opens the window twice, and a queued one would surface minutes later on a client that has moved on. It persists no state at CCP or here. That justification goes in the code comment, or a reviewer will correctly flag it as a rule violation.

- [ ] **Step 1: Write the failing tests for the ESI call**

Append to `tests/esi-client.test.ts`:

```ts
describe("openInformationWindow", () => {
  it("POSTs the target id with the operator's bearer token", async () => {
    let seen: { auth: string | null; target: string | null } | null = null;
    server.use(
      http.post(`${BASE}/ui/openwindow/information/`, ({ request }) => {
        seen = {
          auth: request.headers.get("authorization"),
          target: new URL(request.url).searchParams.get("target_id"),
        };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const esi = createEsiClient();
    await esi.openInformationWindow(90000001, "operator-at", 90000002);
    expect(seen).toEqual({ auth: "Bearer operator-at", target: "90000002" });
  });

  it("throws a classified EsiError when the character is not logged in", async () => {
    server.use(
      http.post(`${BASE}/ui/openwindow/information/`, () =>
        HttpResponse.json({ error: "Character not online" }, { status: 403 }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi
      .openInformationWindow(90000001, "at", 90000002)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(403);
  });

  it("suppresses the call entirely in dry-run", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/ui/openwindow/information/`, () => {
        calls++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const esi = createEsiClient({ syncMode: "dry-run" });
    await esi.openInformationWindow(90000001, "at", 90000002);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/esi-client.test.ts -t "openInformationWindow"`

Expected: FAIL — `esi.openInformationWindow is not a function`.

- [ ] **Step 3: Implement the client call**

In `src/lib/esi/client.ts`, add the scope constant beside the existing module constants (after line 10, `RESOLVE_IDS_CHUNK`):

```ts
/**
 * The scope belongs to the token making the call, i.e. the paying operator's
 * own character. Exported so the UI gate, the server action and the docs all
 * spell it identically: a typo here would silently hide the control forever
 * rather than fail.
 */
export const OPEN_WINDOW_SCOPE = "esi-ui.open_window.v1";
```

Add the function inside `createEsiClient`, after `writeContacts` (which ends at `:292`):

```ts
  /**
   * Opens the in-game information window for `targetId` on whichever client
   * the token's character is logged into. Nothing is persisted, at CCP or
   * here: the entire effect is a window appearing. ESI answers 204, or an
   * error if the character is not online — which the caller surfaces as a
   * message rather than a retry.
   *
   * `characterId` is not in the path (the endpoint is scoped by the token);
   * it is carried so the dry-run log names whose client would have opened.
   */
  async function openInformationWindow(
    characterId: number,
    accessToken: string,
    targetId: number,
  ): Promise<void> {
    if (dryRun) {
      logSuppressedWrite(
        "esi",
        `open information window for ${targetId} on character ${characterId}`,
      );
      return;
    }
    await request(`/ui/openwindow/information/?target_id=${targetId}`, {
      method: "POST",
      accessToken,
    });
  }
```

And add it to the returned object (`:294-333`), beside `resolveIds`:

```ts
  return {
    postAffiliation,
    resolveIds,
    openInformationWindow,
    getContactLabels,
    getAllContacts,
```

- [ ] **Step 4: Run to verify they pass**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/esi-client.test.ts`

Expected: PASS, all suites in the file.

- [ ] **Step 5: Write the failing test for the operator gate**

Append to `tests/tokens.test.ts`. Extend its imports to add `getMainCharacterWithScope` and `OPEN_WINDOW_SCOPE`:

```ts
import { getFreshAccessToken, getMainCharacterWithScope } from "@/services/tokens";
import { OPEN_WINDOW_SCOPE } from "@/lib/esi/client";
```

```ts
describe("getMainCharacterWithScope", () => {
  it("returns the main character's token row when it granted the scope", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000001,
      accountId: acc.id,
      main: true,
      scopes: [...cfg.eveSso.scopes, OPEN_WINDOW_SCOPE],
    });
    const row = await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE);
    expect(row?.id).toBe(90000001);
    expect(row?.tokenStatus).toBe("valid");
    expect(row?.refreshTokenEnc).toBeTruthy();
  });

  it("returns null when the main character authorized before the scope existed", async () => {
    // The whole reason this gate reads the persisted column and not config:
    // config says what we ASK for, and this operator has a valid session
    // whose token predates the ask.
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: acc.id,
      main: true,
      scopes: [...cfg.eveSso.scopes],
    });
    expect(await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE)).toBeNull();
  });

  it("ignores a non-main character that has the scope", async () => {
    // The call goes out on the operator's MAIN token; an alt holding the
    // scope does not make the control work.
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000003,
      accountId: acc.id,
      main: true,
      scopes: [...cfg.eveSso.scopes],
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90000004,
      accountId: acc.id,
      scopes: [...cfg.eveSso.scopes, OPEN_WINDOW_SCOPE],
    });
    expect(await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE)).toBeNull();
  });

  it("returns null for an account with no main character", async () => {
    const acc = await seedAccount(ctx.db);
    expect(await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/tokens.test.ts -t "getMainCharacterWithScope"`

Expected: FAIL — `"@/services/tokens" has no exported member 'getMainCharacterWithScope'`.

- [ ] **Step 7: Implement the gate helper**

In `src/services/tokens.ts`, widen the imports at `:1-9`:

```ts
import { and, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db, Dbx } from "@/db";
import { account, character } from "@/db/schema";
```

and append to the end of the file:

```ts
/**
 * The account's main character, but only if it actually GRANTED `scope`.
 *
 * Reads the persisted `character.scopes` column, never `cfg.eveSso.scopes`:
 * config states what login asks for, and an operator who authorized before a
 * scope was added has a valid session and a token without it. Gating on config
 * would offer them a control that fails every time.
 *
 * Returns the token row rather than a boolean so the caller that renders the
 * gate and the caller that makes the call agree by construction.
 */
export async function getMainCharacterWithScope(
  dbx: Dbx,
  accountId: string,
  scope: string,
): Promise<CharacterTokenRow | null> {
  const [row] = await dbx
    .select({
      id: character.id,
      refreshTokenEnc: character.refreshTokenEnc,
      tokenStatus: character.tokenStatus,
      scopes: character.scopes,
    })
    .from(account)
    .innerJoin(character, eq(character.id, account.mainCharacterId))
    .where(eq(account.id, accountId));
  if (!row || !row.scopes.includes(scope)) return null;
  return {
    id: row.id,
    refreshTokenEnc: row.refreshTokenEnc,
    tokenStatus: row.tokenStatus,
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/tokens.test.ts`

Expected: PASS, all suites in the file.

- [ ] **Step 9: Commit the two service-layer pieces**

```bash
git add src/lib/esi/client.ts src/services/tokens.ts tests/esi-client.test.ts tests/tokens.test.ts
git commit -m "feat(esi): add openInformationWindow and the operator scope gate

The scope belongs to the token making the call, so the gate reads the main
character's persisted scopes column rather than config: config says what login
asks for, and an operator who authorized before the scope existed has a valid
session without it."
```

- [ ] **Step 10: Add the server action**

No test: the action is a thin composition of two units that are now covered (`getMainCharacterWithScope`, `openInformationWindow`) plus `getFreshAccessToken`, which `tests/tokens.test.ts` already covers for all four failure reasons, and the repo has no harness for invoking a server action outside a browser. Its end-to-end behaviour belongs in the e2e task in Part D.

In `src/app/payouts/actions.ts`, extend the imports at `:22-23`:

```ts
import { getSessionAccount } from "@/services/session";
import { getFreshAccessToken, getMainCharacterWithScope } from "@/services/tokens";
import { createEsiClient, EsiError, OPEN_WINDOW_SCOPE } from "@/lib/esi/client";
```

and append to the end of the file:

```ts
/** getFreshAccessToken's four failure reasons, mapped to the `?error=` codes
 *  the detail page renders. Every branch has a message: an operator who clicks
 *  a control and sees nothing happen cannot tell a dead token from a client
 *  they forgot to log into. */
const OPEN_INFO_ERROR_BY_REASON = {
  no_token: "open_info_reauth",
  invalid: "open_info_reauth",
  transient: "open_info_failed",
  dry_run: "open_info_dry_run",
} as const;

/**
 * Opens the in-game information window for `characterId` on the operator's own
 * client, so they can right-click through to a transfer without retyping a
 * name.
 *
 * ARCHITECTURAL EXCEPTION to "enqueue, don't execute" — the second one, after
 * interactive appraisal above. The original justification was "read-only and
 * idempotent", and this is a POST, so it needs its own: the call persists NO
 * state, at CCP or here. Its entire effect is a window appearing on a game
 * client. A duplicated call opens it twice, a lost call opens nothing and the
 * operator clicks again, and there is no record to corrupt. Queueing it would
 * be actively worse — the window would surface minutes later on a client that
 * has moved on.
 *
 * Nothing changed, so nothing is revalidated; failures redirect with a code
 * rather than throwing a raw ESI error at the operator.
 */
export async function openInfoAction(
  operationId: string,
  characterId: number,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const cfg = getConfig();
  const db = getDb();

  // Gated on what this operator GRANTED, not on what config asks for. The
  // control should already be hidden for them; reaching here means a stale
  // page or a hand-made request, and it gets a message, not a 500.
  const main = await getMainCharacterWithScope(db, actor, OPEN_WINDOW_SCOPE);
  if (!main) redirect(`/payouts/${operationId}?error=open_info_reauth`);

  const token = await getFreshAccessToken(db, cfg, main);
  if (!token.ok) {
    redirect(`/payouts/${operationId}?error=${OPEN_INFO_ERROR_BY_REASON[token.reason]}`);
  }

  const esi = createEsiClient({
    userAgent: `authgd/0.1.0 (${cfg.esiContact})`,
    // Unlike appraisal (a read), this is a write and must honour dry-run. In
    // practice getFreshAccessToken already refuses above in dry-run mode; this
    // is the boundary guard sync-mode.ts asks every write to pass through.
    syncMode: cfg.syncMode,
  });
  try {
    await esi.openInformationWindow(main.id, token.accessToken, characterId);
  } catch (err) {
    if (err instanceof EsiError) {
      // The common case by far is "that character is not logged in right now",
      // which is not a fault to retry or to log as an error.
      redirect(`/payouts/${operationId}?error=open_info_offline`);
    }
    throw err;
  }
}
```

- [ ] **Step 11: Add the scope to the deployment values and the docs**

**Contradiction with the brief, resolved in favour of the repo:** `EVE_SSO_SCOPES` has **no default in `src/config.ts`** — it is `z.string().min(1)` at `:66`, deliberately required. There is no default value to edit there. The deployment value lives in `.env.example` and `docs/ops.md`.

`.env.example:41`:

```
EVE_SSO_SCOPES=esi-characters.read_contacts.v1 esi-characters.write_contacts.v1 esi-ui.open_window.v1
```

`docs/ops.md:21`, inside the `fly secrets set` block:

```
  EVE_SSO_SCOPES="esi-characters.read_contacts.v1 esi-characters.write_contacts.v1 esi-ui.open_window.v1" \
```

`docs/ops.md:172`, the environment table row:

```
| `EVE_SSO_SCOPES` | yes | space-separated full scope set requested at every login. Adding a scope flips every existing character to `needs_reauth` until its holder logs in again — a capability warning, not an outage: `src/jobs/contacts.ts` gates per job on the scopes it actually needs |
```

Then add a paragraph under the table, immediately after it, so the deploy-day noise is not a surprise:

```markdown
### Adding an SSO scope

Every character's granted scopes are compared against `EVE_SSO_SCOPES` in four
places — `tokenFields` (`src/services/accounts.ts`), the token-health job
(`src/jobs/token-health.ts`), the member account view and the admin accounts
view (both `src/services/account-view.ts`). Adding a scope therefore flips
**every** existing character to `needs_reauth` on the first token-health run
after deploy, and writes one `token.needs_reauth` audit row per character.

Sync keeps working throughout: each job gates on the scopes it actually needs,
so a character missing only the new scope still syncs. The warning clears
per member as they log in again.
```

**Do NOT change the scope string in `tests/helpers/config.ts`, `playwright.config.ts`, `tests/config.test.ts`, or the other test fixtures.** Those fixtures exist to exercise scope-coverage logic against a known set; widening them would flip `needsReauthForScopes` assertions in `tests/account-view.test.ts:73-81` and `tests/accounts.test.ts:289` for reasons that have nothing to do with this change. Tests that need the new scope opt in per character, as Step 5's do.

- [ ] **Step 12: Verify the whole change**

```bash
npx tsc --noEmit
npx eslint .
npx prettier --check .
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/esi-client.test.ts tests/tokens.test.ts tests/config.test.ts tests/account-view.test.ts tests/accounts.test.ts tests/contacts-job.test.ts tests/token-health-job.test.ts
```

Expected: clean typecheck and lint, `prettier --check` reporting no files, and every listed suite passing — the last four are named specifically because they are the suites that would catch an accidental widening of the shared scope fixtures.

- [ ] **Step 13: Commit**

```bash
git add src/app/payouts/actions.ts docs/ops.md .env.example
git commit -m "feat(payouts): open-info server action and the new SSO scope

Second documented exception to enqueue-don't-execute, justified in the code:
the call persists no state anywhere, so a lost call is a re-click and a
duplicate opens the window twice.

EVE_SSO_SCOPES gains esi-ui.open_window.v1. This flips every existing
character to needs_reauth until its holder logs in again and writes one audit
row each -- noise, not an outage, since every job gates on the scopes it
actually needs. docs/ops.md now says so where the variable is documented."
```

---

### Task 11: `/payouts/[id]` — loot item table, dropped-line reporting, manual participant entry

**Files:**

- Create: `src/app/payouts/dropped.ts`
- Create: `tests/payout-dropped.test.ts`
- Modify: `src/services/payout-view.ts:1-11` (imports), append `listCharacterNames`
- Modify: `src/app/payouts/actions.ts:102-165` (`addAppraisedPoolAction`)
- Modify: `src/app/payouts/[id]/page.tsx` — imports `:1-22`, `searchParams` type `:51`, error
  notice block `:118-122`, pools table `:167-273`, roster forms `:351-359`
- Test: `tests/payout-dropped.test.ts`, `tests/payout-view.test.ts`

**Interfaces:**

- Consumes:
  - `parseLootPaste(raw): { items: ParsedLootLine[]; dropped: DroppedLootLine[] }` and
    `DroppedLootLine = { line: string; reason: "zero-quantity" | "quantity-only" | "quantity-too-large" }`
    from `@/core/loot-paste` (Task A).
  - `AppraisalResult = { items: AppraisedItem[]; totalValue: string; dropped: DroppedLootLine[] }`
    from `@/services/appraisal` (Task A).
  - `addParticipantAction(operationId: string, formData: FormData): Promise<void>` and
    `setItemPriceAction(operationId: string, itemId: string, formData: FormData): Promise<void>`
    from `@/app/payouts/actions` (Task B). `setItemPriceAction` reads the `unitPrice`
    field; `addParticipantAction` reads the `name` field.
- Produces:
  - `src/app/payouts/dropped.ts`:
    `export const DROPPED_SAMPLE_LIMIT = 20`,
    `export const DROPPED_LINE_CHARS = 120`,
    `export const DROPPED_REASONS: Record<DroppedLootLine["reason"], string>`,
    `export type DroppedReport = { total: number; sample: DroppedLootLine[] }`,
    `export function encodeDropped(dropped: DroppedLootLine[]): string`,
    `export function decodeDropped(raw: string | undefined): DroppedReport | null`.
  - `src/services/payout-view.ts`:
    `export const CHARACTER_NAME_CAP = 500`,
    `export async function listCharacterNames(dbx: Dbx): Promise<string[] | null>`.
  - `addAppraisedPoolAction` now redirects to
    `/payouts/${operationId}?dropped=<base64url>` when the paste dropped lines.

**How `dropped` reaches the page — the decision, stated because it is not obvious.**

`dropped` comes back from the *action*, not from the persisted pool: the design deliberately
does not store dropped lines (`…phase-2-design.md:386`, defect 3 — "return them so the page
can name what it ignored", not "store them"), and `addAppraisedPool` derives the pool total
from `appraisal.items` alone, so nothing about the drops survives the write. It is a
**required** field on `AppraisalResult`, which means the action always has it and a re-read of
the pool never will. So the page cannot re-derive them on the next render, and there is no
client state to hold them in.

The existing `?error=` + `ERRORS` map (`[id]/page.tsx:37-40`, `actions.ts:160`) is the right
*mechanism* — a server action hands the next render a fact through the query string — but the
`ERRORS` map itself does not fit: it maps a fixed code to fixed copy, and dropped lines are
variable content that must be named individually. So this follows the redirect-with-a-param
precedent while carrying a payload instead of a code, with the same degradation rule the
`ERRORS` map has: an unrecognized or malformed `?dropped=` renders nothing at all
(`e2e/account.spec.ts:34` pins that rule for `?error=`).

Two alternatives, rejected: persisting the dropped lines on `loot_pool` needs a migration and
contradicts the design; a flash cookie cannot be cleared from a server component in Next 16
(`cookies()` is read-only during render), so the notice would outlive the paste that caused it.

**What the notice can honestly say — `dropped` is per-ITEM, not per-line.**

`parseLootPaste` sums quantities by item name *before* deciding what to drop (Task A), so one
`DroppedLootLine` is one dropped **item**, quoting the first raw line that introduced it. The
consequences the copy has to respect:

- `"0x Foo"` followed by `"2x Foo"` yields Foo at qty 2 and drops **nothing** — a line an
  operator can see was ignored is not necessarily a *drop*.
- `quantity-too-large` is checked against the **summed** quantity, so a run of individually
  reasonable lines can produce a single entry naming only the first of them.
- Therefore the count is a count of items, and it can be smaller than the number of raw lines
  behind it.

So the notice says **"N items ignored"**, and each entry reads as "this item, quoted from
where it first appeared". "N lines ignored" would be a false statement of both the number and
the unit — an operator counting lines against it would conclude the notice was broken.

- [ ] **Step 1: Write the failing test**

Create `tests/payout-dropped.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DROPPED_SAMPLE_LIMIT,
  decodeDropped,
  encodeDropped,
} from "@/app/payouts/dropped";
import type { DroppedLootLine } from "@/core/loot-paste";

const line = (n: number): DroppedLootLine => ({
  line: `Bad Line ${n}`,
  reason: "zero-quantity",
});

describe("encodeDropped / decodeDropped", () => {
  it("round-trips a short report intact", () => {
    const dropped: DroppedLootLine[] = [
      { line: "Tritanium\t0", reason: "zero-quantity" },
      { line: "12", reason: "quantity-only" },
      { line: "Nyx\t99999999999999999999", reason: "quantity-too-large" },
    ];
    expect(decodeDropped(encodeDropped(dropped))).toEqual({
      total: 3,
      sample: dropped,
    });
  });

  // A 200-line paste can drop more items than a query string should carry.
  // The COUNT must stay exact even when the detail is truncated, or the notice
  // under-reports how much of the paste was ignored — which is the one number
  // an operator uses to decide whether to re-paste.
  it("keeps the total exact while truncating the named sample", () => {
    const dropped = Array.from({ length: DROPPED_SAMPLE_LIMIT + 7 }, (_, i) => line(i));
    const report = decodeDropped(encodeDropped(dropped));
    expect(report?.total).toBe(DROPPED_SAMPLE_LIMIT + 7);
    expect(report?.sample).toHaveLength(DROPPED_SAMPLE_LIMIT);
    expect(report?.sample[0]).toEqual(line(0));
  });

  it("truncates an absurdly long line rather than shipping it whole", () => {
    const report = decodeDropped(
      encodeDropped([{ line: "x".repeat(5000), reason: "quantity-only" }]),
    );
    expect(report?.sample[0].line.length).toBeLessThanOrEqual(120);
  });

  // Same rule the ERRORS map already follows for an unrecognized ?error= code
  // (e2e/account.spec.ts:34): a hand-typed or truncated param degrades to the
  // plain page, never to an empty or half-rendered notice.
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["not base64url", "!!!!"],
    ["base64url of non-JSON", Buffer.from("nope", "utf8").toString("base64url")],
    ["JSON of the wrong shape", Buffer.from('{"a":1}', "utf8").toString("base64url")],
    ["a zero total", Buffer.from('{"total":0}', "utf8").toString("base64url")],
  ])("returns null for %s", (_label, raw) => {
    expect(decodeDropped(raw)).toBeNull();
  });

  it("drops a sample entry whose reason is not one this page can explain", () => {
    const raw = Buffer.from(
      JSON.stringify({
        total: 2,
        sample: [
          { line: "ok line", reason: "zero-quantity" },
          { line: "bad", reason: "made-up-reason" },
        ],
      }),
      "utf8",
    ).toString("base64url");
    expect(decodeDropped(raw)).toEqual({
      total: 2,
      sample: [{ line: "ok line", reason: "zero-quantity" }],
    });
  });
});
```

Append to `tests/payout-view.test.ts` (after the last `describe`), and extend its
`@/services/payout-view` import to
`import { CHARACTER_NAME_CAP, getPayoutOperationDetail, listCharacterNames, listPayoutOperations } from "@/services/payout-view";`
plus `import { character } from "@/db/schema";` alongside the existing schema import:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-dropped.test.ts
```

Expected: FAIL — `Failed to resolve import "@/app/payouts/dropped"`.

Run:

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-view.test.ts -t "listCharacterNames"
```

Expected: FAIL — `No test found` / `listCharacterNames is not a function` (the export does
not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/app/payouts/dropped.ts`:

```ts
import type { DroppedLootLine } from "@/core/loot-paste";

/**
 * Dropped paste lines travel from `addAppraisedPoolAction` to the next render
 * of the detail page through the query string, because they are deliberately
 * never persisted (see the phase-2 design, defect 3). This module is the only
 * place that encoding is written or read, so the two halves cannot drift.
 *
 * base64url rather than raw JSON: the payload is operator-pasted text, and
 * base64url's alphabet is already URL-safe, so nothing here depends on a
 * caller remembering to percent-encode it.
 */

/** How many dropped lines are named in the notice. A query string is not a
 *  transport for arbitrary volume — past this the notice names the first
 *  `DROPPED_SAMPLE_LIMIT` and says how many more there were. The *count* is
 *  always exact, because that is the number an operator uses to decide
 *  whether to re-paste. */
export const DROPPED_SAMPLE_LIMIT = 20;

/** Longest single line carried. A pasted inventory row is well under this;
 *  anything longer is already unreadable in a notice. */
export const DROPPED_LINE_CHARS = 120;

/** Why each item was ignored, in words an operator can act on. Worded for the
 *  per-ITEM semantics of `parseLootPaste`, which sums quantities by name before
 *  it decides: "added up to" is not padding, it is the difference between a
 *  true sentence and a false one when the same item appeared on several lines.
 *  Typed as a total `Record` over the union, so adding a reason in
 *  `@/core/loot-paste` fails the build here rather than rendering a bare enum
 *  value. */
export const DROPPED_REASONS: Record<DroppedLootLine["reason"], string> = {
  "zero-quantity": "quantity added up to 0",
  "quantity-only": "just a number, with no item name",
  "quantity-too-large": "quantity added up past what can be recorded exactly",
};

/** One dropped ITEM, quoting the first raw line that introduced it — never a
 *  raw line count. See `DROPPED_REASONS`. */
export type DroppedReport = { total: number; sample: DroppedLootLine[] };

export function encodeDropped(dropped: DroppedLootLine[]): string {
  const report: DroppedReport = {
    total: dropped.length,
    sample: dropped.slice(0, DROPPED_SAMPLE_LIMIT).map((d) => ({
      line: d.line.slice(0, DROPPED_LINE_CHARS),
      reason: d.reason,
    })),
  };
  return Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
}

/**
 * Null for anything this page cannot faithfully render — an absent param, a
 * hand-typed one, a truncated one. Same rule the `ERRORS` map follows for an
 * unrecognized `?error=` code: degrade to the plain page, never to an empty
 * or half-filled notice.
 */
export function decodeDropped(raw: string | undefined): DroppedReport | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { total, sample } = parsed as { total?: unknown; sample?: unknown };
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return null;
  if (!Array.isArray(sample)) return null;
  const clean = sample
    .filter(
      (d): d is DroppedLootLine =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as { line?: unknown }).line === "string" &&
        typeof (d as { reason?: unknown }).reason === "string" &&
        (d as { reason: string }).reason in DROPPED_REASONS,
    )
    .slice(0, DROPPED_SAMPLE_LIMIT)
    .map((d) => ({ line: d.line.slice(0, DROPPED_LINE_CHARS), reason: d.reason }));
  return { total, sample: clean };
}
```

In `src/services/payout-view.ts`, add `character` to the schema import (line 3-9) so it reads:

```ts
import {
  character,
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
} from "@/db/schema";
```

and append at the end of the file:

```ts
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
```

In `src/app/payouts/actions.ts`, add the import beside the other local ones:

```ts
import { encodeDropped } from "./dropped";
```

and rewrite `addAppraisedPoolAction`'s body from line 138 (`try {`) to line 165 as:

```ts
  // Carried out of the try so the redirect below runs after it: `redirect()`
  // throws a control-flow signal, and calling it inside the try would be
  // caught by the `catch` and rethrown as an unhandled error.
  let droppedParam: string | null = null;
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
    // Dropped lines are never persisted (design, defect 3), so the only way the
    // next render learns about them is the query string — same mechanism the
    // failure path above uses, carrying a payload instead of a fixed code.
    if (appraisal.dropped.length > 0) {
      droppedParam = encodeDropped(appraisal.dropped);
    }
  } catch (err) {
    if (err instanceof TriffError || err instanceof EsiError) {
      // Visible error on the appraisal form, pool left unvalued — never a
      // silent partial total, per the design's Pricing/Failure handling. An
      // ESI failure (name resolution inside appraiseLoot's resolveIds) is just
      // as much a transient upstream failure as a triff failure and deserves
      // the same friendly path, not an uncaught exit past this catch.
      redirect(`/payouts/${operationId}?error=appraisal_failed`);
    }
    throw err;
  }
  revalidateOperation(operationId);
  if (droppedParam) redirect(`/payouts/${operationId}?dropped=${droppedParam}`);
}
```

In `src/app/payouts/[id]/page.tsx`:

Replace the import block (lines 4-22) with:

```ts
import { getPayoutOperationDetail, listCharacterNames } from "@/services/payout-view";
import { Notice, RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { requirePayoutReader } from "../access";
import {
  addAppraisedPoolAction,
  addFlatPoolAction,
  addParticipantAction,
  deletePoolAction,
  finalizeAction,
  markPaidAction,
  removeParticipantAction,
  setItemPriceAction,
  setParticipantExcludedAction,
  setParticipantSharesAction,
  setRosterAction,
  unlockAction,
} from "../actions";
import { DROPPED_REASONS, decodeDropped } from "../dropped";
import { CopyAmountButton } from "./copy-amount-button";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { iskToCents } from "@/core/payout-split";
```

Add below the `ERRORS` map (after line 40):

```ts
/** The `<datalist>` the add-participant field points at. One per page, so a
 *  constant rather than a `useId` (this is a server component). */
const CHARACTER_LIST_ID = "known-character-names";
```

Change the `searchParams` type on line 51 to:

```ts
  searchParams: Promise<{ error?: string; dropped?: string }>;
```

and line 56 to:

```ts
  const { error, dropped } = await searchParams;
```

Add after line 59 (the `detail` destructure) — note the datalist read is skipped entirely for
a non-editing viewer, so a cryo reader never pays for a list they cannot use:

```ts
  const droppedReport = decodeDropped(dropped);
```

and after `canUnlock` is computed (line 75), add:

```ts
  // null when there are more characters than the datalist cap — the field then
  // degrades to plain free text (see listCharacterNames).
  const characterNames = canEdit ? await listCharacterNames(getDb()) : null;
```

Insert after the existing error notice block (after line 122):

```tsx
        {/* "items", not "lines": parseLootPaste sums by item name before it
            decides what to drop, so one entry is one item quoted from the line
            it first appeared on, and the count can be smaller than the number
            of raw lines behind it. */}
        {droppedReport && (
          <Notice tone="warn">
            <span>
              <strong>
                {droppedReport.total} item{droppedReport.total === 1 ? "" : "s"} ignored
              </strong>{" "}
              — the rest of the paste was appraised and saved. Nothing listed here is in
              the pool. Re-paste anything that was meant to count.
              <br />
              <span className="dim">
                {droppedReport.sample
                  .map((d) => `${d.line} (${DROPPED_REASONS[d.reason]})`)
                  .join("; ")}
              </span>
              {droppedReport.total > droppedReport.sample.length && (
                <>
                  <br />
                  <span className="dim">
                    …and {droppedReport.total - droppedReport.sample.length} more.
                  </span>
                </>
              )}
            </span>
          </Notice>
        )}
```

In the pools table, add a leading `#` column header (before `Source` at line 171):

```tsx
                <th scope="col">#</th>
```

change the map signature on line 180 to `{pools.map((pool, index) => {`, add the numbering
cell as the row's first `<td>` (before the `Source` cell at line 202):

```tsx
                    <td className="mono nowrap">{index + 1}</td>
```

and change the empty-state `colSpan={4}` on line 266 to `colSpan={5}`.

Then insert the item tables immediately after `</Scroller>` (line 273), before the
`{canEdit && (` block:

```tsx
        {/* The two warnings above stay exactly as they are. They are the fast
            path for "what needs attention" and are readable without opening
            anything; this table is the *fix* — the place an operator can see
            every line they pasted and reprice one. Removing either warning in
            favour of the table would trade a glance for an expand-and-scan.

            Below the Scroller rather than inside a pool row's cell: a table
            nested in a horizontally-scrolling cell is unreachable at 320px
            (the same reason the account page's remediation prose sits outside
            its Scroller). The disclosure keeps a 200-line paste from burying
            the roster, and `Pool N` ties it back to the numbered row above —
            `notes` is optional on an appraised pool and unique on none. */}
        {pools.map(
          (pool, index) =>
            pool.items.length > 0 && (
              <Disclosure
                key={pool.id}
                summary={`Pool ${index + 1} items (${pool.items.length})`}
                ariaLabel={`Pool ${index + 1} items (${pool.items.length}) — names, prices, and per-item overrides`}
              >
                <Scroller label={`Pool ${index + 1} items`}>
                  <table className="log">
                    <thead>
                      <tr>
                        <th scope="col">Item</th>
                        <th scope="col">Qty</th>
                        <th scope="col">Unit price</th>
                        <th scope="col">Line total</th>
                        <th scope="col">Price source</th>
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pool.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.name}</td>
                          <td className="mono nowrap">{item.qty}</td>
                          <td className="mono nowrap">{item.unitPrice}</td>
                          <td className="mono nowrap">{item.totalValue} ISK</td>
                          <td>
                            {item.priceSource === "unresolved" ? (
                              <Status tone="warn">unresolved</Status>
                            ) : (
                              <Status>{item.priceSource}</Status>
                            )}
                          </td>
                          <td>
                            {canEdit && (
                              <form
                                action={setItemPriceAction.bind(
                                  null,
                                  operation.id,
                                  item.id,
                                )}
                                className="inline-form"
                              >
                                {/* Named after the row it acts on, like the
                                    shares input below: "save" alone tells a
                                    speech-input or screen-reader operator
                                    which verb, never which of 200 items. */}
                                <input
                                  className="field"
                                  name="unitPrice"
                                  defaultValue={item.unitPrice}
                                  aria-label={`Unit price for ${item.name}`}
                                />
                                <Submit
                                  className="btn btn--micro"
                                  aria-label={`save unit price for ${item.name}`}
                                >
                                  save
                                </Submit>
                              </form>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </Disclosure>
            ),
        )}
```

Replace the roster form block (lines 351-359) with:

```tsx
        {canEdit && (
          <div className="stack">
            <form action={setRosterAction.bind(null, operation.id)} className="stack">
              <RuleHead as="h3">Replace the roster from a paste</RuleHead>
              <label className="stack">
                Paste (names separated by /)
                <textarea className="field" name="paste" rows={3} required />
              </label>
              <Submit className="btn">Set roster</Submit>
            </form>

            {/* A plain `<datalist>`, not a type-ahead: the browser does the
                filtering, so there is no endpoint, no client component, no new
                authorization surface, and it works with JavaScript off. The
                list is omitted entirely past `CHARACTER_NAME_CAP`, and the
                field then behaves as ordinary free text — `addParticipant`
                resolves the typed name server-side either way, so a missing
                suggestion costs a suggestion, not the feature. */}
            <form
              action={addParticipantAction.bind(null, operation.id)}
              className="stack"
            >
              <RuleHead as="h3">Add one participant</RuleHead>
              <label className="stack">
                Character name
                <input
                  className="field"
                  name="name"
                  list={characterNames ? CHARACTER_LIST_ID : undefined}
                  autoComplete="off"
                  required
                />
              </label>
              {characterNames && (
                <datalist id={CHARACTER_LIST_ID}>
                  {characterNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              )}
              <Submit className="btn">Add participant</Submit>
            </form>
          </div>
        )}
```

- [ ] **Step 4: Run test to verify it passes**

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/payout-dropped.test.ts tests/payout-view.test.ts
npm run typecheck
```

Expected: both suites pass; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```
git add src/app/payouts/dropped.ts src/app/payouts/actions.ts "src/app/payouts/[id]/page.tsx" src/services/payout-view.ts tests/payout-dropped.test.ts tests/payout-view.test.ts
git commit -m "feat(payouts): show every pasted item, name what the parser ignored, add one participant at a time"
```

---

### Task 12: `/payouts/[id]` payments and history, open-info, and `/account` "your payouts"

**Files:**

- Modify: `src/services/payout-view.ts` — append `listAccountPayouts` (no change to `PayoutParticipantView` or `getPayoutOperationDetail`; Task 4 already did that)
- Modify: `src/app/payouts/access.ts:1-50`
- Modify: `src/app/payouts/[id]/page.tsx` — imports, freeze notice after `:147`, participants table `:361-464`
- Create: `src/app/account/account-payouts.tsx`
- Modify: `src/app/account/page.tsx:1-30` (imports), `:110-140` (data), after `:471`
- Test: `tests/payout-view.test.ts`, `tests/account-payouts.test.ts`

**Interfaces:**

- Consumes:
  - `revertPaymentAction(operationId: string, participantId: string): Promise<void>` and
    `openInfoAction(operationId: string, characterId: number): Promise<void>` from
    `@/app/payouts/actions` (Tasks B and C).
  - `PayoutParticipantView` **already carries** its events — Task 4 added
    `payments: Array<typeof payoutPayment.$inferSelect>`, ordered `(at asc, id asc)`, because
    flipping the state check to `paidAmount !== null` would otherwise have left the payments
    query dead. This task only **renders** that field; do not re-add it, re-order it, or
    re-plan the query.
  - `revertPayment` clears `paidAmount` and appends a `kind: "reverted"` row written with
    `clock_timestamp()` (Task B), which is what makes `(at asc, id asc)` causally correct.
  - Derived payment state already comes from `paidAmount !== null` (Task 4).
- Produces:
  - `src/services/payout-view.ts`:
    `export type AccountPayoutRow = { operationId: string; operationName: string; occurredAt: Date; amount: string; paid: boolean }`,
    `export async function listAccountPayouts(dbx: Dbx, accountId: string): Promise<AccountPayoutRow[]>`.
  - `src/app/payouts/access.ts`: `PayoutAccess` gains `canOpenInfo: boolean`.
  - `src/app/account/account-payouts.tsx`:
    `export function AccountPayouts({ rows, linkToOperations }: { rows: AccountPayoutRow[]; linkToOperations: boolean })`.

- [ ] **Step 1: Write the failing test**

Before writing anything, confirm the open-window scope string is not already exported by
Task C's config change (if it is, import it rather than re-declaring it):

```
rg -n "open_window" src/config.ts src/services src/app
```

Append to `tests/payout-view.test.ts`, extending its imports with `payoutOperation` from
`@/db/schema`, `revertPayment` from `@/services/payouts`, and `listAccountPayouts` from
`@/services/payout-view` (Task 4 already added whatever its own history test needed):

```ts
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
    const { member, operationId, operator } = await seedForAccount();
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
```

`seedOperation` in that file must return `operator`; if it does not already, widen its return
to include it — no behaviour change, only what it hands back.

Create `tests/account-payouts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPayouts } from "@/app/account/account-payouts";
import type { AccountPayoutRow } from "@/services/payout-view";

// Renders the section component directly, the way tests/account-page.test.ts
// renders ContactRemedy: the account page itself is an async server component
// that reads the session cookie and the database, so it cannot be rendered
// outside a request. Splitting the section out is what makes the one rule that
// matters here — who gets a link — testable at all.
const rows: AccountPayoutRow[] = [
  {
    operationId: "11111111-1111-4111-8111-111111111111",
    operationName: "Thursday roam",
    occurredAt: new Date("2026-08-01T00:00:00Z"),
    amount: "450000.00",
    paid: true,
  },
  {
    operationId: "22222222-2222-4222-8222-222222222222",
    operationName: "Sunday brawl",
    occurredAt: new Date("2026-07-28T00:00:00Z"),
    amount: "1200.50",
    paid: false,
  },
];

const render = (linkToOperations: boolean) =>
  renderToStaticMarkup(createElement(AccountPayouts, { rows, linkToOperations }));

describe("AccountPayouts", () => {
  it("links each operation for a viewer who can read payouts", () => {
    const html = render(true);
    expect(html).toContain('href="/payouts/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/payouts/22222222-2222-4222-8222-222222222222"');
  });

  // Reading your own history needs only a session; reading an OPERATION needs
  // tier flygd. A member demoted to blue/green still gets the answer to "did I
  // get paid for that Thursday roam" — and a link that silently redirected
  // them back to /account would be worse than no link.
  it("renders the operation as plain text for a viewer who cannot", () => {
    const html = render(false);
    expect(html).not.toContain('href="/payouts/');
    expect(html).toContain("Thursday roam");
    expect(html).toContain("Sunday brawl");
  });

  it("shows the exact stored amount and each paid state", () => {
    const html = render(false);
    expect(html).toContain("450000.00 ISK");
    expect(html).toContain("1200.50 ISK");
    expect(html).toContain("paid");
    expect(html).toContain("unpaid");
  });

  it("renders the operation date, not a relative time", () => {
    expect(render(false)).toContain("2026-08-01");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/account-payouts.test.ts tests/payout-view.test.ts
```

Expected: FAIL — `Failed to resolve import "@/app/account/account-payouts"` for the first
suite, and `listAccountPayouts is not a function` for the second.

- [ ] **Step 3: Write minimal implementation**

In `src/services/payout-view.ts`, add `and` to the drizzle import on line 1 — `asc`, `desc`,
`eq` and `inArray` are already there:

```ts
import { and, asc, desc, eq, inArray } from "drizzle-orm";
```

Append to the same file — `PayoutParticipantView` and `getPayoutOperationDetail` are **not**
touched here; Task 4 already gave them `payments`:

```ts
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
```

In `src/app/payouts/access.ts`, add two imports — `OPEN_WINDOW_SCOPE` from
`@/lib/esi/client` (Task 10 exports it there, beside the `openInformationWindow` call
it authorizes — **do not redeclare the string here**; two copies of a scope constant
drift silently and fail open) and `getMainCharacterWithScope` from `@/services/tokens`
— then replace the type and the return with:

```ts
export type PayoutAccess = {
  accountId: string;
  /** tier flygd AND status active — the requirePayoutOperator gate, mirrored
   *  here only to decide what to render; every mutation re-checks itself. */
  isOperator: boolean;
  isAdmin: boolean;
  /** This operator's own main character has granted `OPEN_WINDOW_SCOPE`. Gated
   *  on the character's PERSISTED grant, never on `cfg.eveSso.scopes`: config
   *  says what authGD asks for, and an operator who authorized before the scope
   *  was added has a perfectly valid session and no open-window grant.
   *
   *  The control is hidden, not disabled, when false: a disabled button
   *  advertises a capability this operator does not have and gives them nothing
   *  to do about it. Copy amount and Mark paid stay scope-free, so an operator
   *  without the grant loses nothing phase 1 gave them. */
  canOpenInfo: boolean;
};
```

and inside `requirePayoutReader`, after the `isOperator` try/catch (before the return):

```ts
  // Task 10's helper IS the gate — do not hand-roll a second scopes read here.
  // It already resolves the account's main character and answers only on the
  // PERSISTED grant, so one source decides both what renders and what runs.
  // The token making the call belongs to the OPERATOR, not the recipient, which
  // is why the operator's own account id is the argument.
  //
  // It returns the row rather than a boolean because `openInfoAction` needs the
  // row (`getFreshAccessToken` wants id / refreshTokenEnc / tokenStatus) and
  // re-checks at call time regardless — a render-time boolean is a rendering
  // decision, never an authorization one. Here only its presence matters.
  const canOpenInfo =
    isOperator &&
    (await getMainCharacterWithScope(db, sess.accountId, OPEN_WINDOW_SCOPE)) !== null;

  return {
    accountId: sess.accountId,
    isOperator,
    isAdmin: acc?.isAdmin ?? false,
    canOpenInfo,
  };
```

Then replace the `ERRORS` map (lines 37-40 as the file stands — Task 11 leaves it in place
and adds `CHARACTER_LIST_ID` below it) with the four codes `openInfoAction` redirects with
(Task 10 maps them: `no_token`/`invalid` → `open_info_reauth`, `transient` →
`open_info_failed`, `dry_run` → `open_info_dry_run`, and a `404`/no-client answer from ESI →
`open_info_offline`). They belong to **this** task, not Task 11, because this task is what
puts a control on the page capable of producing them:

```ts
const ERRORS: Record<string, string> = {
  appraisal_failed:
    "Could not price that paste right now (triff.tools did not answer). Nothing was saved — adjust and try again, or use a flat pool.",
  // The expected outcome on a busy night, not a fault: EVE can only open a
  // window on a client that is running. Worded as a fact about the game rather
  // than a failure, because an operator paying out a fleet will meet this
  // constantly, and the fallback — copy the amount, pay by hand — is exactly
  // what they did before this control existed. Nothing is lost.
  open_info_offline:
    "That character is not logged in, so EVE had nowhere to open the window. Nothing else changed — copy the amount and pay them when they are next online.",
  // Distinct from offline because the fix is different, and is the operator's
  // own to make: the grant is missing from THEIR login, not the recipient's.
  open_info_reauth:
    "Opening a window in EVE needs a permission your login does not carry yet. Add your character again from your account page to grant it — everything else here keeps working without it.",
  open_info_failed:
    "Could not reach EVE just then. Nothing changed; try again in a moment, or copy the amount and pay by hand.",
  open_info_dry_run:
    "This deployment is in dry-run mode, so nothing is sent to EVE. The amounts and the payment controls are real; only the in-game window is suppressed.",
};
```

In `src/app/payouts/[id]/page.tsx`, extend the actions import with `openInfoAction` and
`revertPaymentAction`, and add:

```ts
import { ConfirmArmScope, ConfirmSubmit } from "@/app/_components/confirm-submit";
```

Add beside `fmtDate` (after line 44):

```ts
/** Payment events are audit-grade, so they get a full instant rather than a
 *  relative time — same shape the audit log uses. */
function fmtAt(d: Date): string {
  return `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}
```

Insert the freeze notice immediately after the operation `</dl>` (after line 147):

```tsx
        {locked && (
          <Notice tone="warn">
            <span>
              <strong>This operation is frozen.</strong> A payment has been recorded, so
              the loot pools, the roster, shares and the corp share are fixed permanently.
              Reverting a payment does not reopen editing — it corrects who has been paid,
              and nothing else. If the wrong person was marked paid, revert them and pay
              the right one; both work while frozen.
            </span>
          </Notice>
        )}
```

Wrap the participants `<tbody>` contents in `<ConfirmArmScope>` (required — `ConfirmSubmit`
throws outside one), replace the State cell (lines 402-408) with:

```tsx
                  <td>
                    <div className="stack">
                      {p.paymentState === "excluded" && (
                        <Status tone="off">excluded</Status>
                      )}
                      {p.paymentState === "unpaid" && <Status tone="warn">unpaid</Status>}
                      {p.paymentState === "paid" && <Status tone="ok">paid</Status>}
                      {/* Stored since phase 1 and never shown until now. The
                          list is `.stack` (a grid), which blockifies the items
                          so no markers render. */}
                      {p.payments.length > 0 && (
                        <Disclosure
                          summary={`payments (${p.payments.length})`}
                          ariaLabel={`payments (${p.payments.length}) for ${p.displayName}`}
                        >
                          <ul className="stack">
                            {p.payments.map((ev) => (
                              <li key={ev.id}>
                                <span className="mono nowrap">{fmtAt(ev.at)}</span>{" "}
                                {ev.kind}{" "}
                                <span className="mono nowrap">{ev.amount} ISK</span>
                              </li>
                            ))}
                          </ul>
                        </Disclosure>
                      )}
                    </div>
                  </td>
```

and the finalized branch of the actions cell (lines 411-423) with:

```tsx
                      {operation.status === "finalized" &&
                        p.paymentState !== "excluded" && (
                          <>
                            <CopyAmountButton amount={p.amount} />
                            {access.canOpenInfo && p.recipientCharacterId !== null && (
                              <form
                                action={openInfoAction.bind(
                                  null,
                                  operation.id,
                                  p.recipientCharacterId,
                                )}
                              >
                                <Submit
                                  className="btn btn--quiet btn--micro"
                                  pendingLabel="opening…"
                                  aria-label={`open info for ${p.displayName}`}
                                >
                                  open info
                                </Submit>
                              </form>
                            )}
                            {p.paymentState !== "paid" && access.isOperator && (
                              <form
                                action={markPaidAction.bind(null, operation.id, p.id)}
                              >
                                <Submit className="btn btn--micro">mark paid</Submit>
                              </form>
                            )}
                            {/* Reverting money is not a one-click action, so it
                                arms first, like the admin table's destructive
                                row controls. */}
                            {p.paymentState === "paid" && access.isOperator && (
                              <form
                                action={revertPaymentAction.bind(
                                  null,
                                  operation.id,
                                  p.id,
                                )}
                              >
                                <ConfirmSubmit
                                  className="btn btn--quiet btn--micro btn--danger-quiet"
                                  armedClassName="btn btn--micro btn--danger"
                                  label="revert"
                                  restName={`revert payment for ${p.displayName}`}
                                  confirmName={`confirm revert payment for ${p.displayName}`}
                                />
                              </form>
                            )}
                          </>
                        )}
```

Create `src/app/account/account-payouts.tsx`:

```tsx
import { RuleHead, Scroller, Status } from "@/app/_components/ui";
import type { AccountPayoutRow } from "@/services/payout-view";

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The member's own finalized payouts.
 *
 * A plain (non-async) component taking already-read rows rather than querying
 * for itself: that is what lets tests/account-payouts.test.ts render it
 * directly, the way tests/account-page.test.ts renders ContactRemedy. The
 * account page is an async server component reading the session cookie and the
 * database, and cannot be rendered outside a request.
 *
 * `linkToOperations` is the viewer's `canReadPayouts` verdict, passed in rather
 * than re-derived. Reading your own history needs only a session; reading an
 * OPERATION needs tier flygd. A member demoted to blue/green, or moved to
 * cryo, still gets the answer to "did I get paid for that Thursday roam"
 * without regaining access to the operation — and always linking would hand
 * them a link that silently redirects back to this page.
 *
 * Plain `<a>` rather than next/link, matching every other link on this page,
 * which also keeps it renderable outside the Next router for that test.
 *
 * One row per operation: alts collapse into one participant, and an unresolved
 * name carries no accountId at all, so nothing here can duplicate an
 * operationId key.
 */
export function AccountPayouts({
  rows,
  linkToOperations,
}: {
  rows: AccountPayoutRow[];
  linkToOperations: boolean;
}) {
  return (
    <>
      <RuleHead as="h2">Your payouts</RuleHead>
      <Scroller label="Your payouts">
        <table className="log">
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Date</th>
              <th scope="col">Amount owed</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.operationId}>
                <td>
                  {linkToOperations ? (
                    <a href={`/payouts/${r.operationId}`}>{r.operationName}</a>
                  ) : (
                    r.operationName
                  )}
                </td>
                <td className="mono nowrap">{fmtDate(r.occurredAt)}</td>
                {/* The exact numeric(20,2) string the column holds. */}
                <td className="mono nowrap">{r.amount} ISK</td>
                <td>
                  {r.paid ? (
                    <Status tone="ok">paid</Status>
                  ) : (
                    <Status tone="warn">unpaid</Status>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
    </>
  );
}
```

In `src/app/account/page.tsx`, add to the imports:

```ts
import { listAccountPayouts } from "@/services/payout-view";
import { AccountPayouts } from "./account-payouts";
```

add after line 129 (`const showPayoutsLink = …`):

```ts
  // Finalized operations only, and only rows whose participant resolved to
  // this account — see listAccountPayouts for both, including what the second
  // one cannot show.
  const payouts = await listAccountPayouts(getDb(), sess.accountId);
```

and insert after the "Add character" `</p>` (after line 471):

```tsx
        {/* Omitted entirely when there are none, like the "Last pushed" block
            below: an empty table under "Your payouts" on every green member's
            page is a section that never says anything. */}
        {payouts.length > 0 && (
          <AccountPayouts rows={payouts} linkToOperations={showPayoutsLink} />
        )}
```

- [ ] **Step 4: Run test to verify it passes**

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npx vitest run tests/account-payouts.test.ts tests/payout-view.test.ts
npm run typecheck
```

Expected: both suites pass; `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```
git add src/services/payout-view.ts src/app/payouts/access.ts "src/app/payouts/[id]/page.tsx" src/app/account/account-payouts.tsx src/app/account/page.tsx tests/account-payouts.test.ts tests/payout-view.test.ts
git commit -m "feat(payouts): show payment history, allow an audited revert, and tell members what they are owed"
```

---

### Task 13: End-to-end coverage and the final verification gate

**Files:**

- Modify: `e2e/payouts.spec.ts` (append three tests)
- Modify: `e2e/account.spec.ts` (append one test)

**Interfaces:**

- Consumes: everything Tasks 1-12 produced. No new exports.
- Produces: nothing importable.

**Environment hazards — read before running anything in this task.**

1. **Running the dev server rewrites tracked files.** `next dev` — including the server
   Playwright boots via `webServer` in `playwright.config.ts` — rewrites `tsconfig.json` and
   `AGENTS.md`. **Both are tracked.** After any e2e run:
   - recover with `git checkout tsconfig.json AGENTS.md` — **never** delete them;
   - **never** `git add -A` after an e2e run, or the rewrite lands in the commit. Stage
     explicit paths, as every commit in this plan does.
2. **`npm test` shares one database across worktrees.** Always run it as
   `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npm test`.
3. **`npm run test:e2e` self-isolates** (per-worktree container and port, derived from the
   worktree path in `e2e/env.ts`), **but the derived DB port can collide** with another
   worktree's stale container. The override is `E2E_DB_PORT=<port> npm run test:e2e`
   (`E2E_PORT` does the same for the app port). A collision fails loudly and names the
   variable to set — it does not silently share a database.

- [ ] **Step 1: Write the failing test**

Append to `e2e/payouts.spec.ts` (its imports already cover `lootItem`, `lootPool`,
`payoutOperation`, `payoutParticipant`; add `character` and `payoutPayment` to the schema
import, and add `import { OPEN_WINDOW_SCOPE } from "../src/lib/esi/client";`).

**Append at the end of the file.** Task 9 has already added two pagination specs to this same
file; these three go after them. Do not overwrite the file or re-declare its `testDb()` /
`afterAll` / `beforeEach` preamble — it is shared by every test in it.

```ts
/**
 * The whole phase-2 money loop in one pass: override an item price, finalize,
 * pay, revert, pay again.
 *
 * The pool and its item are written directly rather than through the appraise
 * form, for the same reason the unresolved-item test above does it: the form
 * calls triff.tools, and this suite must not depend on an external service.
 * The override itself goes through the UI, because that is what is under test.
 */
test("override an item price, finalize, pay, revert, and pay again", async ({
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
      name: "Repriced haul",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const [poolRow] = await db
    .insert(lootPool)
    .values({
      operationId: op.id,
      valuationSource: "appraised",
      pricingMode: "sell_best",
      stationId: 60003760,
      totalValue: "100.00",
    })
    .returning();
  await db.insert(lootItem).values({
    poolId: poolRow.id,
    typeId: 34,
    name: "Tritanium",
    qty: 10,
    unitPrice: "10.00",
    totalValue: "100.00",
    priceSource: "triff",
  });

  await page.goto(`/payouts/${op.id}`);
  // The item table is behind the disclosure, so a 200-line paste cannot bury
  // the roster — nothing inside it is reachable until it is opened.
  await expect(page.getByLabel("Unit price for Tritanium")).toHaveCount(0);
  await page.locator("summary", { hasText: "Pool 1 items (1)" }).click();

  await page.getByLabel("Unit price for Tritanium").fill("25.00");
  await page.getByRole("button", { name: "save unit price for Tritanium" }).click();

  // 25.00 x 10, exactly — the line total, the pool total and the operation
  // total all re-derive from the override.
  await page.locator("summary", { hasText: "Pool 1 items (1)" }).click();
  const itemRow = page.getByRole("row").filter({ hasText: "Tritanium" });
  await expect(itemRow).toContainText("250.00 ISK");
  await expect(itemRow).toContainText("manual");
  const poolRowLocator = page.getByRole("row").filter({ hasText: "appraised" });
  await expect(poolRowLocator).toContainText("250.00 ISK");

  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Set roster" }).click();
  const rowFor = (name: string) => page.getByRole("row").filter({ hasText: name });
  await expect(rowFor("Brain Tartare")).toContainText("125.00 ISK");

  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: "mark paid" }).first().click();
  await expect(rowFor("Brain Tartare")).toContainText("paid");

  // The freeze is permanent, and the page has to say so where the operator is
  // about to reach for revert — an operator who reverts expecting to fix the
  // roster has been misled.
  await expect(page.getByText("This operation is frozen")).toBeVisible();
  await expect(
    page.getByText("Reverting a payment does not reopen editing"),
  ).toBeVisible();

  // Revert arms on the first click and only fires on the second.
  const revert = rowFor("Brain Tartare").getByRole("button", { name: /^revert/ });
  await revert.click();
  await rowFor("Brain Tartare")
    .getByRole("button", { name: /^confirm revert/ })
    .click();
  await expect(rowFor("Brain Tartare")).toContainText("unpaid");

  // Paying again is the whole point of clearing paidAmount — without it a
  // reverted participant could never be paid, which defeats the feature.
  await rowFor("Brain Tartare").getByRole("button", { name: "mark paid" }).click();
  await expect(rowFor("Brain Tartare")).toContainText("paid");

  // Three events, in the order they happened, oldest first.
  const [brainTartare] = await db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.displayName, "Brain Tartare"));
  const events = await db
    .select()
    .from(payoutPayment)
    .where(eq(payoutPayment.participantId, brainTartare.id));
  expect(events).toHaveLength(3);

  await rowFor("Brain Tartare").locator("summary", { hasText: "payments (3)" }).click();
  const history = rowFor("Brain Tartare").locator("li");
  await expect(history).toHaveCount(3);
  await expect(history.nth(0)).toContainText("paid");
  await expect(history.nth(1)).toContainText("reverted");
  await expect(history.nth(2)).toContainText("paid");

  // The revert is audited like every other state change, and targets the
  // OPERATION uuid so one operation's history stays under one target.
  const reverted = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, "payout.payment_reverted"), eq(auditLog.target, op.id)),
    );
  expect(reverted).toHaveLength(1);
});

/**
 * The datalist is inert HTML, not a type-ahead: it ships with the page, the
 * browser filters it, and the form submits without JavaScript. This asserts
 * the options are in the document — the browser's own popup is not something
 * Playwright can or should drive.
 */
test("manual participant entry offers known character names and adds one", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  await seedMember(db, { name: "Latecomer Pilot", tier: "green" });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Late arrival",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto(`/payouts/${op.id}`);
  await expect(page.locator("datalist option[value='Latecomer Pilot']")).toHaveCount(1);

  await page.getByLabel("Character name").fill("Latecomer Pilot");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Latecomer Pilot" })).toHaveCount(
    1,
  );
});

/**
 * The open-info control is gated on the operator's own PERSISTED scopes, and
 * is hidden rather than disabled when the grant is absent.
 *
 * The scope is written straight onto the seeded character row. Widening the
 * scope list in `tests/helpers/config.ts` or `playwright.config.ts` would be
 * the wrong lever twice over: it flips unrelated assertions in
 * `tests/account-view.test.ts:73-81` and `tests/accounts.test.ts:289`, and it
 * would test config rather than the gate — the whole point of the gate is that
 * a persisted grant, not a configured request, decides.
 *
 * Nothing here clicks the control. Doing so would call EVE SSO and ESI for
 * real; the four `open_info_*` outcomes are covered as units in
 * `tests/tokens.test.ts` and `tests/esi-client.test.ts`.
 */
test("open info appears only for an operator whose character granted the scope", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  const recipient = await seedMember(db, { name: "Paid Pilot", tier: "flygd" });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  // The control also needs a resolved recipient — it is the ESI target_id, and
  // an unresolved participant name has none. seedMember allocates the character
  // id internally, so read it back rather than guessing.
  const [recipientChar] = await db
    .select()
    .from(character)
    .where(eq(character.accountId, recipient.id));

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Scope check",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      status: "finalized",
      createdBy: operator.id,
    })
    .returning();
  await db.insert(payoutParticipant).values({
    operationId: op.id,
    accountId: recipient.id,
    recipientCharacterId: recipientChar.id,
    displayName: "Paid Pilot",
    shares: "1",
    amount: "100.00",
  });

  // seedMember writes `scopes: []`, so this is the no-grant case.
  await page.goto(`/payouts/${op.id}`);
  const row = page.getByRole("row").filter({ hasText: "Paid Pilot" });
  await expect(row.getByRole("button", { name: "open info for Paid Pilot" })).toHaveCount(
    0,
  );
  // The scope-free controls are unaffected — an operator without the grant
  // loses nothing phase 1 gave them.
  await expect(row.getByRole("button", { name: "copy amount" })).toHaveCount(1);

  await db
    .update(character)
    .set({ scopes: [OPEN_WINDOW_SCOPE] })
    .where(eq(character.accountId, operator.id));

  await page.reload();
  await expect(row.getByRole("button", { name: "open info for Paid Pilot" })).toHaveCount(
    1,
  );
});
```

Append to `e2e/account.spec.ts`, extending its schema import with `payoutOperation` and
`payoutParticipant`:

```ts
/**
 * Reading your own history needs only a session; reading an OPERATION needs
 * tier flygd. A member demoted out of flygd still gets the answer to "did I
 * get paid for that Thursday roam" — as plain text, because a link would
 * silently redirect them straight back to this page.
 */
test("a member who is no longer flygd sees their payout row with no link to the operation", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  const member = await seedMember(db, { name: "Demoted Pilot", tier: "green" });

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Thursday roam",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      status: "finalized",
      createdBy: operator.id,
    })
    .returning();
  await db.insert(payoutParticipant).values({
    operationId: op.id,
    accountId: member.id,
    displayName: "Demoted Pilot",
    shares: "1",
    amount: "450000.00",
  });

  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/account");

  const row = page.getByRole("row").filter({ hasText: "Thursday roam" });
  await expect(row).toContainText("450000.00 ISK");
  await expect(row).toContainText("unpaid");
  // The name is there; the link is not.
  await expect(row.getByRole("link")).toHaveCount(0);
  // And the nav offers no way in either — same tier gate, one control up.
  await expect(page.getByRole("link", { name: "Payouts" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npm run test:e2e -- e2e/payouts.spec.ts -g "override an item price"
```

Expected: FAIL — `locator.click: Timeout` waiting for `summary` matching "Pool 1 items (1)"
if Task 11 is not in place, or the revert control missing if Task 12 is not.

If it fails with a database-port error instead, re-run with the override:
`E2E_DB_PORT=5699 npm run test:e2e -- …`.

Then, immediately: `git checkout tsconfig.json AGENTS.md`.

- [ ] **Step 3: Write minimal implementation**

No implementation — Tasks 1-12 are the implementation. If a test above fails, fix the source
it exercises, never the assertion, unless the assertion is provably wrong about the design.

- [ ] **Step 4: Run test to verify it passes — the full gate**

Run all four, in this order, and **quote the real output** in any completion claim. A claim
that a suite passed is only as good as the output pasted beside it; never assert a result
from memory.

```
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_payouts2 npm test
npm run typecheck
npm run test:e2e
npm run format:check
```

Then: `git checkout tsconfig.json AGENTS.md` and confirm `git status` shows only the files
this plan intends to change.

`npm run format:check` runs `prettier --check .` over the **whole repository**, exactly as CI
does. Checking only the changed files passes locally while CI fails, so run it unscoped. Fix
with `npm run format` and re-run.

Also run `npm run lint` — CI runs ESLint too, and the new client-component boundaries
(`Disclosure`, `ConfirmSubmit`, `ConfirmArmScope`) are exactly where a rule like
`@next/next` or `react-hooks` catches a mistake typecheck does not.

- [ ] **Step 5: Commit**

```
git add e2e/payouts.spec.ts e2e/account.spec.ts
git commit -m "test(payouts): cover the reprice, pay, revert, pay loop and the member payout view end to end"
```

---
