# `/payouts/new` — critique

`$impeccable critique`, register: PRODUCT. Surface block 3.

## What I see, before explaining it

**Wide (1440×900 viewport, 1440×1477 fullPage).** A stamp, an H1, a two-line
lede, and then one outlined rectangle hanging on the left. The rectangle runs
from x=120 to x=731 and from y=261 to y=1380: 612 × 1119. Everything to its
right is empty ground, 709px of it, half the screen. Inside the rectangle,
three short fields at the top and then two large empty boxes, one 234px tall
and one 191px tall, with nothing in them. The one gold object on the page — a
164 × 36 button reading CREATE OPERATION — sits at y=1312, which is 412px below
the bottom of the viewport. On the screen an operator actually sees, this page
is a heading, three inputs, and the top 169px of an empty black box.

**Narrow (390×844 viewport, 390×1546 fullPage).** The same panel, now 355 of
390px wide, so it is a thin outline hugging both edges. The two empty boxes are
*the same 234px and 191px* they were at desktop — a quarter of the phone
viewport each. The fold lands 27px inside the first one. The button is at
y=1421, 577px below the fold. Two labels wrap to two lines.

At both viewports the largest thing on the page is an empty box, and at both
viewports the button that does the thing is off-screen.

(A dark circular badge with a stylized "N" appears at the left edge of both
shots. That is the Next.js dev-overlay, not the design. Ignored throughout.)

## Does `.form-panel` answer pattern 1?

**Half.** Pattern 1 is two claims joined: *content occupying a fraction of the
column with the remainder empty*, **and** *the page running long instead of
wide*. The panel answers the first clause and does nothing about the second.

The first clause is genuinely answered. `page.tsx:52`'s comment is right that a
bare `.form-stack` on the void would have read as a settings row; the panel
draws a boundary, so the form is an object rather than a leak, and there is no
ambiguity about where it starts and stops.

The second clause is untouched, and by the numbers it is worse here than the
pattern usually is. The panel is 612px in a 1440px viewport (42.5%), leaving
709px (49.2%) of empty ground to its right, while the page runs 1477px — 1.64
screens — and puts its only primary action below the fold. Drawing a border
around a column of content does not stop the content from being a column. The
panel converted "unshaped" into "shaped and still tall and narrow." Findings 1
and 2 below are the two independent halves of fixing that, and neither one
fixes the other.

---

## Findings

### 1. The primary action is below the fold at both viewports, pushed there by the two fields the page's own lede calls optional

- **Severity:** Serious
- **Where:** `src/app/payouts/new/new-operation-form.tsx:146` (`rows={10}`) and
  `:158` (`rows={8}`); consequence is the whole surface.
- **Cost:** An operator writing up a fight at 1am on a phone fills in a name,
  accepts today's date, and then has to scroll past 425px of boxes they were
  explicitly told they can leave for later before they can find out where the
  Create button is. The two required fields take 79px of a 1119px panel; the
  two optional pastes take 425px, 38% of it. The page's own lede says "it opens
  a draft you can fill in now or later", and the layout spends more than five
  times as much vertical on "now" as on the fields that are actually required.
  The copy and the shape disagree, and the shape is what people obey.
- **Fix:** Two mechanical changes, either of which alone gets Create above the
  fold at 1440×900:
  - Put Loot and Roster inside `Disclosure`
    (`src/app/_components/disclosure.tsx:60`), summaries "Loot paste" and
    "Roster paste". It is `<details>`-based, so the collapsed textareas stay in
    the DOM and still submit — this does not break the paste-survives-rejection
    property the whole component exists for. **Constraint:** pass
    `defaultOpen={lootPaste !== ""}` / `defaultOpen={rosterPaste !== ""}`, or a
    rejected submit hides a 200-line paste behind a closed twisty, which is
    exactly the failure the file's docblock is written against.
  - Or drop to `rows={4}` / `rows={3}` and let the textareas grow. `rows` is a
    fixed count chosen once and applied at every viewport; 10 rows is 26% of a
    900px desktop and 28% of an 844px phone, which is not a size anybody chose
    for the phone.
- **Principle:** Progressive disclosure — complexity revealed when needed.
  Nielsen #8 (aesthetic and minimalist design): the page gives the most space to
  the least-required thing.

### 2. Half a screen of empty ground at wide, while the page runs 1.64 screens tall

- **Severity:** Serious
- **Where:** whole surface. The rule is `src/app/globals.css:3222`
  (`.form-panel { max-width: var(--measure) }`, 68ch ≈ 612px), inside a
  `.page--narrow` content column that is 1200px wide at this viewport.
- **Cost:** The operator scrolls, twice, past a screen that is 49% blank. The
  form has two natural groups — three short identifying fields, and two bulk
  pastes — and at 1440px there is room to stand them side by side and end the
  scroll entirely. Instead the panel takes a reading measure it does not need:
  68ch is a prose measure, and the widest thing in this panel is a 60-character
  label, not a paragraph.
- **Fix:** Above ~64rem, make `.form-stack` inside `.form-panel` a two-column
  grid: Operation (name / date / battle report) left, the two pastes right,
  Create spanning below. The panel widens toward the page column it already
  sits in and the page stops being taller than a screen. This is the fix that
  finding 1's disclosure does *not* deliver — collapsing the pastes shortens the
  page but leaves the 709px of void exactly where it is.
- **Principle:** Pattern 1, second clause. Also product-register layout: use the
  structural axis the viewport actually gives you.

### 3. The panel is carried by its border, not by the ground its own comment credits

- **Severity:** Moderate
- **Where:** `src/app/globals.css:3222-3228` and the comment block above it
  (from `:3205`); observable in the wide shot at any y inside the panel.
- **Cost:** `--hull` renders `#151514` and `--void` renders `#0a0a0a`. That is
  1.08:1 — no one sees it. The `page.tsx:46-51` and `globals.css` comments both
  argue the panel is justified because "the ground change alone carries the
  panel"; sampled from the shot, the only thing carrying the panel is the 1px
  `#787370` border (3.90:1 against the fill). So one of the system's two
  sanctioned card exceptions is, in fact, a hairline outline — the shape "No
  cards" exists to prevent — and it is justified in the source by a mechanism
  that is not operating. Worse, both textareas are filled with `--void`
  `#0a0a0a`, the *page* ground: the single largest object inside the panel is a
  612 × 234 rectangle of the exact colour the panel is supposed to be
  distinguishing itself from, so the panel reads as a frame around a hole.
- **Fix:** Not a token change (I am not proposing retuning `--hull`). Either
  make the panel's separation honest — drop the border and let a real ground
  step carry it, which means the ground step has to become visible, which it
  cannot without a token change, so: **keep the border and correct the two
  comments**, so a future reader does not remove the border believing the ground
  is doing the work. And give the textareas a fill that is not the page ground —
  `.form-panel .field { background: color-mix(...) }` is out of scope for a
  no-token-change sweep, so at minimum stop describing the panel's ground as the
  thing that carries it.
- **Principle:** Comments must describe the mechanism that is running. (See also
  the record-contradiction reviewer's beat; I file it here because the
  consequence is visual, not documentary.)

### 4. The one everyday rejection has no recovery affordance, only instructions

- **Severity:** Moderate
- **Where:** `src/app/payouts/errors.ts` (`appraisal_failed`) and
  `new-operation-form.tsx:82-84`.
- **Cost:** `appraisal_failed` is the only rejection on this form that is not a
  typo — it fires when triff.tools is down, which is not the operator's fault
  and not something they can fix. Its copy says "leave it blank and price loot
  later." To take that advice the operator must scroll ~470px down from the
  notice they were just focused onto, select a 200-line paste, delete it, scroll
  back down past the roster box, and press Create again — to do the thing the
  page's own lede already told them was the normal way to work. At 1am during an
  upstream outage, that is where someone gives up and creates the operation
  tomorrow, or not at all.
- **Fix:** When `state.code === "appraisal_failed"`, render a second control
  inside the `Notice`: "Create without loot", submitting the same form with the
  loot paste omitted (a `name`/`value` on a second `Submit` — `submit.tsx:65-66`
  already passes both through for exactly this shape of case, and the action can
  branch on it before the `if (lootPaste)` block at `actions.ts:284`). The paste
  stays in the textarea either way, so nothing is destroyed by taking the offer.
- **Principle:** Nielsen #9 (help users recover from errors) — recovery is an
  action, not a sentence describing an action.

### 5. Two of the three section headers name one field each, and that field's label repeats the word

- **Severity:** Moderate
- **Where:** `new-operation-form.tsx:126` and `:152`.
- **Cost:** `LOOT` sits above a field labelled "Loot paste (…)". `ROSTER` sits
  above a field labelled "Roster paste (…)". `.rule-head` costs 48px above and
  16px below (`globals.css:898`), so the two redundant headers spend ~166px of a
  1119px panel — a seventh of the panel's height, and a third of what pushes
  Create off the screen in finding 1 — restating two words that are already the
  first word of the label underneath. Meanwhile `OPERATION` heads three fields,
  so the same furniture means "a group" in one place and "the next field" in two
  others; a reader learns nothing from a header that fires at both scales.
- **Fix:** Drop all three `RuleHead`s. The H1 already says "New operation", so
  the first is redundant with the page title; the other two are redundant with
  the labels below them. The `.form-stack` gap already separates the fields, and
  `globals.css:3194-3197`'s special-cased zero-margin branch — which exists only
  to undo the first header's collision with the panel padding — goes away with
  them. Panel loses ~230px. If the grouping is wanted at all, it belongs to
  finding 2's two-column split, where the columns *are* the grouping.
- **Principle:** Every word earns its place; structure should not be spent
  labelling a set of one.

### 6. Requiredness is a trailing parenthetical on all five labels, at identical weight to the field name

- **Severity:** Minor
- **Where:** `new-operation-form.tsx:90, 100, 116, 142, 154`.
- **Cost:** Five of five labels end in a parenthetical — "(required)",
  "(required)", "(optional)", "(optional: one line per item, quantity before or
  after)", "(optional: one per line, or separated by /)" — all in the same
  proportional face, size, weight and colour as the field name itself. To answer
  "what do I actually have to fill in" the operator reads five full strings, two
  of which run to 60 characters and wrap to two lines at 390px. The one-word
  distinction that matters is buried mid-sentence in the two longest labels.
  This is the form's version of uniform weight where nothing directs the eye.
- **Fix:** Say it once. The two required fields are the first two; mark
  requiredness structurally (a distinct treatment on the two, or a single line
  above them) and drop "(optional)" from the other three entirely — an unmarked
  field in a form whose required ones are marked is already understood as
  optional. Keep the format hints; they are doing real work. **Do not** rephrase
  the loot label without re-reading `new-operation-form.tsx:135-141`: the word
  "name" cannot appear in it or `getByLabel("Name")` matches two fields and 22
  payouts specs fail on strict mode.
- **Principle:** Nielsen #6 (recognition rather than recall); differentiate what
  differs.

### 7. `max={today}` is baked at render, so a page left open across UTC midnight defaults to the wrong day

- **Severity:** Minor — **and this re-opens a known-open item.** The backlog
  entry reads "`/payouts`' future-date guard is client-only"; that entry is
  about bypassability, and I am filing a different consequence of the same
  guard, on a different route.
- **Where:** `src/app/payouts/new/page.tsx:27` (`today`), passed to
  `new-operation-form.tsx:68` as both the `value` default and the `max`.
- **Cost:** `createOperationAction` does not check the date against today at all
  — `parseYmd` (`actions.ts:166-180`) validates format and calendar rollover and
  nothing else — so `max` is the entire guard, and it is a string frozen when the
  page rendered. An operator who opens `/payouts/new` at 23:50 EVE and submits at
  00:10 files the operation under *yesterday*, silently, with no warning, because
  the pre-filled default is stale too. `page.tsx:26` says this is "a record
  operators reconcile against their own logs" — a day-off date is exactly the
  error that costs someone an hour later.
- **Fix:** Validate the date server-side in `createOperationAction` (a
  `date_future` code alongside the four in `NEW_OPERATION_ERRORS`), which closes
  the bypass half of the known-open entry at the same time. The stale-default
  half needs the client to re-derive `today` on mount and on `visibilitychange`,
  or accept it and let the server rejection catch it.
- **Principle:** Nielsen #5 (error prevention). A client-side `max` is a hint,
  not a guard, and a server-rendered one is a hint with an expiry date.

### 8. The lede's first sentence explains the page to someone who cannot reach it

- **Severity:** Minor
- **Where:** `src/app/payouts/new/page.tsx:41-42`.
- **Cost:** "One row per fight." defines *operation* for a reader who, by
  `page.tsx:22`, is necessarily an operator — the only people who can load this
  URL, and the people who least need the term defined. It is the explanatory-
  subtitle smell in its mildest form.
- **Fix:** Cut the first sentence, keep the second. "Creating an operation pays
  nobody: it opens a draft you can fill in now or later" is not explaining the
  page, it is answering the anxiety at a commitment moment, and it is the best
  line on the surface. Cutting the first sentence also drops the lede to one
  line at 1440 and takes ~24px off the page.
- **Principle:** No intros that repeat the title; every word earns its place.

---

## What is genuinely good and should survive

- **The lede's second sentence.** "Creating an operation pays nobody: it opens a
  draft you can fill in now or later." It answers the exact question an operator
  has their hand on the mouse over — *am I committing to something?* — in the
  deadpan register, with no exclamation and no reassurance theatre. Do not
  soften it, do not move it into a tooltip, and do not delete it while acting on
  finding 8.
- **The whole controlled-input / `useActionState` construction.**
  `new-operation-form.tsx:34-41` documents why every field is `useState` rather
  than `defaultValue`, and the reason is real: React DOM resets uncontrolled
  fields when the action promise settles, so an uncontrolled version loses a
  hundred-line paste on the one rejection this form exists to survive. Any fix
  that touches these fields must keep them controlled.
- **The reserved `Notice` slot and the focus move.** Mounted unconditionally so
  the live region exists before the text (`:79-84`), then focused on rejection
  (`:73-75`) because the operator is otherwise standing at a button ~1000px
  below where the message rendered. This is the correct handling and, notably, it
  is a workaround for finding 1 — the page is only that tall because of the two
  optional boxes. Fixing 1 makes this cheaper; it does not make it removable.
- **Redirecting the non-operator rather than showing them a form that will
  reject.** `page.tsx:18-22`. Right call, well argued.
- **`Create operation` at 164px, not a full-measure gold bar.**
  `globals.css:3176-3178` (`justify-self: start`) and its comment. Gold is
  rationed correctly here: one primary action, one gold object, sized from its
  label. The button is *misplaced* (finding 1), not mis-designed.
- **The date default.** Today, in UTC because UTC is EVE time, on a
  `force-dynamic` page. The reasoning at `page.tsx:24-27` is right; finding 7 is
  about its shelf life, not its choice.

## Patterns 2 and 3 — plainly

- **Pattern 2 (total enumeration): not present.** There is no table and no
  repeated row on this surface. The nearest thing is the "(optional)" repetition
  in finding 6, which is a labelling problem, not an enumeration one; I have not
  dressed it up as pattern 2.
- **Pattern 3 (repeated identical controls at uniform weight): not present as
  controls.** There is exactly one pressable thing on the page. The *sections*
  are at uniform weight where two of them should not exist at all (finding 5),
  and the *labels* are (finding 6), but neither is the control-density failure
  pattern 3 names, and I have filed both under their own descriptions rather
  than borrowing its authority.

## What I could not evaluate

- **Focus, hover and pending states.** The shots are static. `.field:hover` and
  `:focus-visible` (`globals.css:3069-3081`), the `aria-busy` pulse, and the
  "Creating…" label swap are all read from source only. In particular I could
  not judge whether "Creating…" is *enough* feedback during a loot appraisal,
  which is a network round trip to triff.tools plus ESI (`actions.ts:286-306`)
  and is the slowest thing this button can do — a 200-line paste against a slow
  upstream may sit on "Creating…" long enough to read as hung, and no shot of
  that state exists.
- **The rejection layout.** No screenshot shows the `Notice` populated, so I
  could not check how the filled notice affects the panel's top spacing or
  whether the focus landing is visually obvious at the moment it happens.
- **The native date picker's rendered panel.** Chromium's own control, unstyled
  by this system, and not in either shot.
- **Fold positions are inferred**, not measured in a live browser: both shots are
  `fullPage`, so I took the fold from the capture viewports the brief states
  (1440×900, 390×844) and the pixel geometry of the shots. The 412px and 577px
  below-fold figures rest on that inference.
- **320px.** `globals.css:5156` gives `.form-panel` a narrower padding below
  40rem and the comment carries a measurement (224px of field width before the
  fix). There is no 320px shot, so I could not check the result, only that the
  rule exists.

## Contested (settled-taste challenges)

None. Nothing in this report asks to re-open a settled item. Finding 3 observes
that one of the two sanctioned card exceptions is not working by the mechanism
its own source comment claims — that is a statement about the comment and the
border, not a request to make it a third card or to stop being one.
