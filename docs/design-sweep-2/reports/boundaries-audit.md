# The boundaries — audit (a11y / performance / responsive)

`$impeccable audit` · register: **PRODUCT** · surfaces: `src/app/error.tsx`,
`src/app/not-found.tsx`, `src/app/payouts/[id]/not-found.tsx`

Shots read before source: `13-error-boundary.{wide,narrow}.png`,
`02-not-found-root.{wide,narrow}.png`, `08-payout-not-found.{wide,narrow}.png`.

Setup note: `node .agents/skills/impeccable/scripts/load-context.mjs` does not
exist in this worktree (`MODULE_NOT_FOUND`). Context gate satisfied by reading
`PRODUCT.md`, `DESIGN.md` and `BRIEF.md` directly. Register taken from the block
assignment, per routing rule 1 in the skill.

## What I see, before explaining it

Three pages built from the same four parts: the shell bar, an `h1` wearing a
gold outline, a lede, and a button row. The two 404s are a heading, two lines of
prose and one gold button in the top eighth of the screen; below that, nothing —
640px of empty ground at 1440×900. The error boundary adds a red-bordered
instruction box and a `WHAT TO SEND` record, and still ends 340px above the fold.

The first thing I noticed, before reading a line of source: on the error
boundary the reference number **is not in the sentence that asks for it**. The
box reads

> `! Try again. If it keeps happening, tell an admin what you were   4292868890 .`
> `  doing and quote reference`

The digest sits at the top right of the box with a stranded full stop beside it,
and the words "quote reference" end four lines lower with nothing after them. It
is the same at 390px (`13-error-boundary.narrow.png`) and I reproduced it at
320px. The second thing: on all three surfaces the gold focus ring around the
`h1` is the widest and loudest element on the page — a 915px box drawn around a
260px word, wider than any content the page holds.

---

## Health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | A successful retry drops focus to `<body>` with no announcement; the failing path is the only one handled |
| 2 | Performance | 3 | `ui.tsx` has no client boundary, so the whole module crosses into the client bundle via `error.tsx` |
| 3 | Responsive | 3 | No overflow at 320px or 200% zoom; but `.notice`'s flex row reorders content at every width |
| 4 | Theming | 4 | Every colour is a token; every pair I measured clears AA |
| 5 | Anti-patterns | 4 | No AI tells. Deadpan, ruled, authored |
| **Total** | | **16/20** | Good — accessibility is the weak dimension |

**Anti-patterns verdict: pass.** No gradient text, no glass, no hero metric, no
card grid, no side stripes (`.notice`'s comment names the ban by hand). Nothing
here would make anyone say "AI made that."

**Contrast: no failures found.** Measured in rendered sRGB, not OKLCH:

| Pair | Rendered | Ratio |
|---|---|---|
| `--ink` on `--void` (lede, notice text) | `#ece7de` on `#0a0a0a` | 16.08 |
| `--ink` on the `notice--bad` ground | `#ece7de` on `#261313` | 14.39 |
| `--signal-bad` glyph/border on that ground | `#f05751` on `#261313` | 5.22 |
| `--ink-dim` on `--void` (escalation body) | `#bab3a9` on `#0a0a0a` | 9.53 |
| `--ink-faint` on `--void` (`RuleHead`) | `#90877e` on `#0a0a0a` | 5.61 |
| `--rule-strong` `.btn` border on `--void` | `#787370` on `#0a0a0a` | 4.23 |
| `--void` on `--gold` (`.btn--primary`) | `#0a0a0a` on `#f1c035` | 11.63 |

The `notice--bad` ground is `color-mix(… 12%, transparent)` composited over
`--void`; it renders `#261313`, not the `#5c1f1d` a linear-space calculation
gives. Both buttons are `min-height: 2.25rem` = 36px, clearing 2.5.8.

---

## Findings

### 1. The reference is torn out of the sentence that asks for it — `.notice` is a flex row and the `<code>` becomes its own flex item

- **Severity:** Serious
- **Where:** `src/app/globals.css:3429` (`.notice { display: flex; gap: var(--s-3) }`), rendering `src/app/error.tsx:197-214`
- **Observation:** `.notice` is `display: flex` with no `flex-wrap`. Per the
  flexbox spec, contiguous runs of text become anonymous flex items, so
  `Notice`'s children resolve to **three** items, not one paragraph: the text
  before the `<code>`, the `<code class="mono">` element, and the "." after it.
  Measured in Chromium against the real stylesheet at 320 / 390 / 1440: the
  `<code>` box lands at x=208, x=278 and x=500 respectively while the notice
  starts at x=16, x=16 and x=120 — the digest is laid out to the *right* of the
  prose at every viewport, with a 12px `gap` on both sides and the orphaned full
  stop after it. Two independent confirmations that this is live and not a probe
  artifact: it is visible in `13-error-boundary.wide.png` and
  `13-error-boundary.narrow.png`.
- **Cost:** A member on their worst day is told to "quote reference", reads to
  the end of that sentence, and finds nothing there — the number is four lines
  up and across the box, reading as a separate stray value. This is precisely
  the failure the merge in `e2e/error-boundary.spec.ts:239` was written to fix
  ("It used to be a separate line below the alert with no instruction attached
  to it"). The DOM merge landed; the render undid it. The spec asserts
  `toContainText` and `toBeVisible` on `code.mono`, both of which pass while the
  digest sits anywhere on the page, so nothing caught it.
- **Fix:** `.notice` should not make its message a flex container. Move the
  glyph and the message into a two-item flex row with the message in its own
  block — e.g. keep `.notice` as the flex row, and have `Notice` wrap
  `{children}` in a `<span>`/`<div>` so the whole message is one flex item and
  inline content flows normally inside it. That is one element in `ui.tsx:321`
  plus a selector in the CSS, and it fixes every `Notice` in the app that ever
  carries inline markup, not just this one.
- **Principle:** WCAG 1.3.2 Meaningful Sequence (the visual order no longer
  matches the reading order the DOM asserts). Also the brief's own rule that a
  reference must live inside the instruction that names it.

### 2. A retry that *succeeds* drops focus to `<body>` and announces nothing

- **Severity:** Serious
- **Where:** `src/app/error.tsx:295-306`
- **Observation:** `error.tsx:280-294` measures and documents what a **failed**
  retry does in detail — `reset()` remounts the boundary, `FocusHeading` re-runs,
  the `h1` is re-announced — and `e2e/error-boundary.spec.ts:96-140` pins exactly
  that path. The successful path is not addressed anywhere in the file, the
  comment, or the spec. On success the boundary subtree is replaced by the real
  segment; the button that was pressed unmounts; no page in `src/app/` renders a
  `FocusHeading`, so focus falls to `<body>` and there is no `<title>` change to
  announce (`error.tsx`'s hoisted title is removed, and the segment's own
  metadata was already resolved).
- **Cost:** A screen-reader user presses "Try again", the retry works, and they
  hear nothing at all. Their next Tab restarts at "Skip to content" on a page
  they were never told they arrived at — the exact stranding
  `focus-heading.tsx:14-18` was written to prevent, reached from the one
  direction nobody checked. The failure case is handled and the success case is
  not, which is the wrong way round: failure repeats, success is the state you
  want the user to notice.
- **Fix:** The boundary cannot reach into the segment it hands off to, so the
  honest options are (a) move focus to `#main` before calling `reset()` inside
  the transition, so the landing page's own main region has focus rather than
  `<body>`, or (b) render a `role="status"` line that says the retry succeeded
  before the unmount. (a) is smaller and matches what the skip link would have
  done. Either way, add the success path to `e2e/error-boundary.spec.ts` — the
  helper already restores the table in `finally`, so a retry inside the restored
  state is a two-line addition.
- **Principle:** WCAG 4.1.3 Status Messages; 2.4.3 Focus Order.

### 3. The escalation record is missing the two fields that would let an admin act on it, and rewrites the one it has

- **Severity:** Serious
- **Where:** `src/app/error.tsx:257-263`, `src/app/_components/utc-time.tsx:2`
- **Observation:** The block's own comment (`error.tsx:216-224`) states its
  purpose precisely: `/admin/audit` "filters on actor, action, target and
  before, and has no free-text search at all… What does narrow that log is the
  route and a time." Three things work against that:
  1. **`seen` carries no date.** `utcHhmm` returns `HH:MM` only. An admin
     handed `11:57 UTC` and filtering `/admin/audit` on `before` — a timestamp —
     has to guess the day. A member who reports the fault the next morning, or
     any incident that straddles 00:00 UTC, hands over an ambiguous value.
  2. **`page` drops the query string.** `usePathname()` returns the path without
     search params. `/admin/audit` is entirely query-driven
     (`admin/audit/page.tsx:246-259` reads `searchParams`), so a throw while
     filtering records `page /admin/audit` and discards the actor/action/target/
     before combination that reproduces it — on the one page whose failures are
     most likely to *be* about the query.
  3. **`seen` is rewritten by a failed retry.** `reset()` remounts (the file
     measures this at line 282), so `seenAt` resets to `null`, prints `—`, and
     refills with the *retry's* time. The first-occurrence time — the one the
     admin would bracket the search on — is gone, silently, and the member has
     no way to know the number changed.
- **Cost:** An admin receives a copied record that names a route without its
  filter, a time without a date, and a time that may be minutes after the event.
  The block exists to stop this escalation dead-ending, and in the three most
  likely escalation shapes it still does.
- **Fix:** Emit an ISO-8601 UTC instant for `seen` rather than `HH:MM` (`page`
  and `ref` are already machine-shaped; this is the only field that is not).
  Append `useSearchParams()` to the `page` line when non-empty. Capture `seenAt`
  once per *error identity* rather than per mount — a `useRef` keyed on
  `error.digest` survives the remount `reset()` performs; if the digest is
  absent, hold the first value and do not overwrite it.
- **Principle:** None cited — this is a correctness gap in the surface's stated
  job, not a rule violation.

### 4. The `h1` focus ring renders, the source says it does not, and it is the loudest thing on all three pages

- **Severity:** Moderate
- **Where:** `src/app/_components/focus-heading.tsx:57-58`
- **Observation:** The comment states: *"No focus ring appears: the global ring
  is `:focus-visible` (globals.css), which a programmatic focus on a non-input
  element does not match."* That is false in Chromium. I verified it directly —
  a programmatic `.focus()` on an `h1[tabindex="-1"]` returns
  `matches(":focus-visible") === true` and paints the outline. All six
  screenshots agree: a 2px gold ring with 2px offset around the `h1`, spanning
  the full 912px `page--narrow` child cap (measured 120→1035 in
  `13-error-boundary.wide.png`), on a heading whose text is ~260px wide.
- **Cost:** Two costs, and the second is why this is not just a stale comment.
  Visually, the boldest, largest, gold element on every boundary is an outline
  around something nobody can press, and it out-ranks both the red instruction
  box and — on the two 404s — the actual gold primary button, so gold appears
  twice on a page whose ration is one. Structurally, a future editor reading
  that comment will conclude the ring is impossible and reason from there; the
  comment is load-bearing and wrong.
- **Fix:** Correct the comment first — it is a factual claim about the browser
  and it is wrong. Then decide deliberately: keeping the ring is defensible
  (focus is where focus is), but it should be a ring the design chose, scoped to
  the heading's text rather than to the 912px column. `h1:focus-visible {
  outline-offset: 4px; width: fit-content }` on the `page__head` heading, or a
  ring on `#main` instead. Do not suppress it.
- **Principle:** WCAG 2.4.7 Focus Visible (satisfied — do not "fix" by removing
  it); DESIGN.md's gold ration is the part under strain.

### 5. The one thing the page asks you to copy has no copy affordance and cannot be selected from the keyboard

- **Severity:** Moderate
- **Where:** `src/app/error.tsx:257-263`, `src/app/globals.css:3359`
- **Observation:** `.escalation`'s comment explains the `<pre>` choice: *"the
  point is that one drag selects all of it"* — a drag, which is a pointer
  gesture. The `<pre>` is not focusable, does not scroll (it wraps), carries no
  copy button, and `user-select: all` is deliberately declined. Chromium has no
  caret-browsing mode, so a keyboard-only user has no mechanism to select this
  text at all.
- **Cost:** A keyboard-only member, or anyone on a touch device where a precise
  three-line drag inside a 286px box is fiddly, is told to send a record they
  cannot pick up. The digest is at least also spoken in the notice sentence; the
  route and the time exist only here.
- **Fix:** Add one `Copy` button beside the `RuleHead`'s `aside` slot —
  `RuleHead` already takes an `aside` and it is empty here — writing the block's
  text via `navigator.clipboard.writeText`, with a `role="status"`
  confirmation. That serves pointer, keyboard and touch with one control and
  costs nothing to the drag path that already works.
- **Principle:** WCAG 2.1.1 Keyboard (the operation the page instructs is
  pointer-only).

### 6. `aria-busy` on a `<button>` is not a busy mechanism

- **Severity:** Moderate
- **Where:** `src/app/error.tsx:298`
- **Observation:** The decision not to set `disabled` is correct and well
  argued (line 274-278: disabling moves focus to `<body>` mid-wait). But
  `aria-busy` is defined for *regions whose contents are being updated*; on a
  focused button it is not reliably announced by any major screen reader, and
  ARIA's own guidance is that it should not be used to mark a control as
  temporarily unavailable. The only real signal in flight is the label swapping
  to "Trying…", which is an accessible-name change on the currently-focused
  element — announced inconsistently and, on some combinations, not at all.
  Nothing prevents a second press either, though `reset()` twice is harmless.
- **Cost:** A screen-reader user presses "Try again" against a slow round trip,
  hears nothing, and presses again. The visual half of the state
  (`globals.css .btn[aria-busy="true"]`) works; the announced half does not.
- **Fix:** Keep `aria-busy` for the styling hook it already drives, and add
  `aria-disabled={retrying}` with an early return in the handler. `aria-disabled`
  keeps focus exactly where the comment requires, is announced, and is the
  attribute that actually means "not actionable right now". Optionally pair it
  with a `role="status"` line so the wait itself is spoken.
- **Principle:** WCAG 4.1.2 Name, Role, Value.

### 7. Two identical controls, and the safer one reads as the afterthought

- **Severity:** Moderate
- **Where:** `src/app/error.tsx:265-313` — the `.btn-row`
- **Observation:** This is the brief's pattern 3 in miniature. Both controls are
  plain `.btn`: same 36px height, same `--hull-hi` ground, same
  `--rule-strong` border, same 11px mono uppercase, side by side, 8px apart.
  Nothing directs the eye. Meanwhile the lede directly above warns that a
  submitted action may already have taken effect — which makes "Try again" the
  control with consequences and "Back to Operations" the one the warning points
  toward. Reading order and left-first position both hand primacy to the riskier
  one.
- **Cost:** A member who has just read "check whether it took effect before you
  send it again" is offered, as the first and visually equal choice, the control
  that sends it again. The page's own copy and its own layout disagree.
- **Fix:** Not gold on "Try again" — that is settled and correct, and I am not
  reopening it. Differentiate downward instead: give "Try again" the existing
  `.btn--quiet` grade so the escape reads as the default at rest, or reverse the
  order so the escape comes first. Either is a one-token change and neither
  spends the ration.
- **Principle:** PRODUCT.md's "state before action" — the page states a hazard
  and then presents the hazardous control as the default.

### 8. Pattern 1: 476px of content in a 912px column, and the page runs long instead of wide

- **Severity:** Minor
- **Where:** whole surface (all three boundaries)
- **Observation:** `page--narrow` caps direct children at 912px
  (`60rem - 2 * --s-5`). `.notice`, `.escalation` and `.page__lede` all set
  their own tighter `--measure` (68ch), measured at 476px at 1440px wide. The
  `h1` and `.page__head` take the full 912px, which is invisible until the focus
  ring draws it (finding 4). Net: a 476px content ribbon inside a 912px column
  inside a 1440px viewport, ending 340px above the fold on the error boundary
  and 640px above it on the two 404s.
- **Cost:** Low, honestly — these are pages nobody should linger on, and a
  narrow measure for prose is right. The cost is only that the ring exposes the
  mismatch, which is why this ranks below finding 4 rather than beside it.
- **Fix:** Cap `.page__head` on these three surfaces at `--measure` too, so the
  ring lands on a box the same width as the prose under it. Do not widen the
  content to fill the column.
- **Principle:** None cited.

### 9. The skip link is unreachable by forward Tab on all three boundaries

- **Severity:** Minor
- **Where:** `src/app/_components/ui.tsx:104`, interacting with `src/app/_components/focus-heading.tsx:53-55`
- **Observation:** `FocusHeading` moves focus into `#main` on mount, past the
  skip link, which is the very first focusable element. `focus-heading.tsx:43-48`
  names this cost for hard navigations and accepts it. What the comment does not
  say is that it is now permanent on these three surfaces: the skip link can
  only be reached by Shift+Tab, backwards, which is not how anyone finds a skip
  link.
- **Cost:** Near zero on the 404s, where `#main` holds one button and the skip
  link would save two Tab presses. Filed because the mechanism is invisible: a
  keyboard user who has learned that Tab-then-Enter reaches "Skip to content"
  everywhere else in this app gets "Try again" here instead, on the one page
  where pressing the wrong thing is warned about two lines above.
- **Fix:** No change recommended to the focus behaviour — it is the right trade.
  Record the consequence in `focus-heading.tsx`'s comment beside the hard-
  navigation cost it already states, so the next reader knows the skip link is
  dead weight on these three routes and does not "fix" the focus move to revive
  it.
- **Principle:** WCAG 2.4.1 Bypass Blocks is satisfied (the focus move bypasses
  the block more directly than the link does). This is a consistency note, not
  a violation.

### 10. `error.tsx` pulls all of `ui.tsx` across the client boundary

- **Severity:** Minor
- **Where:** `src/app/_components/ui.tsx:1` (no `"use client"`), imported by `src/app/error.tsx:13`
- **Observation:** `ui.tsx` is a 376-line shared module with no client
  directive, exporting `SiteHeader`, `RuleHead`, `Status`, `Notice` and `Json`.
  `error.tsx` is `"use client"` and imports three of them, so the module is
  compiled into the client graph — including `Json` (the largest export, with
  its `<details>` payload rendering) and `Status`, neither of which any boundary
  uses. A root-level `error.tsx` wraps every route, so its chunk is part of
  every page's client reference manifest.
- **Cost:** Some JS on every route for code no boundary renders. I am not
  quoting a KB figure because I did not build — the mechanism is certain, the
  magnitude is not.
- **Fix:** Measure first (`next build` and compare the shared chunk). If it is
  material, split the three boundary-facing exports into their own module rather
  than adding `"use client"` to `ui.tsx`, which would push `Json` and `Status`
  into the client on every *server* page that uses them and make things worse.
- **Principle:** None cited.

### 11. Adds to a known-open item: `.escalation`'s border is 1.62:1, so at zoom the block has no perceivable edge at all

- **Severity:** Minor
- **Where:** `src/app/globals.css:3359-3372`
- **Observation:** I am not restating the known-open `1.00:1 ground` item. The
  consequence it does not name: because the ground is identical to the page, the
  block's *only* separation from the surrounding surface is its 1px `--rule`
  border, and that measures **1.62:1** (`#373533` on `#0a0a0a`). One hairline at
  1.62:1 is the entire boundary of the region.
- **Cost:** At 200% zoom the border stays 1px in device terms while everything
  around it doubles, and on a dimmed laptop screen at 1am — the stated reading
  condition for this app — it is not visible. The member is told "copy this" and
  cannot see where "this" starts or stops, so they copy three lines by eye and
  may take the `RuleHead` or the button labels with them.
- **Fix:** Whichever way the known-open ground item is resolved, the border must
  end up ≥3:1 against whatever ground it separates. Colour tokens are frozen for
  this sweep, so the available move is swapping `--rule` for `--rule-strong`
  (4.23:1 on `--void`) on this one rule — a token *use* change, not a retune.
- **Principle:** WCAG 1.4.11 Non-text Contrast (as the boundary of a region the
  user is instructed to operate on).

---

## What is genuinely good and should survive

- **The three-way nav derivation.** `navFromPath` running `navFor` with weaker
  evidence, rather than three literal arrays, is the strongest single piece of
  architecture in these files. `02-not-found-root.wide.png` shows one nav item,
  `08-payout-not-found.wide.png` shows two with OPERATIONS marked current, and
  `13-error-boundary.wide.png` shows two — three different bars from one rule.
  A fix pass must not hand-edit any of these lists.
- **`live={false}` on the notice.** The reasoning at `error.tsx:188-196` is
  correct and subtle: `role="alert"` in the same commit as a focus move preempts
  the heading announcement. Leave it off.
- **The lede.** "That's a fault on this end, not something you did. If you had
  just submitted something, check whether it took effect before you send it
  again." It assigns fault, refuses a claim it cannot support, and tells the
  member the one thing that changes their next move. Do not touch this sentence.
- **The digest-absent branch** (`error.tsx:209-212`). A client-side throw with
  no digest still gets an instruction that points somewhere, instead of the line
  vanishing.
- **`—` for a pending `seen`** rather than omitting the row, so the button
  underneath does not slide out from under the pointer. Finding 3 asks for the
  value to be *stabler*, not for this to go.
- **Every colour is a token and every pair clears AA**, including the 5.22:1
  glyph most systems get wrong. Both hit targets are 36px.
- **No overflow at 320px** (`document.scrollWidth === 320`, measured) **or at
  200% zoom** (measured at 640px CSS width). `.escalation` wraps rather than
  scrolling, `.btn-row` wraps, `.rule-head__label` takes `min-width: 0`.
- **Reduced motion.** Nothing on these three surfaces animates; the only
  transition is a 140ms colour fade on `.btn`, and the global block at
  `globals.css:294` collapses transition-duration as well as animation.
- **`payouts/[id]/not-found.tsx`'s hoisted `<title>`** and the measured
  prefetch-staleness reasoning behind it. That comment is a model of the kind.

## What I could not evaluate

- **Real screen-reader behaviour.** Findings 2, 4 and 6 are reasoned from the
  spec and from what Chromium exposes; I did not run NVDA, JAWS or VoiceOver.
  Finding 6 in particular ("`aria-busy` is announced inconsistently") is a claim
  about AT implementations, not one I measured here.
- **Firefox and WebKit.** The `:focus-visible`-on-programmatic-focus result in
  finding 4 is Chromium, verified. Firefox is likely to differ, which would make
  the ring browser-dependent — worth checking before designing around it either
  way.
- **Bundle magnitude** (finding 10). No build was run; the mechanism is certain,
  the size is not.
- **The dev-overlay badges** in the shots ("2 Issues" on the error boundary,
  "1 Issue" on both 404s) are Next's dev indicator. I have no access to what
  they report and did not run the app; if a fix pass has the dev server up, they
  are worth one click.
- **`global-error.tsx`'s absence** is settled and reasoned in the file; I did
  not attempt to falsify the claim that `RootLayout` has no request-time failure
  path.

## Contested — settled-taste items I think are wrong

Nothing. Every settled item I touched (gold off "Try again", no `global-error`,
the tight ramp under `--t-h2`, `page--narrow` on all three, hairlines over
cards) survives contact with these three surfaces, and finding 7 is written to
respect the gold ration rather than to reopen it.
