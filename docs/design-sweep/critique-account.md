# critique — /account

Register: **product**. Traced: a member with one dead token, from arrival through
`re-authorize` → EVE SSO → `/auth/eve/callback` → `linkCharacter` →
`reauthCharacter` → `enqueueSync` → redirect → second render of `/account`.

The page's spine is right. One derived verdict above everything, a facts grid, a
manifest, remediation prose outside the scroll region, telemetry, then the art.
The verdict *concept* — "answer am I fine before offering anything to press" —
is genuinely built here rather than claimed. What it does not survive is the
round trip: the state it reports is correct on arrival and wrong on return, and
the register it reports in does not distinguish "you must act" from "you cannot".

## Findings

### 1. A successful re-authorization returns the member to a page saying the token is still dead, and hands them the same button again

- **Severity:** blocking
- **Where:** `src/app/account/page.tsx:566-586`, `src/app/account/contact-state.tsx:62,171-199`, `src/core/account-health.ts:112-118`, `src/services/accounts.ts:128-144`
- **Cost:** A member who has just completed the one repair this page exists for lands back on `/account` and reads `1 CHARACTER NEEDS ATTENTION`, a red `TOKEN INVALID` in the CONTACTS cell, and the sentence "This character's EVE token is dead." now carrying a *fresh* re-authorize link — so the only available conclusion is that the fix failed, and the only available act is a second SSO round trip that will land them in exactly the same place.
- **Principle:** PRODUCT.md principle 2 ("state before action" — the state is stale and the page does not say so); "Nobody has to think about the tool".
- **Fix:** `reauthCharacter` updates `character.token_status` and enqueues an account sync, but never touches `contact_sync_state`; the outbox dispatcher polls on a 2s loop and the contacts job then has to reach ESI, so the redirect *always* renders before the new result lands. Two options, in order of preference:
  1. Treat the token-family contacts codes as superseded by a healthy token, using data already on the page. In `contact-state.tsx`, when `result` is `token_invalid` / `needs_reauth` / `missing_scope` **and** the caller reports the token is now valid, render `<Status tone="off">re-checking</Status>` and a remedy reading "Token re-authorized. The next standings sync clears this." In `account-health.ts`, take the same signal so `needsAttention` stops counting it — otherwise the headline keeps contradicting the cell. This needs one extra prop threaded from the row, which the row already has.
  2. Or add `reauthed_at` to `character`, compare against `contact_sync_state.last_synced_at`, and suppress any result older than the last re-auth. More honest, costs a migration.
- Whichever is taken, drop `showReauth` in the token-family branch when the token is already valid (`page.tsx:581`). Its docblock reasons that the stale-snapshot case is "the only place the control can live" — but the dominant way that case arises is *the member having just used it*, and offering it again there is the page asking them to redo work it has not admitted receiving.

### 2. On a degraded account there is no primary action, and the one remedy is the quietest control on the page

- **Severity:** serious
- **Where:** `src/app/account/page.tsx:479-481, 566-586, 588-602`, `src/app/account/contact-state.tsx:87-97`
- **Cost:** A member arrives because a token died, is told so at the top of the page, and then finds the fix rendered as `btn--quiet btn--micro` — visually identical to `make main` and `unlink` beside it — in the third column of a table that horizontally scrolls at 320px, while the remediation block below the scroller, which exists specifically so fix instructions stay reachable when the table does not, deliberately renders no control at all in this state.
- **Principle:** none (this is the "the screen does not do the job it exists for" kind).
- **Fix:** The `attention === 0` gate at `page.tsx:597` correctly stops the page shouting *"Add character"* on a broken account, but nothing was promoted in its place — the demotion left the page with zero primary actions at the exact moment it has one obvious primary action. Invert `showReauth` (`page.tsx:581`) so the remedy block carries the control precisely when the token is bad, and drop it when the TOKEN cell is already offering one; the "never two links to one href" rule then still holds, but it resolves in favour of the copy that is reachable rather than the cell that may be scrolled off. Consider raising that one control to the default `.btn` grade the Discord row uses — `btn--micro` keeps the 28px in-row height, and this is a remedy, not a row utility.

### 3. The verdict does not outrank the tier badge it was written to outrank

- **Severity:** serious
- **Where:** `src/app/globals.css:1395-1422` (`.st--lead`) vs `1492-1496` (`.tier--lead`); `src/app/account/page.tsx:181-189`
- **Cost:** A member alt-tabbed for ten seconds on a degraded account has their eye pulled to a gold-bordered, gold-filled `MEMBER` badge — the one fact on the page that needs no action — while the amber line reporting the fault sits one step above it, one pixel larger, unfilled, and un-bordered.
- **Principle:** DESIGN.md Scale ("Ratio 1.25 minimum between adjacent steps"); the `.st--lead` docblock's own claim, "This outranks it on size".
- **Fix:** The numbers do not support the claim. `.st--lead` is `--t-body` = 15px; `.tier--lead` is `--t-data` = 14px. That is a ratio of 1.07 against DESIGN.md's own 1.25 floor, and the badge additionally carries `0.3em 0.65em` padding, a 1px full-chroma border, and a 14% fill — so it wins on area and on saturation while losing on type size by a rounding error. Either take `.st--lead` to a genuine step (`--t-h2`, 22px, still sentence-case, still no new colour) — which also makes the "no fill needed" argument true — or drop `size="lead"` from `Tier` in `StandingTier` when `health.verdict !== "nominal"`, so the tier badge stops competing on a page where it is not the news. The first is the smaller change and keeps the tier row consistent across states.

### 4. The lead verdict is `white-space: nowrap`, so it runs off the page at 200% text size

- **Severity:** serious
- **Where:** `src/app/globals.css:1352-1363` (`.st` sets `nowrap`), `1413-1422` (`.st--lead` inherits it), `.verdict` at `546-548` adds nothing
- **Cost:** A member who has raised their browser's font size — plausible at 1am, and the exact population PRODUCT.md's zoom promise is written for — loses the right-hand end of the single most important line on the page off the edge of the viewport, and gets a horizontal scrollbar on the document to reach it.
- **Principle:** WCAG 2.2 SC 1.4.10 Reflow and SC 1.4.4 Resize Text; PRODUCT.md "usable to 200% zoom and down to 320px width without horizontal scrolling of the page".
- **Fix:** The docblock already knows the budget is tight — "at 320px the content box is 288px and the longest current verdict … measures ~268px" — and treats it as a copy constraint. It is a wrapping constraint. `nowrap` belongs to `.st` because a status token is a value in a table cell; `.st--lead` is a sentence and should shed it: add `white-space: normal;` to `.st--lead`, and change `.st`'s `align-items: center` to `align-items: baseline` under `.st--lead` (or give the `::before` dot `margin-top` compensation) so a two-line verdict does not centre its dot against the whole block. That also retires the "measure before rewording" constraint, which is currently blocking fix #6 below.

### 5. The two verdicts the member cannot act on shout in the same register as the one they can

- **Severity:** serious
- **Where:** `src/app/account/page.tsx:198-219`; `src/core/account-health.ts:38-47, 120-130`
- **Cost:** A member is trained, over a handful of visits, that a large amber line at the top of their account page means "go do something" — and then meets `2 characters not syncing` and `Discord roles behind schedule`, which mean "wait", so the next time the line genuinely means "your token is dead" they skim it.
- **Principle:** PRODUCT.md principle 4 — "Reserve alarm colour for things the user can and should fix"; principle 2's promise that "a member should be able to leave without clicking".
- **Fix:** The code argues this carefully at the copy level — the `stalled` branch's comment explains why the wording is about who owns the fix — and then renders it `tone="warn" size="lead"`, identical to `degraded`. The argument was won in the sentence and lost in the props. Give `stalled` and `discord-stale` `tone="off"` (which `.st--off` already renders as `--ink-faint` with a hollow dot — a distinct, non-alarm mark that still reads as a state) while keeping `size="lead"` so they stay above the fold, and reserve `tone="warn"` for `degraded`. `AccountHealth.stalled`'s own docblock — "a headline demanding attention above copy saying the opposite teaches members to distrust the headline" — is the argument for this; it just was not applied to the colour.

### 6. "Discord roles behind schedule" reads as a personal fault on a page titled "Your account"

- **Severity:** moderate
- **Where:** `src/app/account/page.tsx:208-219`; the disambiguating sentence is at `625-628`, roughly a full screen below
- **Cost:** Every linked member sees this simultaneously the moment the corp-wide `discord-roles` job stops, reads it as "my Discord roles are wrong", and the fastest available check is to ask in the very chat channel the tool exists to keep quiet.
- **Principle:** PRODUCT.md — "A member links an alt and the right things happen without anyone asking in chat."
- **Fix:** The branch's comment states the constraint exactly right ("this can only ever mean the job itself stopped running corp-wide, never that this member's own roles are wrong") and then mitigates it only by omitting the word "your". Omission is not a signal: the H1 says "Your account", the lede says "the state authGD is pushing out to … Discord", and the Standing section directly below is entirely about this member — the surrounding page asserts personal scope, so silence inherits it. Say the scope: `Discord role sync behind schedule corp-wide`. That is 43 characters and blows the current nowrap budget, so it depends on finding 4 landing first. If finding 4 is deferred, the shorter `Discord sync behind schedule (corp-wide)` still fits under wrapping and says the load-bearing word.

### 7. `nominal` asserts more than the page checked

- **Severity:** moderate
- **Where:** `src/core/account-health.ts:27-36` (the documented exclusion), `src/app/account/page.tsx:224-227`
- **Cost:** A Member-tier player whose characters all read `OFF` in the MAP column — because the Wanderer job has not run since a deploy, which is indistinguishable in `wanderer_acl_observation` from being legitimately off the ACL — is told `NOMINAL` at the top of the page, closes the tab, and undocks without map access.
- **Principle:** PRODUCT.md principle 2 ("Every screen answers what is true right now"); DESIGN.md's Status token rule that colour is never the only carrier — here the *absence* of a signal is carrying a claim.
- **Fix:** The exclusion itself is correct and well argued: a verdict counting `onMapAcl` would alarm every member who is legitimately off the map. But "do not raise an alarm" and "assert that everything is fine" are different decisions, and only the first was made. The verdict word is the problem, not the input set. Either narrow the claim — render `tokens and standings nominal` in the nominal branch, which is exactly what was checked and stays deadpan — or suppress the nominal verdict entirely for a `member`-tier account with zero characters on the ACL and let the MAP column speak for itself. The narrowed wording is the smaller change and does not need the map data to become trustworthy first.

### 8. The closing artwork downloads a 3840px variant to paint a 420px box

- **Severity:** moderate
- **Where:** `src/app/account/page.tsx:651-659`; `src/app/globals.css:2972-2995`; `public/brand/hero-account.webp` (1120×711, 85KB)
- **Cost:** Every member on a short, interruptive session pays for the largest asset on the page — the decorative one — at four to nine times the pixels it renders, on a connection they are sharing with a client that is still running.
- **Principle:** PRODUCT.md principle 5 — "never a large file scaled down".
- **Fix:** `<Image width={1120} height={711} />` with no `sizes` prop makes next/image emit a DPR-descriptor srcset built from the declared width: with the default `deviceSizes`, that is `?w=1200 1x, ?w=3840 2x`. `next.config.ts` sets no override. So a DPR-2 laptop fetches a 3840px upscale of an 1120px source to fill a CSS box that `.closing img` caps at `min(420px, 100%)` — or 260px in the `--compact` state. The two docblocks asserting "cut for exactly this, never a scaled-down master" and "asks the same asset for a smaller frame rather than … downscaling it" describe an intent the markup does not deliver. Pass the real box: `sizes={view.characters.length <= 1 ? "260px" : "420px"}` on the `Image`. The page already branches on that condition one line above for the class name, so the value is free. That switches Next to a `w`-descriptor srcset and the browser picks 640 or 828 instead of 3840. If the asset is genuinely never shown above 420px, also consider re-cutting it at 840 and dropping the declared width to match — DESIGN.md's "cut for the size it is drawn at" then becomes true of the file as well as of the intent.

### 9. The `first-sync-pending` verdict restates the notice directly beneath it

- **Severity:** minor
- **Where:** `src/app/account/page.tsx:220-223` and `242-256`
- **Cost:** A brand-new member — the one reader who has the least idea what any of this means — spends their first two lines reading the same fact twice before reaching the sentence that tells them how long to wait.
- **Principle:** impeccable shared law, Copy: "no restated headings".
- **Fix:** The `Notice` is the one carrying information (the wait is minutes, and which of the three outputs are covered); the `FIRST SYNC PENDING` token above it adds only a mono uppercase paraphrase. Drop the `first-sync-pending` arm of the verdict ternary and fall through to `nominal`, or better, render nothing at all in that arm — the `Notice` is already unconditional on `health.firstSyncPending` and sits within 40px. The `AccountHealth` field stays as it is; only the verdict's fourth branch goes. Note this does not touch the `firstSyncPending`-vs-`degraded` independence the comment at `232-241` protects: that case renders `degraded` in the verdict and the notice below, which is the correct pairing and is unaffected.

## What is good and must survive

- **`ContactRemedy` living outside the `Scroller`.** The docblock records the measurement that drove it (a ~340px row, off-screen and unreachable at 320px). Finding 2 asks to add a control to that block; it must not move the block back inside the table to do it.
- **`hasContactRemedy` gating both the `aria-describedby` and the element.** One predicate at both sites is what makes a dangling id structurally impossible. Any change to the remedy's render condition has to go through that function, not around it.
- **The `firstSyncPending` / `verdict` split in `computeAccountHealth`.** A just-linked character is simultaneously "needs attention" and "waiting on its first run", and the notice explaining that the wait is minutes must survive the verdict leading with the fault. Finding 9 removes the *verdict* arm and deliberately leaves this intact.
- **`ConfirmCost` matching on `describedBy` rather than "something in this scope armed".** The scope-wide reading is correct for a scope of one and silently wrong everywhere else; that is exactly the shape that looks simplifiable in a cleanup pass.
- **The `MEMBER_FIXABLE` set typed `ReadonlySet<string>` but constructed `Set<ContactSyncResult>`.** The construction is the typo check and the declaration is what lets `.has()` take a widened DB value. Collapsing the two types in either direction loses one of the two properties.
- **`PushRow`'s distinct never-pushed state.** `formatAgo(null)` would say "never", which reads as a fault in a member's telemetry rather than "we have not got to you yet". Do not simplify to a null pass-through.
- **The `Notice` empty-slot behaviour.** Mounting unconditionally and rendering an empty slot is what makes the live region announce a *change*; the `&&` form defeats the region it just asked for. A "cleanup" that reintroduces `{message && <Notice/>}` is a silent regression.
- **`.facts__lead` as a layout-only class.** The name says "lead" and it means "flex row that wraps"; the `visually-hidden` `dt` alternative breaks the grid tracks. Both the tier row and the Discord row depend on it and neither is decorative.

## Could not evaluate

- **Whether the `re-authorize` control is actually clipped at 320px.** `.log` is `width: 100%` but every cell's content is `nowrap`, so the manifest's intrinsic width in a 288px box is well over the container and the region scrolls. Where the third column's right edge lands relative to the viewport edge is a measurement, and finding 2's severity partly rests on it. Screenshots and a dev server are out of scope for this sweep; a Playwright assertion in `e2e/account.spec.ts` at a 320px viewport, checking the TOKEN cell's bounding box against the scroller's visible width, would settle it. Finding 2 stands regardless on the "quietest control grade, no primary action" half.
- **The exact next/image srcset emitted.** I derived `?w=1200 1x, ?w=3840 2x` from the default `deviceSizes`, the absent `sizes` prop, and `next.config.ts` setting no override. I did not build the app to read the rendered `srcset`. `npm run build` plus a grep of the account page's HTML would confirm the widths; the qualitative point (no `sizes` on a `width={1120}` image capped at 420px by CSS) holds either way.
- **How often `discord-stale` actually fires.** It depends on the `discord-roles` cron (`15 * * * *`) versus `isOverdue`'s tolerance, which I did not read in full. Finding 6's cost scales with frequency; its correctness does not.
- **Whether the closing artwork "earns its place" editorially.** I think it does — it is the one place PRODUCT.md's joke is allowed to live, it is decorative with an empty `alt`, it is lazy-loaded, and left-aligning it on the page's own vertical rather than centring it is a real and correct call. Finding 8 is entirely about delivery, not about whether the image should be there.

## Contested

Nothing on the settled list. Two notes that touch it without reopening it:

- Finding 3 proposes moving `.st--lead` to `--t-h2` rather than adding colour or fill, and finding 5 proposes moving two verdicts *down* to `--ink-faint`. Neither spends gold, neither adds a hue, and both leave `--signal-warn` at hue 50 exactly where DESIGN.md put it.
- Finding 2 proposes changing the grade of one control from `quiet` to `default`. Both grades are 28px at `btn--micro`; this is a colour-grade change and not a third hit-target size.

The known `.st` weight defect does not apply here — `.st` declares `font-weight: 600` at `globals.css:1358` and `.st--lead` restates it. Whatever fixed it, it is fixed on this surface.
