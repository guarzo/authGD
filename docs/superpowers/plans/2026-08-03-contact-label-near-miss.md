# Contact Label Near-Miss Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a member's in-game contact label differs from `STANDINGS_LABEL` only by letter case or surrounding whitespace, tell them both strings instead of telling them the label is missing.

**Architecture:** A new pure matcher in `src/core/` returns exact / near-miss / absent. The contacts job branches three ways instead of two, records a new `label_mismatch` result code, and persists the offending name in a new nullable `contact_sync_state.last_detail` column. The member and admin pages read that detail and quote it back. Sync behavior is unchanged — a near-miss still writes nothing.

**Tech Stack:** TypeScript, Next.js 15 App Router, Drizzle ORM + Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-03-contact-label-near-miss-design.md`

## Global Constraints

- **Migrations are generated, never hand-written.** Run `npm run db:generate` after a schema edit. Never edit a migration already applied in production.
- **`src/core/` is pure.** No I/O, no database, no clock, no `fetch`. Matching logic goes there; everything else stays out.
- **Never claim a command passed without running it.** Quote actual output for `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`.
- **Fold with `toLowerCase()`, never `toLocaleLowerCase()`.** The latter is locale-dependent (Turkish dotted-I) and the worker's locale is not pinned.
- **Exact match always wins** over any near-miss, even when both exist.
- **Stay in scope.** Do not add an attempt timestamp to `contact_sync_state`, do not move `STANDINGS_LABEL` out of secrets, do not rename or restructure anything the tasks below do not name. Both are noted as out of scope in the spec.
- Test database runs on **port 5433**: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test`. Start it with `docker compose -f docker-compose.dev.yml up -d` if it is not running.
- Test fixtures use label `"flygd"` (`tests/helpers/config.ts`), so near-miss fixtures use `"FLYGD"` / `"flygd "`.

---

### Task 1: Pure label matcher

**Files:**
- Create: `src/core/contact-label.ts`
- Test: `tests/contact-label.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `matchContactLabel(labels: Array<{ labelId: number; labelName: string }>, required: string): LabelMatch` and the exported type `LabelMatch = { kind: "exact"; labelId: number } | { kind: "near_miss"; candidates: string[] } | { kind: "absent" }`. Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

Create `tests/contact-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchContactLabel } from "@/core/contact-label";

const label = (labelId: number, labelName: string) => ({ labelId, labelName });

describe("matchContactLabel", () => {
  it("returns the exact match", () => {
    expect(matchContactLabel([label(7, "AuthGD")], "AuthGD")).toEqual({
      kind: "exact",
      labelId: 7,
    });
  });

  it("prefers an exact match over a fold-equal sibling", () => {
    expect(
      matchContactLabel([label(1, "AUTHGD"), label(2, "AuthGD")], "AuthGD"),
    ).toEqual({ kind: "exact", labelId: 2 });
  });

  it("reports a case-only difference as a near miss", () => {
    expect(matchContactLabel([label(7, "AUTHGD")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: ["AUTHGD"],
    });
  });

  it("reports leading and trailing whitespace as a near miss", () => {
    expect(matchContactLabel([label(7, "AuthGD ")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: ["AuthGD "],
    });
    expect(matchContactLabel([label(7, " AuthGD")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: [" AuthGD"],
    });
  });

  it("reports combined case and whitespace differences as a near miss", () => {
    expect(matchContactLabel([label(7, " authgd ")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: [" authgd "],
    });
  });

  it("returns every fold-equal candidate, sorted, rather than picking one", () => {
    expect(
      matchContactLabel([label(1, "authgd"), label(2, "AUTHGD")], "AuthGD"),
    ).toEqual({ kind: "near_miss", candidates: ["AUTHGD", "authgd"] });
  });

  it("tolerates whitespace in the configured value", () => {
    expect(matchContactLabel([label(7, "AUTHGD")], " AuthGD ")).toEqual({
      kind: "near_miss",
      candidates: ["AUTHGD"],
    });
  });

  it("is absent when nothing folds equal", () => {
    expect(matchContactLabel([label(7, "Blues")], "AuthGD")).toEqual({
      kind: "absent",
    });
  });

  it("is absent for an empty label list", () => {
    expect(matchContactLabel([], "AuthGD")).toEqual({ kind: "absent" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/contact-label.test.ts`
Expected: FAIL — cannot resolve `@/core/contact-label`.

- [ ] **Step 3: Write the implementation**

Create `src/core/contact-label.ts`:

```ts
export type LabelMatch =
  | { kind: "exact"; labelId: number }
  | { kind: "near_miss"; candidates: string[] }
  | { kind: "absent" };

/**
 * Case and surrounding whitespace are the two ways a member's label can be
 * wrong while looking right: the EVE client renders "AuthGD " and "AuthGD"
 * identically, and a case-only change to STANDINGS_LABEL once stranded every
 * member at `missing_label` with no way to see why. Folding both away is what
 * lets the job say which of the two strings is wrong.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the latter is locale-dependent
 * (Turkish dotted-I) and the worker's locale is not pinned.
 */
const fold = (s: string): string => s.trim().toLowerCase();

/**
 * An exact match ALWAYS wins, even when fold-equal siblings exist — the app
 * owns the exact label and must never be talked out of it by a near miss.
 * Absent an exact match, every fold-equal name is returned: two labels
 * differing only in case is a real state, and reporting it honestly is better
 * than picking one and writing contacts under a label nobody configured.
 */
export function matchContactLabel(
  labels: Array<{ labelId: number; labelName: string }>,
  required: string,
): LabelMatch {
  const exact = labels.find((l) => l.labelName === required);
  if (exact) return { kind: "exact", labelId: exact.labelId };

  const wanted = fold(required);
  const candidates = labels
    .filter((l) => fold(l.labelName) === wanted)
    .map((l) => l.labelName)
    .sort();

  return candidates.length > 0 ? { kind: "near_miss", candidates } : { kind: "absent" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/contact-label.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/contact-label.ts tests/contact-label.test.ts
git commit -m "feat(core): match contact labels that differ only by case or whitespace"
```

---

### Task 2: Persist the offending name

**Files:**
- Modify: `src/db/schema.ts` (the `contactSyncState` table, ~line 137)
- Create: `drizzle/0004_*.sql` (generated — do not hand-write)

**Interfaces:**
- Consumes: nothing.
- Produces: `contactSyncState.lastDetail` (`text("last_detail")`, nullable). Tasks 3 and 4 read and write it.

- [ ] **Step 1: Add the column**

In `src/db/schema.ts`, add one line to `contactSyncState`:

```ts
export const contactSyncState = pgTable("contact_sync_state", {
  characterId: bigint("character_id", { mode: "number" })
    .primaryKey()
    .references(() => character.id),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastResult: text("last_result"),
  /**
   * Free-text context for `lastResult` — currently the label name(s) actually
   * found on the character when `last_result = 'label_mismatch'`. Nullable and
   * ALWAYS written (null when inapplicable): `recordResult` does a partial
   * upsert, so a column left out of the set keeps its old value, and a member
   * who fixed their label would keep a stale name in the UI forever.
   */
  lastDetail: text("last_detail"),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0004_<name>.sql` containing `ALTER TABLE "contact_sync_state" ADD COLUMN "last_detail" text;`

- [ ] **Step 3: Verify the generated SQL is additive only**

Read the generated file. It must contain exactly one `ADD COLUMN` and **no** `DROP`, no `NOT NULL`, no `DEFAULT`, and must not touch any other table. If it contains anything else, stop — the schema edit was wrong, not the generator.

- [ ] **Step 4: Apply it to the test database and confirm the suite still passes**

```bash
docker compose -f docker-compose.dev.yml up -d
npm test
```

Expected: PASS, no new failures. The existing suite does not reference `last_detail`; this proves the column is inert.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add contact_sync_state.last_detail"
```

---

### Task 3: Branch the contacts job three ways

**Files:**
- Modify: `src/jobs/contacts.ts` — `recordResult` (~lines 37-51) and the label lookup (~lines 120-127)
- Test: `tests/contacts-job.test.ts`

**Interfaces:**
- Consumes: `matchContactLabel`, `LabelMatch` (Task 1); `contactSyncState.lastDetail` (Task 2).
- Produces: the result code `"label_mismatch"`, with `last_detail` set to the found name(s) joined by `", "`. Task 5 renders both.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contacts-job.test.ts`, inside the existing `describe("runContactsJob", ...)` block. These reuse the file's existing `fakeEsi`, `lastResult`, `okToken`, `seedAccount`, and `seedCharacter` helpers:

```ts
it("records label_mismatch with the found name and writes nothing", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
  const { esi, calls } = fakeEsi({
    labels: { 1: [{ labelId: LABEL_ID, labelName: "FLYGD" }] },
  });
  await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });

  const row = await lastResult(1);
  expect(row?.lastResult).toBe("label_mismatch");
  expect(row?.lastDetail).toBe("FLYGD");
  expect(row?.lastSyncedAt).toBeNull();
  expect(calls.adds).toEqual([]);
  expect(calls.edits).toEqual([]);
  expect(calls.deletes).toEqual([]);
});

it("reports every fold-equal candidate rather than picking one", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
  const { esi } = fakeEsi({
    labels: {
      1: [
        { labelId: 1, labelName: "FLYGD" },
        { labelId: 2, labelName: "flygd " },
      ],
    },
  });
  await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
  expect((await lastResult(1))?.lastDetail).toBe("FLYGD, flygd ");
});

it("still records missing_label when no label is even close", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
  const { esi } = fakeEsi({ labels: { 1: [{ labelId: 9, labelName: "Blues" }] } });
  await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });

  const row = await lastResult(1);
  expect(row?.lastResult).toBe("missing_label");
  expect(row?.lastDetail).toBeNull();
});

it("clears a stale detail once the member fixes the label", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });

  const bad = fakeEsi({ labels: { 1: [{ labelId: LABEL_ID, labelName: "FLYGD" }] } });
  await runContactsJob({ db: ctx.db, cfg, esi: bad.esi, fetchImpl: okToken });
  expect((await lastResult(1))?.lastDetail).toBe("FLYGD");

  const good = fakeEsi({ labels: { 1: [{ labelId: LABEL_ID, labelName: "flygd" }] } });
  await runContactsJob({ db: ctx.db, cfg, esi: good.esi, fetchImpl: okToken });

  const row = await lastResult(1);
  expect(row?.lastResult).toBe("ok");
  expect(row?.lastDetail).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contacts-job.test.ts`
Expected: FAIL — the near-miss cases record `missing_label`, and `lastDetail` does not exist on the row type.

- [ ] **Step 3: Thread the detail through `recordResult`**

In `src/jobs/contacts.ts`, replace `recordResult` with:

```ts
/**
 * `detail` is written on EVERY path, null included. The upsert sets only the
 * columns named here, so omitting it on the success path would leave a fixed
 * member staring at the name they already corrected.
 */
async function recordResult(
  dbx: Dbx,
  characterId: number,
  result: string,
  synced: boolean,
  detail: string | null = null,
): Promise<void> {
  const set = synced
    ? { lastResult: result, lastDetail: detail, lastSyncedAt: new Date() }
    : { lastResult: result, lastDetail: detail };
  await dbx
    .insert(contactSyncState)
    .values({ characterId, ...set })
    .onConflictDoUpdate({ target: contactSyncState.characterId, set });
}
```

- [ ] **Step 4: Replace the two-way label check with a three-way branch**

Add the import at the top of `src/jobs/contacts.ts`:

```ts
import { matchContactLabel } from "@/core/contact-label";
```

Replace this block:

```ts
        const labels = await esi.getContactLabels(target.characterId, token.accessToken);
        const label = labels.find((l) => l.labelName === cfg.standings.label);
        if (!label) {
          counts.skipped++;
          await recordResult(db, target.characterId, "missing_label", false);
          continue;
        }
```

with:

```ts
        const labels = await esi.getContactLabels(target.characterId, token.accessToken);
        const match = matchContactLabel(labels, cfg.standings.label);
        if (match.kind !== "exact") {
          counts.skipped++;
          // A near miss is reported, never accepted: diffContacts DELETES every
          // contact under the matched label that leaves the desired set, so that
          // authority stays bound to the exact configured name.
          await recordResult(
            db,
            target.characterId,
            match.kind === "near_miss" ? "label_mismatch" : "missing_label",
            false,
            match.kind === "near_miss" ? match.candidates.join(", ") : null,
          );
          continue;
        }
```

Then update the two later uses of `label.labelId` in the same block to `match.labelId` — one in the `diffContacts({ ... labelId: label.labelId, ... })` call, one in the `addContacts(..., [label.labelId])` call. Leave the `groups` loop alone; it already uses `g.labelIds`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contacts-job.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/contacts.ts tests/contacts-job.test.ts
git commit -m "feat(contacts): record label_mismatch with the name actually found"
```

---

### Task 4: Surface the detail through the view layer

**Files:**
- Modify: `src/services/account-view.ts` — `AccountView` character type (~line 132), its mapping (~line 186), `AdminCharacterRow` (~line 200), its mapping (~line 272)
- Test: `tests/account-view.test.ts`

**Interfaces:**
- Consumes: `contactSyncState.lastDetail` (Task 2), the `label_mismatch` code (Task 3).
- Produces: `contactSyncDetail: string | null` on both the member character rows and `AdminCharacterRow`. Task 5 renders it.

- [ ] **Step 1: Write the failing test**

Add to `tests/account-view.test.ts`:

```ts
it("surfaces the label detail on the member view", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
  await ctx.db.insert(contactSyncState).values({
    characterId: 1,
    lastResult: "label_mismatch",
    lastDetail: "FLYGD",
  });

  const view = await getAccountView(ctx.db, cfg, acc.id);
  const ch = view.characters.find((c) => c.id === 1);
  expect(ch?.contactSyncResult).toBe("label_mismatch");
  expect(ch?.contactSyncDetail).toBe("FLYGD");
});

it("leaves the detail null when there is nothing to report", async () => {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id, main: true });
  await ctx.db
    .insert(contactSyncState)
    .values({ characterId: 2, lastResult: "ok", lastDetail: null });

  const view = await getAccountView(ctx.db, cfg, acc.id);
  expect(view.characters.find((c) => c.id === 2)?.contactSyncDetail).toBeNull();
});
```

If `contactSyncState` is not already imported in that test file, add it to the existing `@/db/schema` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/account-view.test.ts`
Expected: FAIL — `contactSyncDetail` does not exist on the returned type.

- [ ] **Step 3: Add the field to both projections**

In `src/services/account-view.ts`, in the `AccountView` character array type, immediately after `contactSyncResult: string | null;`:

```ts
    /** Context for `contactSyncResult` — the label name(s) actually found when
     *  the result is `label_mismatch`, else null. */
    contactSyncDetail: string | null;
```

In `getAccountView`'s `chars.map(...)`, immediately after the `contactSyncResult` line:

```ts
      contactSyncDetail: syncByChar.get(c.id)?.lastDetail ?? null,
```

Make the same two additions to `AdminCharacterRow` and its mapping further down the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/account-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/account-view.ts tests/account-view.test.ts
git commit -m "feat(account-view): expose the contact sync detail"
```

---

### Task 5: Quote both strings back to the member

**Files:**
- Modify: `src/app/account/page.tsx` — `contactsNoteApplies` (~line 39), `ContactState` (~lines 54-82), the `<ContactState .../>` call site (line 262)
- Modify: `src/app/admin/accounts/page.tsx:261`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `contactSyncDetail` (Task 4), the `label_mismatch` code (Task 3).
- Produces: no exports.

- [ ] **Step 1: Add the literal-string style**

In `src/app/globals.css`, next to the existing `code {` rule (~line 131):

```css
/* A string quoted back to the member for character-by-character comparison.
   `pre` is load-bearing: HTML collapses whitespace, so without it "AuthGD "
   and "AuthGD" render identically and a trailing-space member sees two
   strings that look the same — the exact bug this message exists to fix. */
code.literal {
  white-space: pre;
}
```

- [ ] **Step 2: Exclude the new code from the generic column note**

In `src/app/account/page.tsx`, update `contactsNoteApplies`:

```ts
function contactsNoteApplies(result: string | null) {
  return result !== "ok" && result !== "missing_label" && result !== "label_mismatch";
}
```

Update its doc comment above to read `"ok", "missing_label", and "label_mismatch" get bespoke treatment` so the comment matches the code.

- [ ] **Step 3: Render the mismatch branch**

In `ContactState`, add a `detail` prop and a branch immediately after the existing `missing_label` branch:

```tsx
function ContactState({
  result,
  detail,
  label,
  target,
}: {
  result: string | null;
  detail: string | null;
  label: string;
  target: boolean;
}) {
```

```tsx
  if (result === "label_mismatch") {
    return (
      <>
        <Status tone="warn">label mismatch</Status>
        <span className="dim">
          {detail ? (
            <>
              Your label is named <code className="literal">{`"${detail}"`}</code>. It
              must be exactly <code className="literal">{`"${label}"`}</code> —
              capitalization and spaces both count. Rename it in game, then re-sync.
            </>
          ) : (
            <>
              A label differing only in capitalization or spacing exists. It must be
              exactly <code className="literal">{`"${label}"`}</code> — rename it in
              game, then re-sync.
            </>
          )}
        </span>
      </>
    );
  }
```

The quotes are part of the rendered text, not decoration: they delimit the value so a leading or trailing space is visible against them. The `detail`-absent fallback covers rows written before this ships.

- [ ] **Step 4: Pass the detail at the call site**

At `src/app/account/page.tsx:262`, the existing call is:

```tsx
                      <ContactState
                        result={c.contactSyncResult}
                        label={cfg.standings.label}
                        target={c.contactsTarget}
                      />
```

Add one prop:

```tsx
                        detail={c.contactSyncDetail}
```

- [ ] **Step 5: Show it to admins too**

In `src/app/admin/accounts/page.tsx`, replace line 261:

```tsx
                  {c.contactSyncResult &&
                    ` · contacts: ${c.contactSyncResult}${
                      c.contactSyncDetail ? ` ("${c.contactSyncDetail}")` : ""
                    }`}
```

- [ ] **Step 6: Verify the whole suite, types, and lint**

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all PASS. Quote the output.

- [ ] **Step 7: Commit**

```bash
git add src/app/account/page.tsx src/app/admin/accounts/page.tsx src/app/globals.css
git commit -m "feat(account): name the mis-cased label instead of calling it missing"
```

---

### Task 6: Document the trap that caused the incident

**Files:**
- Modify: `docs/ops.md` — the "Contact label — use a dedicated one" section (~line 361)

**Interfaces:** none.

- [ ] **Step 1: Add the case-change warning**

In the three-bullet list under that heading, replace the existing "The match is exact and case-sensitive" bullet with:

```markdown
- **The match is exact and case-sensitive** (`src/jobs/contacts.ts`), so
  `authgd` ≠ `AuthGD`. A typo skips rather than deletes.
- **A case-only change strands every existing member at once.** The label id is
  re-resolved from the name each run, so recapitalizing `STANDINGS_LABEL`
  instantly stops matching every label that was correct under the old value.
  This happened on 2026-08-03: eight of ten characters dropped to
  `label_mismatch` in one run. Members must rename their label in game before
  their sync resumes — announce the change before making it, and expect to
  field reports from anyone who does not notice the difference on screen.
```

- [ ] **Step 2: Verify formatting**

Run: `npm run format:check`
Expected: PASS. If it fails on `docs/ops.md`, run `npm run format` and re-check.

- [ ] **Step 3: Commit**

```bash
git add docs/ops.md
git commit -m "docs(ops): warn that a case-only STANDINGS_LABEL change strands members"
```

---

### Task 7: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the complete suite**

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run test:e2e
```

Expected: all PASS. Quote each result — do not assert a pass without output.

- [ ] **Step 2: Check for e2e side effects before committing**

`next dev` rewrites `tsconfig.json` and generates `AGENTS.md` during e2e runs, which fails CI's format check if committed blindly.

```bash
git status --porcelain
git diff -- tsconfig.json
```

Restore `tsconfig.json` if e2e mutated it: `git checkout -- tsconfig.json`. Do not `git add -A`.

- [ ] **Step 3: Review the full diff against the spec**

```bash
git diff main...HEAD
```

Confirm: no attempt-timestamp column, no `STANDINGS_LABEL` relocation, no unrelated renames, no debug output, no placeholder text.

---

## Post-implementation

Per `CLAUDE.md`, after the tasks above and before any "done" claim:

1. `code-reviewer` agent on the diff.
2. `my:polish-core --fix`, then inspect its edits and re-run whatever verification they affect.
3. `my:change-explainer` (routine non-trivial — omit the five knowledge-check questions).

## Deployment note

The migration is additive and nullable, and `fly.toml` runs `npm run db:migrate` as a release command before the new image serves, so the ordering is safe in both directions. **After deploying**, the eight currently-stranded characters keep `missing_label` until the next contacts run (`5 * * * *`), which will re-record them as `label_mismatch` with their actual label names.
