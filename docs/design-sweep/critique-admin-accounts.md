# critique — /admin/accounts

Register: **product**. Traced path: an admin arrives because someone reported a
wrong Discord role, and has to find that person and fix it.

The page is well built and heavily argued. Almost every finding below is about
what the surface *cannot* do, not about what it does badly — and the two
questions it answers worst are the two the arriving admin actually has: "which
row is this person?" and "is anything wrong with them?"

## Findings

### 1. There is no way to find a person, and find-in-page does not reach alts

- **Severity:** serious
- **Where:** `src/app/admin/accounts/page.tsx:177-223`, `src/app/_components/disclosure.tsx:129-133`
- **Cost:** An admin told "my Discord role is wrong" by a member who names an alt has no way to locate that member's row: the filters only take tier and status, and browser find-in-page cannot see alt names because every collapsed drawer is `hidden` and its subtree is not rendered at all until the row's first toggle.
- **Principle:** PRODUCT.md principle 3 (scanning is the primary act); PRODUCT.md's own admin session description, "many rows, looking for the one that is off"
- **Fix:** Add a `?q=` free-text filter to `.filters`, matching main name, every character name, and the Discord handle, implemented as one predicate in `getAdminAccountsList` (`src/services/account-view.ts:336-338`) over the `charsByAccount` map it already builds. The sibling admin surface already has the pattern and the markup to copy: `/admin/audit`'s `.filter-form` carries three labelled free-text fields (`src/app/admin/audit/page.tsx:443-502`), so this is consistency work as much as new capability. Note the second half separately: `Disclosure`'s own docblock argues find-in-page as a *reason* for `<details>` and then explicitly keeps the `as="details"` children eager for it, while the `as="row"` branch gates children on `everOpen` and marks the row `hidden` — so on this one page the argument is inverted and nothing says so at the call site. Either accept that and let the `q=` filter cover alt names, or render the alt names (not the whole crew table) in the collapsed row.

### 2. Approving a pending account costs an extra click per account; granting admin does not

- **Severity:** serious
- **Where:** `src/app/admin/accounts/page.tsx:614-646` (Actions cell) vs `:654-688` (drawer approve)
- **Cost:** An admin working a queue of eight new signups must open eight drawers to reach Approve, while `grant` admin — an action a 2-4-admin corp performs a handful of times ever — sits in the always-visible Actions column of all 200 rows.
- **Principle:** none (this is the prominence question the nav badge already answers in the opposite direction)
- **Fix:** On a `pending` row, render the two Approve buttons in the Actions cell in place of `grant` — `grant` is meaningless on an unapproved account anyway, so the cell's width is free. Keep the drawer copy for admins who arrived there for another reason. The rest of the flow is already right: `approveAction` revalidates without redirecting, and on `?tier=pending` the approved row simply leaves the list, so a queue worked from the Actions column would be one click per account with no navigation at all.

### 3. The Admin column and the grant/revoke control encode the same boolean, side by side

- **Severity:** moderate
- **Where:** `src/app/admin/accounts/page.tsx:71-78`, `:600-602`, `:614-646`
- **Cost:** Two of the ten columns are spent on a fact that is true for 2-4 accounts and false for every other row, on a table that horizontally scrolls at the 320-390px widths `e2e/admin.spec.ts` tests it at — so the columns that push off the right edge are Last login and Actions, pushed there by a column that prints "member" two hundred times.
- **Principle:** PRODUCT.md principle 3 — a column whose value is identical on 98% of rows gives the eye nothing to catch
- **Fix:** Drop the `Admin` column from `FIXED_COLUMNS` and move `grant`/`revoke` into a fourth `drawer__group` beside Cryo and Note, where the other rare, consequential, per-account actions already live. The Actions cell then carries `sync now` plus (per finding 2) approve. `.st--off` already suppresses the dot fill for the neutral state, which is the right instinct; this finishing move is to stop printing the word at all.

### 4. All three notices use the `&&` form the `Notice` primitive documents as the one shape that breaks it

- **Severity:** moderate
- **Where:** `src/app/admin/accounts/page.tsx:154`, `:156`, `:160`; contract at `src/app/_components/ui.tsx:276-282`
- **Cost:** A screen-reader admin who loses a race — clicks `revoke` and gets redirected back with `?error=last_admin` — gets no announcement, because the `role="alert"` element is *inserted* already holding its text during the soft navigation rather than existing across it with only its content changing.
- **Principle:** the component's own docblock, which names this exactly: "The `&&` form is the one shape that defeats the live region it just asked for"
- **Fix:** Mount all three unconditionally — `<Notice tone="bad">{errorMessage}</Notice>`, and the same for the queued and pending banners. `Notice`'s empty-slot mode exists for precisely this and carries no glyph or tone class when empty, so `p.notice--bad` stays the "is there a message" selector the e2e suite already uses. `/admin/sync` (`src/app/admin/sync/page.tsx:152-160`) is the reference implementation and this page is the outlier.

### 5. Column order is `SORTS` order then `FIXED_COLUMNS` order — code structure, not scanning order

- **Severity:** moderate
- **Where:** `src/app/admin/accounts/page.tsx:48-53`, `:71-80`, `:239-281`, cells at `:461-646`
- **Cost:** "Tier changed" — a date consulted when auditing one specific account — occupies the fourth column, immediately beside the pinned name, pushing Tokens, Discord and Map (the three columns an admin arrives to read) further under the horizontal scroll at every width where the table overflows.
- **Principle:** PRODUCT.md principle 3
- **Fix:** Decouple *which columns sort* from *where columns render*. A column's sort link can hang off any header; today the two are one array, and the `FIXED_COLUMNS` docblock's promise that "adding a label here is the only edit a new column needs" structurally biases every future column to the far right, which is the least visible position on a scrolling table. Suggested order: Name (pinned), Tier, Tokens, Discord, Map, Cryo, Last login, Tier changed, Actions.

### 6. The filter chips and the sort set are the schema's writable enums, not the questions admins ask

- **Severity:** moderate
- **Where:** `src/app/admin/accounts/page.tsx:48-59`, `:177-223`; implementation `src/services/account-view.ts:336-366`
- **Cost:** After a mass token expiry, an admin who wants the list of members whose main has gone dark has to read all two hundred rows by eye and has no URL to hand to the other admin — Tokens is neither sortable nor filterable, and neither is Discord, Map, or Last login.
- **Principle:** none
- **Fix:** The tell is that all four sorts and both filters are exactly the fields stored on the `account` row, and everything derived from characters has neither. Add a `Tokens` filter group (`any` / `main dead` / `any dead or stale`) and a `Discord` group (`linked` / `none`), and make Tokens and Last login sortable. All of it is a predicate and a comparator over rows `getAdminAccountsList` has already assembled in memory — no new query. Two filter groups is already the right visual weight for `.filters`; four will need the `.filters__sep` treatment reconsidered, since at 40rem the separator already collapses to a line break.

### 7. The page cannot say whether the Discord roles job is current — the one thing the arriving admin needs first

- **Severity:** moderate
- **Where:** `src/app/admin/accounts/page.tsx:225-227` (the `renderedAt()` aside), `:496-583` (the Discord cell)
- **Cost:** An admin chasing "my Discord role is wrong" reads a Discord column that reports only that a link exists, then opens a drawer and leaves for the audit log — when the likeliest single explanation, "the roles job hasn't run since 02:00", is one number the page never shows.
- **Principle:** PRODUCT.md, "an admin can answer 'why is this person's role wrong?' … in under a minute"
- **Fix:** Per-account role state does not exist in the schema and should not be invented for this. `getPushStatus` (`src/services/account-view.ts:61-96`) already returns `discord.lastPushedAt`, `map`, and `standings`, and the `RuleHead` aside is already the slot for exactly this kind of stamp. Render "roles HH:MMZ · map HH:MMZ · standings HH:MMZ" beside the rendered-at time so the global question is answered before the admin starts opening rows. Related asymmetry worth noting while you are in here: of the three things authGD pushes, Map has a column, Discord has only link-presence, and Standings appears nowhere outside the drawer's crew table.

### 8. The queued-sync confirmation cannot name the account it confirms

- **Severity:** minor
- **Where:** `src/app/admin/accounts/page.tsx:142`, `:156-158`, `:636-644`
- **Cost:** An admin queueing syncs for three members in a row gets the same unchanging "Sync queued" banner at the top of the page all three times, and cannot tell from the screen which presses landed.
- **Principle:** none
- **Fix:** `syncQueuedHref` is computed once at page scope and shared by every row, so it structurally cannot carry a name. Move it into `AccountRow` and build it per row as `qs({ queued: identity })`, then render "Sync queued for {name}." This is also the one control on the page that navigates where its eight siblings revalidate in place, which is defensible (it is the only one whose effect is invisible in the row), but the navigation should at least buy a specific sentence.

### 9. "Cryo" the column and "Status" the filter are the same field under two names, 200px apart

- **Severity:** minor
- **Where:** `src/app/admin/accounts/page.tsx:51` (`{key:"status", label:"Cryo"}`) vs `:199-221` (`filters__label` "Status", chips `cryo`/`active`)
- **Cost:** An admin looking for the frozen-accounts control scans a filter group called Status and a column called Cryo and has to work out they are one thing; a voice-control user saying "cryo" hits an ambiguous pair, since the chip and the sort link share the word — the e2e suite already documents having to disambiguate them by the "▪" the active chip draws (`e2e/admin.spec.ts:696-701`).
- **Principle:** none (WCAG 3.2.4 governs across pages, not within one)
- **Fix:** Name both "Cryo" — it is the product's own noun, the column's header already uses it, and "Status" is a generic that also reads as token status two columns over.

### 10. The pending banner drops the admin's sort, and still renders when it is already satisfied

- **Severity:** minor
- **Where:** `src/app/admin/accounts/page.tsx:160-166`
- **Cost:** An admin sorted by Tier changed who clicks "3 accounts awaiting approval" is silently returned to name-ascending, on the one page that otherwise routes every link and every mutation through `listParams` specifically so that cannot happen.
- **Principle:** none
- **Fix:** Use `qs({ tier: "pending", status: undefined })` rather than the hand-written href — dropping `status` is correct and deliberate (a cryo filter would hide part of the queue), dropping `sort`/`dir` is not. Separately, suppress the banner when `tier === "pending"` already: as written it offers a link to the page you are on, directly above a filter chip that is showing `aria-current`.

### 11. DESIGN.md's "known defect" on `.st` weight has already been fixed in the stylesheet

- **Severity:** minor
- **Where:** `DESIGN.md:141-142` vs `src/app/globals.css:1352-1363` and the register comment at `:234-240`
- **Cost:** A later fix pass reading the design record as the source of truth spends time re-fixing a solved bug, or worse, "restores" the documented state.
- **Principle:** none
- **Fix:** `.st` now declares `font-weight: 600` explicitly, and the register comment already explains why. Delete the parenthetical from DESIGN.md. (Also stale, and cheaper: `e2e/admin.spec.ts:735-737` still says "The three `.drawer__label`s (Set tier / Cryo / Note)"; there are four now that History has joined them.)

## What is good and must survive

- **`tokenState` returning `{tone, mainDead}` as one derived pair** (`page.tsx:344-364`). The proportional tone ladder — main-dead forces red, a stale alt does not — is the single best expression of "nothing reads as punishment" on the surface, and the pair-return is what makes the text and the colour structurally unable to disagree. Do not let a refactor split it into `tokenTone(r, mainDead)`.
- **`listParams`/`qs`/`listSearch` threaded into every mutation.** Nine server actions all return the admin to the exact tier, status, sort and direction they were scanning. This is invisible when it works and infuriating when it does not; findings 10 and 8 are both about the two places the discipline is not applied, which is the measure of how good the rest of it is.
- **`countPendingCached()` deliberately independent of the active filters** (`page.tsx:117-123`). A pending count computed from `rows` would vanish for an admin looking at `?status=cryo`. Any "optimization" that derives the badge from the rendered list is a regression.
- **The `↕` on inactive sortable headers** (`page.tsx:258-272`, `globals.css:780-800`). Four of ten headers sort; without the glyph nothing distinguished them until hover, which touch and keyboard never reach. It is also correctly `aria-hidden`, leaving `aria-sort` to carry the state.
- **`named()` normalising whitespace-only ESI names into a real fallback chain** (`page.tsx:413-438`). A truthy-but-blank name taking the identity slot would produce an empty pinned cell and `aria-label="Note for "` — in the one column whose entire job is saying whose tier is about to change.
- **`.drawer`'s `width: calc(100cqi - 2 * var(--s-3))` plus sticky-left** (`globals.css:2784-2793`). The comment measures the alternative at 332px of horizontal scroll to reach `save note`. Nothing about this rule looks necessary from the outside; it is.
- **The always-hidden Discord unlink cost sentence.** Settled, and the reasoning at `page.tsx:545-571` is correct on its own terms independent of the reveal-on-arm history.

## Could not evaluate

- **Row count in the reference deployment.** Findings 1, 3 and 6 all scale with it: at 30 accounts the missing name filter is an annoyance, at 300 it is the page's defining limitation. PRODUCT.md says "small corporation" and "2-4 admins" but never sizes the membership. A seeded 200-row render would settle whether the ten-column layout is dense or merely wide.
- **Whether `syncAccountAction`'s `redirect()` resets scroll position.** If it does, finding 8 upgrades from "the banner is generic" to "the admin loses their place in the table on every sync press." Settled by pressing `sync now` from row 40 in a browser; out of scope here per the preamble.
- **Whether the crew table's four columns earn their space**, since I could not see one rendered with a realistic eight-alt account. The `.log--crew` comment claims "nothing here fights for space", which is true at desktop and not obviously true inside a 262px drawer at 320px.

## Contested

Nothing on the settled list. One adjacent note: the settled entry for the
Discord unlink cost sentence is framed as an accessibility decision, and the
`ConfirmArmScope` reasoning behind it (one arm state shared by three confirms
per row across every row) is the actual constraint. If `ConfirmSubmit` ever
takes a per-control id, that entry becomes re-openable on its own terms rather
than by re-arguing the reflow — worth recording so a future sweep does not read
"settled" as "settled forever".
