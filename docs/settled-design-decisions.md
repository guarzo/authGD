# Settled design decisions

A consolidated index of design decisions already made and recorded as inline
comments across `src/app/` (and `DESIGN.md`/`PRODUCT.md`), spanning roughly
PRs #95–#127. Every review of this surface has spent tens of thousands of
tokens re-deriving these from scratch, and at least once re-flagged an
already-fixed defect as a live bug. Read this first.

**Scope and method.** Every row below quotes or faithfully paraphrases an
*existing* comment — nothing here is invented rationale, and no wording has
been improved beyond what the comment actually says. Every row cites the
`file:line` where the comment lives today. Entries whose citation could not be
confirmed against the current tree are called out at the end instead of
folded in silently. This is a docs-only artifact: no source file other than
`DESIGN.md`'s one stale line (see below) was changed to produce it, and any
defect noticed while assembling it is reported, not fixed.

## How to use this

If you're reviewing a page in `src/app/` and a piece of markup, a class name,
or a control's grade looks wrong, check here before assuming it's a bug — it
may be a settled trade-off with a citation below. If you disagree with a
trade-off, that's a real review finding; just don't re-derive it as if it were
undiscovered.

---

## 1. Shared primitives (`src/app/_components/`)

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| `ConfirmSubmit` arms on first click, fires on second; no `window.confirm()` | Too easy to hit a destructive action by accident scanning a dense table; `window.confirm()` "rips the member out of the page" | `src/app/_components/confirm-submit.tsx:122-127` |
| No revert timer on an armed control | A timer is a time limit on a user action with no way to extend it (WCAG 2.2.1); 4s is short enough that a magnifier user can lose the arm mid-sentence. Abandonment is covered by blur, Escape, and pointer-leave instead | `src/app/_components/confirm-submit.tsx:33-38` |
| `ConfirmArmScope` renders no DOM of its own | Has to be able to wrap a `<tbody>` without breaking table structure | `src/app/_components/confirm-submit.tsx:28-31` |
| Armed state is announced via an always-mounted `role="status"` span, not just the visible/`aria-label` swap | Neither label swap is reliably re-announced on an already-focused control; a region born already holding text is what AT misses, so the span must exist empty at rest | `src/app/_components/confirm-submit.tsx:129-136` |
| `ConfirmCost` reveals `.visually-hidden` text on arm only, matched by `describedBy` id (not "something in scope is armed") | A scope-wide reveal is correct for one control and wrong for every other one sharing the scope | `src/app/_components/confirm-submit.tsx:62-87` |
| Reveal-on-arm inside a table `<td>` was tried and reverted (#112) | Revealing text widens the cell, which moves the armed button out from under the mouse, firing `pointerLeave` and disarming the very control that just armed — "the reveal undoes the arm" | `src/app/_components/confirm-submit.tsx:89-98` |
| `restName`/`confirmName` must start with the visible label | Keeps the accessible name a WCAG 2.5.3 label-in-name match | `src/app/_components/confirm-submit.tsx:148-151`, `src/app/_components/confirm-submit.tsx:186-190` |
| Submit buttons are never `disabled` while pending | `disabled` moves focus to `<body>`, and most of these actions end in a server-action `redirect()` (a client navigation with no document load) with nothing to put focus back | `src/app/_components/submit.tsx:14-21`, `src/app/_components/submit-guard.ts:9-15` |
| Re-entrant submit guard uses a `ref`, not `useFormStatus().pending` | `pending` only flips true on the render *after* the first submit; a double-click lands both clicks inside that window. The ref latches synchronously in the first click's own handler | `src/app/_components/submit-guard.ts:17-22` |
| Guard's release waits for `pending` to go true-then-false, not just "any render where it reads false" | A bare `if (!pending) release()` also fires on a re-render arriving before React commits the pending state, reopening the double-submit window | `src/app/_components/submit-guard.ts:29-36` |
| `Disclosure` is built on native `<details>`, not an ARIA button+region accordion | Works with no JS at all, and browsers can find text inside a collapsed section (matters when hunting for a job name or error string) | `src/app/_components/disclosure.tsx:5-10` |
| Admin accounts drawer content is gated on `everOpen`, not `open` (latches on first toggle, never re-hides) | An unmount-on-close would drop an unsaved note draft (`defaultValue`) back to its original value; eager render of every row's subtree (crew table, nested Scroller, NoteForm, ~6 forms) up front is the cost of a drawer nobody opened | `src/app/_components/disclosure.tsx:104-117` |
| Same latching deliberately NOT applied to the `as="details"` branch | Find-in-page has to reach text inside a collapsed `<details>` with no JS | `src/app/_components/disclosure.tsx:119-122` |
| `Scroller`'s edge fades live on a second non-scrolling `.scroller-frame` ancestor | An absolutely-positioned child of the `overflow-x: auto` box would ride off with the scrolled content instead of staying pinned to the edge | `src/app/_components/scroller.tsx:9-14` |
| `scrollable`/tab-stop state starts `true` (not measured-false) | Server can't measure; starting `tabIndex={-1}` for every region would leave overflow unreachable by keyboard for the whole pre-hydration window — "a real loss of access traded for a cosmetic one" | `src/app/_components/scroller.tsx:39-44` |
| `Scroller` uses `ResizeObserver`, not a window resize listener | A Scroller inside a collapsed `<details>` (sync page's job strips) measures 0×0 and never gets a resize event when the disclosure opens; an observer sees the box gain size | `src/app/_components/scroller.tsx:60-65` |
| `Tier`'s prop type keeps `(string & {})` open rather than closing on the enum | The audit log renders historic tier values straight from the DB, which can outlive the enum if a tier is renamed/retired | `src/app/_components/tier.tsx:6-12` |
| Unknown tier renders a neutral badge, never another tier's colour | "give it a neutral badge rather than borrowing another tier's colour and asserting a lie" | `src/app/_components/tier.tsx:37-38` |
| Tier lock glyph is CSS-drawn, not the 🔒 emoji | A vendor glyph ignores `--tone` (a fourth uncommanded colour) and its advance width broke the mono column's tabular rhythm | `src/app/_components/tier.tsx:48-52` |
| `Status`'s `tone` and `children` stay separate props, not a bound `{tone, label}` pair | 56 call sites don't share one vocabulary across four unrelated domains (token health, map presence, Discord link, cryo); a bound pair would either have to cover all of them or force every call site through a per-domain lookup — bigger surgery than this primitive should make unilaterally | `src/app/_components/ui.tsx:215-227` |
| `Notice`'s `tone` derives both the ARIA `role` and glyph, replacing 8+ hand-rolled call sites | They had already drifted — some `role="alert"`, some `role="status"`, some no role, each hand-typing `data-glyph` | `src/app/_components/ui.tsx:249-255` |
| `Notice` renders an empty reserved slot rather than nothing (`{err && <Notice>}` is the wrong shape) | The `&&` form inserts a live region with its text already inside it, and AT announces a *change* to a region far more reliably than one born holding text | `src/app/_components/ui.tsx:257-268` |
| `SiteHeader` matches nav items on `href`, not a separate `key` field (now removed) | Two conventions (route-keyed vs label-keyed) both typechecked and silently produced no active tab when they disagreed | `src/app/_components/ui.tsx:4-16` |
| `SiteHeader`'s `section` prop emits `aria-current="true"` instead of `"page"` | `/payouts/new`, `/payouts/[id]` and the payout 404 all passed `current="/payouts"` while not being `/payouts`; `"page"` falsely told a screen reader "current page" | `src/app/_components/ui.tsx:35-44` |
| `SiteHeader` no longer takes a `measure` prop that tracked the page's own column width | Bought seal/nav alignment at the price of a 288px width change (144px lateral jump) whenever a route crossed measures; falsified once `/payouts` (wide) and `/payouts/new` (narrow) sat in the same walk. Reversed within #39 once already, this is the third position | `src/app/_components/ui.tsx:50-69` |
| Sign-out is a `<form method="post">`, not a link | The one control in the nav bar that isn't a destination — see `auth/signout/route.ts`'s own CSRF rationale for why GET is unsafe here | `src/app/_components/ui.tsx:162-170` |
| Nav membership is a property of the *viewer*, not of the section on screen: the bar lists every destination the viewer is provably authorized to reach | Membership used to be hand-copied per section, so an admin on `/admin/audit` had no route to `/payouts` in the chrome — "not because the rule said so but because `admin-nav.tsx`'s `ITEMS` array had never been taught payouts existed. The bug was the architecture, not a missing conditional" | `src/app/_components/nav-items.ts:4-29` |
| `navFor` takes `canReadPayouts` and `isAdmin` as two explicit bits, neither inferred from the other | They are orthogonal columns and the default tier is `alumni`, so an admin is not necessarily a payouts reader; taking both explicitly leaves no call site that can render `Operations` unconditionally just because the viewer is an admin | `src/app/_components/nav-items.ts:25-29` |
| One fixed item order everywhere — `Your account, Operations, Members, Audit log, Sync`, broadest access first — which moved "Your account" from last to first in the admin bar | Every reach then sees a strict prefix "in membership, not merely in count" of one list, rather than five per-surface orderings that happened to agree by convention. The admin bar's reorder "is a consequence of there being one order, not a separate decision about the admin bar" | `src/app/_components/nav-items.ts:31-38` |
| The five label strings exist exactly once, and `error.tsx`'s hand-sync comment is deleted rather than reworded | Two names for one route fails WCAG 3.2.4 Consistent Identification. "A hand-sync comment is a bug report against the architecture: it is only needed because two arrays exist to drift apart" — with one array there is nothing left to keep in sync | `src/app/_components/nav-items.ts:40-49` |
| The three session-blind boundaries use `navFromPath`, written as calls to `navFor` rather than as their own literal arrays | Makes "the boundary is the same rule under weaker evidence" a fact about the code rather than a claim in a comment, and stops a rule change from reaching the session-aware surfaces while silently missing the session-blind ones. Each branch claims only what its guard proves: `/admin/*` proves `isAdmin` and *not* tier, `/payouts/*` proves tier and *not* `isAdmin`, an unrouted 404 cleared no guard and proves neither | `src/app/_components/nav-items.ts:58-74`, `:98-113` |
| `admin/layout.tsx` looks `canReadPayouts` up separately and prop-drills it to `AdminNav`, alongside `pendingCount` | `requireAdminPage` proves `isAdmin` and nothing about tier, so the second bit has to be read from the account row. A layout not re-running on soft navigation is acceptable here because tier changes come from a sync run or an admin action, both full loads | `src/app/admin/layout.tsx:16-29` |
| `SiteHeader`'s `admin` prop stays keyed to the *section*, not to membership, even though item membership no longer is | It drives three things membership does not answer — the mark's destination, the `ADMIN` register marker, and the nav's accessible name ("Admin" vs "Main") — so an admin standing on `/account` gets the full item list in a bar that still names itself "Main" | `src/app/_components/ui.tsx:71-78`; the item-list half is asserted at `e2e/shell.spec.ts:90-108` and the bar-name half at `:145-162` |
| `NoteForm`'s "· saved" confirmation is driven by `useActionState`'s return value, not an optimistic guess | The field's own value already shows what was typed, and the drawer stays open — a successful save otherwise changed nothing else visible ("saving…" flashed ~50ms and a click read as dead) | `src/app/_components/note-form.tsx:6-12` |
| `NoteForm` tracks `dirty` (typed-since-last-save) separately from the action's own returned counter | The action's state holds its last value until the *next* submit; comparing counters is what distinguishes "a save just landed" from "still showing the last one," including two saves in a row | `src/app/_components/note-form.tsx:13-19` |
| `FocusHeading` moves focus to the page's `h1` on mount, rather than relying on Next's `AppRouterAnnouncer` | A soft navigation (e.g. `notFound()` from a stale list link) unmounts the pressed link and focus falls back to `<body>`; the App Router's own `focus()` call targets the `<header>`, which is unfocusable and a no-op | `src/app/_components/focus-heading.tsx:6-28` |
| `AppRouterAnnouncer`'s first-`h1` fallback is *not* relied upon, and is deliberately not asserted in e2e | Measured landing well on a soft nav into a boundary, but that's a race, not a contract | `src/app/_components/focus-heading.tsx:30-37` |

## 2. Type and label register (`globals.css`, `DESIGN.md`)

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| One shared "label register" block declares family/size/weight(600)/case once; components opt in by adding a selector | 13 sites had redeclared it in two different weights (9 inherited 400, 4 said 600); weight is deliberately not left to inheritance because several sit inside elements (`h2`/`th`/`dt`) with differing UA weight | `src/app/globals.css:217-233` |
| `.btn`, `.tier`, `.st` take the register's family/size/case but are NOT in the shared selector list | They are components with their own states; folding their type in would put it "two hundred lines from their behaviour" | `src/app/globals.css:234-236`, `DESIGN.md:138-142` |
| `.st` now declares its own explicit `font-weight: 600` | It used to leave weight to inherit (rendering at 400) while `.btn`/`.tier` declared 600 — "a real inconsistency, not a variant" — now fixed | `src/app/globals.css:237-240`, `src/app/globals.css:1393-1399` (see DESIGN.md fix below) |
| `.shell__nav a` and `.strip__group` are in the register beyond what the original audit enumerated | `.shell__nav a` sits in the same bar as `.shell__register`; leaving it at inherited 400 while its neighbour moved to 600 would rebuild the exact split the register exists to close. `.strip__group` names a fixed group ("Sweep", "On-demand", "Housekeeping") | `src/app/globals.css:242-250` |
| `.push__next`, `.btn-row__stamp`, `.worker` are enumerated by the audit and deliberately NOT in the register | None is a label — each renders a prose word plus a computed value ("next 14:32", "checked 20:25:25 UTC", "worker · last run 18m ago") and reaches for `--track-value` (the value-tracking token), which is the tell | `src/app/globals.css:252-267` |
| Tracking is tokenised (`--track-value`/`control`/`label`/`furniture`) rather than left as a bare number per call site | It's the one property that legitimately varies by the job the label is doing | `DESIGN.md:128-136` |
| `--signal-warn` hue moved from 70 to 50 | At 70 it sat 18° from `--gold`/`--tier-member` at near-identical chroma/lightness (0.057 apart in OKLab) — not enough to tell a gold Member badge from an amber CRYO token two columns away | `DESIGN.md:58` |
| Disabled controls use an explicit `--ink-faint` colour, not an opacity fade | An opacity fade moves with whatever ground it lands on: measured 3.24:1 on `--void` but 2.88:1 on a hovered admin row — under the WCAG 3:1 floor exactly when the pointer is on the row | `DESIGN.md:222-226` |
| Hit targets: 36px standalone (`.btn`), 28px in-row (`.btn--micro`/`.btn--quiet`/`.row-toggle`) — exactly two sizes | Both clear the 24px WCAG 2.5.8 AA minimum; the admin tables carry a control set on every row and cannot reach 44px AAA without growing past a screenful, so density wins there and nowhere else | `DESIGN.md:227-232` |
| **AMENDED 2026-08-07 (owner walkthrough, ruling R1)** — still exactly two sizes, but "in-row" is scoped by the density reason, not by the tag. A `Disclosure as="row"` drawer renders a `<tr>` and is nonetheless **not** in-row: one is open at a time, it spans the full width, nothing competes for the space. Drawer controls take 36px | Resolves a contradiction rather than reversing a decision: `e2e/sync.spec.ts:1095` has been pinning the `/admin/sync` drawer to the standalone grade all along, and `payouts/[id]/notes-form.tsx:90-95` reasons the same way for a panel field. Only `/admin/accounts` read the row above as forbidding it, having inherited 28px by structural accident | `DESIGN.md` "Hit targets", `e2e/sync.spec.ts:1095-1121`, `src/app/_components/note-form.tsx` |

## 3. Controls and confirmation (cross-cutting patterns)

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| Admin accounts table's Discord-unlink cost hint is hidden-always (`.visually-hidden`), not reveal-on-arm | `ConfirmArmScope` is tbody-wide (three confirms per row); reveal-on-arm was tried and reverted after #112 showed the widening disarms the very control it revealed for | `src/app/_components/confirm-submit.tsx:89-98`, `src/app/admin/accounts/page.tsx:560-566` |
| "Queues removal," not "removes" (Discord unlink copy) | `unlinkDiscord` ends in `enqueueSync`; roles come off in the worker, not synchronously | `src/app/admin/accounts/page.tsx:568-571` |
| Admin accounts table has exactly one gold `.btn--primary` at a time, tracked by `primaryStage` | No loot yet → appraising is the only useful action; loot but no roster → set roster; both present, still draft → finalize. Once finalized, Unlock and payment controls are deliberately plain grade | `src/app/payouts/[id]/page.tsx:213-227` |
| Unlock demoted from `.btn--quiet` back to plain `.btn`, matching Finalize | Quiet made it indistinguishable from the label register beside it; it reopens finalized financial state, the same weight as the Finalize it undoes | `src/app/payouts/[id]/page.tsx:439-447` |
| "Replace roster from a paste" submit is `.btn--danger-quiet`, not `.btn--quiet` | Neither structural sibling ("Add participant", "Set roster") is quiet; `.btn--quiet` here would read as a caption rather than the control that sends the form. `--danger-quiet` keeps destructive restraint (colour only) without spending the border the affordance needs — the same pairing "Delete operation" uses | `src/app/payouts/[id]/page.tsx:1004-1014` |
| "Add one participant" is a disclosure, reachable even before the first roster paste | `setRosterAction` deletes and reinserts the whole roster, discarding every share edit; this is the only way to add one name without that cost | `src/app/payouts/[id]/page.tsx:698-707` |
| Only the *first* "mark paid" per operation is armed via `ConfirmSubmit`; later ones are plain `Submit` | `locked` (hasPayments) is permanent once the first payment lands, "so every later 'mark paid' is a click behind a door already shut" | `src/app/payouts/[id]/page.tsx:208-211` |

## 4. Tables (admin accounts, audit, sync, payouts roster/loot)

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| `FIXED_COLUMNS` (admin accounts) is a list, not a count | Three things depend on the table's width — header row, empty-state colSpan, drawer row's colSpan — and a hand-kept number drifts the moment one is updated and the others aren't | `src/app/admin/accounts/page.tsx:66-70` |
| `TIERS` (manual-assign options) excludes `pending`; `TIER_FILTERS` is a superset including it | Pending is a state accounts are born in and `setTierManual` locks whatever it sets; but pending accounts still have to be findable via the filter | `src/app/admin/accounts/page.tsx:54-59` |
| `tokenState()` returns `{tone, mainDead}` as one derived pair, not two independent functions | The tone and the "main dead" marker are two renderings of one fact; splitting them is what lets them disagree (WCAG 1.4.1 — colour alone was the only thing distinguishing two accounts with identical text) | `src/app/admin/accounts/page.tsx:321-342` |
| Token tone escalates to red only when the account's *main* character is dead, or zero healthy tokens; amber otherwise | A long-dead alt token is routine, not an alarm; PRODUCT.md's "nothing reads as punishment" otherwise fails on any account with one stale alt | `src/app/admin/accounts/page.tsx:336-342` |
| History drawer link filters the audit log by resolved NAME, not raw account uuid | `resolveFilterIdentity` expands a name into the account, every character carrying it, AND the linked Discord id — a bare uuid matches strictly less of the person's history | `src/app/admin/accounts/page.tsx:790-796` |
| Audit `Pager` renders on `hasLatest` OR a full page, not `rows.length === AUDIT_PAGE_SIZE` alone | The old condition made the exact-`AUDIT_PAGE_SIZE`-row page a dead end — page 2 has fewer rows, so page 2 rendered no pager and no way back | `src/app/admin/audit/page.tsx:169-173` |
| Audit `ambiguityNotes` threshold is the UNION `accountCount + operationCount <= 1`, not either count alone | A 1-account+1-operation match still warns — that pair is exactly the conflation the notice exists to flag, even though neither count alone is ambiguous | `src/app/admin/audit/page.tsx:332-335` |
| Audit `pastEnd` (cursor ran past a non-empty log) is tracked separately from "the log has zero rows" | Mirrors the same priority the empty-state message uses elsewhere: an unmatched filter name still gets named even if `before` also happens to be set | `src/app/admin/audit/page.tsx:355-359` |
| Audit ISO timestamp column shows elapsed time below 40rem, not the full stamp | At 320px the 19ch ISO stamp was 196px of a 286px region (69%) and it's the pinned column, painting over whatever the scroll brought alongside it | `src/app/admin/audit/page.tsx:575-583` |
| Audit elapsed-time text is rendered once on the server, not by a re-ticking client component | A full page is `AUDIT_PAGE_SIZE` rows; a live version costs 100 `setInterval`s and 100 client-component boundaries in the RSC payload at every viewport | `src/app/admin/audit/page.tsx:585-589` |
| `admin.promoted` is deliberately absent from `summarize.ts`'s `PARTS` registry | It was declared with a scope no writer produces — seeded test data only, never emitted by real code | `src/app/admin/audit/summarize.ts:179-183` |
| Sync page groups jobs under `role="list"` PER group with `aria-labelledby`, not one flat `role="list"` of 7 | The button label used to spell out all four job nouns in uppercase mono before shrinking to "Sync now" once the strip carried that grouping visually; hiding the group headings from the AT tree would have deleted the one thing a screen-reader user needs — which jobs the primary button covers | `src/app/admin/sync/page.tsx:193-212` |
| Sync's `at=Date.now()` redirect param exists to force re-announcement of the notice | The notice lives in a permanently-mounted `role="status"` region; a region only announces a *change*, so a byte-identical repeat notice (same job re-queued) would otherwise be silence | `src/app/admin/sync/actions.ts:18-24` |
| `HEALTH_TONE`/`HEALTH_LABEL`/`NEEDS_ATTENTION` are parallel `Record<RowHealth, …>` maps | A new `RowHealth` member is a compile error across all three, so they cannot fall out of step with each other or the type | `src/app/admin/sync/view.ts:73-76` |
| `never` health renders `off` tone, not `warn` | A job that hasn't run yet on a worker too young to say it should have is a state, not a fault — same logic PRODUCT.md applies to alumni tier and a dead token | `src/app/admin/sync/view.ts:44-48` |
| `QUEUED_AGE_STUCK_MS` is exactly 10× `QUEUED_AGE_NOTABLE_MS` (15min vs 2min) | Past the stuck threshold "the dispatcher is not merely [delayed]" | `src/app/admin/sync/view.ts:293-301` |
| Payout roster table gets its own tall-scroll threshold (`ROSTER_TALL_THRESHOLD = 20`) rather than inheriting `/admin/accounts`'s | Below this many rows, `.scroller--tall`'s height cap does more harm than good | `src/app/payouts/[id]/page.tsx:104-107` |
| Payout loot pool items render as one top-level editable table per pool, not one disclosure per pool | Items used to hide behind "Pool N items (M)" — exactly the loot this section exists to show; DESIGN.md's "scanning is the primary act" argues against burying the thing being scanned | `src/app/payouts/[id]/page.tsx:583-589` |
| Copy-amount button moved out of the roster's Amount cell into the row's action cell | `.stack`'s left-alignment inside a right-aligned numeric column cost the column its one reason to exist — a single vertical to read down | `src/app/payouts/[id]/page.tsx:815-824` |

## 5. Per-surface decisions

### Login / account (`login/`, `account/`)

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| `auth/signout/route.ts` is POST-only, never GET | `sameSite: "lax"` still attaches the session cookie to cross-site top-level navigation, so a GET signout would be CSRF-triggerable | `src/app/auth/signout/route.ts` (see `src/app/_components/ui.tsx:162-170` for the nav-side rationale) |
| OAuth callbacks log only `.message`, never the full error object | Postgres errors can carry the query and its parameters, which can include refresh-token material | `src/app/auth/eve/callback/route.ts`, `src/app/auth/discord/callback/route.ts` |

### Admin guard (`admin/layout.tsx`, `src/lib/admin-guard.ts`)

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| The layout-level guard is additive to each page's own guard, not a replacement | Layouts don't re-run on a soft (client) navigation between sibling admin pages, and a server action never passes through a layout at all | `src/app/admin/layout.tsx` |
| `countPendingCached` needs no DB index | `tier` is a 4-value enum on a small table | `src/app/admin/pending-count.ts` |

### Payouts access and error handling

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| `requirePayoutReader` is tier-only, any status (cryo included) | Matches the design's "Access and visibility" section — a cryo member account still reads everything | `src/app/payouts/access.ts:33-38` |
| `canOpenInfo` is gated on the operator's own main character's PERSISTED scope grant, never on `cfg.eveSso.scopes` | Config says what authGD *asks* for; an operator who authorized before the scope was added has a valid session and no grant. The control is hidden, not disabled, when false — a disabled button "advertises a capability this operator does not have and gives them nothing to do about it" | `src/app/payouts/access.ts:21-30` |
| `getMainCharacterWithScope`'s check returns the row, not a boolean | `openInfoAction` needs the row itself (for `getFreshAccessToken`) and re-checks at call time regardless — "a render-time boolean is a rendering decision, never an authorization one" | `src/app/payouts/access.ts:68-74` |
| Dropped-paste lines travel via a base64url query param, never persisted | Phase-2 design decision (defect 3); base64url avoids relying on a caller remembering to percent-encode | `src/app/payouts/dropped.ts:1-11` |
| Dropped-reason lookup uses `Object.hasOwn`, not `in` | The reason string comes off a query param; `in` walks the prototype chain, so `"constructor"`/`"toString"` would pass and render `Object.prototype`'s own values | `src/app/payouts/dropped.ts:78-82` |
| `NEW_OPERATION_ERRORS` and `OPERATION_ERRORS` are two separate maps with deliberately non-unique codes (`name_required`, `date_invalid` in both) | The detail page's "the old value is unchanged" is true there and false on the create form (nothing exists yet); one map would force a message wrong on one of the two pages | `src/app/payouts/errors.ts:10-17` |
| `pricing_mode`/`location_kind`/`station_invalid`/`region_invalid` in `OPERATION_ERRORS` are unreachable backstops | `AppraiseForm` used to submit these as form fields; `addAppraisedPoolAction` now hardcodes Jita sell-best, so no current form path reaches them — kept because a hand-built request still could | `src/app/payouts/errors.ts:46-51` |
| `share_format`/`share_range` are similarly unreachable backstops | `setCorpShareAction`'s own `<form>` was removed from the facts grid (corp share is now a deployment-wide default); the action and its validation stayed | `src/app/payouts/errors.ts:52-56` |
| `operationFailed()`/action redirects are typed `: never` and must never be called inside a `try` | `redirect()` throws `NEXT_REDIRECT`; a `try`/`catch` around it would swallow the redirect and the operator would land on `error.tsx` instead | `src/app/payouts/actions.ts:98-110` |
| `APPRAISAL_PRICING_MODE`/`APPRAISAL_STATION_ID` are hardcoded constants (Jita, sell-best) | Replaces 3 removed form controls (pricing mode, location kind, station) | `src/app/payouts/actions.ts:62-63` |
| `addAppraisedPoolAction`'s direct triff/ESI call is an ARCHITECTURAL EXCEPTION to "enqueue, don't execute" | Appraisal is interactive (operator pastes, waits, re-pastes) and the call is read-only and idempotent — "a lost or duplicated call is a re-click, not a corrupted record" | `src/app/payouts/actions.ts:260-265` |
| `openInfoAction`'s direct call is a second, separately-justified ARCHITECTURAL EXCEPTION | This one is a POST that persists no state anywhere — its only effect is a window opening on a game client; queueing it would be actively worse (the window would surface minutes later on a client that's moved on) | `src/app/payouts/actions.ts:641-648` |
| `createOperationAction` runs the appraisal call BEFORE opening the DB transaction | Same rule as `addAppraisedPoolAction` — a slow upstream call must never hold a row lock; also avoids creating an orphaned operation shell on appraisal failure | `src/app/payouts/actions.ts:133-144` |

### Payouts pages and forms

| Decision | Reason (as recorded) | Citation |
|---|---|---|
| Every field in `NewOperationForm` is controlled (`useState`), not `defaultValue` | React DOM resets a form's *uncontrolled* fields the instant the action promise settles, success or rejection — an uncontrolled paste textarea would lose a hundred-line paste on the very rejection this component exists to survive | `src/app/payouts/new/new-operation-form.tsx:23-30` |
| `createOperationAction` returns `{ok:false, code}` via `useActionState` rather than redirecting through `?error=` | A redirect can only carry a fixed code in the query string, and a loot paste can run hundreds of lines | `src/app/payouts/new/new-operation-form.tsx:16-21` |
| `/payouts/new` form sits in a `.form-panel` (`--hull` on `--void`), the page H1/lede stay on page ground | A bare form on the page void reads as a settings row rather than the start of a mission; wears no registration ticks (those are the login panel's alone) | `src/app/payouts/new/page.tsx:49-54` |
| `InlineEdit` defaults `standalone = true` (36px hit target), dense table rows opt into `standalone={false}` (28px) | Matches DESIGN.md's two-tier hit-target floor rather than inventing a third size | `src/app/payouts/[id]/inline-edit.tsx:49-84` |
| Every action passed to `InlineEdit` must reject via redirect, never return state | This is what makes `defaultValue` (uncontrolled) safe for `InlineEdit`'s fields — contrast `AppraiseForm`/`NewOperationForm`, whose rejections return state and therefore must stay controlled | `src/app/payouts/[id]/inline-edit.tsx:148-154` |
| `AppraiseForm` uses its own `useActionState` rather than the query-string `?error=` pattern | Same reasoning as the composer: a redirect can't carry a paste running hundreds of lines back to the textarea | `src/app/payouts/[id]/appraise-form.tsx:10-21` |
| `AppraiseForm`'s value is controlled, not merely kept mounted | Staying mounted is necessary but *not* sufficient — React 19 still resets an uncontrolled field once the `<form action>` submit settles | `src/app/payouts/[id]/appraise-form.tsx:16-21` |
| `PaymentHistory` renders a null actor as "unknown", never "system" | No job ever writes a payment row — every one is an operator action, so a null actor is an indistinguishable deleted-account/no-main-character case, not an automated one | `src/app/payouts/[id]/payment-history.tsx:20-24` |
| `deriveRosterWarnings` splits `duplicateUnresolvedNames` (service refuses) from `crossStateClashes` (service explicitly ALLOWS) | The two states have different origins: a duplicate unresolved name can still slip past pre-guard rosters, while a linked/unlinked clash under one name is a state the service tolerates on purpose | `src/app/payouts/[id]/roster-warnings.ts:24-36` |
| `ClearStaleQuery` drops `?error=`/`?dropped=` at the moment the *next* submit starts, not on mount | Balances "notice must survive its own originating redirect" against "notice must not outlive the failure it described" | `src/app/payouts/[id]/clear-stale-query.tsx:44` (see also `src/app/payouts/[id]/page.tsx:310-313`) |
| `data-navigates` opt-out attribute exists for forms that already redirect on success | Keeps `ClearStaleQuery` from clearing a query param that a self-redirecting form is about to set itself | `src/app/payouts/[id]/clear-stale-query.tsx:64` |
| `CopyAmountButton`'s visible label never changes between states | WCAG 2.5.3 label stability; feedback instead goes through a separate `role="status"` live region | `src/app/payouts/[id]/copy-amount-button.tsx:15-26,81` |
| `CopyAmountButton` uses `role="status"`, not `"alert"` | Next's own route announcer (`AppRouterAnnouncer`) already claims `role="alert"` | `src/app/payouts/[id]/copy-amount-button.tsx:26` |
| `/payouts/[id]`'s 404 is a segment-scoped `not-found.tsx`, not the root one | `page.tsx` already calls `requirePayoutReader()` before calling `notFound()`, so everyone who reaches it has already passed the access check | `src/app/payouts/[id]/not-found.tsx:12` |
| `/payouts/[id]`'s 404 uses `generateMetadata`, not a static `metadata` export | Lets the title read "No such operation" specifically, rather than a generic "Payout operation" that would also apply when the operation exists | `src/app/payouts/[id]/not-found.tsx:36` |
| `PendingLink`'s pending affordance is built on `useLinkStatus`, not a route-level `loading.tsx` | A `loading.tsx` fallback would blank `SiteHeader`'s chrome — `SiteHeader` is rendered per-page, not from a shared `payouts/layout.tsx` | `src/app/payouts/pending-link.tsx:16-26` |

---

## Excluded or unverifiable — flagged, not included above

Per the hard requirement that an unverifiable claim is worse than a missing
one, these comments describe past or intended state that could not be
confirmed as *current* fact from the surrounding code alone, and were left out
of the tables above:

- **`.dim-ink` (`src/app/globals.css:1368`)** — the class is introduced with
  language describing it as the thing a future caller "should take instead,"
  i.e. it documents an intended follow-up rather than a settled, verified
  current-state decision. Checked: `grep -rn dim-ink src/` returns the
  definition and nothing else, so as of this file's writing **no call site has
  adopted it**. Treat it as an open follow-up, not as a fix already landed.

- **`.inline-pair` (`src/app/globals.css:3043`)** — the surrounding comment
  describes a rule that "lived here" in the past tense, i.e. a historical note
  about removed CSS. The claim that nothing currently depends on it was not
  independently re-verified against current markup during this pass.
- **The old column-1-unpin-on-drawer-open rule (`src/app/globals.css:3417-3444`)**
  — same shape: a comment explaining why a since-removed rule was removed.
  Treated as historical context, not a citable "current decision," and
  excluded from the tables above for that reason.

None of the three above is a defect — they are comments about history, correctly
read as such — but none makes an affirmative claim about code that exists
today, so none was given a row above.

## Further drift noticed while assembling this (not fixed)

Scanning `DESIGN.md` end-to-end against the current code for the same class of
staleness that affected the `.st` line, nothing else was found to contradict
the code as of this pass: the radius token (`--radius: 2px`), the two motion
durations (140ms/220ms) and easing curve, the global focus ring (`2px solid
--gold`, `2px` offset), `prefers-reduced-motion` collapse, and the two hit-target
sizes (36px/28px, confirmed via `.btn`'s `min-height: 2.25rem` and the
`.btn--micro`/`.btn--quiet` in-row grade) all match `globals.css` as written.
No other correction is proposed.
