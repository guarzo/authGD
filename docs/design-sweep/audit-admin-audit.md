# audit — /admin/audit

Register: product. Read in full: `src/app/admin/audit/page.tsx` (679),
`src/app/admin/audit/summarize.ts`, `src/app/_components/ui.tsx`,
`format-ago.ts`, `relative-time.tsx`, `scroller.tsx`, `submit.tsx`,
`submit-guard.ts`, `focus-heading.tsx`, `utc-time.ts`, `e2e/audit.spec.ts`, and
the `.log`, `.log--audit`, `.log--sticky-*`, `.scroller*`, `.json*`,
`.filter-form*`, `.notice*`, `.dim`, `.only-*` rules in `globals.css`. Contrast
figures below are computed from the OKLCH tokens, not eyeballed.

## Findings

### 1. Below 640px the Details column is 120px wide and the payload is shredded

- **Severity:** serious
- **Where:** `src/app/globals.css:3270-3301`, `src/app/_components/ui.tsx:302-311`, `src/app/globals.css:1241-1282`
- **Cost:** An admin checking on a phone why someone's role is wrong opens the one cell that holds the answer and gets a 15-character-wide ribbon of JSON with `"alliance_left"` broken across three lines, and the collapsed peek above it truncates with no `title` to recover from.
- **Principle:** PRODUCT.md purpose ("An admin can answer 'why is this person's role wrong?' from the audit log in under a minute"); PRODUCT.md principle 3.
- **Fix:** The narrow block's stated bound is real — 34rem floor minus 26.5rem of sized columns leaves Details 7.5rem — but 120px minus 8px padding is ~14 monospace characters at 0.75rem, which is below the width at which a wrapped payload is readable. Two concrete options, in order of preference: (a) at `max-width: 40rem`, let the *opened* `.json__full` escape its column the way `.log__empty-text` already escapes its colSpan cell — `position: sticky; left: 0; display: block; max-width: calc(100vw - 2 * var(--s-5))` — so the disclosure opens into the scroller's visible width instead of into the column's 112px content box; (b) failing that, add `title={summarizeDetails(...)}` to the `<summary>` in `Json` so the truncated peek has the same recovery every `.ellipsis-cell` in this table already has. The narrow docblock at `globals.css:3260-3264` argues the shrink is safe *because* "every one of them is an `.ellipsis-cell` with the full value in `title`" — Details is the one column that sentence does not cover, and it is the column carrying the answer.

### 2. From 1056px down, the exact instant leaves the screen with no way for a sighted admin to get it back

- **Severity:** serious
- **Where:** `src/app/admin/audit/page.tsx:593-601`, `src/app/globals.css:3086-3122`, `src/app/_components/format-ago.ts:8-16`, `src/app/_components/utc-time.ts:11-13`
- **Cost:** An admin in a 1000px browser window trying to establish the order of two role changes, or the exact minute a token died, reads "3d ago" on both rows and has nowhere to go: the ISO stamp is `display: none`, the exact instant exists only in a `.visually-hidden` span, the `<td>` carries no `title`, and the page's own freshness anchor is `as of 14:32 UTC` with no date in it.
- **Principle:** none — this is the surface not doing the job it exists for.
- **Fix:** Add the stamp as a `title` on the `.only-narrow` `<time>` (or on the `<td>`): `title={`${stamp(r.at)} UTC`}`. This is exactly the convention every other cell in this table already uses, it costs no layout, and it does not disturb the accessibility tree (the visually-hidden restatement stays; `title` is redundant to it for AT and is the *only* channel for a mouse). Worth engaging separately: the swap was argued at `page.tsx:575-583` from the 320px reflow case, where dropping a 19ch stamp out of a 286px region is plainly right. The 66rem extension at `globals.css:3030-3085` is argued purely from horizontal-scroll arithmetic and never asks whether a laptop-window reader still needs the instant. It does — 641px to 1056px is a docked window, not a phone. I think the extension is right and the missing `title` is the defect, not the breakpoint.

### 3. `RawId` sits inside the anchor, so one filter link is announced under three different names

- **Severity:** serious
- **Where:** `src/app/admin/audit/page.tsx:63-65, 99-107, 136-146`; contrast with `src/app/_components/ui.tsx:134-142`
- **Cost:** A screen-reader admin scanning the log hears a 36-character UUID read out after every name in every one of 100 rows — 200 recitations per page — and the same destination `/admin/audit?target=Zed` announces as "Zed (id 4f2c-…)", "Zed (id 2114567890)" and "Zed (id 390…)" on three different rows, because `targetKind` can be `account`, `character` or `discord` for one person (`src/services/audit.ts:248-275`) while `filterHref` builds the href from the *name*.
- **Principle:** WCAG 2.2 3.2.4 Consistent Identification. The repo already cites 3.2.4 for precisely this shape: `ui.tsx:134-142` refuses to put the nav badge count inside the link for the same reason.
- **Fix:** Move `<RawId>` out of the `<a>` and into the `<td>` as a sibling, or wire it with `aria-describedby` the way the nav badge is. The docblock at `page.tsx:52-62` argues correctly that the id is genuinely different information and must not live only in `title`; that argument is intact either way. What it does not engage is that placing it *inside* the anchor folds it into the link's accessible **name** rather than making it available as row text. The badge comment's objection to a bare sibling ("screen-reader link navigation would skip it entirely") does not transfer: the id is wanted while reading the row, not while jumping link to link — jumping link to link is exactly when it is noise. Note that `e2e/audit.spec.ts:42` matches `/^Zed\b/`, so the id being in the name is currently tolerated by the suite rather than asserted; only its *visual* absence is pinned (line 52).

### 4. The ambiguity warning cannot announce, and the caption that could is spent restating the region label

- **Severity:** moderate
- **Where:** `src/app/admin/audit/page.tsx:526-528, 541`, `src/app/_components/ui.tsx:241-292`, `src/app/_components/scroller.tsx:82-84`
- **Cost:** A screen-reader admin filters `target: Zed`, gets a union of two unrelated people's histories, and is told so only if they happen to read linearly past the count heading — jumping by heading or by table lands them straight in rows that silently answer the wrong question. Meanwhile they hear "Audit entries, region" immediately followed by "Audit log entries, table" — the same six words twice, on the one page where two identifiers per row are already being read out.
- **Principle:** PRODUCT.md principle 2 ("State before action" — every screen answers what is true right now); WCAG 2.2 1.3.1 for the union case is a stretch, so: none.
- **Fix:** Two parts. (a) `{ambiguityNotes.length > 0 && <Notice tone="warn">…}` is the exact `&&` shape `Notice`'s own docblock (`ui.tsx:249-260`) forbids — and on this page it is worse than the docblock says, because the form is `method="get"` and every filter is a full document load, so a `role="status"` present at parse time announces nothing at all on any AT. Mount it unconditionally (`<Notice tone="warn">{ambiguityNotes.join(" · ")}</Notice>` — the empty slot is what the primitive is built for) so at least the live region is real when the page is reached by soft navigation, and stop relying on it for the announcement. (b) Make the `<caption>` carry what the region label cannot: `` `Audit log entries${filtered ? ` — ${activeFilters.join(" · ")}` : ""}${ambiguityNotes.length ? ` — ${ambiguityNotes.join(" · ")}` : ""}` ``. A caption is announced on table entry, which is the moment the reader is about to consume the rows the note is about, and it costs nothing visually.

### 5. `.dim` on the action prefix changes font size mid-token in the column an admin scans down

- **Severity:** moderate
- **Where:** `src/app/admin/audit/page.tsx:628`, `src/app/globals.css:1315-1329`
- **Cost:** An admin running their eye down the Action column to find the one entry that is off gets `tier.` at 13px and `set` at 14px inside one word, so the post-dot segment — the part that differs between rows — starts at a different x on every row and the monospace column stops being a column.
- **Principle:** DESIGN.md's own recorded finding. `globals.css:1320-1329` says in as many words: "The audit found several data cells reaching for `.dim` and getting a size change with it; this is the class they should take instead," and declares `.dim-ink` for it. The class exists and is unreferenced.
- **Fix:** `className="dim-ink"` on `page.tsx:628`. **Do not** blanket-swap the other `.dim` sites on this page: at `page.tsx:596` the `<time className="ago dim mono">` sits in the 5rem pinned column at `max-width: 40rem`, and `.dim`'s 13px is what makes "365d ago" fit its 72px content box (see finding 9). `page.tsx:89` and `:151` (`mono dim` on `system` and on a literal target) are whole-cell and defensible either way, but they do make `system` render a step smaller than a resolved name in the same column.

### 6. The Details peek is the quietest text in the row, and its own `+` marker is the loudest

- **Severity:** moderate
- **Where:** `src/app/globals.css:1241-1257`, `2340-2361`
- **Cost:** An admin scanning for the one wrong tier transition reads `member → alumni, alliance_left` at 12px in `--ink-faint` while the timestamp beside it — the least of the row's meaning at that width, by the page's own argument — is 14px in `--ink-dim`, and the bright `--ink` 600-weight `+` beside the sentence pulls the eye to the affordance instead of to the fact.
- **Principle:** PRODUCT.md principle 3 ("Optimize for the eye moving down a column and catching the one wrong value"). The peek's own docblock at `globals.css:1248-1250` names it: "The peek is where the answer lives on that page."
- **Fix:** The `color`/`font-weight` overrides at `globals.css:1255-1256` exist to beat `.log summary`'s inherited brighter/heavier treatment, and the docblock explains *how* they win the cascade but never argues for *faint*. Take `--ink-dim` and `var(--t-data)` so the peek reads at the same grade as the row it summarises, and let the `::before` marker drop to `--ink-faint` (the `.row-toggle::before` precedent at `globals.css:2415-2421` already does exactly that). Keep the `font-weight: 400` — 600 on a full sentence would be worse.

### 7. The Filter button's in-flight vocabulary is structurally dead

- **Severity:** minor
- **Where:** `src/app/admin/audit/page.tsx:443, 507`, `src/app/_components/submit.tsx:53-63`, `src/app/_components/submit-guard.ts:38-69`
- **Cost:** An admin presses Filter on a log with a `resolveFilterIdentity` lookup plus a 100-row scan behind it and gets no signal from the control that the press landed; a double-press fires two navigations, because the guard cannot latch.
- **Principle:** none — but the settled position ("`aria-busy` plus a swapped `pendingLabel` is the whole in-flight signal") is silently unavailable here, which is worth knowing before someone assumes it applies.
- **Fix:** `useFormStatus().pending` is only ever true for a form with a React server action. This form is `method="get"` with no `action`, so it is a native browser navigation: `pending` is permanently false, `aria-busy` never flips, `pendingLabel` (not passed) could never fire, and `useSubmitGuard`'s latch never engages. The `Submit` wrapper is therefore paying for a `"use client"` boundary and two hooks to render `<button type="submit" class="btn">`. Either drop to a plain `<button type="submit" className="btn">Filter</button>` and be honest that a GET form has no in-flight state to show, or keep `Submit` and add a comment saying why it is inert here — the current state reads as if the page has the guarantee and it does not.

### 8. Two pagers, four identically-named links, no landmark to tell them apart

- **Severity:** minor
- **Where:** `src/app/admin/audit/page.tsx:187-218, 532-538, 671-676`
- **Cost:** A screen-reader admin pulling up the page's link list gets "Latest entries / Older entries / Latest entries / Older entries" with nothing saying which pair is above the table and which is below — on a page where the top pager exists specifically so a keyboard user does not have to cross 300 tab stops to reach it.
- **Principle:** none (2.4.4 is satisfied — same name, same destination). This is the top pager's stated purpose only half-delivered.
- **Fix:** Render the `.btn-row.pager` div as `<nav aria-label={top ? "Audit pages" : "Audit pages, end of table"}>`. One prop already distinguishes them (`top`), and `e2e/audit.spec.ts:493` asserts `toHaveCount(2)` on the link name, which a `nav` wrapper does not disturb.

### 9. The pinned At column has about 2px of slack, in a log that is append-only

- **Severity:** minor
- **Where:** `src/app/globals.css:3253-3301`, `src/app/_components/format-ago.ts:14-15`
- **Cost:** Three years from now the oldest pages of a log that by design deletes nothing render "1095d ago" in a `white-space: nowrap` cell that is 72px of content box, and the overflow paints out of the pinned column onto the row beneath it — the exact failure the pin exists to prevent.
- **Principle:** none.
- **Fix:** The docblock computes the bound as "`365d ago` caps at 8ch"; the string is 9 characters, and `elapsedShort` has no cap on the day count at all. Either bound the formatter (`>= 999d` → `999d+`) or add `overflow: hidden; text-overflow: ellipsis` to `.log--audit td:first-child` so an over-long value truncates inside the pin instead of escaping it. The second is one declaration and makes the whole class of future overflow safe.

## What is good and must survive

- **The At column does not use `RelativeTime`, and that is deliberate and correct.** `page.tsx:584-592` explains it: 100 client-component boundaries in the RSC payload at every viewport, most of them behind `display: none`. Because `formatAgo` runs on the server, there is no hydration mismatch, no post-mount content swap, and no unannounced text change. Anyone "improving" this to a live ticker reintroduces all three plus a moving page. The `force-dynamic` + `renderedAt()` pairing is what makes the static reading honest.
- **Both At renderings are always in the markup; the breakpoint only toggles visibility.** Nothing is measured or scripted, and — checked at all three bands — the accessibility tree never double-announces and never drops the instant: wide reads the ISO stamp alone (`.only-narrow` is `display: none`, taking the hidden restatement with it); middle and narrow read "12h ago at 2026-08-03 22:19:24 UTC". Do not "optimize" this into a conditional render.
- **`table-layout: fixed` plus the `<colgroup>` means opening a `<details>` cannot reflow the sticky column.** Column widths come from `<col>`, so an open payload changes row height only; the pinned cell stretches and stays put. This is worth stating because it is the reason the audit table needed no equivalent of the accounts table's `:has(tr.drawer-row:not([hidden]))` cap release. If anyone ever moves this table to `auto` layout, that guarantee goes with it.
- **The three exclusions from the pin.** `.log__empty` and `.drawer-row` are excluded from `position: sticky` and from the `border-right`, and `.log__empty-text` is itself `position: sticky; left: 0` so the empty message stays on screen at every scroll offset. All three are load-bearing at 320px.
- **`scroll-margin` is restated at every breakpoint that moves the column.** `globals.css:1141` (12.25rem), `:3111` (8rem), `:3291` (5rem) — three declarations tracking one column, for WCAG 2.4.11. Deleting any one of them silently re-obscures a focused header link at that band. The 3rem `scroll-margin-top` is likewise sized to the *audit* header (42px), not the accounts one.
- **`Scroller` starts at `tabIndex={0}` and takes the stop away after measuring**, rather than the reverse. That trade is argued at `scroller.tsx:41-45` and is the right way round.
- **Contrast is genuinely clear, including under hover.** Computed from the tokens: `--ink-faint` on `--void` 6.15:1, on the hovered row ground (`--hull-hi` at 55% over `--void`) 5.49:1, on `--hull-hi` itself 4.85:1; `--ink-dim` 9.57 / 8.53; gold on the hovered row 10.05; `--rule-strong` on `--void` 4.11. The dimmed action prefix, `.dim` cells and the `--ink-faint` peek all clear 4.5:1 on every ground they can sit on. There is no contrast finding on this surface — findings 5 and 6 are about size and hierarchy, not legibility.
- **`.json__full` wraps rather than scrolling.** `globals.css:1273-1281` removed a keyboard-unreachable scroll container per row rather than adding 100 tab stops. Correct call; do not revert to `overflow-x: auto`.
- **`idsOf` fails closed** (`page.tsx:227-230`): an unmatched name returns an empty list, never `undefined`, so a filter the admin believes is applied can never silently show everything. That is the right failure direction and the reasoning should stay in the file.
- **The empty state's asymmetry nudge** (`page.tsx:410-421`) turns the most common dead end on this page into one click. It is the single best thing on the surface.

## Could not evaluate

- **Whether `.scroller--tall`'s 80svh cap leaves the audit region ending below the fold at 320px and at 200% zoom.** `globals.css:1032-1041` exempts the audit table from the accounts table's `min(80svh, max(18rem, 100svh - 29rem))` on the claim that audit "sits under far less chrome." That claim is checkable and I could not check it: audit's chrome is the page head, the lede, the Filter rule, a filter form that wraps to four stacked cells below ~700px, the count rule, an optional warn notice and the top pager — plausibly close to the 580px (390px wide) and 647px (320px wide) figures the same comment measured for accounts. If it is, the sticky header pins to a region edge that is off-screen for most of the page's scroll range, which is the exact bug the accounts rule was written to fix. A Playwright geometry assertion mirroring the existing one in `e2e/admin.spec.ts` would settle it in one run.
- **The real advance width of `--font-mono`**, which decides whether finding 9 has 2px of slack or none. Needs a rendered measurement; `e2e/audit.spec.ts` already has the machinery (`geometry.ts`).
- **Whether `role="status"` present at document parse announces on any of the AT the corp actually uses.** It is a well-known no-op, but it varies; finding 4's fix does not depend on the answer, since the caption route works either way.
- Anything requiring a browser: forbidden by the preamble, and the dev server rewrites `tsconfig.json` in this worktree.

## Contested

Nothing on the settled list. The two places where I engage a docblock rather than a settled item — the 66rem breakpoint's missing `title` (finding 2) and `RawId`'s placement inside the anchor (finding 3) — are argued in place, and in both cases I think the decision recorded in the comment is right and the implementation of it is incomplete, not that the decision should be reversed.
