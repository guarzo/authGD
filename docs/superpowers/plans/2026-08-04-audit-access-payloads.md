# Audit Access Payloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/admin/audit` answer "why did this member lose access?" by writing the payloads the access-relevant writers never wrote, and by surfacing the keys the renderer silently dropped.

**Architecture:** One renderer task makes `src/app/admin/audit/summarize.ts` tag the payload keys each declaration consumes, so an undeclared key becomes a visible `+N more` instead of vanishing; it also adds three combinators and rewrites the declaration table. Five writer tasks then add the payloads themselves, each a value already in scope from a lock-and-read the writer performs anyway. No schema change, no migration, no backfill.

**Tech Stack:** TypeScript, Next.js 15 App Router (server components), Drizzle ORM, Vitest, Playwright, Prettier (printWidth 90).

**Spec:** `docs/superpowers/specs/2026-08-04-audit-access-payloads-design.md`

## Global Constraints

- **Audit rows are persisted data.** No `audit_log` migration and no backfill. Every renderer must degrade gracefully on a payload written by the old code.
- **Every state change writes an audit row.** Do not remove or make conditional any existing `logAudit` call.
- **`src/core/` stays pure.** Nothing in this plan touches it. `src/core/acl-diff.ts` is read-only reference.
- **Admin routes stay guarded.** Nothing in this plan touches a route or a guard.
- **No em dashes in comments or user-visible copy, and no `--` as a dash substitute.** The existing `"—"` return value inside `summarizeDetails` is a rendered glyph for an empty payload, not prose; it stays exactly as it is.
- **Unit tests live in `tests/**/*.test.ts`.** Vitest collects nothing else (`vitest.config.ts:6`).
- **Migrations are generated, never hand-written.** No migration is expected in this plan; if one appears, stop.
- **Formatter:** Prettier, `printWidth: 90` (`prettier.config.mjs`). Run `npm run format:check` per task, not only at the end.
- **Verification commands**, run and quoted before any completion claim: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`.
- **Worktree note:** `npm test` uses the shared `:5433` Postgres and is not worktree-safe; run it when no other session is using that database. E2E is worktree-safe. An e2e run rewrites `tsconfig.json` and may touch `AGENTS.md`; both are tracked, so recover them with `git checkout`, never by deleting.

---

### Task 1: Renderer — tag consumed keys, surface `+N more`, add three combinators

This is one task rather than three because the pieces cannot land separately without leaving the suite red. Tagging alone changes `tier.changed`'s output (its `cause` becomes `+1 more`); declaring `cause` alone changes it a different way. Only the combination produces the two e2e strings the spec predicts.

**Files:**

- Modify: `src/app/admin/audit/summarize.ts`
- Test: `tests/audit-summarize.test.ts` (exists, seventeen cases)
- Test: `e2e/audit.spec.ts:56` and `:62` (two assertion updates, plus one new test)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: the declaration table that Tasks 2 through 6 write payloads against. The exact key names those tasks must emit are `from`, `cause`, `locked`, `self`, `name`, `wasMain`, `missingScopes`, `tier`, `had`, `has`, `role`. A writer that emits a different spelling renders as `+1 more` rather than as text, which is the failure mode these tests are shaped to catch.
- `summarizeDetails(action: string, details: unknown, roleNames?: ReadonlyMap<string, string>): string` keeps its exact signature. No caller changes.

**One deviation from the spec, recorded deliberately:** the spec's prose writes the new combinator as `list(key, word)`, but its required output for three or more values is `missing 4 scopes`, which needs a noun. Implementing it as `list(key, word, noun)` produces exactly the spec's strings without baking `"scopes"` into a combinator that does not otherwise know what it is listing. Same rendered output, one extra argument at the single call site.

- [ ] **Step 1: Write the failing tests**

Two parts. Do the replacement first, because appending around it would leave the file asserting both a fictional `admin.promoted` shape and its removal.

**1a. Replace the one existing test this change contradicts.** `tests/audit-summarize.test.ts:60-64` currently reads (shown de-indented; in the file it sits one level in, inside `describe`):

```ts
it("shows scope on a privilege grant", () => {
  expect(
    summarizeDetails("admin.promoted", { scope: "full", note: "shift lead" }),
  ).toBe("full, shift lead");
});
```

That test pins the speculative declaration this task deletes. It is the only existing case that changes. Replace those five lines in place with:

```ts
it("no longer declares admin.promoted, which writes no payload", () => {
  // The declaration described seeded test data: the app has no admin scope
  // or note. An admin.promoted row has no details at all, so page.tsx
  // short-circuits before this function; a payload from anywhere else falls
  // through to the generic fallback rather than to a fictional shape.
  expect(summarizeDetails("admin.promoted", { scope: "all" })).toBe("scope=all");
});
```

**1b. Append the new cases.** In the same file, inside the existing `describe("summarizeDetails", ...)` block, before its closing `});`:

```ts
it("surfaces the cause a tier change was written with", () => {
  expect(
    summarizeDetails("tier.changed", {
      from: "flygd",
      to: "green",
      cause: "main unlinked",
    }),
  ).toBe("flygd → green, main unlinked");
});

it("renders a truthy flag as its word and a falsy one as nothing", () => {
  expect(summarizeDetails("tier.changed", { to: "blue", locked: true })).toBe(
    "→ blue, locked",
  );
  expect(summarizeDetails("tier.changed", { to: "blue", locked: false })).toBe("→ blue");
});

it("does not count a declared key that rendered blank as hidden", () => {
  // Rule 1: declared-and-deliberately-silent is not nobody-looked-at-it.
  expect(summarizeDetails("tier.changed", { to: "blue", locked: false })).not.toContain(
    "more",
  );
});

it("appends the remainder for an undeclared key on a declared action", () => {
  expect(summarizeDetails("tier.changed", { to: "blue", surprise: 1 })).toBe(
    "→ blue, +1 more",
  );
});

it("appends the remainder even when every declared part rendered blank", () => {
  // Rule 2: a blank line carrying unnamed keys must not claim emptiness.
  expect(summarizeDetails("tier.unlocked", { surprise: 1, alsoNew: 2 })).toBe("+2 more");
});

it("does not truncate declared parts at the fallback cap", () => {
  // Rule 3: the three-key cap is the machine-generated fallback's, not a
  // hand-curated declaration's.
  expect(
    summarizeDetails("tier.changed", {
      from: "flygd",
      to: "green",
      cause: "manual",
      locked: true,
    }),
  ).toBe("flygd → green, manual, locked");
});

it("renders one or two missing scopes in full and collapses three or more", () => {
  expect(summarizeDetails("token.needs_reauth", { missingScopes: ["esi-a.v1"] })).toBe(
    "missing esi-a.v1",
  );
  expect(
    summarizeDetails("token.needs_reauth", { missingScopes: ["esi-a.v1", "esi-b.v1"] }),
  ).toBe("missing esi-a.v1, esi-b.v1");
  expect(
    summarizeDetails("token.needs_reauth", {
      missingScopes: ["esi-a.v1", "esi-b.v1", "esi-c.v1", "esi-d.v1"],
    }),
  ).toBe("missing 4 scopes");
});

it("renders nothing for a malformed scope list and never marks it hidden", () => {
  // One legacy or hand-inserted row must not become a dead cell. Parity with
  // the roles() guard; the payload stays one disclosure click away.
  for (const missingScopes of ["a string", null, [], 7]) {
    const out = summarizeDetails("token.needs_reauth", { missingScopes });
    expect(out).toBe("—");
  }
});

it("renders an unlink with the name the deleted character had", () => {
  expect(summarizeDetails("character.unlinked", { name: "Zed Alt", wasMain: true })).toBe(
    "Zed Alt, was main",
  );
  expect(
    summarizeDetails("character.unlinked", { name: "Zed Alt", wasMain: false }),
  ).toBe("Zed Alt");
});

it("renders the tier automation was handed back", () => {
  expect(summarizeDetails("tier.unlocked", { tier: "flygd" })).toBe("was flygd");
});

it("renders a status note change as added, replaced, or cleared", () => {
  expect(summarizeDetails("status.note_changed", { had: false, has: true })).toBe(
    "note added",
  );
  expect(summarizeDetails("status.note_changed", { had: true, has: true })).toBe(
    "note replaced",
  );
  expect(summarizeDetails("status.note_changed", { had: true, has: false })).toBe(
    "note cleared",
  );
});

it("renders the wanderer role that was revoked", () => {
  expect(summarizeDetails("wanderer.removed", { role: "manager" })).toBe("role manager");
});

it("renders a self-service status change", () => {
  expect(
    summarizeDetails("status.changed", { from: "cryo", to: "active", self: true }),
  ).toBe("cryo → active, self-service");
});

it("surfaces the tier and cause a discord role change was written with", () => {
  const names = new Map([["1", "green"]]);
  expect(
    summarizeDetails(
      "discord.role_changed",
      { added: ["1"], tier: "green", cause: "tier change" },
      names,
    ),
  ).toBe("+green, tier green, tier change");
});

it("still degrades on rows written before this change", () => {
  // The no-migration guarantee, expressed as tests.
  expect(summarizeDetails("tier.changed", { to: "green", cause: "main unlinked" })).toBe(
    "→ green, main unlinked",
  );
  expect(summarizeDetails("status.changed", { to: "cryo" })).toBe("→ cryo");
  expect(summarizeDetails("character.unlinked", {})).toBe("—");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/audit-summarize.test.ts`

Expected: FAIL. Representative failures: `"flygd → green"` received where `"flygd → green, main unlinked"` was expected, and `"—"` received for `token.needs_reauth` because no such declaration exists yet. The replaced test from 1a also fails, receiving `"all"` rather than `"scope=all"`, because the speculative declaration is still present.

- [ ] **Step 3: Add the key-tagging type and helper**

In `src/app/admin/audit/summarize.ts`, replace the `Part` type declaration (currently lines 22 to 25) with:

```ts
type Render = (
  d: Record<string, unknown>,
  roleNames: ReadonlyMap<string, string>,
) => string;

/**
 * A renderer that knows which payload keys it reads. The tag is what lets
 * summarizeDetails tell "declared and deliberately silent" apart from "nobody
 * looked at this key", so only the second earns a `+N more`. Tagging at the
 * combinator keeps the key names in one place: they are already arguments.
 */
type Part = Render & { readonly keys: readonly string[] };

const part = (keys: readonly string[], render: Render): Part =>
  Object.assign(render, { keys });
```

- [ ] **Step 4: Tag the four existing combinators**

Still in `summarize.ts`, wrap each existing combinator's return value in `part(...)`. Bodies are unchanged; only the wrapper and the key list are new.

```ts
/** `flygd → green`, or `→ green` when the payload has no prior value. One
 * renderer shared by every transition action, so the two can't drift apart
 * the way tier.changed and status.changed did. */
function transition(fromKey: string, toKey: string): Part {
  return part([fromKey, toKey], (d) =>
    d[fromKey] !== undefined
      ? `${fmt(d[fromKey])} → ${fmt(d[toKey])}`
      : `→ ${fmt(d[toKey])}`,
  );
}
```

```ts
function roles(addedKey: string, removedKey: string): Part {
  return part([addedKey, removedKey], (d, roleNames) => {
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
  });
}
```

```ts
/** A single payload value, rendered bare. */
function scalar(key: string): Part {
  return part([key], (d) => (d[key] === undefined ? "" : fmt(d[key])));
}

/** A payload value behind a fixed word, e.g. `character 90000001`. */
function labelled(word: string, key: string): Part {
  return part([key], (d) => (d[key] === undefined ? "" : `${word} ${fmt(d[key])}`));
}
```

Leave the `roles` doc comment (currently lines 37 to 40) exactly where it is, above the function.

- [ ] **Step 5: Add the three new combinators**

Insert directly after `labelled`, before the PARTS table:

```ts
/** A boolean that is only worth words when it is true: `locked`, `was main`.
 * A false flag renders nothing but still counts as read, so it never shows up
 * as an unexplained `+1 more`. */
function flag(key: string, word: string): Part {
  return part([key], (d) => (d[key] ? word : ""));
}

/** `missing esi-a.v1, esi-b.v1` up to two values, `missing 4 scopes` beyond
 * that: a full EVE scope string is long and this column is narrow.
 *
 * Guards with Array.isArray because the DB does not enforce payload shape, so
 * a legacy row, a hand-inserted row, or a future writer bug can put a bare
 * string or null here. A malformed value renders nothing rather than mapping
 * into per-character garbage or throwing into the (unreadable) catch, and the
 * key still counts as read so the line does not claim a hidden key it is
 * actually refusing to guess at. The payload stays one disclosure click away. */
function list(key: string, word: string, noun: string): Part {
  return part([key], (d) => {
    const raw = d[key];
    if (!Array.isArray(raw) || raw.length === 0) return "";
    if (raw.length > 2) return `${word} ${raw.length} ${noun}`;
    return `${word} ${raw.map(fmt).join(", ")}`;
  });
}

/** Whether a note was added, replaced, or cleared. Deliberately not the note
 * text: the audit log records that a note changed, and the note itself lives
 * on the account where it is current rather than frozen at write time. */
function noteChange(hadKey: string, hasKey: string): Part {
  return part([hadKey, hasKey], (d) => {
    const had = Boolean(d[hadKey]);
    const has = Boolean(d[hasKey]);
    if (had && has) return "note replaced";
    if (has) return "note added";
    if (had) return "note cleared";
    return "";
  });
}
```

- [ ] **Step 6: Rewrite the declaration table**

Replace the PARTS doc comment and object (currently lines 71 to 93) with:

```ts
/**
 * Which payload keys matter, per action, and how they read. Adding an action
 * means adding a row here; adding a key to an existing action without adding
 * it here means the summary says `+1 more` rather than dropping it in silence.
 *
 * `admin.promoted` is deliberately absent. It was declared here with a scope
 * and a note that no writer produces: the app has no admin-scope concept, and
 * the declaration described seeded test data.
 */
const PARTS: Record<string, readonly Part[]> = {
  "tier.changed": [transition("from", "to"), scalar("cause"), flag("locked", "locked")],
  "status.changed": [transition("from", "to"), flag("self", "self-service")],
  "admin.bootstrap_granted": [labelled("character", "characterId")],
  "account.created": [labelled("main", "mainCharacterId")],
  "account.main_changed": [labelled("main →", "mainCharacterId")],
  "character.reclaimed": [labelled("from", "fromAccount")],
  "character.unlinked": [scalar("name"), flag("wasMain", "was main")],
  "token.invalidated": [scalar("reason")],
  "token.verify_failed": [scalar("error")],
  "token.subject_mismatch": [labelled("subject", "subjectCharacterId")],
  "token.needs_reauth": [list("missingScopes", "missing", "scopes")],
  "tier.unlocked": [labelled("was", "tier")],
  "status.note_changed": [noteChange("had", "has")],
  "character.owner_mismatch": [labelled("detected by", "detectedBy")],
  "discord.unlinked": [scalar("reason")],
  "discord.role_changed": [
    roles("added", "removed"),
    labelled("tier", "tier"),
    scalar("cause"),
  ],
  "wanderer.removed": [labelled("role", "role")],
};
```

- [ ] **Step 7: Append the remainder count in `summarizeDetails`**

Replace the declared-action branch inside `summarizeDetails` (currently lines 122 to 127) with:

```ts
    const parts = PARTS[action];
    if (parts) {
      const rendered = parts.map((p) => p(d, roleNames)).filter(Boolean);
      const declared = new Set(parts.flatMap((p) => p.keys));
      const hidden = Object.keys(d).filter((k) => !declared.has(k)).length;
      const line = rendered.join(", ");
      // Declared parts are never truncated: the cap below is for the
      // machine-generated fallback, and truncating a hand-curated declaration
      // would be second-guessing whoever wrote it.
      if (hidden > 0) return line ? `${line}, +${hidden} more` : `+${hidden} more`;
      return line || "—";
    }
```

Also update the trailing clause of the `summarizeDetails` doc comment, which currently promises that a declared action's undeclared keys are dropped. Replace the sentence beginning "A key nobody declared" if it survives anywhere in the file; the PARTS comment rewritten in Step 6 is the canonical statement now.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/audit-summarize.test.ts`

Expected: PASS, all cases including the seventeen that existed before.

- [ ] **Step 9: Update the two e2e assertions the change is supposed to move**

In `e2e/audit.spec.ts`, line 56 currently reads:

```ts
  await expect(adminDetails.locator(".json__peek")).toHaveText("green → flygd");
```

Replace with:

```ts
  await expect(adminDetails.locator(".json__peek")).toHaveText("green → flygd, admin");
```

Line 62 currently reads:

```ts
  await expect(systemDetails.locator(".json__peek")).toHaveText("→ green");
```

Replace with:

```ts
  await expect(systemDetails.locator(".json__peek")).toHaveText("→ green, membership");
```

**These two are the change working, not the change overreaching.** PR #73's plan carried a standing instruction not to change assertions in this file. The line: **exactly two `.json__peek` text assertions change, and nothing structural changes at all.** A third changed `.json__peek` means a declaration went further than the table in Step 6; stop and reconcile the table rather than editing the assertion.

Do not count the structural assertions and do not encode a total here; totals go stale. Check the diff instead. After the two edits above, run:

```bash
git diff -U0 -- e2e/ | grep -E '^-[^-]' | grep -E 'toHaveCount|tbody tr|log__empty' || echo "(empty = no structural assertion touched)"
```

Only removed lines are inspected, so Step 10's new test may add its own `tbody tr` locator freely. Expected: `(empty = no structural assertion touched)`. Any output means a structural assertion was modified or deleted, which this task has no business doing.

- [ ] **Step 10: Add the end-to-end product-question test**

Append to `e2e/audit.spec.ts`:

```ts
test("a demotion row shows why it happened without opening the payload", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });

  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { from: "flygd", to: "green", cause: "main left alliance" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  // The product question, answered from the collapsed line: an admin reads why
  // the tier moved without opening the disclosure.
  const row = page.locator("tbody tr").filter({ hasText: "Zed" });
  await expect(row).toHaveCount(1);
  await expect(row.locator("details.json .json__peek")).toHaveText(
    "flygd → green, main left alliance",
  );
  await expect(row.locator("details.json .json__full")).toBeHidden();
});
```

Note the row locator filters by content rather than counting bare `<tr>` elements: the empty state is also a `<tr>`, so a bare count assertion passes whether or not the row is there.

- [ ] **Step 11: Verify**

Run and quote each:

```bash
npm run format:check
npm run lint
npm run typecheck
npx vitest run tests/audit-summarize.test.ts
npm run test:e2e -- audit.spec.ts
```

Expected: all pass. If `git status` shows `tsconfig.json` or `AGENTS.md` modified after the e2e run, restore with `git checkout -- tsconfig.json AGENTS.md`; both are tracked, so never delete them.

- [ ] **Step 12: Commit**

```bash
git add src/app/admin/audit/summarize.ts tests/audit-summarize.test.ts e2e/audit.spec.ts
git commit -m "feat(audit): stop dropping declared actions' undeclared keys

Combinators now tag the payload keys they read, so a declared action falls
through to the same +N more counter the undeclared fallback already used.
A declared key that renders blank is still consumed, so a false flag does not
masquerade as a hidden key.

Declares cause, locked, self and tier, which every tier.changed writer in the
app has always written and the page has never shown, plus the five actions
whose payloads land in the following commits. Drops admin.promoted, whose
declaration described seeded test data rather than anything a writer emits."
```

---

### Task 2: Writers — `from` on the four transition writers that already hold it

**Files:**

- Modify: `src/services/admin-accounts.ts:45-50` and `:88-93`
- Modify: `src/services/accounts.ts:95-100` and `:155-160`
- Test: `tests/admin-accounts.test.ts`, `tests/accounts.test.ts`

**Interfaces:**

- Consumes: Task 1's `transition("from", "to")` declaration on both `tier.changed` and `status.changed`.
- Produces: nothing later tasks depend on.

PR #73 built `transition(fromKey, toKey)` so `status.changed` would stop rendering a bare `→ cryo`. No `status.changed` writer writes `from`, so it still does. Each of these four writers has already locked and read the row it is about to change, so `from` is a reference to a variable in scope, not a query. `tests/membership-job.test.ts` is untouched: that writer already writes `from`.

- [ ] **Step 1: Write the failing tests**

In `tests/admin-accounts.test.ts`, extend the existing `setTierManual` assertion and add a `setAccountStatus` one. Add these cases inside their respective `describe` blocks:

```ts
it("records the tier it moved from, so the transition reads both ways", async () => {
  const admin = await seedAdmin();
  const target = await seedAccount(ctx.db, { tier: "flygd" });
  await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "blue"));
  const audit = await lastAudit();
  expect(audit.details).toMatchObject({
    from: "flygd",
    to: "blue",
    locked: true,
    cause: "manual",
  });
});
```

```ts
it("records the status it moved from", async () => {
  const admin = await seedAdmin();
  const target = await seedAccount(ctx.db);
  await ctx.db.transaction((tx) => setAccountStatus(tx, admin.id, target.id, "cryo"));
  const audit = await lastAudit();
  expect(audit.details).toMatchObject({ from: "active", to: "cryo" });
});
```

In `tests/accounts.test.ts`, add a case asserting the self-reactivation writer records `from`. The file already wraps the call as `wake(accountId)` (line 73), and `wakeSelf` only proceeds when the account is in `cryo`, so `from` is always `"cryo"` there:

```ts
it("records the status wakeSelf moved from", async () => {
  const acc = await seedAccount(ctx.db, { status: "cryo" });
  await wake(acc.id);
  const audits = await ctx.db.select().from(auditLog);
  const row = audits.find((a) => a.action === "status.changed");
  expect(row?.details).toMatchObject({ from: "cryo", to: "active", self: true });
});
```

The no-main-rule `tier.changed` writer is covered in Task 3, where an unlink is already being set up; adding a second unlink fixture here would duplicate it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/admin-accounts.test.ts tests/accounts.test.ts`

Expected: FAIL, with received payloads missing the `from` key.

- [ ] **Step 3: Add `from` to the two `admin-accounts.ts` writers**

In `setTierManual`, replace the `logAudit` call at lines 45 to 50 with:

```ts
  await logAudit(dbx, {
    actor,
    action: "tier.changed",
    target: accountId,
    details: { from: acc.tier, to: tier, locked: true, cause: "manual" },
  });
```

In `setAccountStatus`, replace the `logAudit` call at lines 88 to 93 with:

```ts
  await logAudit(dbx, {
    actor,
    action: "status.changed",
    target: accountId,
    details: { from: acc.status, to: status },
  });
```

`acc` is the `FOR UPDATE` row read at line 38 and line 81 respectively, so both reads already happened under the lock this writer takes anyway.

- [ ] **Step 4: Add `from` to the two `accounts.ts` writers**

In `wakeSelf`, replace the `logAudit` call at lines 95 to 100 with:

```ts
  await logAudit(dbx, {
    actor: accountId,
    action: "status.changed",
    target: accountId,
    details: { from: "cryo", to: "active", self: true },
  });
```

The literal is correct rather than lazy: line 90 returns early unless `acc.status === "cryo"`, so this branch is only reachable from `cryo`.

In `applyNoMainRule`, replace the `logAudit` call at lines 155 to 160 with:

```ts
    await logAudit(dbx, {
      actor: "system",
      action: "tier.changed",
      target: accountId,
      details: { from: acc.tier, to: "green", cause },
    });
```

`acc` is the `FOR UPDATE` row read at line 138, and this branch only runs when `demote` is true, which already required reading `acc.tier`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/admin-accounts.test.ts tests/accounts.test.ts`

Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
npm run format:check
npm run lint
npm run typecheck
```

```bash
git add src/services/admin-accounts.ts src/services/accounts.ts tests/admin-accounts.test.ts tests/accounts.test.ts
git commit -m "feat(audit): record the value a tier or status change moved from

Four writers already hold the prior value from the FOR UPDATE read they take
anyway, and none of them wrote it down, so the transition renderer PR #73
built has been rendering a bare arrow on four writers out of five."
```

---

### Task 3: Writers — `character.unlinked` records the name and whether it was main

**Files:**

- Modify: `src/services/accounts.ts:309-325`
- Test: `tests/accounts.test.ts`

**Interfaces:**

- Consumes: Task 1's `"character.unlinked": [scalar("name"), flag("wasMain", "was main")]`.
- Produces: nothing later tasks depend on.

`accounts.ts:310` deletes the `character` row before the log write, so the audit `target` is a character id that can never again resolve to a name: `resolveAuditIdentities` looks it up in a table it is no longer in, and the Target cell renders a dead id forever. `character.name` survives nowhere else once the row is gone.

`wasMain` is the fork into `applyNoMainRule`, which is what clears the main and deroles the account. It is the field that connects an unlink to the `tier.changed` row that follows it.

**The recorded name is legible, not searchable, and that is accepted.** `resolveFilterIdentity` (`src/services/audit.ts:296-303`) matches names against live `character` rows only, so filtering by a deleted character's name still returns "No account or character named X". Scoped out in the spec: an investigation starts from the account, which still exists and resolves via the actor filter. Do not add payload search here.

**This task moves a statement near a lock. Read the ordering note in Step 3 before editing.**

- [ ] **Step 1: Write the failing tests**

These are the first tests in this file to seed a character directly, so widen the import first. `tests/accounts.test.ts:19` currently reads:

```ts
import { seedAccount } from "./helpers/seed";
```

Replace it with:

```ts
import { seedAccount, seedCharacter } from "./helpers/seed";
```

Then add to `tests/accounts.test.ts`. The file already wraps the call as `unlink(actor, characterId)` (line 67):

```ts
it("records the unlinked character's name, which the row deletion destroys", async () => {
  const acc = await seedAccount(ctx.db);
  await seedCharacter(ctx.db, cfg, {
    id: 90000001,
    accountId: acc.id,
    main: true,
    name: "Zed Main",
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000002,
    accountId: acc.id,
    name: "Zed Alt",
  });
  await unlink(acc.id, 90000002);
  const audits = await ctx.db.select().from(auditLog);
  const row = audits.find((a) => a.action === "character.unlinked");
  expect(row?.details).toMatchObject({ name: "Zed Alt", wasMain: false });
});

it("flags an unlink of the main character, which is what triggers the derole", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, {
    id: 90000001,
    accountId: acc.id,
    main: true,
    name: "Zed Main",
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000002,
    accountId: acc.id,
    name: "Zed Alt",
  });
  await unlink(acc.id, 90000001);
  const audits = await ctx.db.select().from(auditLog);
  const unlinked = audits.find((a) => a.action === "character.unlinked");
  expect(unlinked?.details).toMatchObject({ name: "Zed Main", wasMain: true });
  // The unlink row still precedes the derole row it explains.
  const tier = audits.find((a) => a.action === "tier.changed");
  expect(tier?.details).toMatchObject({
    from: "flygd",
    to: "green",
    cause: "main unlinked",
  });
  expect(unlinked!.id).toBeLessThan(tier!.id);
});
```

`seedCharacter` takes an optional `name` (`tests/helpers/seed.ts:40`) and defaults it to `Char <id>`; these cases pass it explicitly so the assertion reads against a name a human chose.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/accounts.test.ts`

Expected: FAIL, with `details` received as `null`.

- [ ] **Step 3: Move the log call below the account read and add the payload**

In `unlinkCharacter`, replace lines 311 to 325 (the `logAudit` call, the account `SELECT ... FOR UPDATE`, and the `if` that follows) with:

```ts
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, existing.accountId))
    .for("update");
  // Logged after the account read, not before: wasMain needs that row, and the
  // character row carrying the name is already deleted above, so the name has
  // to come from `existing` or it is gone for good.
  const wasMain = acc?.mainCharacterId === characterId;
  await logAudit(dbx, {
    actor,
    action: "character.unlinked",
    target: String(characterId),
    details: { name: existing.name, wasMain },
  });
  if (wasMain) {
    await applyNoMainRule(dbx, existing.accountId, "main unlinked");
  } else {
    await enqueueSync(dbx, { kind: "account", accountId: existing.accountId });
  }
```

**Lock ordering is unchanged and a reviewer should confirm it rather than take it on faith.** Character first (`findCharacterForUpdate`, line 294), then account (the `FOR UPDATE` above). The account read does not move relative to the deletes; only the `logAudit` call moves, and `logAudit` takes no lock. Audit row ordering is also unchanged: `character.unlinked` still precedes the `tier.changed` row `applyNoMainRule` writes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/accounts.test.ts`

Expected: PASS, including the existing case at line 207 asserting that a `last_character` refusal writes no `character.unlinked` row at all.

- [ ] **Step 5: Verify and commit**

```bash
npm run format:check
npm run lint
npm run typecheck
```

```bash
git add src/services/accounts.ts tests/accounts.test.ts
git commit -m "feat(audit): record which character an unlink removed

The character row is deleted before the log write, so the audit target is an
id that never resolves to a name again and the Target cell renders a dead id
forever. Records the name, and whether it was the main, which is the field
connecting an unlink to the derole row that follows it."
```

---

### Task 4: Writers — `tier.unlocked` and `status.note_changed` payloads

**Files:**

- Modify: `src/services/admin-accounts.ts:69` and `:110`
- Test: `tests/admin-accounts.test.ts`

**Interfaces:**

- Consumes: Task 1's `"tier.unlocked": [labelled("was", "tier")]` and `"status.note_changed": [noteChange("had", "has")]`.
- Produces: nothing later tasks depend on.

`status.note_changed` records that a note changed, deliberately not the note text: the note itself lives on the account where it is current, rather than frozen at write time in a log row.

- [ ] **Step 1: Write the failing tests**

Add to `tests/admin-accounts.test.ts`:

```ts
it("records the tier automation was handed back", async () => {
  const admin = await seedAdmin();
  const target = await seedAccount(ctx.db, { tier: "blue" });
  await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "blue"));
  await ctx.db.transaction((tx) => returnTierToAuto(tx, admin.id, target.id));
  const audit = await lastAudit();
  expect(audit.action).toBe("tier.unlocked");
  expect(audit.details).toMatchObject({ tier: "blue" });
});

it("records whether a status note was added, replaced, or cleared", async () => {
  const admin = await seedAdmin();
  const target = await seedAccount(ctx.db);

  await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "first"));
  expect((await lastAudit()).details).toMatchObject({ had: false, has: true });

  await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "second"));
  expect((await lastAudit()).details).toMatchObject({ had: true, has: true });

  await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "   "));
  expect((await lastAudit()).details).toMatchObject({ had: true, has: false });
});

it("does not record the note text, which lives on the account", async () => {
  const admin = await seedAdmin();
  const target = await seedAccount(ctx.db);
  await ctx.db.transaction((tx) =>
    setStatusNote(tx, admin.id, target.id, "left the corp"),
  );
  expect(JSON.stringify((await lastAudit()).details)).not.toContain("left the corp");
});
```

The whitespace-only third call is not incidental: `setStatusNote` trims to `null` at line 107, so `"   "` is the clear path.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/admin-accounts.test.ts`

Expected: FAIL, `details` received as `null` for both actions.

- [ ] **Step 3: Add the payloads**

In `returnTierToAuto`, replace line 69 with:

```ts
  await logAudit(dbx, {
    actor,
    action: "tier.unlocked",
    target: accountId,
    details: { tier: acc.tier },
  });
```

In `setStatusNote`, replace line 110 with:

```ts
  await logAudit(dbx, {
    actor,
    action: "status.note_changed",
    target: accountId,
    // Whether a note changed, not what it says: the text lives on the account
    // where it is current, rather than frozen here at write time.
    details: { had: acc.statusNote !== null, has: value !== null },
  });
```

Both `acc` and `value` are already in scope from the `FOR UPDATE` read at line 105 and the trim at line 107.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/admin-accounts.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run format:check
npm run lint
npm run typecheck
```

```bash
git add src/services/admin-accounts.ts tests/admin-accounts.test.ts
git commit -m "feat(audit): record what tier.unlocked handed back and how a note changed

tier.unlocked records the tier automation was handed control of. The note
writer records added/replaced/cleared and deliberately not the note text,
which lives on the account where it is current."
```

---

### Task 5: Writers — `token.needs_reauth` records the scopes actually missing

**Files:**

- Modify: `src/jobs/token-health.ts:103` and `:116-123`
- Test: `tests/token-health-job.test.ts`

**Interfaces:**

- Consumes: Task 1's `"token.needs_reauth": [list("missingScopes", "missing", "scopes")]`.
- Produces: nothing later tasks depend on.

This is the action behind the 96 consecutive identical rows noted in PR #73's out-of-scope list; each of those rows currently carries zero bits. `missingScopes` is what distinguishes an app-wide scope change (every member, same missing scope) from one member's revocation.

Record what is missing, not what is required: the required set is config an operator can read, while the difference is the row's actual news.

- [ ] **Step 1: Write the failing test**

Add a case to `tests/token-health-job.test.ts` alongside the existing scope-shortfall test at line 105, which asserts the status transition and stays as it is. The test config's required scopes are `esi-characters.read_contacts.v1 esi-characters.write_contacts.v1` (`tests/helpers/config.ts:12`) and the identity is signed with only the read scope, so exactly the write scope is missing:

```ts
it("records which scopes are missing, not the whole required set", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, {
    id: 1,
    accountId: acc.id,
    main: true,
    refreshToken: "rt1",
    ownerHash: "oh-1",
  });
  const at = await signAccessToken({
    characterId: 1,
    ownerHash: "oh-1",
    scopes: ["esi-characters.read_contacts.v1"], // write scope missing
  });
  await runTokenHealthJob({
    db: ctx.db,
    cfg,
    jwks,
    fetchImpl: refreshFetchFor({ rt1: at }),
  });
  const audits = await ctx.db.select().from(auditLog);
  const row = audits.find((a) => a.action === "token.needs_reauth");
  expect(row?.details).toMatchObject({
    missingScopes: ["esi-characters.write_contacts.v1"],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/token-health-job.test.ts`

Expected: FAIL, `details` received as `null`.

- [ ] **Step 3: Compute the difference once and log it**

Replace line 103 with:

```ts
      const missingScopes = cfg.eveSso.scopes.filter((s) => !identity.scopes.includes(s));
      const covered = missingScopes.length === 0;
```

Leave the comment above it and the `nextStatus` line at 104 unchanged: `covered` keeps its meaning exactly, it is now derived from the difference rather than from an `every` over the same two arrays.

Replace the `logAudit` call at lines 117 to 121 with:

```ts
        await logAudit(db, {
          actor: "system",
          action: "token.needs_reauth",
          target: String(ch.id),
          // What is missing, not what is required: the required set is config
          // an operator can read, and the difference is what tells an app-wide
          // scope change apart from one member's revocation.
          details: { missingScopes },
        });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/token-health-job.test.ts`

Expected: PASS, including the existing coverage case at line 89 where full scopes yield `valid` and no row.

- [ ] **Step 5: Verify and commit**

```bash
npm run format:check
npm run lint
npm run typecheck
```

```bash
git add src/jobs/token-health.ts tests/token-health-job.test.ts
git commit -m "feat(audit): record which scopes a needs_reauth row is missing

These rows arrive in long identical runs and carried zero bits each. The
difference between required and held scopes is what distinguishes an app-wide
scope change from one member revoking consent."
```

---

### Task 6: Writers — `wanderer.removed` records the role that was revoked

**Files:**

- Modify: `src/jobs/wanderer.ts:56` and `:88-94`
- Test: `tests/wanderer-job.test.ts`

**Interfaces:**

- Consumes: Task 1's `"wanderer.removed": [labelled("role", "role")]`.
- Produces: nothing later tasks depend on.

A `cause` field would be a constant: the job knows only `diff.remove`, and the reason is always "not in the desired flygd set". The role held at removal records which permission level was revoked, and is what an admin needs to restore the entry if the removal turns out to have been wrong.

**Note what that role can and cannot be.** `diffAcl` (`src/core/acl-diff.ts:23-27`) excludes both `admin` and `blocked` from `remove`: admin entries are never removed, and removing a blocked entry would be equivalent to un-banning. So a `wanderer.removed` payload can only ever carry `manager`, `member` or `viewer`. The test below asserts that invariant at the job level, where the payload is written.

Building the id-to-role `Map` is the only new computation in this plan, and it is over a list the job has already fetched at line 43.

- [ ] **Step 1: Write the failing tests**

Add to `tests/wanderer-job.test.ts`, inside the existing `describe("runWandererJob", ...)`. These reuse the file's own `seedFlygdChar(id)` helper (line 74) and its `fakeWanderer(...)` fixture, which returns `{ client, members, reads }`:

```ts
it("records the role a removed member held", async () => {
  // 1 is desired (a flygd main); 2 is not, and holds an elevated grant.
  await seedFlygdChar(1);
  const w = fakeWanderer([
    { characterId: 1, role: "member" },
    { characterId: 2, role: "manager" },
  ]);
  await runWandererJob({ db: ctx.db, cfg, wanderer: w.client });
  const audits = await ctx.db.select().from(auditLog);
  const row = audits.find((a) => a.action === "wanderer.removed");
  expect(row?.target).toBe("2");
  expect(row?.details).toMatchObject({ role: "manager" });
});

it("never records a removal of an admin or blocked entry", async () => {
  // The invariant, asserted where the payload is written: diffAcl excludes
  // both roles from `remove` (src/core/acl-diff.ts:23-27), so no
  // wanderer.removed row can carry either. Removing a blocked entry would be
  // equivalent to un-banning. This is what stops a later "record a cause"
  // change from quietly widening what a removal row can say.
  await seedFlygdChar(1);
  const w = fakeWanderer([
    { characterId: 1, role: "member" },
    { characterId: 2, role: "admin" },
    { characterId: 3, role: "blocked" },
  ]);
  await runWandererJob({ db: ctx.db, cfg, wanderer: w.client });
  const audits = await ctx.db.select().from(auditLog);
  expect(audits.filter((a) => a.action === "wanderer.removed")).toHaveLength(0);
});
```

The dry-run case already asserts that no audit row is written at all and needs no change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/wanderer-job.test.ts`

Expected: the first FAILs with `details` received as `null`. The second should PASS already, since it asserts existing behaviour; keep it, because it is what stops a later "record a cause" change from quietly widening what a removal row can say.

- [ ] **Step 3: Hoist the entries and build the role map**

Replace line 56 with:

```ts
    const entries = characterEntries(members);
    // The role each member holds right now, from the list already fetched
    // above: which permission level a removal revoked is what an admin needs
    // to restore the entry if the removal turns out to have been wrong.
    const roleById = new Map(entries.map((m) => [m.characterId, m.role]));
    const diff = diffAcl({ desiredIds, members: entries });
```

Leave the post-mutation re-read at line 121 onward alone: it builds its own `characterEntries(observed)` from a different list and must keep doing so.

- [ ] **Step 4: Add the payload**

Replace the `logAudit` call at lines 89 to 93 with:

```ts
          await logAudit(db, {
            actor: "system",
            action: "wanderer.removed",
            target: String(id),
            details: { role: roleById.get(id) },
          });
```

`diff.remove` is built from `entries`, so every id here has a role in the map.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/wanderer-job.test.ts`

Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
npm run format:check
npm run lint
npm run typecheck
```

```bash
git add src/jobs/wanderer.ts tests/wanderer-job.test.ts
git commit -m "feat(audit): record the ACL role a wanderer removal revoked

A cause would be a constant here (always: not in the desired flygd set). The
role held at removal is the part an admin needs to restore the entry, and it
comes from the member list the job already fetched."
```

---

### Task 7: Full verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Inspect the whole diff against the spec**

```bash
git diff main...HEAD
```

Confirm against `docs/superpowers/specs/2026-08-04-audit-access-payloads-design.md`:

- No `drizzle/` migration and no `src/db/schema.ts` change. If either appears, stop: this plan requires neither.
- No change under `src/core/`.
- No change to any route, guard, or `page.tsx`.
- Exactly two `.json__peek` text assertions changed in `e2e/audit.spec.ts`, plus one added test. A third changed text assertion means a declaration went further than Task 1's table.
- No structural e2e assertion was modified or deleted. Verify from the diff rather than from a remembered total:

```bash
git diff main...HEAD -- e2e/ | grep -E '^-[^-]' | grep -E 'toHaveCount|tbody tr|log__empty' || echo "(empty = none touched)"
```

  Expected: `(empty = none touched)`. Only removed lines are inspected, so Task 1's added test is free to use its own `tbody tr` locator. `e2e/admin.spec.ts` should not appear in the diff at all.

- No em dashes in comments or user-visible copy, and no `--` as a dash substitute.

- [ ] **Step 2: Run the full suite and quote every result**

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
```

Expected: all pass. The unit baseline before this branch was 67 files / 710 tests; the count rises with the cases added here, and no previously-passing test may fail.

`npm test` uses the shared `:5433` Postgres and is not worktree-safe. If another session is using it, say so and report the check as not run rather than reporting a failure as this branch's.

After the e2e run, check `git status` for `tsconfig.json` and `AGENTS.md`; restore either with `git checkout --`, never by deleting.

- [ ] **Step 3: Check for scope expansion and leftovers**

```bash
git diff main...HEAD --stat
```

Expected files, and no others: `src/app/admin/audit/summarize.ts`, `src/services/accounts.ts`, `src/services/admin-accounts.ts`, `src/jobs/token-health.ts`, `src/jobs/wanderer.ts`, `tests/audit-summarize.test.ts`, `tests/accounts.test.ts`, `tests/admin-accounts.test.ts`, `tests/token-health-job.test.ts`, `tests/wanderer-job.test.ts`, `e2e/audit.spec.ts`, plus the spec and this plan.

Grep the diff for placeholders, `console.log`, `.only`, and `.skip`.

- [ ] **Step 4: Run the project's post-implementation gates**

This worktree contains no `CLAUDE.md`. The only instruction file checked in here is `AGENTS.md`, and it holds nothing but the Next.js rules block that `next dev` writes; it declares no gates. The gates below are therefore stated in full rather than referenced.

**Review.** Dispatch the repository's own reviewer, `.claude/agents/code-reviewer.md`, via the Agent tool with `subagent_type: "code-reviewer"`, over `git diff main...HEAD`. It is read-only and reports with `file:line` citations. It checks the invariants this branch sits closest to: an audit write on every state change, purity of `src/core/`, admin-guard coverage, migration safety, and the enqueue-don't-execute boundary. Two of those are live here. Every writer this branch touches already logged an audit row and must still log exactly one, with the payload as the only change; and no task may reach into `src/core/`.

**Then fix and re-verify.** Address whatever the review raises, then re-run the affected commands from Step 2 and quote their output. A review finding that is deliberate rather than a defect gets a one-line justification in the PR body, not a silent dismissal.

**Then write the completion explanation** covering: what changed, how a payload reaches the audit cell, the design decisions (undeclared-key remainder, the three combinator additions, deleting `admin.promoted` rather than emptying it, the `character.unlinked` lock ordering), deviations from this plan, the backward-compatibility behavior on rows written before the change, the exact verification run, and where a reviewer should look first. Task 1 is the highest-risk file, because it is the one change that alters what every already-persisted row renders as.

Do not claim completion until Step 2's five commands have been run and quoted.
