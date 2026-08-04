# Audit Filter by Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin filter the audit log by the human names PR #43 put on
screen — by clicking a name in a row, or by typing one into the filter box.

**Architecture:** Names are resolved to id sets *before* the audit query runs,
never inside it, and the resulting ids are matched with `inArray`. One person's
target rows span up to three raw identifier forms (account UUID, EVE character
id, Discord snowflake), so a name filter unions them. The audit table's scan
shape is unchanged; the name work lands on `character`/`account`.

**Tech Stack:** Next.js 15 App Router (server components only), Drizzle ORM,
Postgres, Vitest, Playwright.

Spec: `docs/superpowers/specs/2026-08-03-audit-filter-by-name-design.md`

## Global Constraints

- **Read path only.** No schema change, no migration, no change to `logAudit`
  or any write path. If you think you need an index, stop and ask.
- **Server components only.** The repo has exactly four `'use client'` modules;
  do not add a fifth. The filter is a plain GET form and `clear` is a link.
- **Reuse `resolveAuditIdentities`** (`src/services/audit.ts`) for id→name. Do
  not write a second id→name path. The new function is the *reverse* direction
  and is additive.
- **Do not touch the `action` filter.** It is already a prefix match and is
  correct.
- **Raw ids must stay filterable.** A pasted UUID, a bare character id, a bare
  Discord snowflake, `"system"` and `"all"` must all keep working exactly as
  today.
- **`before=` keyset pagination and the `clear` link must keep working.**
- **No Tailwind.** Hand-written CSS in `src/app/globals.css` using the existing
  OKLCH tokens.
- **DESIGN.md:** one gold primary action per view — the `Filter` submit already
  spends it, so name links must not be gold. Colour is never the only carrier
  of meaning.
- **Unit tests run against port 5434, not 5433.** Port 5433 is held by another
  project's container and yields ~50 spurious failures. Always:
  `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5434/authgd_test npm test`
- **Never claim a command passed without running it and quoting the output.**

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/services/audit.ts` | Modify | Add `resolveFilterIdentity` (name→ids); switch `queryAuditLog` to id-array filters |
| `tests/audit-filter.test.ts` | Create | Unit coverage for `resolveFilterIdentity` |
| `tests/audit-query.test.ts` | Modify (2 lines) | Existing raw-filter assertions move to the array parameter |
| `src/app/admin/audit/page.tsx` | Modify | Resolve filters, short-circuit, heading notes, empty states, name links |
| `src/app/globals.css` | Modify | `.cell-link` rule |
| `e2e/audit.spec.ts` | Modify | Click-to-filter, union, raw-id and `all` regression coverage |

---

### Task 1: `resolveFilterIdentity` — the name→ids reverse resolver

**Files:**
- Modify: `src/services/audit.ts`
- Test: `tests/audit-filter.test.ts` (create)

**Interfaces:**
- Consumes: `Dbx` from `@/db`; `account`, `character`, `discordLink` from
  `@/db/schema`; the module-private `UUID_RE` and `DIGITS_RE` already defined in
  `src/services/audit.ts`.
- Produces:
  ```ts
  export type FilterResolution =
    | { kind: "raw"; ids: string[] }
    | { kind: "name"; name: string; ids: string[]; accountCount: number }
    | { kind: "none"; name: string };

  export async function resolveFilterIdentity(
    dbx: Dbx, field: "actor" | "target", value: string,
  ): Promise<FilterResolution>
  ```
  Task 3 consumes both. `ids` are always strings — character ids are
  `String(id)` because `audit_log.target` is a `text` column.

- [ ] **Step 1: Write the failing tests**

Create `tests/audit-filter.test.ts`. Note the seed helpers: `seedAccount(db,
{discordUserId?})` and `seedCharacter(db, cfg, {id, accountId, name, main?})`,
both from `./helpers/seed`. `main: true` also sets the account's
`mainCharacterId`.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveFilterIdentity } from "@/services/audit";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

/** Counts pg pool queries for the duration of `fn` (same shape as
 * tests/audit-resolve.test.ts) so we can assert the raw path is free. */
type PoolQuery = typeof import("pg").Pool.prototype.query;
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  let calls = 0;
  const pool = ctx.pool as unknown as { query: PoolQuery };
  const origQuery: PoolQuery = pool.query.bind(pool);
  pool.query = ((...args: Parameters<PoolQuery>) => {
    calls++;
    return (origQuery as (...a: Parameters<PoolQuery>) => ReturnType<PoolQuery>)(...args);
  }) as PoolQuery;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    pool.query = origQuery;
  }
}

describe("resolveFilterIdentity", () => {
  it("treats a UUID as raw, with no queries", async () => {
    const uuid = "3f9a1c2e-0000-4000-8000-000000000001";
    const { result, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "actor", uuid),
    );
    expect(result).toEqual({ kind: "raw", ids: [uuid] });
    expect(calls).toBe(0);
  });

  it("treats a bare digit string as raw, with no queries", async () => {
    const { result, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "target", "90001"),
    );
    expect(result).toEqual({ kind: "raw", ids: ["90001"] });
    expect(calls).toBe(0);
  });

  it("treats the reserved literal 'system' as raw", async () => {
    const r = await resolveFilterIdentity(ctx.db, "actor", "system");
    expect(r).toEqual({ kind: "raw", ids: ["system"] });
  });

  // Regression guard: sync.requested / sync.recheck_requested write the literal
  // target "all" (src/app/admin/sync/actions.ts:13,25). Sending it down the
  // name path would match no character and silently return zero rows.
  it("treats the reserved literal 'all' as raw", async () => {
    const r = await resolveFilterIdentity(ctx.db, "target", "all");
    expect(r).toEqual({ kind: "raw", ids: ["all"] });
  });

  it("resolves an actor name to the account whose main displays it", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect(r).toEqual({ kind: "name", name: "Zed", ids: [acc.id], accountCount: 1 });
  });

  it("matches case-insensitively", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "zED");
    expect(r.kind).toBe("name");
    expect((r as { ids: string[] }).ids).toEqual([acc.id]);
  });

  it("unions account, character and discord ids for a target name", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "target", "Zed");
    expect(r.kind).toBe("name");
    const ids = (r as { ids: string[] }).ids;
    expect(new Set(ids)).toEqual(new Set([acc.id, "90001", "555555555555555555"]));
  });

  it("does not include discord ids for an actor filter", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect((r as { ids: string[] }).ids).toEqual([acc.id]);
  });

  it("resolves an alt's name to its character id only, never its account", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Boss", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: acc.id, name: "Alt Zed" });
    const r = await resolveFilterIdentity(ctx.db, "target", "Alt Zed");
    expect(r).toEqual({
      kind: "name", name: "Alt Zed", ids: ["90002"], accountCount: 1,
    });
  });

  it("an alt's name is unresolvable as an actor (no account displays it)", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Boss", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: acc.id, name: "Alt Zed" });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Alt Zed");
    expect(r).toEqual({ kind: "none", name: "Alt Zed" });
  });

  it("reports accountCount 2 for two accounts sharing a main name", async () => {
    const a = await seedAccount(ctx.db);
    const b = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: a.id, name: "Zed", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: b.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect(r.kind).toBe("name");
    expect((r as { accountCount: number }).accountCount).toBe(2);
    expect(new Set((r as { ids: string[] }).ids)).toEqual(new Set([a.id, b.id]));
  });

  // The reason accountCount exists. Two same-named ALTS on two accounts widen
  // the target results across an account boundary while no account *displays*
  // the name -- counting only display-accounts would report 0 and hide it.
  it("counts owning accounts when two same-named alts widen a target filter", async () => {
    const a = await seedAccount(ctx.db);
    const b = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: a.id, name: "Boss A", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: b.id, name: "Boss B", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90003, accountId: a.id, name: "Zed" });
    await seedCharacter(ctx.db, cfg, { id: 90004, accountId: b.id, name: "Zed" });
    const r = await resolveFilterIdentity(ctx.db, "target", "Zed");
    expect(r.kind).toBe("name");
    expect((r as { accountCount: number }).accountCount).toBe(2);
    expect(new Set((r as { ids: string[] }).ids)).toEqual(new Set(["90003", "90004"]));
  });

  it("returns kind none for a name that matches nothing, in one query", async () => {
    const { result, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "target", "Nobody"),
    );
    expect(result).toEqual({ kind: "none", name: "Nobody" });
    expect(calls).toBe(1); // short-circuits after the character lookup
  });

  it("stays within the query budget: <=3 for a target name, <=2 for an actor name", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const t = await countQueries(() => resolveFilterIdentity(ctx.db, "target", "Zed"));
    expect(t.calls).toBeLessThanOrEqual(3);
    const a = await countQueries(() => resolveFilterIdentity(ctx.db, "actor", "Zed"));
    expect(a.calls).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5434/authgd_test \
  npx vitest run tests/audit-filter.test.ts
```
Expected: FAIL — `resolveFilterIdentity is not a function` / no such export.

- [ ] **Step 3: Implement `resolveFilterIdentity`**

In `src/services/audit.ts`, add `sql` to the existing `drizzle-orm` import
(`account`, `character`, `discordLink` and `inArray` are already imported), then
add below `resolveAuditIdentities`:

```ts
/**
 * The two literal, non-id values the audit log stores: `system` as an actor
 * (every job writes it) and `all` as the broadcast target of `sync.requested`
 * / `sync.recheck_requested`. Both must bypass name resolution or filtering by
 * them regresses -- a grep of every logAudit call site confirms these are the
 * complete set.
 */
const RESERVED_FILTER_LITERALS = new Set(["system", "all"]);

export type FilterResolution =
  | { kind: "raw"; ids: string[] }
  | { kind: "name"; name: string; ids: string[]; accountCount: number }
  | { kind: "none"; name: string };

/**
 * Inverts `resolveAuditIdentities` for the filter box: turns what an admin
 * sees ("Zed") back into the raw ids the audit log actually stores.
 *
 * A raw id costs nothing -- UUIDs, bare digit strings and the two reserved
 * literals short-circuit with zero queries, which is what keeps pasting an id
 * working. Everything else is a name, resolved along the same three display
 * paths `resolveAuditIdentities` renders:
 *
 *   actor  -> accounts whose main character carries the name (actor is only
 *             ever an account uuid or "system", so nothing else can match)
 *   target -> those accounts, PLUS every character carrying the name, PLUS the
 *             discord ids linked to those accounts, because one person's
 *             target rows are spread across all three identifier forms and a
 *             filter that pinned one would silently hide the others
 *
 * Deliberately NOT called from inside queryAuditLog: that function receives
 * raw ids only, so a caller passing a non-uuid raw actor (as
 * tests/audit-query.test.ts does) can never have it reinterpreted as a name.
 */
export async function resolveFilterIdentity(
  dbx: Dbx,
  field: "actor" | "target",
  value: string,
): Promise<FilterResolution> {
  if (
    RESERVED_FILTER_LITERALS.has(value) ||
    UUID_RE.test(value) ||
    DIGITS_RE.test(value)
  ) {
    return { kind: "raw", ids: [value] };
  }

  // 1. every character carrying the name (case-insensitive), with its owner
  const chars = await dbx
    .select({ id: character.id, accountId: character.accountId })
    .from(character)
    .where(sql`lower(${character.name}) = lower(${value})`);
  if (chars.length === 0) return { kind: "none", name: value };

  const characterIds = chars.map((c) => c.id);

  // 2. the accounts that *display* the name, i.e. whose main is one of those
  const mains = await dbx
    .select({ id: account.id })
    .from(account)
    .where(inArray(account.mainCharacterId, characterIds));
  const displayAccountIds = mains.map((a) => a.id);

  if (field === "actor") {
    // An alt's name can never appear in the actor column, so its owning
    // account neither contributes rows nor counts toward ambiguity.
    if (displayAccountIds.length === 0) return { kind: "none", name: value };
    return {
      kind: "name",
      name: value,
      ids: displayAccountIds,
      accountCount: displayAccountIds.length,
    };
  }

  // 3. discord ids of the displaying accounts (this one IS index-backed --
  //    discord_link.account_id is that table's primary key)
  const links = displayAccountIds.length
    ? await dbx
        .select({ discordUserId: discordLink.discordUserId })
        .from(discordLink)
        .where(inArray(discordLink.accountId, displayAccountIds))
    : [];

  const ids = [
    ...displayAccountIds,
    ...characterIds.map(String),
    ...links.map((l) => l.discordUserId),
  ];
  if (ids.length === 0) return { kind: "none", name: value };

  // Matched character ids are in the union, so their owning accounts are
  // surfaced too and must count -- otherwise two same-named alts on two
  // accounts widen the results while the page reports no ambiguity.
  const accountCount = new Set([
    ...displayAccountIds,
    ...chars.map((c) => c.accountId),
  ]).size;

  return { kind: "name", name: value, ids, accountCount };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5434/authgd_test \
  npx vitest run tests/audit-filter.test.ts
```
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/audit.ts tests/audit-filter.test.ts
git commit -m "feat(audit): resolve a filter name back to the ids the log stores"
```

---

### Task 2: `queryAuditLog` takes id arrays

**Files:**
- Modify: `src/services/audit.ts:queryAuditLog`
- Modify: `tests/audit-query.test.ts` (2 assertion lines)
- Test: `tests/audit-filter.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  queryAuditLog(dbx, {
    actorIds?: string[]; action?: string; targetIds?: string[];
    beforeId?: number; limit?: number;
  }): Promise<ResolvedAuditRow[]>
  ```
  `actor` and `target` are **removed**. Length 1 → `eq`, length > 1 →
  `inArray`, length 0 → `[]` without querying. Task 3 consumes this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/audit-filter.test.ts`:

```ts
describe("queryAuditLog id-array filters", () => {
  it("matches a single id with equality, as before", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "all" });
    await logAudit(ctx.db, { actor: "admin-1", action: "tier.changed", target: "42" });
    const rows = await queryAuditLog(ctx.db, { actorIds: ["admin-1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("admin-1");
  });

  it("matches any of several ids", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "a" });
    await logAudit(ctx.db, { actor: "admin-1", action: "tier.changed", target: "b" });
    await logAudit(ctx.db, { actor: "admin-2", action: "tier.changed", target: "c" });
    const rows = await queryAuditLog(ctx.db, { actorIds: ["admin-1", "admin-2"] });
    expect(rows.map((r) => r.actor).sort()).toEqual(["admin-1", "admin-2"]);
  });

  it("returns nothing, and issues no query, for an empty id list", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "all" });
    const { result, calls } = await countQueries(() =>
      queryAuditLog(ctx.db, { actorIds: [] }),
    );
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("unions target ids across identifier forms", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: acc.id });
    await logAudit(ctx.db, { actor: "system", action: "character.linked", target: "90001" });
    await logAudit(ctx.db, {
      actor: "system", action: "discord.role_changed", target: "555555555555555555",
    });
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "someone-else" });

    const res = await resolveFilterIdentity(ctx.db, "target", "Zed");
    const rows = await queryAuditLog(ctx.db, {
      targetIds: res.kind === "none" ? [] : res.ids,
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "character.linked", "discord.role_changed", "tier.changed",
    ]);
  });

  it("keeps beforeId keyset paging working under a union filter", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    for (let i = 0; i < 3; i++) {
      await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: acc.id });
      await logAudit(ctx.db, { actor: "system", action: "character.linked", target: "90001" });
    }
    const res = await resolveFilterIdentity(ctx.db, "target", "Zed");
    const ids = res.kind === "none" ? [] : res.ids;
    const all = await queryAuditLog(ctx.db, { targetIds: ids });
    expect(all).toHaveLength(6);
    const older = await queryAuditLog(ctx.db, { targetIds: ids, beforeId: all[0].id });
    expect(older).toHaveLength(5);
    expect(older.every((r) => r.id < all[0].id)).toBe(true);
  });
});
```

Extend the imports at the top of `tests/audit-filter.test.ts`:

```ts
import { logAudit, queryAuditLog, resolveFilterIdentity } from "@/services/audit";
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5434/authgd_test \
  npx vitest run tests/audit-filter.test.ts
```
Expected: FAIL — `actorIds` is not a known property (TS) / filters ignored.

- [ ] **Step 3: Implement the id-array filters**

Replace the filter block in `queryAuditLog`:

```ts
export async function queryAuditLog(
  dbx: Dbx,
  filters: {
    /** Raw actor ids. Exactly one -> equality; several -> any-of; empty -> no
     * rows. Names are resolved by resolveFilterIdentity BEFORE this call, so a
     * non-uuid raw actor can never be mistaken for one. */
    actorIds?: string[];
    action?: string; // prefix match, e.g. "tier."
    /** Raw target ids; one person spans several (see resolveFilterIdentity). */
    targetIds?: string[];
    beforeId?: number;
    limit?: number;
  } = {},
): Promise<ResolvedAuditRow[]> {
  // An empty list is "resolved to nothing", not "unfiltered" -- short-circuit
  // rather than let it degrade into a full scan.
  if (filters.actorIds?.length === 0 || filters.targetIds?.length === 0) return [];

  const conds = [];
  if (filters.actorIds) {
    conds.push(
      filters.actorIds.length === 1
        ? eq(auditLog.actor, filters.actorIds[0])
        : inArray(auditLog.actor, filters.actorIds),
    );
  }
  if (filters.action) {
    // The filter is a LITERAL prefix; % and _ are LIKE wildcards, so escape
    // them (and backslash, Postgres's default escape character).
    const prefix = filters.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(auditLog.action, `${prefix}%`));
  }
  if (filters.targetIds) {
    conds.push(
      filters.targetIds.length === 1
        ? eq(auditLog.target, filters.targetIds[0])
        : inArray(auditLog.target, filters.targetIds),
    );
  }
  if (filters.beforeId !== undefined) conds.push(lt(auditLog.id, filters.beforeId));
  const limit = Math.min(filters.limit ?? AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE);
  const rows = await dbx
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return resolveAuditIdentities(dbx, rows);
}
```

- [ ] **Step 4: Update the two existing raw-filter assertions**

In `tests/audit-query.test.ts`, lines 40-41 — the values are unchanged, only
the parameter shape:

```ts
    expect(await queryAuditLog(ctx.db, { actorIds: ["admin-1"] })).toHaveLength(2);
    expect(await queryAuditLog(ctx.db, { targetIds: ["42"] })).toHaveLength(1);
```

- [ ] **Step 5: Run both audit test files to verify they pass**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5434/authgd_test \
  npx vitest run tests/audit-filter.test.ts tests/audit-query.test.ts tests/audit-resolve.test.ts
```
Expected: PASS. `tests/audit-resolve.test.ts` must be untouched and still green
— in particular its `calls <= 4` no-N+1 assertion.

- [ ] **Step 6: Commit**

```bash
git add src/services/audit.ts tests/audit-filter.test.ts tests/audit-query.test.ts
git commit -m "refactor(audit): filter the log by id sets instead of single ids"
```

---

### Task 3: Page wiring — resolve, short-circuit, and say what happened

**Files:**
- Modify: `src/app/admin/audit/page.tsx`

**Interfaces:**
- Consumes: `resolveFilterIdentity`, `FilterResolution`, `queryAuditLog` from
  Task 1 and Task 2.
- Produces: a `filterHref(params, field, value)` helper that Task 4 uses for
  the row links.

No test step here — this is server-component wiring, covered end-to-end by
Task 5. Verify with `typecheck` and the e2e suite.

- [ ] **Step 1: Replace the data-loading block**

In `src/app/admin/audit/page.tsx`, replace lines 154-171 — the block from
`const params = await searchParams;` down to and including the `activeFilters`
assignment:

```tsx
  const params = await searchParams;
  const beforeId = params.before ? Number(params.before) : undefined;

  const db = getDb();
  // Both filters resolve concurrently; each costs 0 queries when absent or
  // when the admin pasted a raw id.
  const [actorRes, targetRes] = await Promise.all([
    params.actor ? resolveFilterIdentity(db, "actor", params.actor) : null,
    params.target ? resolveFilterIdentity(db, "target", params.target) : null,
  ]);

  // A name that matched nothing guarantees zero rows, so don't scan audit_log
  // at all -- and remember WHICH field failed, since the fix differs.
  const unmatched = (
    [
      ["actor", actorRes],
      ["target", targetRes],
    ] as const
  ).filter(([, r]) => r?.kind === "none") as ReadonlyArray<
    readonly [string, { kind: "none"; name: string }]
  >;

  const rows: ResolvedAuditRow[] = unmatched.length
    ? []
    : await queryAuditLog(db, {
        actorIds: idsOf(actorRes),
        action: params.action || undefined,
        targetIds: idsOf(targetRes),
        beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
      });

  const older = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && k !== "before") older.set(k, v);
  if (rows.length > 0) older.set("before", String(rows[rows.length - 1].id));

  const filtered = Boolean(params.actor || params.action || params.target);
  const activeFilters = [
    params.actor && `actor: ${params.actor}`,
    params.action && `action: ${params.action}`,
    params.target && `target: ${params.target}`,
  ].filter(Boolean) as string[];

  // One note per field whose name spans more than one account, so a widened
  // result never looks like a narrow one. Text, not colour.
  const ambiguityNotes = (
    [
      ["actor", actorRes],
      ["target", targetRes],
    ] as const
  )
    .map(([field, r]) =>
      r && r.kind === "name" && r.accountCount > 1
        ? `${field} "${r.name}" matches ${r.accountCount} accounts`
        : null,
    )
    .filter(Boolean) as string[];

  const countLabel =
    rows.length === 0
      ? filtered
        ? "No matching entries"
        : "No entries"
      : `${rows.length}${rows.length === AUDIT_PAGE_SIZE ? "+" : ""} ${
          filtered ? "matching entries" : "entries"
        }`;

  const emptyMessage = unmatched.length
    ? `No account or character named ${unmatched
        .map(([field, r]) => `"${r.name}" (${field})`)
        .join(" or ")}.`
    : filtered
      ? "Nothing matches this filter."
      : "Nothing has happened yet.";
```

Note `unmatched.length ? [] : ...` guarantees no `kind: "none"` resolution ever
reaches `idsOf`, but TypeScript cannot see that, and `FilterResolution` is a
union whose `"none"` arm has no `ids` — so `actorRes?.ids` is a compile error.
Add the narrowing helper above `AdminAuditPage`:

```tsx
/** The ids to filter by, or undefined when the field isn't filtered at all.
 * A `kind: "none"` resolution never reaches this — the caller short-circuits
 * to zero rows first — but the union has to be narrowed explicitly. */
function idsOf(r: FilterResolution | null): string[] | undefined {
  return r && r.kind !== "none" ? r.ids : undefined;
}
```

- [ ] **Step 2: Update the imports**

```tsx
import {
  AUDIT_PAGE_SIZE,
  queryAuditLog,
  resolveFilterIdentity,
} from "@/services/audit";
import type { FilterResolution, ResolvedAuditRow } from "@/services/audit";
```

- [ ] **Step 3: Use the new heading and empty message in the JSX**

Replace the results `RuleHead` (lines 226-234, the one with no `aside`) with one
that carries the notes:

```tsx
      <RuleHead
        as="h2"
        aside={
          ambiguityNotes.length > 0 && (
            <span className="dim">{ambiguityNotes.join(" · ")}</span>
          )
        }
      >
        {countLabel}
      </RuleHead>
```

And replace the empty-row cell body:

```tsx
                <td className="log__empty" colSpan={5}>
                  {emptyMessage}
                </td>
```

- [ ] **Step 4: Add the `filterHref` helper**

Above the `AdminAuditPage` component:

```tsx
/**
 * A link that sets one filter field to `value`, keeps every other active
 * filter, and drops `before` -- clicking a name narrows the query, so the
 * keyset cursor from the previous, wider query is meaningless and would page
 * into the middle of the new result set.
 */
function filterHref(
  params: Record<string, string | undefined>,
  field: "actor" | "target",
  value: string,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "before" && k !== field) q.set(k, v);
  }
  q.set(field, value);
  return `/admin/audit?${q.toString()}`;
}
```

- [ ] **Step 5: Verify it compiles**

```bash
npm run typecheck && npm run lint
```
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/audit/page.tsx
git commit -m "feat(audit): resolve filter names on the log page and report what matched"
```

---

### Task 4: Click-to-filter — make the rendered names links

**Files:**
- Modify: `src/app/admin/audit/page.tsx` (`ActorCell`, `TargetCell`, call sites)
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `filterHref` from Task 3.
- Produces: `.cell-link` class, and `ActorCell`/`TargetCell` each taking a new
  `params` prop.

- [ ] **Step 1: Rewrite `ActorCell`**

Preserve every existing branch's classes and `title` — truncation and the
mono/dim system treatment must survive. Only the wrapping changes:

```tsx
/**
 * The actor column. `system` is a job, not a person, so it gets the monospace
 * dimmed treatment used for machine output elsewhere in this table -- a
 * font-family signal, not a colour-only one. A resolved human name renders
 * plain; an unresolved actor falls back to the raw id in mono so it still
 * reads as "an id", not as a name that happened not to load.
 *
 * Resolved values (and `system`) link to themselves as a filter, so the admin
 * never retypes what is already on screen. Unresolved ids stay inert: they are
 * already exactly filterable by pasting, and linking them would add a tab stop
 * per row for nothing.
 */
function ActorCell({
  r,
  params,
}: {
  r: ResolvedAuditRow;
  params: Record<string, string | undefined>;
}) {
  if (r.actorKind === "system") {
    return (
      <a
        className="mono dim cell-link"
        href={filterHref(params, "actor", "system")}
        title={r.actor}
      >
        system
      </a>
    );
  }
  if (r.actorName) {
    return (
      <a
        className="ellipsis-cell cell-link"
        href={filterHref(params, "actor", r.actorName)}
        title={r.actor}
      >
        {r.actorName}
      </a>
    );
  }
  return (
    <span className="mono ellipsis-cell" title={r.actor}>
      {r.actor}
    </span>
  );
}
```

- [ ] **Step 2: Rewrite `TargetCell`**

```tsx
/**
 * The target column. A literal (e.g. the string "all") reads as what it is,
 * not as a mystery id; an unresolved reference stays in mono so it still
 * reads as raw data rather than a name. Every branch also gets
 * `ellipsis-cell`: a resolved display name, a raw UUID, and a Discord
 * snowflake all lack natural break points, and any of them left unbounded
 * wraps and inflates the row height exactly like the actor column used to.
 *
 * A name links to the NAME, not to this row's raw id -- one person's target
 * rows are spread across an account uuid, a character id and a discord
 * snowflake, and filtering by whichever one this row happens to carry would
 * hide the other two thirds of their history.
 */
function TargetCell({
  r,
  params,
}: {
  r: ResolvedAuditRow;
  params: Record<string, string | undefined>;
}) {
  if (r.targetName) {
    return (
      <a
        className="ellipsis-cell cell-link"
        href={filterHref(params, "target", r.targetName)}
        title={r.target}
      >
        {r.targetName}
      </a>
    );
  }
  if (r.targetKind === "literal") {
    return (
      <a
        className="mono dim ellipsis-cell cell-link"
        href={filterHref(params, "target", r.target)}
        title={r.target}
      >
        {r.target}
      </a>
    );
  }
  return (
    <span className="mono ellipsis-cell" title={r.target}>
      {r.target}
    </span>
  );
}
```

- [ ] **Step 3: Pass `params` at both call sites**

In the table body:

```tsx
                  <td>
                    <ActorCell r={r} params={params} />
                  </td>
```
```tsx
                  <td>
                    <TargetCell r={r} params={params} />
                  </td>
```

- [ ] **Step 4: Add the `.cell-link` rule**

The base `a` rule (`src/app/globals.css:135`) already supplies the underline,
`text-decoration-color: var(--rule-strong)` and the underline offset, and
`a:hover` already goes gold — that is the sitewide link idiom, and every other
link on this page (`clear`, `older`) uses it. So `.cell-link` exists to undo
exactly one thing: the base rule's `color: var(--ink)`, which would otherwise
repaint the dimmed mono `system` and `all` cells as ordinary ink.

**Insert it immediately after the `.log--audit` block (around line 470), NOT at
the end of the file.** The position is load-bearing: `.dim` (line 574) and
`.cell-link` have equal specificity, so `.dim` can only win the resting colour
for the dimmed cells by coming later. Appending `.cell-link` at the end would
silently un-dim `system` and `all`.

```css
/* Audit log: a resolved name is its own filter control. `color: inherit`
   keeps the base `a` rule from repainting the cells that are deliberately
   dimmed mono -- `system` and the literal `all` read as machine values, and
   that treatment is the point. Everything else about the link (underline,
   offset, gold on hover) is inherited, so a name behaves exactly like every
   other link on the page rather than inventing a second affordance.

   Must stay ABOVE `.dim`: equal specificity, so `.dim` wins the resting
   colour only by being later in the file. */
.cell-link {
  color: inherit;
}
```

DESIGN.md's "one gold primary action per view" is satisfied: the resting state
of a name link is not gold, so the `Filter` submit keeps the only gold
affordance at rest. And the affordance is not colour-only — the underline
carries it.

- [ ] **Step 5: Verify it compiles**

```bash
npm run typecheck && npm run lint && npm run format:check
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/audit/page.tsx src/app/globals.css
git commit -m "feat(audit): click a name in the log to filter by it"
```

---

### Task 5: End-to-end coverage

**Files:**
- Modify: `e2e/audit.spec.ts`

**Interfaces:**
- Consumes: `seedMember(db, {name, tier?, isAdmin?, alts?})`, `sessionCookieFor`,
  `resetDb`, `testDb` from `./helpers`. `seedMember` returns the account row and
  sets `mainCharacterId` to a generated main character id.

**⚠️ Read this before running Playwright.** `reuseExistingServer` is
`!process.env.CI`, so a dev server left running by another worktree on port 3111
will be silently reused and you will get a green run that never executed your
branch. Check first, then run from a throwaway config on a free port:

```bash
ss -lptn 'sport = :3111'   # expect no listener
```

```bash
sed -e 's/3111/3141/g' -e 's/reuseExistingServer: !process.env.CI/reuseExistingServer: false/' \
  -e 's#postgres://authgd:authgd@localhost:5433/authgd_test#postgres://authgd:authgd@localhost:5434/authgd_test#' \
  playwright.config.ts > playwright.local.config.ts
npx playwright test --config playwright.local.config.ts e2e/audit.spec.ts
rm playwright.local.config.ts   # MUST NOT be committed
```

- [ ] **Step 1: Add the click-to-filter and union test**

Append to `e2e/audit.spec.ts`:

```ts
test("names are clickable filters, and a name unions a person's identifier forms", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "555555555555555555",
  });

  // The same person, targeted three different ways plus one unrelated row.
  await db.insert(auditLog).values([
    { actor: admin.id, action: "tier.changed", target: member.id,
      details: { from: "green", to: "flygd" } },
    { actor: "system", action: "character.linked", target: String(member.mainCharacterId) },
    { actor: "system", action: "discord.role_changed", target: "555555555555555555",
      details: { added: "10", removed: "", tier: "flygd" } },
    { actor: admin.id, action: "tier.changed", target: admin.id, details: { to: "flygd" } },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");
  await expect(page.locator("tbody tr")).toHaveCount(4);

  // Clicking the target name filters by the NAME, not by that row's raw id.
  await page.locator("tbody tr").first().getByRole("link", { name: "Zed" }).click();
  await expect(page).toHaveURL(/[?&]target=Zed/);

  // All three of Zed's identifier forms come back; Boss's own row does not.
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "tier.changed" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "character.linked" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "discord.role_changed" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "3 matching entries" })).toBeVisible();

  // clear still works.
  await page.getByRole("link", { name: "clear" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);

  // Clicking an actor name filters the actor column.
  await page.getByRole("link", { name: "Boss" }).first().click();
  await expect(page).toHaveURL(/[?&]actor=Boss/);
  await expect(page.locator("tbody tr")).toHaveCount(2);
});
```

Extend the schema import at the top of the file:

```ts
import { auditLog, discordLink } from "../src/db/schema";
```

- [ ] **Step 2: Add the raw-id and reserved-literal regression test**

```ts
test("raw ids and the literal 'all' target stay filterable", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });

  await db.insert(auditLog).values([
    { actor: admin.id, action: "tier.changed", target: member.id, details: { to: "flygd" } },
    { actor: admin.id, action: "sync.requested", target: "all" },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // A pasted account uuid still filters exactly, and the chip echoes it.
  await page.goto(`/admin/audit?target=${member.id}`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText(`target: ${member.id}`)).toBeVisible();

  // "all" is a real stored target, not a name -- it must not resolve to nothing.
  await page.goto("/admin/audit?target=all");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("sync.requested");

  // A name that matches nothing names the field that failed.
  await page.goto("/admin/audit?actor=Nobody");
  await expect(page.locator(".log__empty")).toHaveText(
    'No account or character named "Nobody" (actor).',
  );
});
```

- [ ] **Step 3: Add the ambiguity test**

```ts
test("an ambiguous name reports how many accounts it spans", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const zedA = await seedMember(db, { name: "Zed", tier: "green" });
  const zedB = await seedMember(db, { name: "Zed", tier: "blue" });

  await db.insert(auditLog).values([
    { actor: admin.id, action: "tier.changed", target: zedA.id, details: { to: "green" } },
    { actor: admin.id, action: "tier.changed", target: zedB.id, details: { to: "blue" } },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit?target=Zed");

  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByText('target "Zed" matches 2 accounts')).toBeVisible();
});
```

- [ ] **Step 4: Run the audit e2e spec**

Use the throwaway-config recipe above. Expected: 5 tests passing (the 2 that
already existed plus the 3 added here).

- [ ] **Step 5: Delete the throwaway config and confirm the tree is clean**

```bash
rm -f playwright.local.config.ts
git status --porcelain   # must show only e2e/audit.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add e2e/audit.spec.ts
git commit -m "test(audit): cover click-to-filter, name unions, and raw-id fallbacks"
```

---

### Task 6: Full verification

**Files:** none — this task only runs checks.

- [ ] **Step 1: Full unit suite on the correct port**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5434/authgd_test npm test
```
Expected: 47 files, all passing. Baseline before this work was 46 files / 338
tests; the new file adds one. **Quote the real output.**

- [ ] **Step 2: Typecheck, lint, format**

```bash
npm run typecheck && npm run lint && npm run format:check
```

- [ ] **Step 3: Full e2e suite**

Throwaway-config recipe from Task 5, without the `e2e/audit.spec.ts` filter, so
the admin-accounts and account-page specs are exercised too.

- [ ] **Step 4: Review the whole diff against the spec**

```bash
git diff origin/main --stat
git diff origin/main
```
Confirm: no migration, no `drizzle/` change, no fifth `'use client'`, no
`playwright.local.config.ts`, `action` filter untouched, and
`tests/audit-resolve.test.ts` unmodified.

- [ ] **Step 5: Run the project's review gate**

Per `CLAUDE.md`: dispatch `code-reviewer`, then `my:polish-core --fix`, inspect
its edits, and re-run whatever verification they affect before any "done" claim.
