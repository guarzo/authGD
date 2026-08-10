# `/admin/audit` — critique

Register: product. Shots read before source: `10-audit-full.wide.png`,
`10-audit-full.narrow.png`, `09-audit-empty.wide.png`, `09-audit-empty.narrow.png`.

## What I saw before I opened anything

**Wide, 62 rows.** A title, a one-line explanation under it, a three-field filter
row, a rule reading `62 ENTRIES · as of 11:57 UTC`, and a five-column table:
At (UTC), Actor, Action, Target, Details. Thirteen rows, then the table's bottom
border, then void to the bottom of the frame. The count says 62. Thirteen are
drawn. Every visible row begins `2026-08-08` — the same eleven characters, thirteen
times, in the widest-looking column on the page. Every Details cell begins with a
`+`. Six of the thirteen Details cells read the identical string
`roleId=1284410981234567890, characterId=90000006`. The Target column mixes
person names, truncated UUIDs and a bare `90000007`. One action, `contact.sync_failed`,
is orange; everything else is the same weight and the same ink. The timestamps
ascend down the page — 17:31 at the top, 23:11 at the bottom — under a subtitle
that says "newest first".

**Narrow, 390px.** The At column becomes `42h ago` / `41h ago` / `41h ago` / `41h ago`
/ `40h ago` — fourteen rows carrying seven distinct values, two and three at a time.
The table is cut off mid-Target. Details is not on screen at all.

**Empty, wide.** The whole page occupies the top 520px of a 900px frame. A five-column
header row sits over one sentence, `Nothing has happened yet.`, and ~380px of void
below it.

## Timing the promise

PRODUCT.md's claim is that an admin answers *"why is this person's role wrong?"* in
under a minute. Traced against the 62-row shot:

**The path when the fork is taken correctly.** Read the head (3s). Type the member's
name into **Target**, press Filter (10s). Scan the Action column for `tier.changed`
or `discord.role_changed` (10s). Read that row's Details peek — `Member → Alumni,
alliance affiliation` (5s). **≈30 seconds.** The design does deliver, and the
`summarizeDetails` line is why: it puts the transition *and* the cause on one line
instead of making the admin open a payload. That works.

**The path most admins will take.** Actor is the first field, the first tab stop, and
"who did it" is the natural reading of "who changed this person's role". Type the name
there and you get that member's *self-service* history — the handful of things they did
to their own account — and none of the role changes, because every tier change and
every derole is written with `system` or an admin as actor and the member as target.
In the fixture that returns a non-empty set: `character.linked`, `token.invalidated`,
`payout.paid`. **≈20 seconds to a confident wrong answer**, with nothing on screen
saying the column was the wrong one.

The page knows about this asymmetry. It is documented at length at `page.tsx:461-470`
and there is a nudge for it — but the nudge lives at `page.tsx:425-434`, inside the
`rows.length === 0` branch. It fires only on the harmless failure. The dangerous one,
a plausible partial result, is silent.

---

## Findings

### 1. The actor/target trap warns only when it does no damage

**Severity:** Serious
**Where:** `src/app/admin/audit/page.tsx:416-435` (the nudge's branch), against
`page.tsx:471-485` (Actor is the first field)

**Cost:** An admin investigating why Rifter Pilot lost their tier types the name into
the first field, gets six real rows back, sees no tier change among them, and concludes
the log has nothing — while the row explaining the derole sits one column over. The
one failure mode this page exists to prevent is answering the question wrongly while
looking right, and the guard against it is wired to the one case where the admin
already knows something is off.

**Fix:** Hoist the asymmetry note out of the empty branch. When `actor` is set and
`target` is not, show it above the table on *every* result — including a full one:
"Showing what {name} did. Most entries about a member are on Target. [Search {name}
as a target]". The link and the copy already exist at `page.tsx:429-432`; the change is
the condition it hangs off. Cheaper alternative if that reads as too loud on the
correct path: on a name that resolves in *both* columns, say so in the rule aside
next to the count.

**Principle:** Error prevention over error recovery — the recovery only exists for the
error that recovers itself.

---

### 2. Eight of sixty-two rows at first paint, and no cue that the rest exist

**Severity:** Serious
**Where:** `src/app/globals.css:1792-1815` (`.scroller--tall` at 80svh),
`src/app/admin/audit/page.tsx:563` (`<Scroller label="Audit entries" tall>`)

The table region starts at y≈426 in the wide shot. `.scroller--tall` caps it at
80svh — 720px at a 900px viewport — so it ends at y≈1140, **240px below the fold**.
At 53px per row plus a 42px head, that is 8 rows visible on a 1440×900 screen while
the rule above says 62. The remaining 54 are inside a nested scrollbar on a page that
itself has only 343px of scroll, all of it dead: scrolling the page reveals the
region's bottom border and padding, not rows.

There is no affordance for the vertical overflow. `.scroller-fade--start` /
`--end` are the only fades (`globals.css:1108-1123`), both horizontal, and
`scroller.tsx`'s `atStart`/`atEnd` read `scrollLeft` only — so a region that
overflows vertically and fits horizontally hides both. On top of that,
`globals.css:1132-1134` suppresses the start fade entirely for `.log--sticky-col`,
which this table carries. The one remaining cue points sideways.

**Cost:** An admin scrolls the page looking for older entries, the page bottoms out
after a third of a screen, and they conclude they are at the end of the log. On macOS
and iOS, where overlay scrollbars draw nothing at rest, there is no pixel on screen
that says otherwise.

**Fix:** `globals.css:1842-1845` already solves this for `/admin/accounts` —
`max-height: min(80svh, max(18rem, 100svh - 29rem))`, so the region ends *inside* the
viewport. The comment at `globals.css:1817-1819` declines to share it with
`/admin/audit` because that page's "region sits under far less chrome". That premise
is measurably wrong: the accounts figure the comment quotes is 426px, and this page's
region top measures y≈426 in the wide shot. The two are the same number. Apply the same
subtraction (`.scroller--tall:has(.log--audit)`, or widen the existing selector) and
re-measure. Separately: give `Scroller` a vertical end-fade driven off `scrollTop`,
since it already measures `scrollHeight`/`clientHeight` at `scroller.tsx:52`.

**Principle:** Visibility of system status — a count that says 62 and a viewport that
shows 8 disagree, and the interface picks neither.

---

### 3. On a phone the answer is 424px to the right of where you are looking

**Severity:** Serious
**Where:** `src/app/globals.css:5242-5275` (narrow column widths), and the Details cell
at `src/app/admin/audit/page.tsx:675-689`

At 390px the four sized columns total 26.5rem = 424px against a ~358px region, with
column 1 pinned at 5rem. To reach Details — which is where the transition and the
cause live, i.e. the answer to "why" — you scroll the region right past At, Actor,
Action and Target, and it opens into 7.5rem (120px). `Member → Alumni, alliance
affiliation` does not survive 120px with `text-overflow: ellipsis`
(`globals.css:2124-2140`), so the phone reading of the answer column is a truncated
fragment plus a `+` to open the raw JSON payload.

The narrow shot confirms it: Details is not merely small, it is entirely absent from
the initial view, and nothing on screen names it.

**Cost:** The 1am phone check — the exact scenario this surface is read in — cannot
answer the question the page is for. The admin either gives up or opens 62 raw JSON
payloads one at a time.

**Fix:** Below 40rem, stop treating this as a five-column table. Promote the Details
summary to a second line under the Actor/Action pair inside the row (a `colspan` line,
or a stacked cell), so the answer and the action it belongs to are read together
without any horizontal scroll. Target and the absolute stamp can stay behind the
scroll — they are identifiers, not answers. If a stacked layout is too large a change,
the narrower version is to reorder the narrow column set so Details follows Action.

**Principle:** The primary content of a row should not be the part that requires the
most work to reach.

---

### 4. Pattern 2 — every row restates the date, and on narrow the pinned column carries the least information on the page

**Severity:** Moderate
**Where:** `src/app/admin/audit/page.tsx:35-37` (`stamp`), `page.tsx:617-624` (the At
cell), `src/app/_components/format-ago.ts` (`elapsedShort`)

`stamp()` prints the full `YYYY-MM-DD HH:MM:SS` on every row with no reference to the
set around it. In the wide shot all thirteen rows read `2026-08-08` — eleven of nineteen
characters, 58% of the cell, identical top to bottom, in a 12.25rem column. The page
already fixed the sibling case: `(UTC)` is said once in the header
(`page.tsx:583-586`) and restored per-row in `visually-hidden` text. The date is the
same fact and did not get the same treatment.

Narrow is the worse half. `elapsedShort` is hour-granular from 90 minutes to 48 hours
and day-granular beyond, so a page of rows from one afternoon collapses to a handful of
repeated values — the shot shows fourteen rows carrying seven, in pairs and triples
(`41h ago` three times running). That column is **pinned**: it is the one cell that never
scrolls away, holding 5rem of permanently-reserved width, and on a log more than two days
old every row in it says `3d ago`. It cannot even order two rows against each other.

**Cost:** An admin scanning for "the change that happened around the time the Discord
role vanished" reads the same eleven characters sixty-two times on desktop, and on a
phone gives up 5rem of a 358px region to a column that answers nothing.

**Fix:** `crewNorms` in `src/app/account/page.tsx` is the pattern. Compute the set's
date span once. If every row on the page falls on one date, put that date in the rule
aside beside the count ("62 entries · 2026-08-08 · as of 11:57 UTC") and render only
`HH:MM:SS` in the cells; where the page spans days, render the date only on the row
where it changes. Keep the full instant in the `visually-hidden` span that is already
there (`page.tsx:623`) so the accessible name loses nothing — the same parity rule
"Cadence (UTC)" uses on `/admin/sync`. On narrow, either give `formatAgo` a minute
tier past 90 minutes for same-day rows, or drop the elapsed form and render `HH:MM`
with the date said once above.

**Principle:** State the shared fact once; spend the column on what varies.

---

### 5. The answer is set in the dimmest ink on the page, in the last column, with nothing directing the eye to it

**Severity:** Moderate
**Where:** `src/app/globals.css:2124-2140` (`.json__peek`), against
`src/app/admin/audit/summarize.ts`

`.json__peek` — the line that renders `Member → Alumni, alliance affiliation`, the
sentence this whole page is built to deliver — takes `--ink-faint`, **`#90877e`**, at
`--t-detail` and weight 400. That is 5.61:1 on `--void` (`#0a0a0a`), so it clears AA
comfortably; this is not an accessibility failure. It is a hierarchy inversion. The
same page sets the Actor name at `--ink` (**`#ece7de`**, 16.08:1) and the timestamp,
the least varying value on the row, in full-strength mono. The answer is quieter than
the identifiers that lead to it.

Read the wide shot without reading any words: nothing pulls. Five columns, one weight,
one ink, sixty-two rows. The single exception is `contact.sync_failed` in
`--signal-warn` (**`#ff9f5f`**, 9.78:1) — and that one exception proves the mechanism
works, because it is the only thing on the page the eye finds unaided.

**Cost:** A scanning admin's eye lands on timestamps and names, which are the same on
every row, instead of on the six words that differ and matter.

**Fix:** Do not add colour — the gold ration and the `warn` reservation are both
correct as they stand. Move one step of ink instead: `.json__peek` to `--ink-dim`
(`#bab3a9`), and let the At cell drop to `--ink-faint`. That is a two-token swap that
inverts the current reading order without introducing a third signal. Consider also
giving Details more of the fixed-layout budget at the expense of column 1 once finding
4 shortens the stamp.

**Principle:** Visual weight should track information value.

---

### 6. The lede explains the table and restates itself, and asserts an ordering the query does not guarantee

**Severity:** Minor
**Where:** `src/app/admin/audit/page.tsx:444-447`

> "Every state change, append only, newest first. Nothing here can be edited or removed."

Two problems in nineteen words. First, "append only" and "nothing here can be edited or
removed" are the same statement twice — the second sentence is the first one's
definition. Second, "newest first" is asserted as a property of what is on screen, and
the query orders by `id` (`src/services/audit.ts:622`, `orderBy(desc(auditLog.id))`)
while the column the admin reads is `at`. Those agree for as long as rows are inserted
in clock order and no further.

The wide shot is what disagreement looks like: timestamps ascending, 17:31 to 23:11,
under copy promising the opposite. **That specific instance is a fixture artifact** —
`capture.spec.ts.txt:311` seeds row *i* at `now - i * 1_700_000`, so serial id ascends
as `at` descends, and `id desc` yields `at` ascending. It is not evidence that the
shipped page misorders. It is evidence that the page has no way to notice when it does,
and that the copy would keep making the claim regardless.

This is also the brief's explanatory-subtitle smell: a caption teaching the reader
what the table is.

**Fix:** Cut to one clause — "Append only. Nothing here can be edited or removed." —
and let the ordering be shown rather than promised (finding 4's date grouping does
that). If the ordering claim is worth keeping, order the query by `at desc, id desc`
so the claim and the sort key are about the same column.

**Principle:** Every word earns its place; do not promise in copy what the system does
not enforce.

---

### 7. "Why is this role wrong?" needs two queries because the action filter is one prefix

**Severity:** Minor
**Where:** `src/app/admin/audit/page.tsx:486-507` (the action field),
`src/services/audit.ts:603-607` (single `LIKE` prefix)

Role state lives under two namespaces: `tier.*` (the app's own tier) and `discord.*`
(the role that actually appears in the client). The filter takes one prefix, and the
datalist offers exactly those namespaces as separate options — so the admin runs the
query twice and holds the two result sets in their head, or filters by target alone and
scans both out of a mixed list.

**Cost:** The most common investigation on this page is the one the filter cannot
express in a single pass.

**Fix:** Cheapest version: leave the field alone and put the two queries one press
apart — when a target filter is set and no action filter is, offer two links in the
rule aside, "tier changes" and "Discord roles", each setting `action` and keeping the
target. That reuses `filterHref` and costs no query semantics.

---

## What is genuinely good and should survive

- **`summarizeDetails` and its `Part` vocabulary** (`summarize.ts`). The line
  `Member → Alumni, alliance affiliation` is the answer to the page's question in six
  words, and the `+N more` accounting means the summary never quietly drops a key.
  Making the summary *honest about being partial* rather than complete is the right
  call and it is rare. Do not let any of the fixes above shorten this line.
- **`(UTC)` said once in the header, restored per row in `visually-hidden`**
  (`page.tsx:583-586`, `617-624`). This is the exact fix finding 4 asks for, already
  built and already correct. It is the model, not a target.
- **`--signal-warn` on `_failed` actions, with the word `failed` carrying the same
  signal in text** (`isFailureAction`, `globals.css:4366-4368`). The only thing on the
  page the eye finds unaided, and colour is not the only channel.
- **The count label's `older` qualifier and the past-the-end exit**
  (`page.tsx:379-389`, `407-415`). "No older entries" plus a link back is a genuinely
  well-handled dead end, and the fact that `hasCursor` is judged in exactly one place
  so the heading and the pager cannot disagree is careful work.
- **Actor / Action / Target all clickable as filters, and the target name linking to
  the *name* rather than to that row's raw id** (`TargetCell`'s docblock,
  `page.tsx:136-141`). That one decision is what keeps a person's history from
  splintering across a uuid, a character id and a snowflake.
- **The unconditionally-mounted ambiguity `Notice`** (`page.tsx:550-552`). Correct
  live-region handling, and "actor X matches 2 accounts" is precisely the warning that
  stops this page answering wrongly while looking right — which is why finding 1 asks
  for the same treatment for the column asymmetry.

## What I could not evaluate

- **The pager, at any real page size.** The fixture is 62 rows against an
  `AUDIT_PAGE_SIZE` of 100, so `hasOlder` is false and `hasLatest` is false — neither
  pager renders in either shot. I could not see the duplicate-pager problem, the
  `100+ entries` heading, or what 100 rows of tab stops feels like. The known-open
  entry stands; I have nothing to add to it.
- **Interaction states.** Static shots only, no dev server. Hover, `:focus-visible`
  rings on the ~250 links a full page carries, the `Scroller` end-fade actually
  appearing, and whether opening a `<details>` mid-table shifts the rows below it are
  all unverified.
- **The real action vocabulary at density.** The fixture seeds `discord.role.added`,
  `acl.member.added`, `contact.sync_failed` and `payout.paid`, none of which exist in
  `PARTS` or in `NAMESPACE_TARGET_KIND` — so most Details cells in the shot fall to the
  generic `key=value` fallback and repeat `roleId=…, characterId=…` verbatim. That
  repetition is a seed artifact and I have not counted it against the page. What the
  Details column looks like across 100 rows of the *real* vocabulary, where most rows
  hit a declared `Part`, I could not see.
- **Contrast of `.json__peek` against the actual row background.** I measured against
  `--void` `#0a0a0a`; if rows paint on a lighter surface token the 5.61:1 figure moves
  slightly. It does not move far enough to change the finding, which is about hierarchy
  and not about the floor.

## Contested — settled taste I think is wrong

Nothing. Every settled-taste item this surface touches — the tight ramp below `--t-h2`,
the two-family split, no cards, gold rationed to one primary action (the Filter button
correctly declines it, `page.tsx:525-527`) — reads as right on this page, and the
`.st--ok`-style restraint that keeps `--signal-warn` reserved for the one row that
failed is why finding 5 asks for an ink swap rather than a colour.
