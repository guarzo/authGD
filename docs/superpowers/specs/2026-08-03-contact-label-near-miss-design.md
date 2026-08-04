# Contact label near-miss detection

**Status:** design — pending review
**Problem origin:** production incident, 2026-08-03

## The incident this comes from

`STANDINGS_LABEL` was changed from `AUTHGD` to `AuthGD` — a case-only edit. The
contacts job matches the label name exactly (`src/jobs/contacts.ts:123`), so
every member whose in-game label had been correct under the old value stopped
matching in the next run. Eight of ten characters landed on `missing_label` and
stayed there.

The account page then told each of them:

> Create a contact label named `AuthGD` in game, then re-sync.

They looked in game, saw a label reading `AUTHGD`, and read it as the same
string. One member renamed the label, could not tell the difference on screen,
and reported that the fix had not worked — it had; a stale-looking verdict and
an indistinguishable string hid it.

The failure mode is not that the app got the match wrong. It is that the app
knew exactly what was wrong and did not say it.

## Outcome

When a member's label differs from `STANDINGS_LABEL` only by letter case or
surrounding whitespace, the app names both strings and tells them to rename.
Sync behavior does not change: a near-miss still writes nothing.

## Decisions

**The app never guesses which label the member meant.** A near-miss is reported,
not accepted. `diffContacts` *deletes* every contact carrying the matched label
that leaves the desired set (`src/core/contacts-diff.ts`), so binding that
destructive authority to a label the operator did not configure is a larger
change than fixing a confusing message. Considered and rejected: matching
case-insensitively.

**Whitespace is in scope alongside case.** A trailing space renders identically
to no trailing space in the EVE client, so it produces the same "I made the
label and it says missing" report, and is strictly less visible than wrong case.
Folding with `.trim().toLowerCase()` covers both in one comparison.

**The found name is persisted and shown.** The entire failure is that the wrong
string is invisible; a message that cannot quote it back solves half the
problem. This costs a nullable column.

## Design

### Matching — `src/core/contact-label.ts`

A pure function, consistent with `src/core/contacts-diff.ts`:

```ts
export type LabelMatch =
  | { kind: "exact"; labelId: number }
  | { kind: "near_miss"; candidates: string[] }
  | { kind: "absent" };

export function matchContactLabel(
  labels: Array<{ labelId: number; labelName: string }>,
  required: string,
): LabelMatch;
```

Rules:

- **Exact match always wins**, even when other labels also fold to the required
  name. Only when no exact match exists is folding considered.
- Fold is `s.trim().toLowerCase()`. `toLowerCase`, not `toLocaleLowerCase` —
  the latter is locale-dependent (Turkish dotted-I) and the worker's locale is
  not pinned.
- **All** folded-equal names are returned as candidates, sorted for
  deterministic output. Two labels differing only in case is a real state and
  is reported honestly rather than resolved by picking one.
- No fold-equal names → `absent`, the existing `missing_label` behavior.

### Job — `src/jobs/contacts.ts`

The truthiness check at line 123 becomes a three-way branch. `exact` proceeds
into the existing diff path unchanged. `absent` records `missing_label` exactly
as today. `near_miss` records a new result code `label_mismatch` and skips every
write, incrementing `skipped` like `missing_label` does.

`recordResult` gains a `detail: string | null` parameter and **always writes
it** — `null` on every path that is not a near-miss. This is deliberate: the
function does a partial `onConflictDoUpdate`, so a column omitted from the set
keeps its previous value. A member who fixes their label would otherwise keep a
stale "you have `AUTHGD`" in the UI forever.

Candidates are stored joined with `", "`.

### Schema

One additive column on `contact_sync_state` (`src/db/schema.ts:137`):

```ts
lastDetail: text("last_detail"),
```

Nullable, no default, no backfill. Generated with `npm run db:generate` — never
hand-written. Safe to deploy: `fly.toml`'s `release_command` runs migrations
before the new image serves, and the pre-existing code ignores an unread
nullable column.

### Member UI — `src/app/account/page.tsx`

A new `ContactState` branch for `label_mismatch`:

> **label mismatch** — Your label is named `"AUTHGD"`. It must be exactly
> `"AuthGD"` — rename it in game, then re-sync.

Both strings render inside `<code>` elements that are **wrapped in literal
quotes and styled `white-space: pre`**. Without this the fix reproduces the bug
it is fixing: HTML collapses whitespace, so `AuthGD ` and `AuthGD` would render
identically and a trailing-space member would again see two strings that look
the same. The quotes delimit the value so a leading or trailing space is
visible against them.

`contactsNoteApplies` (`src/app/account/page.tsx:39`) must gain `label_mismatch`
to its exclusion list. It currently excludes only `"ok"` and `"missing_label"`,
so a new code would show the generic column note *and* the bespoke message.

Label names are member-authored free text. React escapes on render, so there is
no injection concern; the value is displayed, never interpolated into markup.

### Admin UI — `src/app/admin/accounts/page.tsx`

Line 261 renders the raw code. Append the detail when present, so an admin
fielding a report sees the offending string without opening a database session:
`contacts: label_mismatch ("AUTHGD")`.

### Data flow

`contactSyncResult` already flows through `getAccountView` and
`AdminCharacterRow` (`src/services/account-view.ts:186,272`).
`contactSyncDetail` is added alongside it in both, read from the same
`syncByChar` map.

## Testing

**Core (`tests/contact-label.test.ts`)** — table-driven, no I/O: exact match
wins over a fold-equal sibling; case-only difference; leading and trailing
whitespace; combined case + whitespace; two fold-equal candidates both
returned; unrelated labels → absent; empty label list → absent.

**Job (`tests/contacts-job.test.ts`)** — extends the existing fake ESI: a
near-miss label records `label_mismatch` with the found name in `last_detail`,
performs **no** add/edit/delete calls, and does not set `last_synced_at`; a
successful run **clears** `last_detail` to null; `missing_label` is unchanged
for a genuinely absent label.

**View (`tests/account-view.test.ts`)** — the detail is surfaced on both the
member and admin projections.

Verification: `npm test`, `npm run typecheck`, `npm run lint`, and
`npm run test:e2e`, each quoted in the completion report rather than asserted.

## Docs

`docs/ops.md:361` warns that changing `STANDINGS_LABEL` leaves old contacts
unmanaged. It does not say that a **case-only** change instantly strands every
member whose label was previously correct, because the id is re-resolved from
the name each run and the old name no longer matches. That is the trap this
incident hit; it goes in that section.

## Explicitly out of scope

- **No attempt timestamp on `contact_sync_state`.** It has `last_synced_at`
  (written on success only) and `last_result`. `recordResult` is reached only
  for characters returned by `getFlygdCharacters` (`src/services/desired.ts:34`,
  filtering `tier = 'flygd'` and `affiliation_invalid = false`), so a character
  leaving that set keeps its last verdict indefinitely with nothing in the UI
  marking it stale. Real defect, found while debugging this incident, unrelated
  to label matching. Separate change.
- **Notifying the eight currently-stranded members.** This ships a better
  message; it does not reach out. They are told out-of-band or on next login.
- **Making `STANDINGS_LABEL` a `fly.toml` `[env]` value** rather than a secret.
  It is not sensitive and would be more reviewable in git. Unrelated.
