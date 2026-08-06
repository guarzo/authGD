# critique — the boundary states (`error.tsx`, both `not-found.tsx`, the absent `loading.tsx`)

Register: product. Read in full this session: `src/app/error.tsx`,
`src/app/not-found.tsx`, `src/app/payouts/[id]/not-found.tsx`,
`src/app/_components/focus-heading.tsx`, `src/app/_components/ui.tsx`,
`src/app/layout.tsx`, `src/app/_components/utc-time.ts`,
`src/app/payouts/pending-link.tsx`, `src/app/admin/layout.tsx`,
`src/app/_components/admin-nav.tsx`, `e2e/error-boundary.spec.ts`,
`e2e/not-found.spec.ts`, the filter path in `src/app/admin/audit/page.tsx` and
`src/services/audit.ts`, and the `.btn` / `.notice` / `.escalation` /
`.link-pending` / `.page__lede` rules in `src/app/globals.css`.

These three files are the most carefully argued surfaces I have read in this
repo. Six of the seven findings below are about copy and one control's label,
not about structure, because the structure is right. The seventh is the verdict
on the missing loading state, which the brief asked for explicitly.

## Findings

### 1. The lede warns the member off the one control that would answer its own question, because the page believes "Try again" re-submits and it does not

- **Severity:** serious
- **Where:** `src/app/error.tsx:170-174` (lede), `src/app/error.tsx:252-260` (the
  docblock the lede is built on), `src/app/error.tsx:281-292` (the control),
  `src/app/error.tsx:109-115` (the props that decide the question)
- **Cost:** A member who pressed "set tier" and landed here is told to go and
  check whether it took effect before sending again, so they leave by "Back to
  Members" and re-do the change by hand, producing exactly the duplicate write
  the sentence was written to prevent, when the button directly under it would
  have re-fetched the page and shown them the answer in one press.
- **Principle:** none. This is the "this control lies about what it did" case.
  The docblock at `252-260` states it plainly: *"the lede directly above warns
  that a submitted action may have taken effect and to check before sending it
  again — and pressing this is that second send."* That is the claim I think is
  wrong, and every other decision on the page (no gold, the plain grade, the
  copy) is derived from it.
- **Why I think it is wrong:** the boundary's entire interface is
  `{ error, reset }` (`error.tsx:109-115`). It holds no reference to the action
  that threw, no form, and no arguments. There is nothing for it to re-send.
  Next's `reset()` re-renders the segment, which for a server-action throw means
  re-running the page's server component against current data. That is not the
  second send; it *is* the check the lede asks for. The file's own e2e is
  consistent with this and does not distinguish the two: `e2e/error-boundary.spec.ts`
  only drives render throws (a renamed table), where a re-render correctly
  throws again, which is why the mistake survived. Note this is the one claim in
  the file that was reasoned rather than measured, and the file's standard
  everywhere else is measurement.
- **Fix:** First settle it: add a case to `e2e/error-boundary.spec.ts` that drives
  a *server action* into the boundary (an action that throws after a committed
  write) and counts the write, then presses "Try again" and counts it again. If
  the count does not move, the following applies.

  Keep the lede's first sentence verbatim; the docblock is right that it is the
  best sentence on the page. Replace the second so it points at the control
  rather than away from it:

  > That's a fault on this end, not something you did. Try again reloads this
  > page against current data, so if you had just submitted something, that is
  > how to see whether it took effect.

  Then correct the docblock at `252-260`, because the next reader will otherwise
  restore the old sentence from it. The gold question re-opens as a consequence
  (the argument for withholding it was "a boundary has no action it can
  recommend", which stops being true if the button is the check) but does not
  have to be answered in the same change, and the plain grade is defensible on
  its own.

### 2. The escalation block hands over three fields, none of which the admin's only tool accepts, and omits the one it does

- **Severity:** serious
- **Where:** `src/app/error.tsx:217-249`, `src/app/error.tsx:198-215`,
  against `src/services/audit.ts:459,488` and `src/app/admin/audit/page.tsx:41-49`
- **Cost:** A member does exactly what the page asks — quotes the reference,
  names the route and the time — and the admin who receives it opens
  `/admin/audit`, which filters on `actor`, `target`, `action` and an integer row
  cursor, and can search for none of the three, so the escalation the block was
  built to unblock dead-ends one hop later in the admin's hands instead of in
  the member's.
- **Principle:** none. The block's own docblock at `217-224` makes the claim I am
  contesting: *"What does narrow that log is the route and a time, and neither
  was on screen."* The route is not a column and not a filter — `queryAuditLog`
  takes `actor`, `target`, `action` and `beforeId` and nothing else
  (`src/services/audit.ts:459-488`) — and the time is not in the filter's
  format, since `before` is an integer audit-row id guarded by `Number.isFinite`,
  not a wall clock. So the premise the block was designed against is false about
  its own tool. A second, quieter problem: the audit log records state changes,
  not errors, so for a page that threw while *reading*, there is no row in it to
  narrow to at all. The one case where it genuinely helps is the file's own
  example (a DB hiccup while enqueueing, after the tier change committed) and
  that row is keyed by actor, which is the field the block does not carry.
- **Fix:** Add the identity. `actor` and `target` are the only two things the log
  matches on, and the member is the only one who knows them. Two options,
  cheapest first:
  1. Copy only, no server change: change the Notice at `198-215` from *"tell an
     admin what you were doing"* to *"tell an admin which character you were
     signed in as and what you were doing"*, in both branches. The member then
     supplies the filterable field verbally even though the page cannot print it.
  2. If it is worth a query: `useBrand()` at `error.tsx:122` already establishes
     the mechanism for handing a client boundary a server-known value through the
     root layout's provider. Extend it (or add a sibling provider) with the
     signed-in character name, and print a `who` line in the block. Weigh this
     against `layout.tsx` doing zero DB work today, and against the `max = 5`
     pool in `src/db/index.ts`; a session read on every request is not free and
     option 1 buys most of the value for nothing.

  Separately, `ref` is only resolvable by someone with the deploy's server logs.
  Nothing in the app surfaces a digest, and `/admin/sync` shows job failures, not
  request throws. If that is the intent, "tell an admin" is under-specified and
  should name the one person who can actually resolve it.

### 3. `seen` carries no date, on the one value written to be read hours later by someone else

- **Severity:** moderate
- **Where:** `src/app/error.tsx:126-133` and `243-249`, via
  `src/app/_components/utc-time.ts:2-4`
- **Cost:** A member who hits the boundary at 22:19 and reports it in Discord the
  next morning hands the admin `seen 22:19 UTC`, which cannot be bracketed to a
  day, and the audit log it exists to narrow renders full
  `2026-08-05 22:19:24` stamps (`src/app/admin/audit/page.tsx:22-24`), so the two
  values do not line up by eye either.
- **Principle:** none.
- **Fix:** Print the audit log's own `stamp()` format, or at minimum date plus
  `hh:mm`. Add a dated helper beside `utcHhmm` rather than changing it:
  `utcHhmm` is correct for `renderedAt()` and for `PushRow` in
  `src/app/account/page.tsx:87-89`, where the reader is looking at the page now.
  This block is the opposite case and is the only one in the app that is.

### 4. Every exit from all three boundaries is a hard navigation with no press feedback, on the pages where a dead-feeling click costs the most

- **Severity:** moderate
- **Where:** `src/app/error.tsx:296-298`, `src/app/not-found.tsx:54-58`,
  `src/app/payouts/[id]/not-found.tsx:73-76`; `src/app/globals.css` declares no
  `:active` rule anywhere in 3,331 lines (verified by grep)
- **Cost:** A member on a slow link presses "Back to Members" or "All
  operations" and gets nothing at all — no colour change, no mark, and the
  already-broken page stays painted while the browser waits — so on the one
  screen that has just told them the app is faulty, the reading is "that click
  didn't work either" and they press again.
- **Principle:** none, but the app has already argued this exact point against
  itself. `src/app/payouts/pending-link.tsx:14-17`: *"A press produced nothing
  visible: `globals.css` declares no `:active` rule anywhere... The documented
  human response to a control that appears not to have fired is to fire it
  again."* That diagnosis was then fixed only for the three `next/link` call
  sites on `/payouts`, because `useLinkStatus` only works inside a `<Link>`. The
  boundary exits are deliberately plain anchors (correctly — a document load is
  the robust escape from a thrown client tree) and so were left with nothing.
- **Fix:** Add an `:active` rule to the button block at `globals.css:1511-1533`,
  reusing the hover vocabulary rather than inventing a device: hold
  `border-color: var(--gold-dim); color: var(--gold)` on `:active` and shift the
  ground one step. No JS, no layout property animated, nothing for the
  reduced-motion collapse to leave running, and it covers every hard-nav `.btn`
  in the app rather than just these three. This, not a `loading.tsx`, is the
  missing press feedback.

### 5. The root 404's chrome asserts a session a signed-out visitor does not have

- **Severity:** minor
- **Where:** `src/app/not-found.tsx:41-44`, rendering
  `src/app/_components/ui.tsx:163-171`; `e2e/not-found.spec.ts:63-73` pins the
  signed-out case for the link only
- **Cost:** A signed-out visitor who follows a dead link lands on a page whose
  chrome carries a "sign out" control and a "Your account" tab, so the only
  thing the screen says about their own state is wrong; pressing sign out POSTs,
  no-ops, and lands them at `/login`, which is the right destination reached by
  an incoherent route.
- **Principle:** PRODUCT.md principle 2, "State before action. Every screen
  answers 'what is true right now?'".
- **Fix:** The file's docblock is right that it cannot read the session, and
  right that `/account` is the correct single destination. The gap is that
  `SiteHeader` renders the sign-out form unconditionally with no way to opt out.
  Add a `signOut = true` prop to `SiteHeader` and pass `false` here (and only
  here — `error.tsx` stands on a guarded route and `payouts/[id]/not-found.tsx`
  is behind `requirePayoutReader`, so both have real evidence of a session).
  Consider dropping the nav item too: the same destination is already the gold
  `btn--primary` six lines down, so the page loses nothing and stops claiming
  a session it cannot see. The existing e2e's
  `getByRole("link", { name: "Your account" })).toHaveCount(2)` assertion at
  `not-found.spec.ts:47` would need updating and is the right place to pin the
  new behaviour.

### 6. Two names for one system, on the page whose whole job is orientation

- **Severity:** minor
- **Where:** `src/app/not-found.tsx:49`, `src/app/payouts/[id]/not-found.tsx:59`
- **Cost:** A member follows a truncated Discord link, lands on a header reading
  their corporation's name, and two lines below reads that the address "doesn't
  match anything in authGD" — a word that appears nowhere else on the screen and
  nowhere in the chrome, on the one page a stranger or a signed-out member can
  reach.
- **Principle:** none. Counter-evidence, weighed: `.env.example:78-79` scopes
  `BRAND_NAME` to "the header wordmark, every page title, and image alt", so the
  prose literal is documented rather than accidental, and it is app-wide (six
  further sites in `account/page.tsx`, `payouts/page.tsx`, `login/page.tsx`).
  That documents the scope; it does not argue that the reader benefits. On these
  two pages the lede is nearly the entire screen, which is what makes them worse
  than the rest.
- **Fix:** On these two the name adds nothing and can simply go: *"That address
  doesn't match any page here."* and *"That link points at an operation that
  isn't here."* Both read better, neither needs config, and neither pre-judges
  the app-wide prose question, which is a single decision that should be made
  once and not inside a 404.

### 7. The missing `loading.tsx` is the right call, but the reason does not cover `/admin` and lives where nobody will find it

- **Severity:** minor
- **Where:** absence across `src/app/`; the argument at
  `src/app/payouts/pending-link.tsx:17-24`; the exception at
  `src/app/admin/layout.tsx:13-21`
- **Cost:** Small and bounded. An admin clicking "Audit log" from "Members"
  holds on the previous page for the length of the query with only the tab
  spinner; a `src/app/admin/loading.tsx` would flush the chrome plus a skeleton
  at the layout's TTFB instead. The larger cost is to the next contributor: the
  decision is recorded in a payouts-only client component that scopes itself to
  "at the root and at this segment alike", so someone adding an admin page has
  nothing telling them it was considered for theirs.
- **Principle:** none.
- **Fix:** Mostly, do nothing, and move the reasoning somewhere reachable. The
  brief asked me to argue this either way, so:

  **The absence is correct.** No page render in this app makes an external HTTP
  call. `error.tsx:15-18` states it directly ("the web tier never calls ESI
  directly, so an ESI outage itself shows up in the worker, not here"), and the
  only ESI import anywhere under `src/app/` is `payouts/actions.ts:41`, an
  action rather than a render. Every page's TTFB is therefore a small number of
  same-region Postgres queries — three overlapped on `/account`, two on
  `/admin/sync`, four sequential on `/payouts/[id]` — against a `max = 5` pool
  with a 5s connect timeout. And all but three in-app navigations are hard
  `<a href>` (`SiteHeader` uses anchors throughout), where the browser's own
  progress UI is the loading state and, crucially, the previous page stays
  painted rather than blanking. A root `loading.tsx` would be actively worse
  than nothing: `SiteHeader` is rendered by each page, not by a layout, so its
  Suspense fallback replaces the chrome, trading a stable old page for a
  chrome-less dark flash. `pending-link.tsx` says this and is right. The three
  soft navigations that genuinely paint nothing already have a better answer
  than a route-level fallback: `useLinkStatus` scoped to the pressed control.

  **The one place the argument does not hold** is `/admin/*`, where the chrome
  *is* in a layout — `admin/layout.tsx` renders `AdminNav`, which renders
  `SiteHeader`, and no admin page renders one of its own (verified). So an
  `src/app/admin/loading.tsx` would preserve the header and the section nav and
  cost nothing. Whether it is worth adding is a judgement about how slow
  `getAdminAccountsList` and `queryAuditLog` actually are, which I could not
  measure from source. Either way, record the decision in `admin/layout.tsx`
  where the next admin page's author will read it.

  Note that fixing finding 4 removes most of what a loading state would have
  bought here anyway: the complaint "I pressed it and nothing happened" is a
  missing `:active`, not a missing skeleton.

## What is good and must survive

- **`FocusHeading` on all three boundaries, and the `reset()` remount it rides
  on.** `focus-heading.tsx:20-23` and `e2e/error-boundary.spec.ts:97-140`
  together are the only signal a screen-reader user gets that a failed retry
  landed. If finding 1 changes the button's label or copy, do not touch the
  remount behaviour or the effect it re-runs.
- **`Notice tone="bad" live={false}`.** The reasoning at `error.tsx:189-197` and
  `ui.tsx:262-266` is correct and non-obvious: an assertive region rendering in
  the same commit as a focus move preempts the heading. The `live` knob exists
  for exactly this one case. Do not "fix" the missing role.
- **The digest-absent branch of the Notice** (`error.tsx:204-214`). A render
  throw arrives with no digest, and the old markup dropped the whole sentence,
  leaving a member told to escalate with nothing to escalate. Any copy rewrite
  from finding 1 or 2 must keep both branches.
- **The three-way divergence in how titles resolve** across `error.tsx`,
  `not-found.tsx` and `payouts/[id]/not-found.tsx`, and the fact that all three
  are pinned by e2e. `error.tsx:147-155` and `payouts/[id]/not-found.tsx:26-33`
  each record the measurement and each warn against generalising to the other.
  This is the single most likely thing for a tidying pass to "simplify" into a
  bug.
- **`.escalation`'s decision not to set `user-select: all`**
  (`globals.css:2036-2039`). It defeats selecting the digest alone, which is the
  most likely single thing anyone copies. Findings 2 and 3 add fields to this
  block; do not let that turn into a select-all.
- **`sectionFor()`'s honesty argument** (`error.tsx:58-79`). The deliberate
  divergence from `not-found.tsx` — path evidence on a guarded route versus no
  evidence at all on an unrouted URL — is correct and is the reason finding 5
  applies to one file and not the others.
- **`payouts/[id]/not-found.tsx` existing at all.** The second file earns itself
  on one path: a member reading the operations list clicks a row that has since
  been deleted and is returned to the list rather than to `/account`
  (`e2e/not-found.spec.ts:75-129`). A dedupe pass that merges it into the root
  boundary would lose exactly that.
- **The absence of `global-error.tsx`** (`error.tsx:26-34`), which is on the
  settled list and which I agree with after reading the argument: it would ship
  a second, permanently off-brand shell without `globals.css` or either face,
  for a failure path `RootLayout` cannot produce.

## Could not evaluate

- **Whether `reset()` re-invokes a thrown server action.** This decides finding 1
  and I reasoned it from the boundary's props rather than measuring it. Settled
  by: an e2e that drives a server action which commits a write and then throws,
  presses "Try again", and asserts the write count did not change. That test does
  not exist; `e2e/error-boundary.spec.ts` drives render throws only.
- **Real TTFB per route.** Finding 7's verdict rests on "a few same-region
  Postgres queries", which I established by reading the query fan-outs, not by
  timing them. `getAdminAccountsList` on a full roster and `queryAuditLog` with
  its name-resolution pass are the two that could surprise. Settled by timing
  those two against a production-sized dataset. A dev server was out of scope
  for this sweep.
- **Whether any admin other than the deployer can resolve a digest.** Finding 2's
  third paragraph assumes the only route is the platform's log CLI. Settled by
  the operator saying whether the 2-4 admins have that access.
- **How members actually escalate.** Findings 2 and 3 both assume the report is
  relayed asynchronously through Discord rather than the member and the admin
  being in the same conversation. If it is always the latter, finding 3 loses
  most of its force and finding 2's identity gap partly closes on its own.

## Contested

Nothing on the settled list. Two of my findings brush against it and I want to
be explicit that neither is a reversal request:

- Finding 1 does not propose disabling "Try again" or adding a revert timer. It
  proposes that the label and the lede describe what the control does. The
  `aria-busy`-not-`disabled` decision is correct and should stay.
- Finding 4 does not propose a `loading.tsx` anywhere, and finding 7 argues
  against one at the root and under `/payouts`, agreeing with the existing
  reasoning.
