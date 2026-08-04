# Admin Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/admin/audit` from 500ing on a duplicated query parameter, make details lines say what happened instead of dumping JSON arrays, and fix an empty state that highlights on hover and overflows at 320px.

**Architecture:** Four independent changes. The largest extracts `summarizeDetails` out of the 489-line page component into a pure, parameter-injected module (`src/app/admin/audit/summarize.ts`) driven by a per-action field declaration rather than bespoke template strings — the drift between those templates is what produced two of the bugs. The other three are localized: a type widening plus a `one()` normalizer, two CSS rules, and a third `emptyMessage` branch.

**Tech Stack:** Next.js App Router (server components), TypeScript, Vitest (`tests/**/*.test.ts` only), Playwright, plain CSS in `src/app/globals.css`.

**Spec:** `docs/superpowers/specs/2026-08-04-admin-audit-fixes-design.md`

## Global Constraints

- **Never claim a command passed without running it and quoting the output.** Applies to `npm test`, `npm run typecheck`, `npm run test:e2e`.
- **Unit tests live in `tests/`, not colocated.** `vitest.config.ts:6` sets `include: ["tests/**/*.test.ts"]`. A test written next to its source silently never runs.
- **`npm test` is not worktree-safe** — the suite defaults to the shared `:5433` Postgres. `npm run test:e2e` is worktree-safe (per-worktree container and port).
- **Running e2e rewrites `tsconfig.json` and may create `AGENTS.md`.** Never `git add -A` after an e2e run; stage named paths only.
- **No em dashes in user-facing copy.** Use commas, colons, or parentheses.
- **Stay in scope.** Do not rename, restructure or clean up anything this plan does not name. `/admin/accounts` is explicitly out of bounds.
- **The empty state stays a `<td>` inside `<tbody>`.** `e2e/audit.spec.ts` carries 29 `tbody tr` references (eleven count assertions), three `.log__empty` assertions, and a family of `tbody tr:first-child td:first-child` locators; `e2e/admin.spec.ts:504` locates `td.log__empty`. If a task makes you want to change one of those assertions, stop: the change went further than intended.
- **Role id truncation:** an unresolvable Discord role id shown alone renders as its first six characters plus `…`, with the full id in a `title` attribute.

---

### Task 1: Extract summarize into a pure module, unchanged

Pure move, no behavior change. Doing this first means Task 2's diff shows only the logic change, and gives a green baseline to compare against.

**Files:**
- Create: `src/app/admin/audit/summarize.ts`
- Create: `tests/audit-summarize.test.ts`
- Modify: `src/app/admin/audit/page.tsx:19-84` (delete `fmt` and `summarizeDetails`), `page.tsx:1-11` (add import)

**Interfaces:**
- Consumes: nothing.
- Produces: `summarizeDetails(action: string, details: unknown): string` exported from `@/app/admin/audit/summarize`. Task 2 changes its signature; Task 3 and 4 do not touch it.

- [ ] **Step 1: Write tests that pin the CURRENT behavior, including the bugs**

Create `tests/audit-summarize.test.ts`. These pin behavior that is CORRECT today and must survive Task 2 unchanged, so the extraction can prove it changed nothing. Deliberately absent: the three behaviors Task 2 fixes (`status.changed` dropping `from`, the silent three-key cut, JSON role arrays). Pinning those would mean committing a test that asserts wrong output, so Task 2 writes them fresh against the corrected behavior instead. The tradeoff is accepted: this file is a partial, not a total, baseline.

```ts
import { describe, expect, it } from "vitest";
import { summarizeDetails } from "@/app/admin/audit/summarize";

describe("summarizeDetails", () => {
  it("renders a tier transition with its from value", () => {
    expect(summarizeDetails("tier.changed", { from: "flygd", to: "green" })).toBe(
      "flygd → green",
    );
  });

  it("renders a tier transition without from", () => {
    expect(summarizeDetails("tier.changed", { to: "green" })).toBe("→ green");
  });

  it("renders a labelled scalar action", () => {
    expect(
      summarizeDetails("admin.bootstrap_granted", { characterId: 90000001 }),
    ).toBe("character 90000001");
  });

  it("renders a bare scalar action", () => {
    expect(
      summarizeDetails("token.invalidated", { reason: "refresh rejected" }),
    ).toBe("refresh rejected");
  });

  it("renders an empty payload as an em dash", () => {
    expect(summarizeDetails("unknown.action", {})).toBe("—");
  });

  it("does not throw on a non-object payload", () => {
    expect(summarizeDetails("unknown.action", "a string")).toBe("—");
    expect(summarizeDetails("unknown.action", null)).toBe("—");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/audit-summarize.test.ts`
Expected: FAIL. The error is a module resolution failure — `Cannot find module '@/app/admin/audit/summarize'` — because the file does not exist yet.

- [ ] **Step 3: Create the module by moving the code verbatim**

Create `src/app/admin/audit/summarize.ts`. Cut lines 19-84 of `page.tsx` (the `fmt` doc comment through the close of `summarizeDetails`) and paste them in unchanged, adding `export` to `summarizeDetails` only. `fmt` stays module-private.

```ts
/** Renders a JSON value inline where it can't throw: a string/number/boolean
 * as itself, anything else as compact JSON. Never lets a malformed payload
 * take the whole row down. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "?";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "?";
  }
}

/**
 * One factual line per action, e.g. `tier.changed` -> `green → flygd`. This is
 * what a scanning admin actually reads; the full payload stays behind the `+`
 * disclosure. Total and defensive: an unknown action or a malformed payload
 * falls through to a generic key=value rendering rather than throwing, since
 * new action names appear over time and the DB does not enforce a shape.
 */
export function summarizeDetails(action: string, details: unknown): string {
  const d = (details && typeof details === "object" ? details : {}) as Record<
    string,
    unknown
  >;
  try {
    switch (action) {
      case "tier.changed":
        return d.from !== undefined ? `${fmt(d.from)} → ${fmt(d.to)}` : `→ ${fmt(d.to)}`;
      case "status.changed":
        return `→ ${fmt(d.to)}`;
      case "admin.bootstrap_granted":
        return `character ${fmt(d.characterId)}`;
      case "account.created":
        return `main ${fmt(d.mainCharacterId)}`;
      case "account.main_changed":
        return `main → ${fmt(d.mainCharacterId)}`;
      case "character.reclaimed":
        return `from ${fmt(d.fromAccount)}`;
      case "token.invalidated":
        return fmt(d.reason);
      case "token.verify_failed":
        return fmt(d.error);
      case "token.subject_mismatch":
        return `subject ${fmt(d.subjectCharacterId)}`;
      case "character.owner_mismatch":
        return `detected by ${fmt(d.detectedBy)}`;
      case "discord.unlinked":
        return fmt(d.reason);
      case "discord.role_changed":
        return d.added !== undefined
          ? `+${fmt(d.added)} -${fmt(d.removed)} (${fmt(d.tier)})`
          : `-${fmt(d.removed)} (${fmt(d.cause)})`;
      default: {
        const entries = Object.entries(d)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${fmt(v)}`);
        return entries.length ? entries.join(", ") : "—";
      }
    }
  } catch {
    return "(unreadable)";
  }
}
```

- [ ] **Step 4: Delete the originals from the page and import instead**

In `src/app/admin/audit/page.tsx`, delete lines 19-84 (both functions and their doc comments), then add this import alongside the existing ones near line 11:

```ts
import { summarizeDetails } from "@/app/admin/audit/summarize";
```

Leave the call site at what was line 464 alone — `summary={summarizeDetails(r.action, r.details)}` still resolves.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/audit-summarize.test.ts`
Expected: PASS, 6 tests.

Run: `npm run typecheck`
Expected: no output, exit 0. If it reports `fmt` unused or undefined in `page.tsx`, a fragment of the deleted block was left behind.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/audit/summarize.ts tests/audit-summarize.test.ts src/app/admin/audit/page.tsx
git commit -m "refactor(audit): extract summarizeDetails into its own module

Pure move with no behavior change, plus tests pinning current output
(bugs included) so the next commit's diff is only the logic change."
```

---

### Task 2: Replace the template switch with a field declaration

**Files:**
- Modify: `src/app/admin/audit/summarize.ts` (whole file)
- Modify: `tests/audit-summarize.test.ts` (update three baseline assertions, add new ones)
- Modify: `src/app/admin/audit/page.tsx` (pass the role map at the call site)

**Interfaces:**
- Consumes: `summarizeDetails(action, details)` from Task 1.
- Produces: `summarizeDetails(action: string, details: unknown, roleNames?: ReadonlyMap<string, string>): string`. The third parameter is optional so existing call sites and tests keep compiling; when omitted, role ids do not resolve and fall back to truncation. Nothing later in this plan consumes it.

- [ ] **Step 1: Write the failing tests for the new behavior**

In `tests/audit-summarize.test.ts`, append this second `describe` block. Change nothing in the existing block: those six tests pin behavior that must survive this rewrite untouched, and they are the regression guard proving this task changed only what it meant to.

```ts
const ROLE_NAMES = new Map([
  ["100", "flygd"],
  ["200", "blue"],
  ["300", "green"],
]);

describe("summarizeDetails, declared fields and role rendering", () => {
  it("renders a status transition with its from value", () => {
    expect(
      summarizeDetails("status.changed", { from: "active", to: "cryo" }),
    ).toBe("active → cryo");
  });

  it("renders a status transition without from", () => {
    expect(summarizeDetails("status.changed", { to: "cryo" })).toBe("→ cryo");
  });

  it("shows scope on a privilege grant", () => {
    expect(
      summarizeDetails("admin.promoted", { scope: "full", note: "shift lead" }),
    ).toBe("full, shift lead");
  });

  it("marks a truncated fallback instead of cutting silently", () => {
    expect(
      summarizeDetails("unknown.action", { a: 1, b: 2, c: 3, d: 4, e: 5 }),
    ).toBe("a=1, b=2, c=3, +2 more");
  });

  it("does not mark a fallback that fits", () => {
    expect(summarizeDetails("unknown.action", { a: 1, b: 2, c: 3 })).toBe(
      "a=1, b=2, c=3",
    );
  });

  it("resolves known role ids to tier names", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["300"], removed: ["100"] },
        ROLE_NAMES,
      ),
    ).toBe("+green −flygd");
  });

  it("collapses unresolvable ids alongside known ones", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["300"], removed: ["100", "999888777"] },
        ROLE_NAMES,
      ),
    ).toBe("+green −flygd, −1 other");
  });

  it("truncates a lone unresolvable id", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: [], removed: ["298471555"] },
        ROLE_NAMES,
      ),
    ).toBe("−298471…");
  });

  it("resolves nothing when no role map is supplied", () => {
    expect(
      summarizeDetails("discord.role_changed", {
        added: ["987654321098765432"],
        removed: [],
      }),
    ).toBe("+987654…");
  });

  it("does not throw on a role payload that is not an array", () => {
    expect(
      summarizeDetails("discord.role_changed", { added: "300", removed: null }, ROLE_NAMES),
    ).toBe("—");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/audit-summarize.test.ts`
Expected: FAIL. The status/scope/truncation tests fail on wrong output (`"→ cryo"` received where `"active → cryo"` expected); the role tests fail to compile because `summarizeDetails` takes two parameters.

- [ ] **Step 3: Rewrite the module**

Replace the entire contents of `src/app/admin/audit/summarize.ts`:

```ts
/** Renders a JSON value inline where it can't throw: a string/number/boolean
 * as itself, anything else as compact JSON. Never lets a malformed payload
 * take the whole row down. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "?";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "?";
  }
}

/** A Discord role id we can't name: first six characters, then an ellipsis.
 * The full value rides along in the `title` the details cell already sets. */
function shortId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
}

type Part = (d: Record<string, unknown>, roleNames: ReadonlyMap<string, string>) => string;

/** `flygd → green`, or `→ green` when the payload has no prior value. One
 * renderer shared by every transition action, so the two can't drift apart
 * the way tier.changed and status.changed did. */
function transition(fromKey: string, toKey: string): Part {
  return (d) =>
    d[fromKey] !== undefined
      ? `${fmt(d[fromKey])} → ${fmt(d[toKey])}`
      : `→ ${fmt(d[toKey])}`;
}

/** `+green −flygd`. Ids the app manages resolve to their tier name; anything
 * else collapses to a count, or to a truncated id when it stands alone. An
 * operator asking which roles changed gets an answer, and an id that changed
 * since the row was written degrades instead of lying. */
function roles(addedKey: string, removedKey: string): Part {
  return (d, roleNames) => {
    const side = (key: string, sign: string): string => {
      const raw = d[key];
      if (!Array.isArray(raw) || raw.length === 0) return "";
      const ids = raw.map(String);
      const known = ids.filter((id) => roleNames.has(id));
      const unknown = ids.filter((id) => !roleNames.has(id));
      const parts = known.map((id) => `${sign}${roleNames.get(id)}`);
      if (unknown.length === 1 && known.length === 0) {
        parts.push(`${sign}${shortId(unknown[0])}`);
      } else if (unknown.length > 0) {
        parts.push(`${sign}${unknown.length} other`);
      }
      return parts.join(", ");
    };
    return [side(addedKey, "+"), side(removedKey, "−")].filter(Boolean).join(" ");
  };
}

/** A single payload value, rendered bare. */
function scalar(key: string): Part {
  return (d) => (d[key] === undefined ? "" : fmt(d[key]));
}

/** A payload value behind a fixed word, e.g. `character 90000001`. */
function labelled(word: string, key: string): Part {
  return (d) => (d[key] === undefined ? "" : `${word} ${fmt(d[key])}`);
}

/**
 * Which payload keys matter, per action, and how they read. Adding an action
 * means adding a row here. A key nobody declared shows up as a visible blank
 * rather than being silently dropped, which is the failure mode the old
 * hand-written templates had.
 */
const PARTS: Record<string, readonly Part[]> = {
  "tier.changed": [transition("from", "to")],
  "status.changed": [transition("from", "to")],
  "admin.promoted": [scalar("scope"), scalar("note")],
  "admin.bootstrap_granted": [labelled("character", "characterId")],
  "account.created": [labelled("main", "mainCharacterId")],
  "account.main_changed": [labelled("main →", "mainCharacterId")],
  "character.reclaimed": [labelled("from", "fromAccount")],
  "token.invalidated": [scalar("reason")],
  "token.verify_failed": [scalar("error")],
  "token.subject_mismatch": [labelled("subject", "subjectCharacterId")],
  "character.owner_mismatch": [labelled("detected by", "detectedBy")],
  "discord.unlinked": [scalar("reason")],
  "discord.role_changed": [roles("added", "removed")],
};

/** How many key=value pairs the fallback shows before it says so. */
const FALLBACK_KEYS = 3;

/**
 * One factual line per action, e.g. `tier.changed` -> `flygd → green`. This is
 * what a scanning admin actually reads; the full payload stays behind the `+`
 * disclosure, so the line's job is not to be complete, it is to not lie about
 * being complete.
 *
 * Total and defensive: an unknown action or a malformed payload falls through
 * to a generic key=value rendering rather than throwing, since new action names
 * appear over time and the DB does not enforce a shape.
 *
 * `roleNames` maps a Discord role id to its tier name. Passed in rather than
 * imported so this module stays a pure function of its arguments and needs no
 * env to test.
 */
export function summarizeDetails(
  action: string,
  details: unknown,
  roleNames: ReadonlyMap<string, string> = new Map(),
): string {
  const d = (details && typeof details === "object" ? details : {}) as Record<
    string,
    unknown
  >;
  try {
    const parts = PARTS[action];
    if (parts) {
      const rendered = parts.map((p) => p(d, roleNames)).filter(Boolean);
      if (rendered.length) return rendered.join(", ");
      return "—";
    }
    const entries = Object.entries(d);
    const shown = entries.slice(0, FALLBACK_KEYS).map(([k, v]) => `${k}=${fmt(v)}`);
    if (!shown.length) return "—";
    const hidden = entries.length - shown.length;
    return hidden > 0 ? `${shown.join(", ")}, +${hidden} more` : shown.join(", ");
  } catch {
    return "(unreadable)";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/audit-summarize.test.ts`
Expected: PASS. Every test in the file, including the untouched baseline ones from Task 1.

If `"tier.changed"` with only `{to}` now fails, `transition` is checking the wrong key. If the empty-payload test fails, a declared action returned all-empty parts and did not reach the `"—"` fallback.

- [ ] **Step 5: Pass the role map from the page**

In `src/app/admin/audit/page.tsx`, add the config import next to the existing ones:

```ts
import { config } from "@/config";
```

Inside `AdminAuditPage`, after `const now = Date.now();`, build the reverse map once per render:

```ts
// tier -> role id in config; this table needs role id -> tier.
const roleNames = new Map(
  Object.entries(config.discord.roleIds).map(([tier, id]) => [id, tier]),
);
```

Then update the call site in the details cell:

```tsx
summary={summarizeDetails(r.action, r.details, roleNames)}
```

Verify the import path and shape first: `src/config.ts:117-121` defines `roleIds: { flygd, blue, green }`. If `config` is not the exported name, match whatever `src/config.ts` actually exports rather than guessing.

- [ ] **Step 6: Typecheck and run the full unit suite**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: all suites pass. Note this needs the shared `:5433` Postgres up (`docker-compose.dev.yml`). Quote the summary line in the commit or report.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/audit/summarize.ts tests/audit-summarize.test.ts src/app/admin/audit/page.tsx
git commit -m "fix(audit): say which roles changed, and stop dropping fields

Replaces per-action template strings with a field declaration. status.changed
now shares tier.changed's transition renderer, so it keeps its 'from' value;
admin.promoted declares scope instead of falling through a 3-key cut; Discord
role ids resolve to tier names, and a truncated fallback says '+N more'
instead of cutting in silence."
```

---

### Task 3: Stop the page 500ing on a duplicated query parameter

**Files:**
- Modify: `src/app/admin/audit/page.tsx:219-244`
- Modify: `e2e/audit.spec.ts` (append one spec)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: nothing consumed later. `params` keeps its existing `Record<string, string | undefined>` shape, so `filterHref` (`page.tsx:97`), `ActorCell` (`page.tsx:122`) and `TargetCell` need no change.

- [ ] **Step 1: Write the failing e2e spec**

Append to `e2e/audit.spec.ts`. The file already has `db`, `pool`, `resetDb` and the imports this needs at the top; do not re-declare them.

```ts
test("a repeated filter param does not break the page", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  const res = await page.goto("/admin/audit?actor=alpha&actor=beta");
  expect(res?.status()).toBe(200);

  // Last value wins: appending &actor=beta to a URL that already has an actor
  // is how a duplicate arises, so the appended one is the intent. Active
  // filters render as a dim aside on the rule head (page.tsx:331), not chips.
  await expect(page.getByText("actor: beta")).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/audit.spec.ts -g "repeated filter param"`
Expected: FAIL with a 500 status, because `raw.actor?.trim()` is called on an array.

- [ ] **Step 3: Widen the type and normalize**

In `src/app/admin/audit/page.tsx`, change the signature at lines 219-228:

```tsx
export default async function AdminAuditPage({
  searchParams,
}: {
  // Next passes `string | string[]` for any param, and the page used to
  // declare only `string`. A repeated param (`?actor=a&actor=b`) then reached
  // `.trim()` on an array and took the whole page down with a 500.
  searchParams: Promise<{
    actor?: string | string[];
    action?: string | string[];
    target?: string | string[];
    before?: string | string[];
  }>;
}) {
```

Add this helper above the component, near `filterHref`:

```ts
/** Collapses a possibly-repeated query param to one value, last wins: a
 * duplicate arises in practice by appending `&actor=x` to a URL that already
 * has one, so the appended value is the intent. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[v.length - 1] : v;
}
```

Then replace the `params` block at lines 239-244:

```ts
  const params = {
    actor: one(raw.actor)?.trim() || undefined,
    action: one(raw.action) || undefined,
    target: one(raw.target)?.trim() || undefined,
    before: one(raw.before),
  };
  const beforeId = params.before ? Number(params.before) : undefined;
```

Note the spread of `raw` is gone on purpose: it would put raw arrays back into `params`, which downstream code types as `Record<string, string | undefined>`. Keep the existing comment above this block explaining why `actor` and `target` are trimmed and `action` is not.

- [ ] **Step 4: Run the spec and typecheck**

Run: `npx playwright test e2e/audit.spec.ts -g "repeated filter param"`
Expected: PASS.

Run: `npm run typecheck`
Expected: no output, exit 0. An error at `filterHref(params, ...)` or `<ActorCell params={params}>` means a param is still typed `string | string[]`; every field of `params` must be `string | undefined`.

- [ ] **Step 5: Commit**

Do not use `git add -A`: an e2e run rewrites `tsconfig.json` and may create `AGENTS.md`.

```bash
git checkout tsconfig.json 2>/dev/null || true
git add src/app/admin/audit/page.tsx e2e/audit.spec.ts
git commit -m "fix(audit): stop a repeated query param from 500ing the page

searchParams was annotated string-only while Next passes string | string[],
so ?actor=a&actor=b hit .trim() on an array. Widen the type to the real
contract and collapse through one(), last value wins."
```

---

### Task 4: Empty state — no hover highlight, readable at 320px

**Files:**
- Modify: `src/app/globals.css:567-569` (hover rule), `globals.css:572` (`.log__empty`)
- Modify: `src/app/admin/audit/page.tsx:473-479` (wrap the message in a span)
- Modify: `e2e/audit.spec.ts` (append one spec)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing e2e spec**

Append to `e2e/audit.spec.ts`:

```ts
test("the empty state is readable at 320px", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/admin/audit?actor=nobody-by-this-name");

  const geometry = await page.evaluate(() => {
    const cell = document.querySelector(".log__empty");
    const scroller = document.querySelector(".scroller");
    if (!cell || !scroller) return null;
    const inner = cell.firstElementChild ?? cell;
    return {
      innerRight: Math.round(inner.getBoundingClientRect().right),
      scrollerRight: Math.round(scroller.getBoundingClientRect().right),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.innerRight).toBeLessThanOrEqual(geometry!.scrollerRight);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/audit.spec.ts -g "readable at 320px"`
Expected: FAIL. The message box extends to roughly 561px against a scroller right edge near 304px, because `colSpan={5}` inherits the colgroup's summed rem widths.

- [ ] **Step 3: Wrap the message in a positioned span**

In `src/app/admin/audit/page.tsx`, change the empty row at lines 473-479:

```tsx
            {rows.length === 0 && (
              <tr>
                {/* The cell spans five fixed-width columns, so at 320px its box
                    is far wider than the scroller and the text used to wrap out
                    of view. The inner span pins to the scroller's visible left
                    edge and wraps within it; the cell keeps its layout width. */}
                <td className="log__empty" colSpan={5}>
                  <span className="log__empty-text">{emptyMessage}</span>
                </td>
              </tr>
            )}
```

- [ ] **Step 4: Add the two CSS rules**

In `src/app/globals.css`, add the exclusion to the hover rule at lines 567-569. Lines 709, 722 and 739 already carry exactly this exclusion for the sticky-column rules; this one was missed.

```css
.log tbody tr:not(:has(.log__empty)):hover {
  background: color-mix(in oklab, var(--hull-hi) 55%, transparent);
}
```

Then add, immediately after the existing `.log__empty` block:

```css
/* The empty cell spans every column, so under `table-layout: fixed` its box is
   as wide as the whole table. Sticky-pinning the text to the scroll container's
   left edge keeps the message on screen at narrow widths instead of wrapping
   past the right edge of the viewport. */
.log__empty-text {
  position: sticky;
  left: 0;
  display: inline-block;
  max-width: 100vw;
  text-align: center;
}
```

`:has()` is used rather than `:not(.log__empty)` because the hover rule targets the `<tr>` while the class sits on the `<td>`. If the project's browser floor does not allow `:has()`, add a `log__empty-row` class to the `<tr>` in Step 3 and use `tr:not(.log__empty-row):hover` instead.

- [ ] **Step 5: Verify both behaviors**

Run: `npx playwright test e2e/audit.spec.ts -g "readable at 320px"`
Expected: PASS.

Run: `npx playwright test e2e/audit.spec.ts e2e/admin.spec.ts`
Expected: PASS, all specs. The three `.log__empty` assertions and `e2e/admin.spec.ts:504`'s `td.log__empty` must still pass untouched — the cell is still a `td` with that class. **If any of them fail, do not edit the assertion.** Re-read Step 3: the class must stay on the `td`, with the span nested inside it.

Then check the hover fix by hand, since no assertion covers colour: load `/admin/audit` with a filter matching nothing, hover the message, and confirm the row does not change background.

- [ ] **Step 6: Commit**

```bash
git checkout tsconfig.json 2>/dev/null || true
git add src/app/globals.css src/app/admin/audit/page.tsx e2e/audit.spec.ts
git commit -m "fix(audit): stop the empty state highlighting and overflowing

The row hover rule was missing the :not() exclusion its three sticky-column
neighbours already carry, so the empty state lit up like a real event. Its
colSpan cell also inherits the colgroup's summed widths, so at 320px the
message wrapped out of view and read 'No account or character na'."
```

---

### Task 5: Tell the truth when the cursor is past the end, and name the table

**Files:**
- Modify: `src/app/admin/audit/page.tsx:311-317` (`emptyMessage`), and the `<table>` element
- Modify: `e2e/audit.spec.ts` (append one spec)

**Interfaces:**
- Consumes: `params.before` from Task 3's normalized `params`. If Task 3 has not landed, `raw.before` works the same way for this purpose.
- Produces: nothing.

- [ ] **Step 1: Write the failing e2e spec**

```ts
test("paging past the end says so instead of claiming an empty log", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await db.insert(auditLog).values([
    { actor: "system", action: "tier.changed", target: admin.id, details: { to: "green" } },
    { actor: "system", action: "tier.changed", target: admin.id, details: { to: "blue" } },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // Serial ids restart at 1 per resetDb, so `before=1` is guaranteed to be at
  // or past the oldest row while the log itself is not empty.
  await page.goto("/admin/audit?before=1");

  await expect(page.locator(".log__empty")).toContainText("older");
  await expect(page.locator(".log__empty").getByRole("link")).toHaveAttribute(
    "href",
    "/admin/audit",
  );
});
```

Confirm `resetDb` restarts identity before relying on the id-1 assumption; if it does not, read the inserted rows' ids back and use the lowest.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/audit.spec.ts -g "paging past the end"`
Expected: FAIL. The page renders "Nothing has happened yet." because `filtered` (`page.tsx:280`) counts `actor`, `action` and `target` but not `before`.

- [ ] **Step 3: Add the third branch**

Replace `emptyMessage` at `page.tsx:311-317`:

```tsx
  const emptyMessage = unmatched.length ? (
    `No account or character named ${unmatched
      .map(([field, r]) => `"${r.name}" (${field})`)
      .join(" or ")}.`
  ) : beforeId !== undefined && Number.isFinite(beforeId) ? (
    // The log is not empty, the cursor is simply past its end. Saying "nothing
    // has happened yet" here is false, and the `Older →` button is gone
    // (it renders only on a full page), so this state had no exit at all.
    <>
      Nothing older than this point. <a href="/admin/audit">Back to the latest entries</a>
    </>
  ) : filtered ? (
    "Nothing matches this filter."
  ) : (
    "Nothing has happened yet."
  );
```

`emptyMessage` now holds a `ReactNode` rather than a `string`. It is only ever rendered as JSX children (inside the span from Task 4), so no other call site changes. If TypeScript infers too narrow a type, annotate it `const emptyMessage: React.ReactNode =`.

- [ ] **Step 4: Add the accessible name**

Find the `<table className="log ...">` element in `page.tsx` and add a caption as its first child. The table currently has no `<caption>`, no `aria-label` and no `aria-labelledby`.

```tsx
<caption className="visually-hidden">Audit log entries</caption>
```

`visually-hidden` already exists in `globals.css` and is used elsewhere in this same file (see the timestamp cell around line 435).

- [ ] **Step 5: Verify**

Run: `npx playwright test e2e/audit.spec.ts -g "paging past the end"`
Expected: PASS.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git checkout tsconfig.json 2>/dev/null || true
git add src/app/admin/audit/page.tsx e2e/audit.spec.ts
git commit -m "fix(audit): don't claim an empty log when the cursor ran past the end

?before=<id past the end> reported 'Nothing has happened yet' on a full log,
with no way back because the pager only renders on a full page. Adds the
missing branch and a link out, plus a visually-hidden caption so the table
has an accessible name."
```

---

### Task 6: Full verification

**Files:** none modified unless a failure demands it.

- [ ] **Step 1: Format and lint**

Run: `npm run format:check`
Expected: pass. If it fails, run `npm run format` and stage only the files this plan touched.

Run: `npm run lint`
Expected: pass.

- [ ] **Step 2: Full unit suite**

Run: `npm test`
Expected: all suites pass. Needs the shared `:5433` Postgres up.

- [ ] **Step 3: Full typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 4: Full e2e suite**

Run: `npm run test:e2e`
Expected: all specs pass, including the eleven pre-existing `tbody tr` count assertions and the three `.log__empty` assertions in `e2e/audit.spec.ts`, plus `e2e/admin.spec.ts:504`. None of them should have been edited by this plan.

- [ ] **Step 5: Confirm the working tree is clean of e2e side effects**

```bash
git status --porcelain
```

Expected: empty. If `tsconfig.json` shows as modified or `AGENTS.md` appears, revert them — they are e2e side effects, not part of this change:

```bash
git checkout tsconfig.json
rm -f AGENTS.md
```

- [ ] **Step 6: Quote the output**

Report the actual output of steps 2, 3 and 4. Per the working agreement, a pass may not be claimed without it.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| 1. Widen searchParams, `one()` helper, last-wins | Task 3 |
| 2. Field declaration, `transition`, `roles`, injected role map, `+N more` | Tasks 1-2 |
| 3. `:not()` on the hover rule | Task 4 |
| 3. 320px overflow, acceptance test `overflowsRight: false` | Task 4 (expressed as `innerRight <= scrollerRight`) |
| 4. Third `emptyMessage` branch with a link out | Task 5 |
| 4. Visually-hidden `<caption>` | Task 5 |
| Testing: unit cases, e2e cases, watch item | Tasks 1, 2, 3, 4, 5, 6 |

No gaps.

**Type consistency:** `summarizeDetails` is two-parameter in Task 1 and gains an optional third in Task 2, which is why every Task 1 test still compiles. `params` is `Record<string, string | undefined>` after Task 3, matching what `filterHref`, `ActorCell` and `TargetCell` already declare. `emptyMessage` widens from `string` to `ReactNode` in Task 5 and is consumed only as JSX children.

**Known soft spots, flagged rather than hidden:**

- Task 5's spec assumes `resetDb` restarts serial identity, so `before=1` sits at or past the oldest row. Step 1 says to confirm this rather than trust it.
- Task 4's CSS is the plan's least certain part. `position: sticky` against `table-layout: fixed` with a `colSpan` is exactly the interaction the spec declined to assert blind. The acceptance test in Step 2/5 is the real specification; if these declarations do not satisfy it, change the declarations, not the test.
- The `:has()` selector in Task 4 has a stated fallback if the browser floor forbids it.
