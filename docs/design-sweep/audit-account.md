# audit — /account

Register: **product**. Read: `src/app/account/page.tsx` (663 lines), `actions.ts`,
`contact-state.tsx`, `standing.tsx`, `src/core/account-health.ts`,
`src/services/account-view.ts`, `_components/{confirm-submit,ui,scroller,tier,submit,note-form,focus-heading}.tsx`,
and the `.verdict` / `.facts` / `.log` / `.st` / `.tier` / `.btn` / `.closing` /
`.scroller` / breakpoint rules in `globals.css`. Contrast figures below are
computed from the OKLCH tokens; my model reproduces the `--signal-warn` figures
already written into `globals.css:44-46` (9.43 / 8.54 / 7.44 / 8.41) exactly, so
the rest of the column can be trusted to the same tolerance.

## Findings

### 1. Every server action on this page lands in silence, with focus on `<body>`

- **Severity:** blocking
- **Where:** `src/app/account/page.tsx:280-284, 339-358, 508-539`; `src/app/account/actions.ts:27-88`
- **Cost:** A member unlinking the second of six alts is thrown back to the top of the document — their next Tab is "Skip to content" — and a screen-reader member gets no word at all that the press did anything, on four separate controls, one of which strips every Discord role they hold.
- **Principle:** WCAG 3.2.2 / 4.1.3; and the argument is already written in this repo — `_components/focus-heading.tsx:14-19` describes this exact failure ("React swaps the subtree, the link they pressed unmounts, and focus falls back to `<body>`. Their next Tab restarts at the top of the document") and `note-form.tsx:62-78` built a `role="status"` for a save that changed *less* than any of these four do.
- **Fix:** All four actions end in `revalidatePath("/account")` with no redirect, so React reconciles in place and the pressed control is unmounted in every case:
  `setMainAction` → `{!c.isMain && <form>}` goes false; `unlinkAction` → the `<tr key={c.id}>` is removed (and if the count drops to 1, *every* unlink form is removed with it); `wakeSelfAction` → the `view.status === "cryo"` block is removed; `unlinkDiscordAction` → the `<form>` is replaced by `<a>Link Discord</a>`. 4/4.
  Two changes, both already precedented here:
  (a) Add a `role="status"` region to `.page__head` that states the outcome, rendered always-mounted-and-empty the way `Notice`'s empty-slot mode and `note-form.tsx:76` both are — a region born holding its text is the shape AT misses, and this file already knows that (`ui.tsx:248-257`).
  (b) Move focus to a stable anchor after each action. The cheapest correct target is the `RuleHead` `h2` that owns the section the control lived in ("Crew manifest" for the two row actions, "Standing" for the two `.facts` ones), given `tabIndex={-1}`, using the `FocusHeading` pattern rather than a new one.
  Note the compounding problem: `unlinkAction` and `unlinkDiscordAction` both document their failure paths as **silent no-ops** (`actions.ts:57-59`, `actions.ts:80-83`). With no success signal either, a rejected unlink and a completed unlink are byte-identical to the user. Whatever region (a) adds must be written from the action's actual result, not unconditionally.

### 2. The Discord unlink can disarm itself at 641–851px with a mouse — the reverted #112 bug, in the row declared safe from it

- **Severity:** serious
- **Where:** `src/app/globals.css:608-613` (`.facts__lead`), `src/app/account/page.tsx:295, 382-384`, `_components/confirm-submit.tsx:88-98, 241-249`
- **Cost:** A member on a half-width laptop window who arms "unlink" with the pointer near the button's top edge watches it snap straight back to "unlink", and no number of clicks will ever get them to the confirm state.
- **Principle:** none (behavioural defect). The settled list says this row may reveal because it is "a `dd` in a grid that already reserves a wrapping line" — that reservation does not exist in the CSS.
- **Fix:** `.facts__lead` is `display: flex; flex-wrap: wrap; align-items: center`. Nothing reserves a line for the revealed `ConfirmCost`; it is simply a third flex item appended after the form. Whether the button moves depends entirely on which flex line that item lands on:
  - Item wraps to line 2 (wide, or `<40rem` where `.facts` collapses to one column): line 1's cross-size is unchanged, the button holds still. This is the case the row was reasoned about, and it is fine.
  - Item stays on line 1 but shrinks below its max-content and wraps *internally* to two lines: line 1's cross-size goes 28px → ~40px, and `align-items: center` re-centres the 28px button 6px down. The pointer is stationary, so it is now outside the button, `onPointerLeave` fires, `ctx.disarm()` runs. Exactly the #112 mechanism, arrived at through cross-axis centring instead of cell widening.
  Estimating the row: `.discord-id` ~150px, the form ~80px, two `--s-3` gaps 24px, cost sentence (68 chars at 13px) ~430px max-content / ~60px min-content. The item stays on line 1 and wraps whenever the space left to it is between ~60px and ~430px, i.e. dd width ~314–684px. Above 40rem the dd is `min(viewport-48, 912) - 120`, which puts the band at roughly **641–851px viewport** — mouse-capable widths. Below 40rem the same geometry occurs but `pointerType` is `touch` and the handler correctly ignores it.
  Fix in one declaration, and it makes the settled claim true rather than aspirational: give the revealed cost `flex-basis: 100%` (a `.facts__lead > .confirm-cost` rule, or a modifier class on `ConfirmCost`) so it genuinely takes a line of its own at every width. `align-items: baseline` on `.facts__lead` would also pin the button, but changes the rest state's alignment.
  Numbers are computed from the CSS, not measured in a browser — see "Could not evaluate". The mechanism does not depend on the exact band.

### 3. The manifest has no row order, so "N characters need attention" points at nothing

- **Severity:** serious
- **Where:** `src/services/account-view.ts:151-154` (no `orderBy`), rendered at `src/app/account/page.tsx:443`
- **Cost:** A member told "3 characters need attention" has to scan an arbitrarily-ordered table for the three amber tokens, and a member who comes back tomorrow may find the same eight rows in a different order — including the row whose "unlink" they are about to press.
- **Principle:** PRODUCT.md principle 3 ("optimize for the eye moving down a column and catching the one wrong value"); principle 2 ("state before action").
- **Fix:** The query is a bare `select().from(character).where(eq(character.accountId, ...))`. Postgres returns heap order, which an `UPDATE` (a token refresh, a name change — both routine here) can move. Nothing downstream sorts: `page.tsx:443` maps `view.characters` straight out. Order the query — main first, then anything `needsAttention` (the predicate already exists, exported-adjacent, in `core/account-health.ts:112`), then name. Main-first is the cheap half and is worth doing on its own: the main character is the one the tier and alumni copy is about, and today it can render fifth.
  This is also what makes finding 1 worse than a nuisance: return the member to the top after an unlink, and the list they come back down to may not be the list they left.

### 4. At 320px the actions column is ~550px off-screen and the name does not travel with it

- **Severity:** serious
- **Where:** `src/app/globals.css:753-810` (`.log` base), `3126-3290` (the 40rem block, which touches `.log--runs` and `.log--audit` and never `.log`); `src/app/account/page.tsx:414-557`
- **Cost:** The member PRODUCT.md describes — phone, 1am, minutes before a fleet — has to scroll a 288px window ~550px to the right to reach "unlink", by which point the character name is ~450px behind them, on the one table in the app whose row action deletes something.
- **Principle:** PRODUCT.md "Zoom and reflow"; the argument is DESIGN-internal — `globals.css:3222-3230` states it for the admin table ("The name an admin is about to change the tier of stays on screen through the scroll right to the controls") and the member's own manifest is the surface that did not get it.
- **Fix:** Estimating min-content at 320px: six cells × 32px padding = 192px, plus portrait 32, name (`.char` is `white-space: nowrap`, 14px/600, plus a mono "(main)") ~175, token control ~98, contacts (`.st` is nowrap; "TOKEN REFRESH FAILED" in mono at 11px with `--track-value`) ~160, map ~35, actions ("make main" + an 11ch-reserved ConfirmSubmit) ~153 — about **845px in a 288px region**. Both admin tables took two mitigations at 40rem that this one did not: a sticky first column (`.log--sticky-col`) and padding cut to `var(--s-2) var(--s-1)`. Apply the same two here. The padding cut alone returns ~144px, a sixth of the table. `.log--sticky-col`'s existing rules already exclude `.log__empty`, so the empty state is unaffected.

### 5. The table's accessible name is a 35-word sentence, and it is asserted to members it is false for

- **Severity:** moderate
- **Where:** `src/app/account/page.tsx:406-426`
- **Cost:** A screen-reader member entering the crew manifest hears "authGD owns the Blue contact label on your characters: contacts under that label are managed automatically and may be added, changed, or removed" as the *name of the table*, every time — including the associate member for whom every CONTACTS cell reads "— not managed" and for whom the sighted copy of that same sentence is correctly suppressed.
- **Principle:** WCAG 1.3.1 / 2.4.6. HTML-AAM: `<caption>` supplies the table's accessible name, so this is a name, not a description.
- **Fix:** The docblock (page.tsx:416-421) argues the caption "is the one place a standing fact about the CONTACTS column reaches a member no matter which cell they navigate to". A `<caption>` does the opposite of that: it is announced once on table entry. A `<th scope="col">` with `aria-describedby` is the construct that repeats per cell in most screen readers, which is the behaviour the comment wanted. Two changes: make the caption the table's actual name (`Crew manifest`, matching the `RuleHead` above it), and hang the contact-label sentence off the CONTACTS `<th>` via `aria-describedby`, pointed at the existing `<p class="table-note">` rendered always but `.visually-hidden` when `!showContactsNote` — the same always-in-the-tree / conditionally-visible shape `ConfirmCost` already uses on this page. That also fixes the asymmetry: today the sighted note is gated on `showContactsNote` and the accessible one is not, so members with nothing to fix, and members with no contacts targets at all, are the only ones who hear it.

### 6. `aria-describedby` on a `<td>`, pointing at prose that contains a link

- **Severity:** moderate
- **Where:** `src/app/account/page.tsx:46, 484-497, 566-586`; `contact-state.tsx:182-198`
- **Cost:** A member whose token has refreshed but whose last contacts run still reports a fault hears "This character's EVE token is dead. re-authorize" flattened into a cell description, with no signal that "re-authorize" is a control and no way to reach it from where they are standing.
- **Principle:** WCAG 1.3.1; ARIA authoring practice — accessible descriptions are flattened to text, so interactive content inside a described element is unreachable through the reference.
- **Fix:** The id wiring itself is sound: reference and element are gated on the same `hasContactRemedy(...)` call, so it cannot dangle, exactly as the docblock claims. Two problems sit on top of it. (a) `aria-describedby` on `role=cell` is not reliably surfaced — NVDA browse mode often reads it, VoiceOver and JAWS frequently do not, so the association may be doing nothing at all for most readers. (b) When it *is* surfaced, `ContactRemedy` with `showReauth` (page.tsx:581, reachable exactly when the TOKEN cell shows "ok" but the contacts snapshot still reports a token fault) puts an `<a class="btn">re-authorize</a>` inside the described text. Move the association onto the CONTACTS cell's `Status` token wrapped in a real reference the reader can follow — the simplest version is a `.visually-hidden` anchor in the cell reading "fix for {name}" and `href="#contact-remedy-{id}"`, which turns an unreliable description into a link that works in every reader. The visible prose below the table is doing the real work today and should stay exactly where it is (see "What is good").

### 7. The closing image downloads ~1200px to paint a 420px box — 260px on a one-character account

- **Severity:** moderate
- **Where:** `src/app/account/page.tsx:657-659`; `src/app/globals.css:2984-2995`
- **Cost:** Every member on every visit pays roughly 85KB for artwork rendered at a third of that width, and a member with one alt — the newest member, the one most likely on a phone — pays it for a 260px frame.
- **Principle:** PRODUCT.md principle 5, "Earn the artwork": "from an asset cut for the size it is drawn at, never a large file scaled down".
- **Fix:** `<Image src="/brand/hero-account.webp" width={1120} height={711}>` with no `sizes`. `next.config.ts` sets no `images` config, so with no `sizes` Next emits density descriptors off the `width` prop — the smallest `deviceSizes` entry ≥1120 (1200) at 1x and ≥2240 (3840, capped to source) at 2x. CSS then paints it into `width: min(420px, 100%)`, or `min(260px, 100%)` under `.closing--compact`. So the 1x candidate is ~2.9× the box, and 4.3× in compact. The comment at page.tsx:651-656 says `.closing--compact` "asks the same asset for a smaller frame rather than cropping or downscaling it" — with no `sizes` it never asks for anything smaller, and CSS downscaling is precisely what principle 5 rules out. Pass `sizes={view.characters.length <= 1 ? "260px" : "420px"}`, which switches Next to a `w`-descriptor srcset and lets the browser take a 384w/640w render. `alt=""` is correct (decorative), and omitting `priority` is correct — it is the last element on the page and `next/image` lazy-loads by default. Both should stay.

### 8. `.st--lead` is `white-space: nowrap` on a full sentence

- **Severity:** minor
- **Where:** `src/app/globals.css:1395-1424`
- **Cost:** A member who has raised their browser's default font size sees the page's one-line verdict — the whole point of the block — run off the right edge and drag a horizontal scrollbar onto the page with it.
- **Principle:** WCAG 1.4.4 (text resize to 200%).
- **Fix:** `.st` sets `white-space: nowrap` for tokens in a table column, which is right there and wrong for a 29-character sentence at `--t-body`. The rule's own comment does the arithmetic and states the trap plainly ("Lengthening the copy overflows rather than wraps, so measure before rewording it") — a documented budget with ~13px of slack at 320px that any text-size increase spends immediately. Add `white-space: normal` to `.st--lead` and switch its `align-items` to `baseline` so the leading dot stays on the first line rather than centring against a two-line block. That also retires the copy-length budget, which is a latent trap for the next person who edits the verdict strings.

### 9. The manifest names its unlink and nothing else

- **Severity:** minor
- **Where:** `src/app/account/page.tsx:479-481, 512-517`
- **Cost:** A speech-input member with four alts says "click make main" and gets an ambiguity dialog, or the wrong row; a screen-reader member hears "re-authorize, link" three times with nothing to tell the three apart.
- **Principle:** none as a hard failure (WCAG 2.4.4 is satisfiable from row context); the standard being missed is this repo's own, argued at `confirm-submit.tsx:152-158` — "the manifest is exactly where they cannot see which row they are on."
- **Fix:** `ConfirmSubmit` correctly takes `restName={`unlink ${c.name}`}`. The two other row controls in the same `<tr>` do not: the `make main` `Submit` has no `aria-label` (the prop exists and is used on every admin row), and the TOKEN cell's `re-authorize` link carries only its visible text. Add `aria-label={`make main: ${c.name}`}` and `aria-label={`re-authorize ${c.name}`}` — both keep the visible label as a prefix, so WCAG 2.5.3 holds. The re-authorize case has a genuine counter-argument worth recording rather than ignoring: `/auth/eve/link` is row-independent (it links whichever character the member authorizes at SSO), so all N links really are the same control. If that is the position, render one, below the table, instead of N identical ones in cells.

### 10. "Add character" is gold on a page that just said something is wrong

- **Severity:** minor
- **Where:** `src/app/account/page.tsx:588-602`
- **Cost:** A member told "Discord roles behind schedule" — something they cannot fix — sees the page's single gold action inviting them to add another character to the thing that is behind.
- **Principle:** PRODUCT.md principle 2, "state before action".
- **Fix:** The gate is `health.attention === 0`, but the comment beside it argues the verdict-level rule: "the loudest thing on a broken page must not be adding more to it". Those diverge on two of five verdicts: `stalled` and `discord-stale` both have `attention === 0` and both render an amber `size="lead"` warn token immediately above a gold button. Change the condition to `health.verdict === "nominal"`, which is what the comment describes. `first-sync-pending` then also demotes, which is arguably a loss — if it should keep the gold, spell that out: `health.verdict === "nominal" || health.verdict === "first-sync-pending"`.

## What is good and must survive

- **Contrast is clean on every ground this page uses, including the hovered row.** Computed against `--void` and against the hovered `.log tbody tr` ground (`color-mix(--hull-hi 55%, transparent)` over void): `--ink` 16.06/14.32, `--ink-dim` 9.57/8.53, `--ink-faint` 6.15/5.49, `--signal-ok` 9.42/8.40, `--signal-warn` 9.43/8.41, `--signal-bad` 6.09/5.43. The tier badges on their own 14% tint over void: member 8.74, alumni 7.44, associate 6.32, pending 7.53. `--rule-strong` on void 4.11 (the `.scroller` boundary, which is the one border here under 1.4.11). Nothing on this surface is near a floor. A later pass that dims `--ink-faint` by a step to "quiet things down" would take `.st--off`, `.dim`, `.log th`, `.facts dt` and `.btn--danger-quiet` at rest with it in one move.
- **Prose out of the table cells.** The `contactRemedies` block below the `Scroller` (page.tsx:559-586) is the single best decision on this page: it is why the manifest is a scannable six-column table at all, and the comment records the measurement that produced it (~340px row height, off-screen and unreachable). Do not "improve" this by folding the remedy back into the cell it describes.
- **`ConfirmCost` at rest is `.visually-hidden`, never unmounted.** The description has to pre-exist the first press because it sits after the button in reading order. Any refactor that switches this to conditional rendering silently removes the only warning a keyboard member gets before stripping their Discord roles.
- **`.facts__lead` folding cryo and pending into the tier `dd`.** The reason (a `.visually-hidden` `dt` is `position: absolute` and knocks every subsequent `dt`/`dd` into the wrong grid track) is non-obvious and correct. Same for `StandingTier` using `Status` rather than `Notice` for pending.
- **The verdict's colour discipline.** `size="lead"` spends size, not a new hue, to outrank the gold tier badge below it; the quiet verdicts stay at token size. That is the right shape even though the announcement (finding 1) and the `nowrap` (finding 8) need work.
- **`Scroller`'s conditional tab stop** — `tabIndex={scrollable ? 0 : -1}`, starting `true` server-side so the pre-hydration window never loses keyboard access to the overflow. It is the correct default and the reasoning (scroller.tsx:38-45) is worth keeping intact.
- **The Discord row's display-name-then-dimmed-handle**, and the decision not to render a `linked` token beside a button whose presence already says so.

## Could not evaluate

- **Real pixel geometry.** Findings 2 and 4 rest on widths computed from the CSS and the mono/sans metrics, not measured. The mechanisms are sound; the band boundaries are not. Settling it: a Playwright case that arms the Discord unlink at 700px with a mouse and asserts the button still reads "confirm" after 200ms, and one that measures `.log`'s `scrollWidth` at 320px.
- **Whether `aria-describedby` on a `<td>` is announced at all** by the readers this corp actually uses. If it is universally dropped, finding 6(b) is moot and 6(a) becomes the whole finding; if it is announced, both halves stand. Only a real NVDA/VoiceOver pass settles it.
- **Exact bytes served for the closing image.** I read `next.config.ts` (no `images` block) and reasoned from Next's documented default `deviceSizes`; I did not run a build to read the emitted `srcset`. The direction is certain, the KB figure is not.
- **Whether focus is truly lost on all four actions**, versus React preserving it through some reconciliation path I have not accounted for. Every one of the four unmounts the pressed control, which is the condition, but a `page.getByRole` + `evaluate(() => document.activeElement)` assertion after each action would make it a fact rather than an inference.

## Contested

Nothing on the settled list. One clarification rather than a disagreement: the settled entry says the account page's Discord row "can reveal because it is a `dd` in a grid that already reserves a wrapping line". The conclusion is right — revealing here is safe at most widths and the button is correct not to move — but the stated reason is not the mechanism (`.facts__lead` reserves nothing; the button holds still because flex items are packed from the main-start edge and the new item is appended last). Finding 2 is not a proposal to reverse the decision; it is the width band where the real mechanism stops holding, plus the one declaration that would make the settled sentence literally true.
