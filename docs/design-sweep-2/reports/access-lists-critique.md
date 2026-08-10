# `/admin/access-lists` — critique

> **OUT-OF-SCOPE ADDITION.** This surface appears in neither the owner's scope
> list for this sweep nor the Aug-5 sweep. It has never been reviewed. Every
> finding below can be lifted out cleanly if the owner does not want them.

Register: product. Shots: `14-access-lists.wide.png`, `14-access-lists.narrow.png`.
Compared against `/account` (12), `/admin/sync` (11), `/admin/accounts` (15).

---

## What the screenshot shows, before any explanation

Wide (1440×900). An H1, "Access lists", in white. Two lines of dim body prose
under it. Two buttons, one gold, one dark. Then nothing. Content ends at roughly
y=275; the remaining 625px of the fold is `--void` `#0a0a0a`. Horizontally the
widest thing on the page is the prose, ending around x=700 of a 1440px window.
The page occupies about the top-left quarter of the viewport and stops.

Narrow (390×844). Same three elements. The nav takes four rows and 220px, about
26% of the fold, before the H1 starts. Content ends around y=420 and the lower
half of the screen is empty.

The two sentences read as one paragraph at one weight: "This page compares the
alliance roster against the in-game access lists. Nobody has granted the
access-list scope yet, so nothing can be read." The first sentence is
boilerplate about the page. The second is the only fact on the screen. They are
the same colour (`--ink-dim`, `#bab3a9`), the same size, the same face, and the
same paragraph.

Two controls sit side by side: gold "GRANT ACCESS", dark "CHECK NOW". In this
state "Check now" cannot succeed: the sentence directly above it says nothing
can be read.

---

## Findings, worst first

### 1. The dark monitor announces itself in the same voice as its own boilerplate

**Severity:** Serious

**Where:** `src/app/admin/access-lists/view.ts:81-114`, rendered at
`src/app/admin/access-lists/page.tsx:137`

The page's own design record states the goal exactly. `monitorSentence`'s
docblock (view.ts:74-80): *"a page that renders zero rows without saying why is
indistinguishable from a page saying everything is fine."* Six of the seven
`monitorState` branches return a fault sentence. The code says why. It then
renders that why as `.lede`, the class both siblings use for page description,
in `--ink-dim` `#bab3a9`, at body size, in the proportional face.

Compare `/admin/sync` (shot 11) directly. That page has the same problem to
solve, a monitor that may be dark. It puts the description in `.page__lede` and
the two faults in bordered `Notice`s, one red, one amber, which are the second
and third things the eye reaches after the H1. `/admin/access-lists` has
`Notice` imported and in use inside the detail drawer (page.tsx:344) with a
`warn` tone, so the component and the tone were available and were not spent
here.

The compound effect is worse than the flat weight alone. In `grant-needed`, the
only state captured, the description and the fault are welded into one string
(view.ts:84-87), so there is no separation to give weight to. In the other six
states the description silently disappears and only the fault is printed, which
means the standing explanation of what this page is exists for exactly one
viewer: the one who has never configured it.

**Cost:** An admin who opens this page at a glance sees a paragraph of grey
prose where `/admin/sync` would have shown them a red box, and concludes the
monitor is fine. The states this most affects (`scope-dropped`,
`holder-needs-reauth`, `holder-no-token`) are, by view.ts's own docblock, *"the
ones most likely to be reached in production"* and they are the ones where the
monitor has silently stopped reading. The page is built to prevent exactly the
failure its own typography then permits.

**Fix:** Split the two jobs. Keep one standing description as the lede across
all seven states, unchanged whatever the monitor is doing. Render
`monitorSentence`'s fault half through the `Notice` already imported here, at
`warn` for the four holder faults and untoned for `catalog-empty`/`normal`.
`grant-needed`'s string then loses its first sentence, because the lede is
saying it in every state instead of one.

**Principle:** Visibility of system status (Nielsen 1). Colour is not the sole
carrier here in either direction, so the R4 parity rule is not at risk.

---

### 2. The skip link does nothing on this route

**Severity:** Serious

**Where:** `src/app/admin/access-lists/page.tsx:133`

```
<main id="main" className="page page--wide">
```

Eleven elements in `src/app` carry `id="main"`. Ten carry `tabIndex={-1}`. This
one does not. I checked all eleven.

The shell renders `<a className="skip" href="#main">Skip to content</a>`
(`src/app/_components/ui.tsx:104-105`). A fragment target that is not focusable
scrolls the viewport but does not move focus, so the next Tab resumes from the
document position it already held, which is the first nav link. The skip link
is present, visible on focus, and inert.

This surface is the worst one to lose it on. It sits last in a nav of seven
links plus "Sign out" (visible in every shot), and three of its four server
actions redirect back to this same URL (`actions.ts:34, 42, 56`), so the admin
lands at the top of that nav again after designating a holder, adding a list, or
queueing a check.

**Cost:** A keyboard-only admin tabs through eight header links to reach the
page content, and does it again after every press that redirects. On
`/admin/sync` and `/admin/accounts`, the same admin presses the skip link once.

**Fix:** Add `tabIndex={-1}` to the `<main>`.

**Principle:** WCAG 2.4.1 Bypass Blocks. Also plain consistency: ten of eleven.

---

### 3. Pattern 1, and the class that declares the width admits it changes nothing

**Severity:** Moderate

**Where:** `src/app/admin/access-lists/page.tsx:133`,
`src/app/globals.css:694-700`

This is the sweep's unshaped field in its purest captured form. Content
occupying roughly the top-left quarter of a 1440×900 fold, the rest empty, and
no compositional acknowledgement that the remainder exists.

The width class is worth reading in full. `globals.css:698-700` is
`.page--wide { max-width: var(--measure-page) }`, and its own comment says every
other admin route *"gets it by leaving `.page` unmodified, so this changes
nothing about the box. It exists so the page states which column it chose."* It
is used once, here, and only here. So the page's one width decision is a
no-op class asserting a choice that nothing enforces, on the surface where that
choice is most visibly wrong.

The populated markup does not need 78rem either. A watched row is a name, a
status token and an age (page.tsx:217-231). The widest thing behind a drawer is
a two-column table of character and corporation names (page.tsx:355-374). None
of that is a `/admin/accounts` nine-column table.

I can only make the strong claim about the state I have pixels for. In that
state the finding is unambiguous.

**Cost:** An admin arriving at an unconfigured monitor gets a screen that is
mostly nothing, which reads as a page that failed to load rather than a page
with one thing to tell them. It is also the page's first impression, since
`grant-needed` is by construction the state every installation starts in.

**Fix:** Move to `page--narrow`. It caps *contents* at 60rem and leaves the page
box on `--measure-page`, so the H1's left edge and every rule origin stay on the
one vertical the settled one-column-origin rule requires. Delete `.page--wide`,
which then has no callers. Separately, give this state something to fill the
column with: the grant flow is three steps (authorize a character, designate it,
wait for a read) and the page currently states none of them.

**Principle:** Sweep pattern 1, unshaped field.

---

### 4. The removal confirmation recites a number the code already resolved to a name

**Severity:** Moderate

**Where:** `src/app/admin/access-lists/actions.ts:80`

```
return { text: `Access list ${accessListId} removed from the watchlist.` };
```

Three things make this more than a copy nit.

First, the page states the opposite rule in its own docblock
(page.tsx:322-323): *"Names lead and ids are secondary throughout: the admin
retypes these in-game, where the id is not what the client accepts."*

Second, the row went to real trouble to have one authoritative label.
page.tsx:216 computes `label = c.name ?? \`#${c.accessListId}\`` with the
comment *"so the two can never disagree about what an unnamed list is called"*,
and feeds it to both the visible name and the button's `aria-label`. The
confirmation is a third channel that disagrees with both.

Third, and this is the part that makes it a clean fix: `removeWatch`
(`src/services/access-lists.ts:133-153`) **already reads the name.** It calls
`watchedListName` before the delete, specifically so the audit row carries it
(`details: { accessListId, name }`, line 152). It then returns `void`. The name
is fetched, spent on the auditor, and withheld from the person who pressed the
button, one return value away.

The two redirect confirmations name nothing at all. `doneNotice`
(`view.ts:263-269`) returns "List added to the watchlist" and "Holder
designated", neither carrying which list or which character, on a page whose
`designateHolder` control exists precisely because the identity of the holder is
the fact that matters.

**Cost:** The admin presses "Stop watching" on a row, the row vanishes, and the
only text left says "Access list 4192 removed from the watchlist." To undo a
mispress they must open the catalog select and match a bare number against a
list of names, which is the operation the page's own docblock says the id is bad
for.

**Fix:** Change `removeWatch` to return the `name` it already reads (or null),
and have the action return `"<label> removed from the watchlist."` using the
same `name ?? #id` fallback the row uses. Note the shape constraint: this is one
shared `ConfirmingForm` for the whole region (page.tsx:194-195), so a per-row
hidden input is not available and the name has to come back from the server.
Same treatment for `doneNotice`'s `watch` and `holder` cases, which have the
redirect query string available to carry a name.

**Principle:** Recognition rather than recall (Nielsen 6). Same species as the
Aug-5 "UUID recital" finding on `/admin/audit`, on a surface that never got that
pass.

---

### 5. The add-list select has no unchosen state, so its button acts on an arbitrary list

**Severity:** Moderate

**Where:** `src/app/admin/access-lists/page.tsx:172-178`

```
<select id="add-list" name="accessListId" defaultValue="">
  {addable.map((c) => (
    <option key={c.accessListId} value={c.accessListId}>{c.name}</option>
  ))}
</select>
```

No option carries `value=""`. `defaultValue=""` therefore matches nothing, and
the browser falls back to selecting the first option. The control renders
looking as though a choice has been made, and submitting without touching it
adds whichever list happens to sort first in the catalog.

There is no confirmation step and, per finding 4, the resulting notice does not
name the list either, so the admin gets no signal that the wrong one was added.

The blast radius is real but bounded: watching a list is reversible via "Stop
watching", and the worker reads rather than writes. This is why it is Moderate
and not Serious.

**Cost:** An admin who tabs to "Add to watchlist" and presses Enter, or clicks
it while intending to open the select first, silently starts monitoring a list
they did not choose, and the page tells them only that "List added to the
watchlist."

**Fix:** Add a disabled, selected placeholder as the first option
(`<option value="" disabled>Choose a list</option>`) so the submit is refused
until a real choice is made. `parseId` (`actions.ts:24-28`) already throws on a
non-positive value, so the server side is covered; this is about not reaching
it. Pair with naming the list in the confirmation.

**Principle:** Error prevention (Nielsen 5).

---

### 6. The drawer's "Stop watching" takes the 28px grade a drawer is not entitled to

**Severity:** Moderate

**Where:** `src/app/admin/access-lists/page.tsx:256`, styled by
`src/app/globals.css:2813-2819`

`StopWatching` renders `className="btn btn--quiet"` and is used twice: in-row on
a clean list (page.tsx:243), and *inside the open `Disclosure`* on a drifted one
(page.tsx:256). `.btn--quiet` sets `min-height: 1.75rem`, the 28px grade.

The settled constraint is explicit: *"28px is scoped by the reason for it, rows
that each carry a control set and are read many at a time. A disclosure drawer
is not in-row for this purpose and takes 36px."* The in-row use qualifies. The
drawer use does not.

The codebase has already solved this exact case. `globals.css:2827-2836`
documents `InlineEdit` needing *"the 36px floor back without losing the quiet
colouring `.btn--quiet` still earns them"* for its page-level uses, and does it
with a two-class override.

**Cost:** On a drifted list, the admin has just read a table of characters
missing access and a list of non-members. The one control that ends that
row's presence on the page is the smallest hit target on the screen, at the
bottom of an expanded drawer, and it is the control most likely to be pressed
with a trackpad after a long read.

**Fix:** One rule mirroring the existing `InlineEdit` precedent:
`.acl-list__disc > div > .btn { min-height: 2.25rem; padding: var(--s-2) var(--s-4); }`.
The in-row instance is matched by `.acl-list__row > .btn` and is untouched.

**Principle:** The settled two-grade hit-target rule; WCAG 2.5.8 is met either
way by spacing, so this is the system's own floor rather than the standard's.

---

### 7. The section head is the one in the admin set with no count and no as-of, and spends its aside restating the form beneath it

**Severity:** Moderate

**Where:** `src/app/admin/access-lists/page.tsx:165-181`; across surfaces

Both siblings put two facts in the aside of the head above their data. Shot 11:
`9 JOBS · CHECKED 11:57:14 UTC`. Shot 15: `13 MEMBERS · as of 11:57 UTC`. Both
answer "how much is here" and "how current is this" once, for the whole set,
which is the pattern-2 fix in its constructive form.

This page's head is `<RuleHead as="h2" aside={... "add a list"}>Watched lists`.
`RuleHead`'s `aside` renders a `<span>` (`ui.tsx:216`), so "add a list" is a
label, not a control, and the control it labels (the select plus "Add to
watchlist") renders as the very next element at page.tsx:170-181. The aside is
spent announcing what is immediately visible below it, and the two facts the
siblings put there are absent.

This is the surface where "how current" matters most. The page's own docblock
(page.tsx:44-49) is a paragraph on why nothing here is live: a render-time ESI
fetch would burn a token rotation, so every number is a worker read that may be
hours old. The rows carry `observedAt` individually, deliberately as the last
*successful* read (page.tsx:222-223). There is no set-level answer, so "is this
page stale" costs a scan of every row's `RelativeTime`.

**Cost:** An admin checking whether the access-list monitor has been running has
to read every row's age and take the maximum by eye, on the one page whose
entire purpose is to report a background job's freshness.

**Fix:** Put the count and the oldest observation in the aside, in the siblings'
shape: `4 LISTS · OLDEST READ 3h ago`, one string, computed once over `compared`.
Drop the "add a list" label; the labelled `<select>` beneath it already names
itself.

**Principle:** Sweep pattern 2, inverted. The shared fact about the set is
missing rather than repeated.

---

### 8. The control row heads the page, against both siblings and against the class's own documented contract

**Severity:** Minor

**Where:** `src/app/admin/access-lists/page.tsx:139`

`.btn-row--controls`'s CSS comment (`globals.css:2986-2991`) defines the class:
*"A control row that follows the data it operates on rather than heading the
page."* This page applies it at line 139, above everything.

`/admin/sync` uses the same two classes at page.tsx:1108, after the strip, with
its own comment (lines 1104-1107): *"State before action (PRODUCT.md principle
2): the strip answers 'what is true right now' before the gold button, which is
the most saturated thing on the page, gets to pull the eye."*

In the captured `grant-needed` state this costs nothing, since there is no data
to precede. In `normal` and `catalog-empty` it inverts principle 2 on the page
whose single job is state: gold "Check now" (`#f1c035`, the most saturated thing
on the screen) is the first thing under the lede, and the watched lists are
below it.

**Cost:** In the populated state, the eye lands on a button that enqueues a
background job before it lands on the answer that would say whether the job
needs enqueueing.

**Fix:** Move the `btn-row--controls` block below the watched-list region, as on
`/admin/sync`. Keep it above in `grant-needed` and `designate-needed`, where
`showsObservations` is false and there is nothing for it to follow.

**Principle:** PRODUCT.md principle 2, state before action.

---

### 9. `.lede` duplicates `.page__lede` exactly, and the confirmation is wedged between the title and the sentence

**Severity:** Minor

**Where:** `src/app/admin/access-lists/page.tsx:134-137`,
`src/app/globals.css:757-761` and `768-772`

The two rule bodies are identical, three declarations each:

```
.page__lede { max-width: var(--measure); color: var(--ink-dim); margin-top: var(--s-2); }
.lede       { max-width: var(--measure); color: var(--ink-dim); margin-top: var(--s-2); }
```

`.lede`'s comment states why it exists: this page has no `.page__head` wrapper
around its H1, so the child selector cannot reach. And the reason it has no
wrapper is the ordering at page.tsx:134-137, which puts `ConfirmNotice` between
the H1 and the sentence. Both siblings wrap H1 and lede together and put the
confirmation after (`sync/page.tsx:230-282`, `accounts/page.tsx:252-294`).

The ordering has a behavioural edge too: after any of the three redirecting
actions, the confirmation inserts itself above the sentence that explains what
the page is doing, pushing it down.

**Cost:** Small for the reader. It is one duplicated rule and one page whose
masthead is assembled differently from every other, which is the kind of drift
that compounds when the next surface copies whichever one it happened to open.

**Fix:** Wrap H1 and lede in `.page__head`, move `<ConfirmNotice>` below them,
switch to `page__lede`, delete `.lede`.

**Principle:** Consistency and standards (Nielsen 4).

---

## What is genuinely good and should survive

**`monitorRemedy`'s two-href split** (view.ts:135-151) is the best decision on
the page and the least likely to survive a careless refactor. `scope-dropped`
and `grant-needed` get `/auth/eve/link?grant=access-lists`; the two token faults
get the bare `/auth/eve/link`. The docblock explains that the bare link is *what
drops the ACL scope in the first place*, so it must never be offered as the
remedy for a missing scope. Collapsing these to one link would send an admin
round the loop that caused the fault. Do not unify them.

**`rowHasDetail`** (view.ts:232-236). A clean list gets no disclosure control at
all rather than a toggle that opens an empty box, and it still keeps its own
inline "Stop watching" so a clean or never-read list is not permanently
unremovable. A fix pass tempted to make rows uniform will break both halves of
this. Leave it.

**`rowTone` refusing `bad`** (view.ts:188-193), with the rule stated: the alarm
colour is reserved for destructive acts, and nothing here is one, since every
row reports on a list only a human can change in-game. This is a page that
could easily have cried wolf and does not.

**`rowSummary` preempting the drift counts on a failed read** (view.ts:205-209).
Those counts came from the last *successful* read; printing them beside a read
failure would date a stale number to now. Paired with `observedAt` being the
last successful read rather than the last attempt (page.tsx:222-223), the page
is honest about staleness in two places at once.

**"plus an unknown number of others"** (page.tsx:405-407), on every broad grant,
because the app stores a corporation per character and holds no corp roster, so
the covered count is our members only. This is a clause a copy pass would delete
as wordy. It is the difference between a true statement and a false one.

**The `Status` plus words pairing** on every row (page.tsx:220), and the
`aria-label` on `StopWatching` carrying the row identity that the visible words
cannot (page.tsx:314). Both are the parity rule working.

**The region-level `ConfirmingForm`** (page.tsx:194-195) and the deliberate
absence of `pendingLabel` on `StopWatching` (page.tsx:290-302), each with the
failure it prevents written down. The absent `pendingLabel` in particular looks
like an oversight and is not.

---

## What I could not evaluate

**Six of seven states have no pixels.** The only shot is `grant-needed`. I have
no capture of `normal`, `catalog-empty`, or any of the three holder faults, and
no capture of a populated `.acl-list` at either width. Everything in findings 3,
6, 7 and 8 about the populated page is reasoned from markup and CSS, and I have
scoped each claim accordingly. Findings 1, 2, 4, 5 and 9 do not depend on it.

**Whether the row's right-hand column reads as a column.** `.acl-list__head`
(globals.css:4671-4679) is a wrapping flex line with no grid tracks, and its
comment claims name / status / age *"read as a loose right-hand column across
rows rather than `.strip`'s hard-pinned tracks"* because there is no fourth
value competing. `/admin/sync`'s `.strip__head` uses an explicit grid. Whether
the looser treatment holds up across four rows of unequal name lengths is a
pixel question and I could not answer it.

**The 320px reflow claim.** `globals.css:4699-4703` states the drift sentence
measures 388px of mono uppercase in a 288px content box and scopes
`white-space: normal` to this list to fix it. I did not re-measure, and I have
no narrow capture of a drifted row to check the resulting wrap for raggedness.

**Interaction.** Read-only with no running app, so the confirm and pending
behaviour of the shared region form, the `Disclosure` open-state survival across
`removeWatchAction` (which deliberately does not redirect, `actions.ts:59-70`),
and focus placement after each press are all from source only.

**Checked and not a finding, recorded so it is not re-raised:** `.acl-list`'s
`1px solid var(--rule-strong)` plus `--radius` (globals.css:4625-4631) is not a
third card. `.strip` carries the identical treatment (globals.css:4038-4045)
and so does `.scroller`; the border bounds a region of interactive rows rather
than decorating one, which is the stated reason for `--rule-strong` in both. The
two-card exception is intact. Contrast is also clean throughout: `.btn--quiet`
at `--ink-faint` `#90877e` on `--void` `#0a0a0a` is 5.64:1, rising to `--ink`
`#ece7de` on `--hull-hi` `#21201f` at 13.21:1 on hover; `.acl-detail th` at
`#90877e` on `--hull` `#151514` is 5.21:1. The drawer summary computes to about
49px tall (24px padding plus a 24.8px line box), comfortably over the 36px
grade, so finding 6 is about the button alone.

---

## Contested

Nothing. None of the settled taste items needed to be re-opened to file the
above, and finding 3's proposed `page--narrow` respects the one-column-origin
constraint rather than working around it.
