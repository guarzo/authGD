# The boundaries — critique

Register: PRODUCT. Surfaces: `src/app/error.tsx`, `src/app/not-found.tsx`,
`src/app/payouts/[id]/not-found.tsx`. Shots: `13-error-boundary.*`,
`02-not-found-root.*`, `08-payout-not-found.*`.

## What I saw before I opened anything

All three pages, wide and narrow, are framed by a thin gold rectangle around the
`<h1>` — a 2px gold line at a 2px offset, running the full content column. On
the two 404s that box is roughly 915px wide holding about 380px of text, so more
than half of the most emphatic shape on the page is empty. It is the first thing
the eye lands on, on every one of the six screenshots.

On `13-error-boundary.wide.png` the red notice reads, line by line:

> `!  Try again. If it keeps happening, tell an admin what you were   4292868890 .`
> `   doing and quote reference`

The reference number sits at the end of the *first* line, followed by an orphan
period, and the words that introduce it ("doing and quote reference") are on the
second. The narrow shot is worse: the digest is parked alone at the top-right of
the block with a gap of about 90px between it and the sentence, which then runs
four lines beneath it. I read the sentence twice before I understood it.

Below that, a hairline labelled WHAT TO SEND runs to x≈1035, and the boxed
record it introduces stops at x≈665. The lede above stops at x≈712. Three
different right edges on six stacked blocks, with the longest line on the page
being a rule that heads a block 370px shorter than itself.

Then two identical dark buttons, TRY AGAIN and BACK TO OPERATIONS, and 355px of
void below them.

The two 404s are the same page twice, correctly: heading, two-line lede, one
solid gold button, and then roughly 625px of nothing. They agree with each other
completely. The error page is the one that does not look like the other two.

---

## Findings

### 1. Serious — the reference number is laid out outside the sentence that names it

**Where:** `src/app/error.tsx:197-214`; mechanism at `src/app/globals.css:3429-3431`.

`.notice` is `display: flex`. Every child of `Notice` becomes a flex item. The
digest branch passes three children into that row — the text run, a
`<code className="mono">`, and the trailing `"."` — so the sentence is item 2,
the digest is item 3, and the full stop is item 4. Item 2 is the only one that
wraps, so it becomes a two-line box and the digest is baseline-aligned beside its
*first* line. The rendered reading order is "…what you were **4292868890** .
doing and quote reference".

This is not an obscure property of the component. `admin/accounts/page.tsx:298-300`
already reasons out loud about "`.notice`'s flex row" and what it does to a child
element, and all four multi-part notices on `/payouts/[id]` (e.g.
`payouts/[id]/page.tsx:358-363`) wrap their whole message in a single `<span>` so
it stays one flex item. `error.tsx` is the only caller in the app that puts an
inline element directly into the row, and it is the one page whose entire job is
to hand over a string correctly.

Only the digest branch is affected; the no-digest fallback is pure text and
renders fine. The digest branch is the server-throw case, which is the common one.

**Cost:** a member told to relay a ten-digit reference is shown that reference
detached from the words "quote reference", trailed by a stray period that reads
like part of the number. On a phone the two are 90px and one line apart. The
likeliest failure is the member quoting `4292868890.` or reading the sentence as
truncated and quoting nothing.

**Fix:** wrap the notice body in a single `<span>`, exactly as
`payouts/[id]/page.tsx:359` does. One element, no CSS change, no change to the
copy. (If it is worth preventing structurally, `Notice` could wrap its own
children — but that would change layout at eleven other call sites and is a
bigger decision than this page needs.)

**Principle:** the app's own established `Notice` convention; reading order must
match DOM order.

### 2. Serious — an undesigned gold rectangle is the loudest element on all three boundaries, and the code states it does not exist

**Where:** `src/app/_components/focus-heading.tsx:56-57`, rendered by
`src/app/globals.css:289-292`. Visible on all six shots.

`FocusHeading` moves focus to the `h1` on mount. Its closing comment says: *"No
focus ring appears: the global ring is `:focus-visible`, which a programmatic
focus on a non-input element does not match."* The screenshots disagree. The box
is `2px solid var(--gold)` at `outline-offset: 2px` with a 1px radius — that is
`globals.css:289-292` character for character, and nothing else in the stylesheet
draws a gold outline on an `h1`.

Evidence it is the ring and not something else: the box appears on exactly the
three pages that use `FocusHeading` and on no other shot in the set.
`03-payouts-empty.wide.png` renders the same `h1` element in the same
`.page__head` with no box. Chromium's programmatic-focus heuristic is what makes
`:focus-visible` match here; other engines may differ, which is precisely why
this cannot stay an accident.

`confirm-notice.tsx:102` repeats the same claim, so the belief has already
propagated to a second component.

**Cost:** on `/payouts/[id]` 404 there are now four gold things on a page with
three elements of content — the mark, the active OPERATIONS underline, this box,
and the primary button. Gold is the app's one emphasis ration
(`DESIGN.md:103`, `DESIGN.md:287` "one per view"), and the largest gold shape is
the one thing on the page that cannot be pressed. It outranks the button it is
supposed to be pointing at. On the error boundary it is the *only* gold on the
page, so the strongest emphasis the design system has is spent framing a
non-interactive heading and 535px of empty column.

**Fix:** decide it, do not delete it. Suppressing the outline is off the table —
focus is never suppressed (`DESIGN.md:341`, PRODUCT.md Accessibility). The
cheapest honest version keeps the ring and stops it outlining the void: give the
focused heading a `width: fit-content` (or an inline-block inner span) so the box
hugs the words. Then correct both comments to say the ring appears and is
intended. If the team decides it should *not* appear, the fix is a
`:focus:not(:focus-visible)`-shaped opt-out on this one element, made explicitly
rather than assumed.

**Principle:** `DESIGN.md:341` scopes the global ring to interactive controls;
gold rationed to one primary action plus the mark.

### 3. Moderate — the escalation record is not copyable in the situation it exists for

**Where:** `src/app/error.tsx:256-263`.

The comment at `error.tsx:225-226` claims the block is *"selectable as a unit, so
'copy this' is one gesture rather than three."* That holds on a desktop, where a
triple-click takes the whole `<pre>`. It does not hold on the narrow viewport,
where selecting three lines of a `<pre>` is a long-press followed by dragging two
handles, and where the member escalating to an admin over Discord actually is.

This app already owns the answer. `payouts/[id]/copy-amount-button.tsx` is a
fully-worked copy control — secure-context guard, `role="status"` feedback,
WCAG 2.5.3-safe naming — built, per its own docblock, because *"what actually
goes wrong today is transcribing a twelve-digit ISK figure by hand."* A ten-digit
digest a member is explicitly instructed to relay is the same problem with worse
stakes, and it is the one place in the app that does not get the control.

**Cost:** the member types the digest by hand from a phone, or screenshots the
page and sends a picture an admin cannot paste into a filter.

**Fix:** put a copy control on the `RuleHead`'s `aside` slot (which exists for
exactly this) writing the whole three-line block. Reuse the
`CopyAmountButton` shape rather than writing a second clipboard path.

**Principle:** consistent affordances across the surface (product register).

### 4. Moderate — the record omits the two things that would let an admin act on it

**Where:** `src/app/error.tsx:131` and `src/app/error.tsx:259`.

The block's own comment (`error.tsx:216-223`) argues correctly that a digest
alone matches none of `/admin/audit`'s columns and that what narrows the log is
*a route and a time*. It then ships neither at the fidelity that claim needs.

- **`seen` has no date.** `utcHhmm` (`_components/utc-time.ts:2-4`) returns
  `HH:MM` and nothing else. A member who hits this at 23:50 and messages an admin
  the next morning has handed over "11:57 UTC" with no day attached, and
  `/admin/audit`'s `before` filter is a point in time. The row that exists to
  bracket a search cannot bracket one.
- **`page` drops the query string.** `usePathname()` returns the path only. On
  `/admin/audit` — the surface whose entire state lives in its search params —
  the record reports `/admin/audit` for a failure that happened on
  `?actor=…&page=7`, discarding the exact state needed to reproduce it.

**Cost:** the admin receives a well-formatted record and still cannot narrow the
log with it, which is the dead end this block was built to remove.

**Fix:** render the full UTC date-time in `seen` (`YYYY-MM-DD HH:MM UTC`), and
build `page` from `usePathname()` plus `useSearchParams()`. Both are additive and
neither changes the block's height behaviour.

### 5. Moderate — the escalation material is presented before the retry it is the fallback for

**Where:** `src/app/error.tsx:197-313` (block order).

The page reads: *try again* (notice) → **what to send an admin** → the Try again
button. The member is handed the escalation kit before they have been given the
control that might make escalation unnecessary. In the wide shot that is 253px
and a section heading between the instruction "Try again" and the button labelled
"Try again".

The stated reason the block sits above the buttons (`error.tsx:236-243`) is that a
late-arriving `seen` value must not move the buttons under the pointer. Moving the
block *below* the button row dissolves that concern entirely rather than
mitigating it — nothing sits under the block to be shifted — so the reorder is
strictly better on the axis the current order was chosen for.

**Cost:** every member who hits a transient fault reads a wall of escalation
procedure before finding out they could just press a button.

**Fix:** order it `h1` → lede → notice → `.btn-row` → `RuleHead` + escalation.
That is also the ladder in its true sequence: what happened, what you can do, what
to send if that did not work.

**Principle:** progressive disclosure; PRODUCT.md principle 2 (state before
action) is satisfied either way, but the *actions* should precede the escalation
apparatus.

### 6. Moderate — the three boundaries disagree about how an escape link is drawn

**Where:** across surfaces. `not-found.tsx:61`, `payouts/[id]/not-found.tsx:104`,
`error.tsx:310-312`.

All three pages carry the same control: a plain `<a href>` doing a hard
navigation to a section index, as the way out of a dead end. Two of them draw it
`btn btn--primary` (gold ground). The third draws it `btn`.

To be explicit: this is **not** the closed "Try again" item. Try again is
correctly plain, and the argument at `error.tsx:266-273` for demoting it is
sound — pressing it re-sends something the lede just warned may already have
landed. But that argument is about the *retry*, and the demotion silently applied
to the neighbour as well. "Back to operations" carries none of the risk the
comment names; it is the identical control that is gold on both 404s.

The comment's premise — *"a boundary has no action it can recommend"* — is also
the one premise the other two boundaries reject. Both 404s recommend leaving, in
gold, and are right to.

**Cost:** on the page with the most content, the most decisions, and the highest
stress, nothing directs the eye; on the two emptiest pages, something shouts. The
emphasis is inversely proportional to how hard the moment is. A member who has
just been told the app broke has to read two identical dark rectangles to work out
which is the safe one.

**Fix:** `btn--primary` on the "Back to …" anchor in `error.tsx`, leaving Try
again plain. That gives the error page one primary action (the ration), matches
its two siblings, and makes the safe exit the one the eye finds first.

**Principle:** consistent component vocabulary across screens (product register);
one primary action per view.

### 7. Minor — a six-block page with three right edges, headed by a rule that overruns everything under it

**Where:** whole surface (`13-error-boundary.wide.png`).

Measured off the wide shot: the `h1`'s box and the WHAT TO SEND hairline reach
x≈1035; the lede stops at x≈712; the notice and the escalation record stop at
x≈665. The column starts at x=120.

Two mechanisms, both worth naming because the fix differs:

- `.rule-head` (`globals.css:894-923`) has no measure cap and its `::after`
  hairline is `flex: 1`, so it runs to the full `page--narrow` child width of
  57rem while `.notice` and `.escalation` cap at `--measure`. On every other
  surface a `RuleHead` introduces a full-width table and the two edges agree.
  Here it introduces a 68ch block and overruns it by roughly 370px, so the
  strongest horizontal line on the page points at empty space.
- `--measure` is `68ch`, and `ch` resolves against each element's own font-size.
  `.page__lede` is body size, `.notice` and `.escalation` are `--t-data`
  (0.875rem). The same token therefore produces two different pixel widths,
  which is where the 47px step between the lede and the notice comes from.

This is the honest form of pattern 1 on this surface, and it is worth stating
plainly what it is *not*: none of the three pages "runs long instead of wide."
They are short pages that are honestly short, and padding them out would be
worse. The error page's problem is raggedness, not emptiness.

**Cost:** low, but it is the difference between the page reading as composed and
reading as a stack of defaults — on the surface most likely to be screenshotted
and sent to someone.

**Fix:** cap the escalation section's `RuleHead` to the same measure as the block
it heads (a modifier, not a change to `.rule-head`). The `ch` step is a
system-level observation; flag it, do not chase it here.

### 8. Minor — addition to the known-open `.escalation` ground

**Where:** `src/app/globals.css:3359-3372`.

Not restating the 1.00:1 ground, which is on the backlog — adding the half that
entry does not name. The block's border is `--rule`, which renders `#373533`
against a `#0a0a0a` ground: **1.62:1**. So both channels that were meant to make
this read as an inset field are absent at once — the ground is identical to the
page and the boundary is a hairline near the floor of visibility. The comment's
intent (`globals.css:3355-3357`, *"inset into `--hull` like a field, so it reads
as a value the system produced"*) does not land; it reads as loose mono text with
a faint outline around it. Worth pricing the two together when the ground item is
worked, since fixing the ground alone may be enough and fixing the border alone
is not.

(1.4.11 is not strictly engaged — a `<pre>` is content, not a UI component — so
this is a design-intent finding, not a conformance one.)

---

## Pattern verdicts, stated plainly

- **Pattern 1 (unshaped field):** present in a modified form on `error.tsx` only,
  and it is raggedness rather than the /account shape. The two 404s do **not**
  have it: they are three-element pages that end after three elements, which is
  correct. Do not let a fix pass inflate them.
- **Pattern 2 (total enumeration):** absent. There is no repetition to collapse on
  any of the three. The digest appears twice on `error.tsx`, once as the thing a
  sentence points at and once as a field in a record, and the reasoning at
  `error.tsx:226-230` for that is right.
- **Pattern 3 (repeated identical controls at uniform weight):** present in
  miniature on `error.tsx` — exactly two controls, drawn identically, with nothing
  directing the eye. Finding 6 is the fix. Absent on both 404s, which have one
  control each.
- **Explanatory subtitle under an H1:** the ledes are not that. Each names the two
  plausible causes and what to do, and none of them restates its heading.

## What is genuinely good and should survive

- **The copy, all of it.** "That's a fault on this end, not something you did"
  is the best sentence in the app. The three headings — "Something broke",
  "Nothing at that address", "No such operation" — are deadpan, parallel, and
  none of them says 404 or "Oops". Both 404 ledes name the two real causes (typo,
  truncated link) instead of apologising. A fix pass should touch none of it.
- **`navFromPath` as a shared rule rather than three literal arrays**
  (`nav-items.ts:143-151`). The claim "the boundary is the same rule under weaker
  evidence" is true of the code rather than asserted by a comment, and the three
  surfaces are visibly consistent because of it.
- **The escalation block existing at all.** The reasoning that a digest alone
  matches none of `/admin/audit`'s columns is correct and unusual; the block is
  the right idea. Findings 3 and 4 are about it not going far enough, not about
  it being wrong.
- **`Notice live={false}` on the error boundary.** Letting the focused `h1`
  announce the arrival instead of an assertive region preempting it is the right
  call and is easy to "fix" backwards.
- **The two 404s' restraint.** One heading, one lede, one exit. Nothing to add.

## What I could not evaluate

- **Whether `:focus-visible` matches in Firefox and Safari.** I confirmed the ring
  renders in the shots' Chromium capture and confirmed the CSS that draws it, but
  the cross-engine behaviour of programmatic focus on a `tabindex="-1"` heading is
  browser-dependent and I did not run other engines. It affects the framing of
  finding 2, not its substance: undesigned either way.
- **The no-digest branch (`error.tsx:209-212`) in a shot.** Only the digest branch
  was captured. Its layout should be clean (pure text, one flex item), but I did
  not see it rendered.
- **The `seen: —` first-paint window.** I could not observe how long the `—`
  is on screen before the effect runs; the shots are post-mount.
- **Whether a member can actually reach an admin.** "Tell an admin" and "What to
  send" never say *where*. The app has a Discord integration; whether the corp's
  escalation channel is obvious enough to leave unnamed is a call I do not have
  the context to make. Noting it rather than filing it.

## Contested

Nothing. None of the settled taste or constraint items needs challenging from
these three surfaces. Finding 6 touches the "Try again" area and finding 2 touches
gold rationing, and both are deliberately arguing *within* those settled
positions rather than against them.
