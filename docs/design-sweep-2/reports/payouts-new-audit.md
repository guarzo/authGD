# `/payouts/new` — audit

`$impeccable audit`. Register: **product**. Read-only pass; no source was
modified.

Screenshots read before source: `05-payouts-new.wide.png` (1440×1477) and
`05-payouts-new.narrow.png` (390×1546), both `fullPage`.

## What the screenshots show, before any explanation

**Wide.** A page stamp, an H1, a two-line lede, then a single bordered panel
starting at x=120 and ending at x=731 — 611px of a 1248px page column. Nothing
is to the right of it, for the panel's entire 1,130px height. Inside: three
short fields (Name, Date pre-filled `08/10/2026`, Battle report), a 230px-tall
textarea, a 190px-tall textarea, and one gold button. The capture is 1,477px
tall. On a 1440×900 window that is 1.64 screens for six inputs, and the gold
button — the only primary action on the surface — sits roughly 413px below the
fold, as does the entire ROSTER section. Half the page column is empty and the
page is scrolling.

**Narrow.** The same stack, 1,546px tall on an 844px viewport. Fields fill the
column properly; the loot label wraps to two lines. Nothing overflows
horizontally. The dark circle overlapping the loot label at x≈38 is the Next
dev-overlay indicator, not app UI — I did not count it.

Measured colours, converted from OKLCH to rendered sRGB rather than judged in
the authoring space: `--void` `#0a0a0a`, `--hull` `#151514`, `--rule-strong`
`#787370`, `--ink` `#ece7de`, `--ink-faint` `#90877e`, `--gold` `#f1c035`.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Rejection is announced twice and the field in error is never identified programmatically |
| 2 | Performance | 4 | Five controlled fields, one client leaf, no images, nothing to optimise |
| 3 | Responsive | 3 | 320px and 200% zoom both hold; the wide viewport is the one that fails, by running long instead of wide |
| 4 | Theming | 4 | Every value is a token; no hard-coded colour in either file or in `.form-panel`/`.field` |
| 5 | Anti-patterns | 4 | The panel is one of the two sanctioned card exceptions and earns it; no other tell |
| **Total** | | **18/20** | Excellent — but see finding 1, which the score band undersells |

## Anti-patterns verdict — pass

No AI tells. `.form-panel` is a card, and it is one of the two the system
sanctions by name; it carries no registration ticks (globals.css:3212-3221
argues why, correctly). No gradient text, no glass, no hero metric, no card
grid, no side-stripe border — `.notice` is explicitly commented "Full border,
never a side stripe" (globals.css:3427). Structure is hairline rules and mono
section labels. This does not read as generated.

---

## Findings

### 1. The panel gives the form a ground; it does not stop the page running long instead of wide

- **Severity:** Serious
- **Where:** whole surface. Anchored at `src/app/globals.css:3222-3228`
  (`.form-panel { max-width: var(--measure) }`) and
  `src/app/payouts/new/new-operation-form.tsx:126-162` (the two textareas
  stacked in one column).
- **Cost:** An operator writing up a fight cannot see the button that creates it
  without scrolling — at 1440×900 the "Create operation" button and the entire
  ROSTER section are below the fold, while 637px of the page column (51% of it)
  sits empty beside the form for the whole 1,477px scroll. They scroll down to
  press, and if the submit is rejected the notice renders back up at the top,
  out of view, which is the exact problem
  `new-operation-form.tsx:73-75`'s focus effect exists to paper over. The
  layout creates the distance that the focus move then has to travel.
- **Fix:** This is the brief's pattern 1 and the panel answers only half of it.
  The panel does succeed at "a bare form on the page void read as a settings
  row" — at 611px on `--hull` with a 3.90:1 border it reads as an object. What
  it does not do is shape the field. Above ~64rem, lay the panel out in two
  tracks rather than one: the three short OPERATION fields (Name, Date, Battle
  report) in a left track, the LOOT and ROSTER pastes side by side in the
  right, submit under both. That is the difference between 1,477px and roughly
  one screen. Scope it to a `min-width` branch on `.form-stack` inside
  `.form-panel` and lift the panel's own cap from `--measure` (a *reading*
  measure, 68ch, and these are fields not prose) to the 57rem content cap
  `.page--narrow > :where(*)` already grants it. The single-column stack stays
  exactly as it is below the branch, so the narrow shot does not change.
- **Principle:** Sweep pattern 1 — content occupying a fraction of the column
  with the remainder empty, and the page running long instead of wide.

### 2. Four of the form's five error messages cannot be reached through the form

- **Severity:** Serious
- **Where:** `src/app/payouts/new/new-operation-form.tsx:96` (`required`), `:111-112`
  (`max={today}` + `required`), `:119` (`type="url"`), against
  `src/app/payouts/errors.ts:34-44`
- **Cost:** An operator who pastes a zKillboard link as `zkillboard.com/related/…`
  — no scheme, which is what you get from a copied breadcrumb or a typed-out
  link — gets the browser's own bubble, "Please enter a URL.", which does not
  say what is wrong. The app wrote the sentence that does say it ("Battle
  report links must start with http:// or https://") and that sentence never
  renders. The bubble also auto-dismisses and cannot be recalled, so a screen
  reader user who moves focus away loses the message entirely, where the app's
  own `Notice` is persistent and focusable.
- **Fix:** The mechanism: the browser fires `submit` only after interactive
  constraint validation passes, and React's `<form action>` integration runs
  from that event, so `required`, `type="url"` and `max` all intercept before
  `createOperationAction` is ever called. `name_required`, `date_invalid`,
  `url_invalid` and `url_scheme` are therefore server backstops for scripted
  requests only; `appraisal_failed` is the sole code an operator can actually
  see. Two coherent answers, pick one. Either accept that and stop maintaining
  four messages that read as if they render (they end "Everything else you
  typed is still here.", a promise about a screen nobody sees) — or put
  `noValidate` on the `<form>` and let the server's own copy be the error UI
  everywhere, which is the only way the http/https sentence reaches anyone.
  I would take the second: this form already returns state rather than
  redirecting precisely so rejections are answered in place, and native bubbles
  are the one error channel on this surface that is neither styled, persistent,
  nor written by anyone here.
- **Principle:** WCAG 3.3.3 Error Suggestion — the suggestion exists and is not
  shown. Also: two error surfaces for one form, and the better one is dead code.
- **Supporting evidence:** no e2e spec asserts any of these four messages;
  `e2e/payouts.spec.ts` and `e2e/submit-guard.spec.ts` reach `/payouts/new` six
  times and never a rejection notice. Nothing tests them because nothing can.
  (Verified from source and the HTML spec's validation ordering; I did not run
  a browser — see "What I could not evaluate".)

### 3. The roster and loot pastes are wide open to autocorrect and autocapitalisation

- **Severity:** Serious
- **Where:** `src/app/payouts/new/new-operation-form.tsx:143-149` and `:155-161`
  (both `<textarea>`s), and `:91-97` (the Name input)
- **Cost:** `<textarea>` defaults to `autocapitalize="sentences"` and
  `autocorrect="on"`. An operator typing a roster on a phone at 1am gets EVE
  character names silently rewritten to whatever dictionary word is nearest —
  and `resolveRosterNames` matches exactly, so a corrected name does not fail
  loudly, it comes back as an *unresolved* entry reported after the redirect on
  `/payouts/[id]?unresolved=…`, by which point the operation exists and the
  operator has to work out which of sixteen names the phone changed. The same
  attributes squiggle every item name in a 300-line loot paste. Separately,
  `name="name"` on a plain text input is the strongest autofill heuristic there
  is: browsers offer the operator's own saved personal name as the operation
  title.
- **Fix:** `spellCheck={false} autoCapitalize="none" autoCorrect="off"` on both
  textareas — they hold machine paste, not prose — and `autoComplete="off"` on
  the Name input. Five attributes, no layout change.
- **Principle:** Not a WCAG clause. Input hygiene: a field that accepts a
  machine format must not be handed to a prose-correcting keyboard.

### 4. The rejection is announced twice, against the primitive's own documented rule

- **Severity:** Moderate
- **Where:** `src/app/payouts/new/new-operation-form.tsx:82-84` and `:73-75`
- **Cost:** `Notice tone="bad"` renders `role="alert"` (`ui.tsx:320`), so the
  message is announced assertively the moment it commits; the effect then moves
  focus to that same node, and a screen reader announces a newly-focused
  element's text again. The operator hears the rejection twice, or hears the
  focus announcement cut off the alert mid-sentence. On a form whose whole
  rejection design is "say it once, clearly, where they are standing", that is
  the one thing it does not do.
- **Fix:** Pass `live={false}` here. `Notice`'s own docblock (`ui.tsx:285-288`)
  already states the rule — "a surface that already announces itself by moving
  focus gets its heading preempted by an assertive region rendering in the same
  commit" — and applies it to `error.tsx`, where the focus target is a
  *different* node. Here the focus target *is* the live region, which is the
  same collision at closer range. Focus movement alone carries the message to
  both audiences: a focused `<p tabindex="-1">` is announced, and the sighted
  operator is scrolled to it. Nothing else changes; the `id`/`tabIndex`
  contract is untouched.
- **Principle:** WCAG 4.1.3 Status Messages, applied in the direction the
  primitive already documents.

### 5. The field in error is never identified programmatically

- **Severity:** Moderate
- **Where:** `src/app/payouts/new/new-operation-form.tsx:89-124` (no
  `aria-invalid` or `aria-describedby` on any input)
- **Cost:** After a rejection the operator is standing on the notice with no
  machine-readable link from it to the field. For `name_required` the next tab
  stop happens to be the right field, which is luck rather than design; for
  `url_invalid` or `url_scheme` a screen reader user tabs past Name and Date
  with nothing marking which of the three is wrong, and the fields themselves
  give no non-visual signal that anything was refused. A sighted operator has
  the same problem in reverse: the notice names the field in prose and no
  field is highlighted.
- **Fix:** Derive the offending field from `state.code` — the mapping is
  one-to-one (`name_required`→name, `date_invalid`→date,
  `url_invalid`/`url_scheme`→battleReportUrl, `appraisal_failed`→lootPaste) —
  and set `aria-invalid="true"` plus `aria-describedby={ERROR_NOTICE_ID}` on
  that one input. Consider moving focus to the field rather than the notice
  once `aria-describedby` points at it, which would collapse findings 4 and 5
  into one better behaviour: the field is announced, its description (the
  notice text) is announced with it, once.
- **Principle:** WCAG 3.3.1 Error Identification. The text description is
  present, so this is not a failure at A; the programmatic association is the
  gap.

### 6. Nothing on the form says the date is EVE time

- **Severity:** Moderate
- **Where:** `src/app/payouts/new/page.tsx:27` and
  `new-operation-form.tsx:106-113`
- **Cost:** The default is `new Date().toISOString().slice(0,10)` — today in
  **UTC** — and the action parses the submitted `yyyy-mm-dd` as UTC midnight.
  Both are right, and both are invisible. A US-Pacific operator writing up a
  fight at 8pm local on the 9th sees `08/10/2026` pre-filled by a field labelled
  only "Date (required)", concludes the form is wrong, and corrects it to the
  9th — dating the operation a day before the fight for everyone reconciling
  against EVE time later. The source comments at page.tsx:25-26 and
  new-operation-form.tsx:101-104 both explain this to the next developer and
  neither explains it to the operator.
- **Fix:** Put it in the label: "Date (required, EVE time)". The label already
  carries requiredness for the same reason (`new-operation-form.tsx:87-88`), so
  this needs no new mechanism. A hint below the field is the alternative, and
  `.form-stack__field` already supports one (globals.css:3199-3202) — but the
  label is where an operator reading fast will see it.
- **Principle:** WCAG 3.3.2 Labels or Instructions.

### 7. `max={today}` goes stale across EVE downtime, and there is no code for a date the server refuses

- **Severity:** Minor
- **Where:** `src/app/payouts/new/new-operation-form.tsx:111`,
  `src/app/payouts/actions.ts:166-180` (`parseYmd`),
  `src/app/payouts/errors.ts:34-44`
- **Cost:** *Re-opening nothing — this adds to the known-open "future-date guard
  is client-only" item, from the other direction.* Two consequences that entry
  does not name. First, `today` is computed once at render (page.tsx:27), so a
  composer left open across 00:00 UTC has a `max` of yesterday: the operator
  picks the new day's date and the browser refuses with "Value must be
  2026-08-10 or earlier", with nothing on the page explaining why the correct
  date is rejected. Corps that fight around downtime hit this. Second,
  `NEW_OPERATION_ERRORS` reserves no code for a future date at all — so closing
  the server-side gap is not a one-line check in `parseYmd`, it needs a new code
  and new copy in the same change, which is worth knowing before the backlog
  item is picked up.
- **Fix:** For the stale-`max` half: compute `max` in the client from
  `new Date()` at submit time, or drop `max` and let the server refuse with a
  real message once the guard exists. For the second half: add a
  `date_future` entry to `NEW_OPERATION_ERRORS` when the server check lands.
- **Principle:** none cited — this is a correctness observation, not a rule
  violation.

---

## What is genuinely good and should survive

- **The panel earns its exception.** `.form-panel` at 611px on `--hull` with a
  `--rule-strong` border reads as an object rather than a settings row, and it
  refuses registration ticks on the stated grounds. Finding 1 asks it to be
  *shaped*, not removed. Do not delete the panel to fix the whitespace.
- **`--void` inset into `--hull` measures clean.** The lead asked; here are the
  numbers. Field boundary `--rule-strong` `#787370` against the panel's `--hull`
  `#151514` is **3.90:1**, over the 3:1 that WCAG 2.2 AA 1.4.11 asks of a UI
  component boundary. `--ink` `#ece7de` in the field on `--void` is 16.08:1. The
  fill difference alone (`--void` on `--hull`) is 1.08:1 and carries nothing —
  the border does all the work, which is the right division. Section labels
  `--ink-faint` `#90877e` on `--hull` measure 5.18:1 at 11px. The gold button's
  `--void`-on-`--gold` label is 11.63:1. Nothing on this surface fails contrast.
  (Note for whoever holds DESIGN.md: globals.css:1521-1524 states
  `--ink-faint` on `--hull` as 5.58:1; I measure 5.18:1. Both pass, so it
  changes no decision here, but the record-contradiction reviewer may want it.)
- **Hit targets are uniform and correct.** `.field` and `.btn` both carry
  `min-height: 2.25rem` (36px), the standalone grade, against a 24px AA floor.
  No control on this surface is in-row, so the 28px grade correctly does not
  appear.
- **Keyboard traversal is exactly right.** Six stops, DOM order equals visual
  order, no trap, no positive `tabindex`. The `Notice` carries `tabIndex={-1}`
  so a landing place never becomes a stop on the way to the controls — the
  paired `id`/`tabIndex` contract in `ui.tsx` is working as documented.
  `:focus-visible` is a 2px gold outline at 2px offset (globals.css:289-292),
  gold on `--hull` at 10.73:1, and the panel's 32px padding leaves room for the
  ring on every field including the textareas.
- **Controlled fields, and the reason for them.** The docblock at
  `new-operation-form.tsx:34-41` is right: React DOM resets *uncontrolled*
  fields when an action settles, success or rejection alike. On a form whose
  reason for existing is surviving a rejection with a 300-line paste intact,
  `useState` on every field is not over-engineering. Do not "simplify" these to
  `defaultValue`.
- **320px and 200% zoom both hold.** `.form-panel`'s narrow padding override
  (globals.css:5151-5158) is present and its measurement is correct: at 320px
  the fields get 224px rather than 192px. At 200% zoom on a 1280px screen the
  effective 640px viewport hits the same `max-width: 40rem` branch and the
  panel shrinks below its 68ch cap; no horizontal scroll either way, and every
  size on the surface is in `rem` so text-only zoom scales cleanly too.
- **The operator gate is a redirect, not a disabled form.** `page.tsx:18-22`
  and its comment. A non-operator never meets a form that would reject them.
- **The reserved `Notice` slot.** Mounted unconditionally and taken out of flow
  when empty (globals.css:3459-3480), so the live region is registered before
  its text arrives and costs no dead space. Finding 4 changes `live`, not this.

## Patterns and systemic issues

- **Em dashes in user-facing copy.** `NEW_OPERATION_ERRORS.appraisal_failed`
  ("Nothing was created — adjust the paste…") uses one, as do most entries in
  `OPERATION_ERRORS`. The shared design law bans them. This is app-wide rather
  than a defect of this surface, and it belongs to whoever owns copy across all
  of `errors.ts`; noting it here so it is counted once, not litigated per page.
- **The native-validation gap in finding 2 is not local to this form.** Any
  other form in the app that pairs `required`/`type=`/`min`/`max` with a
  hand-written server rejection message has the same dead copy. Worth one grep
  when finding 2 is worked, rather than a second report.

## What I could not evaluate, and why

- **The rejection path in a live browser.** Finding 2's mechanism is reasoned
  from the HTML spec's validation ordering plus React's use of the `submit`
  event, and corroborated by the absence of any e2e that reaches those four
  codes — but I did not run a browser to watch a bubble appear. I am read-only
  on source, other agents are working this session, and this worktree's e2e run
  shares one database. Worth thirty seconds of manual confirmation before the
  fix is scoped; the two remedies differ.
- **Whether `OPERATION_ERRORS` ships to the client.** `errors.ts` exports both
  maps from one module and the client component imports one of them; whether
  tree-shaking drops the other needs a production build to answer. It is ~3.5KB
  of strings either way, which is why I did not spend the build.
- **Screen-reader behaviour on the double announcement (finding 4).** The
  collision is structural and the primitive documents the rule it breaks, but
  the exact outcome — announced twice, or alert truncated by the focus
  announcement — differs by AT and browser pairing, and I tested with neither.
  The fix is the same in both cases.
- **Real appraisal latency.** `appraisal_failed` is the one rejection an
  operator can actually reach, and how long they wait before it arrives depends
  on triff.tools. `pendingLabel="Creating…"` plus `aria-busy` is the whole
  in-flight signal, and `onRefused` is not wired here, so a second press during
  a slow appraisal is silently refused. I could not time the round trip, so I
  did not file it; if appraisal routinely runs past a couple of seconds it is
  worth revisiting.

## Contested — settled taste I would push back on, once

Nothing. The two decisions this surface leans on hardest — the card exception
for `.form-panel` and no registration ticks on it — are both right, and finding
1 works with the panel rather than against it.
