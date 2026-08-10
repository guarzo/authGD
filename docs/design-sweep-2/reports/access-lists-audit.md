# `/admin/access-lists` — audit

**Out-of-scope addition.** This surface appears in neither the owner's scope list
for this sweep nor the Aug-5 sweep. Nothing has ever reviewed it. Every finding
below is new, and the standard checks were run as genuinely open questions
rather than as confirmations. Separate this file cleanly if the owner does not
want the surface in the round.

Register: PRODUCT. Command: `$impeccable audit`.

## What the screenshots show

Both shots capture **state 1 of seven** — `grant-needed`, the state a fresh
install opens on. The fixture never granted the ACL scope, so the populated
monitor was never photographed.

At 1440×900: an `<h1>`, a two-line sentence, and two buttons ("Grant access" in
gold, "Check now" outlined). The rendered content occupies roughly the top-left
580×180 of the fold. Below y≈272 the page is empty `--void` all the way to 900,
and right of x≈700 it is empty all the way to 1440. Nothing else is on screen.

At 390×844: the same three elements, the nav taking 215px of the 844, content
ending at y≈420, and 420px of empty ground under it.

The gold ration is respected in both — one primary, and it is the remedy.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Drawer control at the wrong hit grade; a disclosure name that mutates on a timer. Contrast, semantics, labelling and focus all clear. |
| 2 | Performance | 4 | One batched name lookup, five parallel reads, shared 30s ticker, no ESI on render. |
| 3 | Responsive | 3 | Wraps correctly at 320px; the column it wraps inside is unearned at every width. |
| 4 | Theming | 3 | Tokens used throughout; one `<select>` escapes the field vocabulary entirely. |
| 5 | Anti-patterns | 4 | No cards, no gradients, no hero metric, no glass. Reads as authored. |
| **Total** | | **17/20** | Good — the weak dimensions are narrow and fixable. |

---

## Findings

### 1. "Check now" is offered, and confirms success, in the two states where it provably cannot do anything

- **Severity:** Serious
- **Where:** `src/app/admin/access-lists/page.tsx:153-160`, against
  `src/jobs/access-lists.ts:59-62`
- **Cost:** The `checkNowAction` form is rendered unconditionally, outside the
  `showsObservations(state)` gate that hides everything else. In
  `grant-needed` — the state both screenshots show, and the state every new
  deployment opens on — there is no holder, so the job returns
  `{ status: "ok", counts: { noHolder: 1 } }` having read nothing. The admin
  gets back `"Check queued at 09:41:22.418 UTC. Reload this page once the
  worker has run."`, reloads, and sees a byte-identical page. They now cannot
  tell whether the worker is dead, the queue is stuck, or the feature is simply
  unconfigured, and the one sentence on the page ("nothing can be read") reads
  like a fault report rather than a setup step, so it does not settle the
  question either.
- **Fix:** Wrap the `checkNowAction` form in the same `showsObservations(state)`
  condition the watched-list region already uses. In states 1 and 2 the remedy
  button is the only honest control on the page, and removing the second one
  also removes the choice a first-time admin has to make between two controls
  where only one works.
- **Principle:** Product register — every control has a defined behaviour;
  a control that reports success for a no-op is worse than an absent one.
  Also PRODUCT.md's state-before-action ordering.

### 2. `page--wide` is unearned in all seven states, and the first-run state is a 78rem column holding one sentence

- **Severity:** Serious
- **Where:** `src/app/admin/access-lists/page.tsx:133`; whole surface
- **Cost:** This is the brief's pattern 1 in its purest form, and it is the
  state every new install lands on. But it is not only the empty state: the
  widest thing this page can ever render is `AccessListDetail`'s two-column
  Character/Corporation table, inside a drawer, inside a list that declares no
  `max-width` of its own (`globals.css:4625-4631`). At 1248px a watched row's
  name sits at the left edge and its drift `Status` and age float somewhere in
  the middle of an otherwise empty band, and the page runs long instead of
  wide — which is exactly what `/account` was fixed for. The settled rule is
  "narrow surfaces cap their contents, never the column"; `.acl-list` caps
  nothing.
- **Fix:** Two separate changes. (a) Cap `.acl-list`'s inline size to something
  its content earns — `--measure-crew` is the nearest existing token and the
  row's three values do not want more — so the status and age read as a
  right-hand column rather than as floating debris. (b) Give states 1 and 2
  something to occupy the field, or accept the narrow column for them: this is
  a first-run screen and it currently teaches nothing. What the ACL scope is,
  what the page will show once it has one, and which character should hold it
  are all facts the admin needs and none are on screen.
- **Principle:** Pattern 1 (unshaped field). Product register — "empty states
  that teach the interface, not 'nothing here'".

### 3. "Stop watching" inside an open drawer is the 28px in-row grade; the settled rule gives a drawer control 36px

- **Severity:** Serious
- **Where:** `src/app/admin/access-lists/page.tsx:304-318`, rendered at
  `page.tsx:256` inside the `Disclosure`; `globals.css:2813-2819`
- **Cost:** `StopWatching` renders one component in two structurally different
  positions with one class string. On a clean row it sits inline at the end of
  the row and 28px is correct. Inside the drawer at `page.tsx:256` it is a
  standalone control below the drawer's content — which the sweep's settled
  constraints name explicitly: "A disclosure drawer is not in-row for this
  purpose and takes 36px." An admin on a touch device, working through drifted
  lists, gets an 8px-shorter target on exactly the rows that carry the most
  content above the button. It clears WCAG 2.5.8's 24px floor, so this is the
  project's own rule being broken, not the standard's.
- **Fix:** The codebase already contains this exact buy-back twice, and the
  precedent is the fix: `.inline-edit--standalone .btn--quiet`
  (`globals.css:2831-2840`) and `.manifest-panel__controls .btn--quiet`
  (`globals.css:1603+`) both restore `min-height: 2.25rem` and `padding: var(--s-2)
  var(--s-4)` for a quiet control that is standalone rather than in-row. Add a
  third selector on `.acl-list__disc > div > .btn`. Two grades, no third — the
  drawer button just needs to be in the right one.
- **Principle:** Settled constraint — two hit-target grades, 36px standalone /
  28px in-row, and no third.

### 4. The drift summary is a sentence rendered in the 11px uppercase mono state register, and the codebase has already written down why that is wrong

- **Severity:** Moderate
- **Where:** `src/app/admin/access-lists/view.ts:205-222`;
  `src/app/globals.css:4693-4702`
- **Cost:** `rowSummary` produces strings like `1 missing access · 1 has access,
  not a member` and hands them to `<Status>`, which is `--t-label` (11px), mono,
  weight 600, uppercase, with `--track-value`. Uppercase removes word-shape
  cues, and this is the smallest step on the ramp — so the one line on each row
  that says what is actually wrong is the hardest line on the page to read, and
  a row's drift is what an admin came here to scan. The CSS author already
  noticed: the comment at `globals.css:4693-4698` says in as many words "this
  page's drift summary is a sentence, not a token", then fixes only the
  wrapping and leaves the register.
- **Fix:** `.st--lead`'s rule (`globals.css:2572+`) already states the remedy and
  the reasoning, for the identical problem on `/account`: *"Uppercase and the
  wide tracking come off deliberately: they are legible devices at 11px, where
  they mark a value in a table, but at this size they turn a sentence into what
  reads like a section heading. Sentence case keeps it a statement."* Apply
  `text-transform: none; letter-spacing: 0` to `.acl-list__head .st` alongside
  the `white-space` override already scoped there. Do not change the size — 11px
  is fine once it is sentence case, and the tone dot and its wording both stay.
- **Principle:** The project's own `.st--lead` ruling. Also the two-family
  split's actual content: state is monospaced, but this string is prose wearing
  state's clothes.

### 5. The disclosure control's accessible name changes every 30 seconds

- **Severity:** Moderate
- **Where:** `src/app/admin/access-lists/page.tsx:217-231` (the `head` span
  becomes `<summary>` at `page.tsx:249`), with `RelativeTime` at 224-229
- **Cost:** `head` is passed as `Disclosure`'s `summary`, and no `ariaLabel` is
  passed, so the `<summary>`'s accessible name is computed from its contents —
  which include the `RelativeTime` element. That element re-renders on a shared
  30-second ticker (`_components/relative-time.tsx:36-60`). A screen-reader user
  who opens a drawer, reads the detail, and navigates back to the control finds
  it named something different from what they left; a user driving by voice
  ("click Alpha ACL, four minutes ago") loses the target mid-sentence. The
  visible `+`/`−` pseudo-element (`globals.css:4714-4722`) also enters the name
  in Chromium and Firefox, so the name opens with a punctuation mark.
- **Fix:** Pass `ariaLabel={label}` — or `` `${label}, ${rowSummary(row)}` `` — to
  the `Disclosure`, which already supports it and documents the label-in-name
  constraint (`_components/disclosure.tsx:40-43`). Both start with the visible
  text, so WCAG 2.5.3 holds. The age stays visible and stays out of the name,
  which is the correct division: it is context, not identity.
- **Principle:** WCAG 4.1.2 (name changing without user action) and 3.2.4
  Consistent Identification. Note: `/admin/sync`'s `.strip__disc > summary`
  carries `.ago` the same way (`globals.css:4142`, `admin/sync/page.tsx:435-449`)
  — same defect, different surface, and that one was in scope and not filed.

### 6. The add-to-watchlist form is the only place in the app where a `<select>` and its `<label>` fall outside the design system

- **Severity:** Moderate
- **Where:** `src/app/admin/access-lists/page.tsx:170-180`
- **Cost:** Three defects from one omission, verified against the app's only
  other `<select>` (`src/app/payouts/page.tsx:194-207`):
  1. The `<select>` carries no `className`. Everything else in the app uses
     `.field` — `--void` ground, `--rule-strong` border, mono at `--t-data`,
     `--gold-dim` on hover, `--gold` border on `:focus-visible`, 36px min-height.
     This one gets the UA widget: proportional face, no gold focus border (the
     global ring still applies, so this is a vocabulary break, not a focus
     failure), and a UA height that sits under the 36px standalone grade. It
     renders dark rather than light only because `layout.tsx:47` declares
     `colorScheme: "dark"` — the contrast is fine, the consistency is not.
  2. The `<label>` carries no class, so it renders in the body face at body
     size. Every other form label in the app is in the documented label
     register (`.filters__label`, `.filter-form__label`, `.drawer__label`,
     `.crew__label` — `globals.css:375-392`): mono, `--t-label`, 600, uppercase.
  3. `defaultValue=""` matches no rendered `<option>` — the catalog options are
     the only ones present. The browser silently selects index 0, so the form
     works, but the declaration says a placeholder was intended and none exists.
     `/payouts` gets this right with an explicit `<option value="">any</option>`.
- **Fix:** `className="field"` on the select, `className="filter-form__label"`
  on the label, and either add the empty option or drop the `defaultValue`.
- **Principle:** Product ban — inconsistent component vocabulary across screens.
  "If the save button looks different in two places, one is wrong."

### 7. The removal confirmation names a number the admin has never seen

- **Severity:** Moderate
- **Where:** `src/app/admin/access-lists/actions.ts:79`
- **Cost:** `removeWatchAction` returns `` `Access list ${accessListId} removed
  from the watchlist.` `` — the raw ESI id. The page went to real trouble two
  files away to make sure a list is always called by its name: `page.tsx:216`
  computes `label = c.name ?? \`#${c.accessListId}\`` specifically so the visible
  name and the button's accessible name "can never disagree about what an
  unnamed list is called", and `AccessListDetail`'s docblock states the rule
  outright — "Names lead and ids are secondary throughout: the admin retypes
  these in-game, where the id is not what the client accepts." The one sentence
  confirming an irreversible-ish act is the one place that rule is dropped. An
  admin removing "Home Fleet ACL" from a list of five reads "Access list
  99000891 removed" and cannot confirm from the sentence that the right row
  went, because the row is already gone. Focus has just been moved onto that
  sentence, so it is also what a screen-reader user hears.
- **Fix:** Carry the label on the submit button that already carries the id, or
  have `removeWatch` return the removed row's name, and render
  `` `${label} removed from the watchlist.` `` with the `#id` fallback the page
  already computes.
- **Principle:** PRODUCT.md — the tool speaks in the operator's vocabulary. Same
  class as the Aug-5 sweep's closed "UUID recital" item on `/admin/audit`; this
  is a fresh instance on a surface that sweep never opened, not a re-report.

### 8. The lede does two jobs in one slot, and in state 1 it is the explanatory subtitle the brief warns about

- **Severity:** Minor
- **Where:** `src/app/admin/access-lists/view.ts:83-88`
- **Cost:** Six of the seven `monitorSentence` cases are live status about the
  holder — "Kestrel Vane is the holder", "…and its authorization has gone
  stale". The seventh opens "This page compares the alliance roster against the
  in-game access lists", which is a caption explaining what the page means,
  sitting under an `<h1>` that already says "Access lists". It occupies the
  status slot, so a returning admin's eye goes to the position that normally
  holds a state fact and finds a definition instead. It is also the sentence
  most likely to be read once and never again, taking up the page's best line.
- **Fix:** Split the two registers. The status sentence stays in `.lede`; the
  one-time explanation belongs with whatever fills the empty field in finding 2
  — a short "what this does / what you need" block that a configured install
  never renders at all.
- **Principle:** The brief's own smell — an explanatory subtitle under an H1
  usually means the surface needs work, not a caption.

### 9. `themeColor` is still the retired navy

- **Severity:** Minor
- **Where:** `src/app/layout.tsx:47` — **across surfaces**, not this one
- **Cost:** `themeColor: "#080f1f"` is blue at nearly four times red. The
  palette moved off the blue-slate axis deliberately and `--void` is
  `#0a0a0a` at chroma 0, which the token comment defends at length. On Android
  Chrome and as an installed PWA this paints the browser chrome navy directly
  above a neutral-black page, so the one surface the design cannot restyle is
  the one still wearing the old palette. Visible in the 390×844 context of every
  narrow shot in this sweep, including both of mine.
- **Fix:** `themeColor: "#0a0a0a"`, matching `--void`. This is a stale value, not
  a token retune, so it does not touch the "do not change colour tokens"
  constraint.
- **Principle:** Record contradiction — the shipped chrome contradicts the
  palette's own stated axis. Flagged here because I found it; it likely belongs
  to reviewer B and should be de-duplicated rather than counted twice.

---

## What is genuinely good and should survive

- **`monitorState`'s cascade, and its ordering argument.** `view.ts:40-72` puts
  the scope check before the token check because the plain re-auth link is what
  *drops* the ACL scope — so offering it first would send the admin round the
  loop that broke it. That is a real trap, correctly avoided, and the reasoning
  is written where the next person will hit it. Seven states, each with exactly
  one remedy, exhaustive over the union so a new state is a compile error rather
  than a dead end. Do not collapse this into a `Record`.
- **`rowHasDetail`.** A clean row gets no disclosure control at all, rather than
  a toggle that opens an empty box — and still gets its own inline "Stop
  watching", so the list an admin most wants to remove is not the one that is
  permanently unremovable. Both halves of that are right.
- **`rowTone` refusing `bad`.** Nothing on this page is a destructive act, so
  the alarm colour is never spent. `never read` is `off`, not a failure. This is
  the status-token rule working, in a place nobody was watching.
- **Honest staleness.** `observedAt` is the last *successful* read, never the
  last attempt, and a failed row still dates the answer under it
  (`page.tsx:222-229`, `view.ts:196-204`). `rowSummary` also refuses to print
  drift counts beside a read failure, because those counts describe an older
  read — that is a subtle correctness point about time, handled.
- **`allowEveryone` gets its own words.** Such a list has zero missing members
  by construction, so "in sync" would have been true and a lie. It says "open to
  everyone" instead.
- **Broad grants always carry "plus an unknown number of others."** The app
  holds no corp roster, so the covered count is ours only, and the copy never
  lets that be read as complete.
- **The single region-wide `ConfirmingForm`.** The docblock at `page.tsx:183-193`
  and `271-303` reasons correctly that both halves of the confirm pair must
  outlive a row's removal, and drops `pendingLabel` because a shared form's
  pending state would name the wrong row. That is a genuinely hard-won shape;
  do not "simplify" it back to per-row forms.
- **Contrast, measured.** Every colour pair on this surface clears WCAG 2.2 AA.
  `--ink` `#ece7de` on `--void` `#0a0a0a` is 16.11:1; `--ink-dim` `#bab3a9`
  9.54:1; `--ink-faint` `#90877e` 5.64:1 on void and 4.63:1 on a hovered
  `--hull-hi` `#21201f` row; `--signal-warn` `#ff9f5f` 9.75:1. `.acl-detail th`
  at `--ink-faint` on `--hull` `#151514` is 5.21:1. Nothing here is close to the
  floor.
- **Semantics and keyboard.** Heading order is clean (h1 → h2 → h3, no skips).
  The detail table has `<thead>`/`<tbody>` and `scope="col"`. The summary's
  focus ring is explicit and inset (`globals.css:4728-4731`), not suppressed.
  Focus is deliberately moved to the confirmation after every action, by two
  different mechanisms chosen per control, and neither announces twice.
- **Performance.** Five reads in one `Promise.all`, one batched
  `lookupEntityNames` for every id every drawer will print rather than one per
  row, no ESI call on render at all (and the docblock says why: a live fetch
  would burn a refresh-token rotation per page load). No animation of layout
  properties. `RelativeTime` shares one 30s ticker document-wide.
- **Anti-patterns: clean.** No cards, no gradient text, no glass, no hero
  metric, no identical card grid, no modal. Hairlines and type carry the
  structure. This does not read as generated.

## What I could not evaluate, and why

- **The populated monitor.** Both shots are state 1. Six of the seven states,
  the watched list at realistic length, an open drawer, and the drift `Status`
  in context were never photographed. Findings 2 and 4 reason about the
  populated layout from the CSS and the content set and say so; they are
  inferences, not observations, and a shot of a five-row watched list with one
  drifted row open would confirm or kill both cheaply.
- **200% zoom and 320px reflow, as measured facts.** I did not run a browser —
  this is a read-only review and starting the dev server was out of scope. The
  structural evidence is good: `.acl-list__head` is `flex-wrap: wrap` with a
  row-gap, `.btn-row` wraps, the detail table is inside a `Scroller`, and
  `globals.css:4693-4698` records an actual 320px measurement (388px of mono
  uppercase in a 288px box) being fixed. I have no reason to think either gate
  fails and no measurement saying it passes.
- **Screen-reader behaviour of the two focus-move confirmations.** Both
  `ConfirmNotice` and `ConfirmGroup` focus a `tabIndex={-1}` `<div>` carrying
  `live={false}` text, relying on the focused element's name being read. That
  pattern is shipped and reviewed on `/account`, `/admin/accounts` and
  `/admin/sync`, so I did not re-open it — but I did not verify it with an AT
  either, and finding 7's cost depends on it working.
- **Whether the owner wants this surface at all.** It is out of scope by the
  brief's own statement. Finding 9 in particular is app-wide and probably
  belongs to reviewer B.

## Recommended actions

1. **[P1] `$impeccable harden`** — gate `checkNowAction` on
   `showsObservations`, and name the removed list rather than its id (findings
   1, 7).
2. **[P1] `$impeccable layout`** — cap `.acl-list`'s contents, and give states
   1-2 something that earns the column or a narrower one (finding 2).
3. **[P1] `$impeccable adapt`** — third `.btn--quiet` buy-back selector for the
   drawer's standalone control (finding 3).
4. **[P2] `$impeccable typeset`** — de-case the drift summary, following
   `.st--lead`'s written ruling (finding 4).
5. **[P2] `$impeccable audit`** — the mutating disclosure name, here and on
   `/admin/sync` (finding 5).
6. **[P2] `$impeccable polish`** — `.field` and the label register on the add
   form; `themeColor` (findings 6, 9).
7. **[P3] `$impeccable clarify`** — split the lede's two registers (finding 8).

## Contested — settled taste I think is wrong

Nothing. The two settled items this surface leans on hardest — `.st--ok` being
`--ink-dim` rather than green, and gold rationed to one primary action — are
both doing visible work here, and I would not change either.
