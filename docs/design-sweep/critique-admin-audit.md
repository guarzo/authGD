# critique — /admin/audit

Register: **product**.

Judged against PRODUCT.md's stated criterion: *"An admin can answer 'why is this
person's role wrong?' from the audit log in under a minute."*

Traced literally. An admin is told "Zed's Discord role is wrong", opens
`/admin/audit`, types `Zed` into a filter, and reads.

The good case works, and works well. If Zed is the **main** of their account and
the system **did** act, the admin gets it in seconds: `resolveFilterIdentity`
unions the account uuid, the character ids and the Discord snowflake, so
`tier.changed → Member → Alumni, main left alliance` and
`discord.role_changed → +Alumni −Member, tier Alumni` land as adjacent rows under
one name — the exact answer, in one query, in under a minute. That is a real
achievement and most of the findings below are about the paths that fall off it.

The two that fall off it are the common ones: Zed is an alt, or nothing happened.

## Findings

### 1. The page is silent about every way a role sync fails, and silence reads as health

- **Severity:** serious
- **Where:** `src/jobs/discord-roles.ts:143-197` (esp. `147`, `179-189`,
  `190-196`), read against `src/app/admin/audit/page.tsx:403-425`
- **Cost:** An admin told "Zed's role never showed up" filters `target: Zed`,
  sees the last `discord.role_changed` from three weeks ago and no error since,
  and concludes the system did its job — when the actual cause (Zed is not in
  the guild, or Discord 403'd on that one user) was recorded nowhere on this
  page and is sitting in a five-item truncated `errorSummary` on `/admin/sync`
  that nothing told them to open.
- **Principle:** PRODUCT.md success criterion ("answer 'why is this person's
  role wrong?' from the audit log in under a minute"); PRODUCT.md principle 2,
  "State before action — every screen answers 'what is true right now?'"
- **Fix:** Two halves, and the page-side half alone is not enough.
  - Writer: `discord-roles.ts:147`'s comment already says `// user not in guild
    → log and skip` and then only increments a counter — make it true with a
    `logAudit(db, { actor: "system", action: "discord.not_in_guild", target:
    row.discordUserId })`, written once on transition rather than every cycle.
    Do the same in the `catch` at `190-196` for the non-transient case
    (`discord.role_failed`, `details: { error }`) — that branch currently pushes
    a string into a local array and loses it after five. Both then resolve to
    Zed's name through the existing Discord-snowflake path and appear on this
    page under the filter the admin already typed, with `summarizeDetails`
    parts (`scalar("error")`, and nothing for `not_in_guild`) added alongside
    the existing `discord.*` entries in `summarize.ts:238-243`.
  - Page: an audit log answers "why" only by containing rows. Where it contains
    none for the thing being asked about, it must say where else to look. When
    `target` resolves to a person and the returned page holds no `discord.*`
    row, the count rule should carry a link to `/admin/sync` rather than leaving
    an absence to be read as an all-clear.

### 2. Searching an alt's name silently returns a fraction of that person's history — or lies that the character does not exist

- **Severity:** serious
- **Where:** `src/services/audit.ts:332-361` (actor) and `407-432` (target);
  empty copy at `src/app/admin/audit/page.tsx:378-393`
- **Cost:** A member reports the problem under the character name they were
  flying — usually an alt, since the crew manifest is the product's whole
  premise. Typing that name into **Target** returns only the `character.*` /
  `token.*` / `wanderer.*` rows that happen to carry the character id, and drops
  every `tier.*`, `status.*` and `discord.*` row for the owning account, with no
  warning; the admin reads a plausible non-empty result set and concludes the
  system never touched Discord. Typing it into **Actor** is worse: it returns
  `No account or character named "Zed" (actor).` — factually false, a character
  by that name exists — and, because the unmatched branch outranks the
  `filtered` branch, the "Search Zed as a target" nudge that would rescue them
  does not render.
- **Principle:** none. (It is precisely the failure `TargetCell`'s own docblock
  at `page.tsx:116-128` argues against — "filtering by whichever one this row
  happens to carry would hide the other two thirds of their history." The
  argument was applied to clicking a name and to a **main's** name in the filter
  box; the alt case is its unhandled residue.)
- **Fix:** In the target branch, `ids` is built from `displayAccountIds` only
  (`audit.ts:427-432`) while `accountCount` already includes
  `chars.map(c => c.accountId)` (`437`). Widen `ids` the same way — include the
  owning accounts of every matched character and their Discord links — so a
  name resolves to a person, not to a row-shape. Then let the existing
  `ambiguityNotes` machinery say so: when the union came from an alt, emit
  `target "Zed" is an alt on Bob's account; showing that account's history`.
  For the actor branch, `audit.ts:353` returns `{kind: "none"}` for a real
  character — return a distinct kind, or at minimum make the unmatched message
  at `page.tsx:388-393` say *"'Zed' is a character but never appears as an
  actor"* and carry the same target nudge the `filtered` branch already writes.

### 3. The row about the role never says why the role changed

- **Severity:** moderate
- **Where:** `src/jobs/discord-roles.ts:182-188`,
  `src/app/admin/audit/summarize.ts:239-243`
- **Cost:** The admin scanning for the one row that answers the question reads
  `+Alumni −Member, tier Alumni` — the state, said twice, and no cause. The
  cause is on a different row (`tier.changed`, `cause: "main left alliance"`,
  `membership.ts:58-67`) with a different target id, and the admin has to notice
  the two are related before the page has told them anything.
- **Principle:** none.
- **Fix:** `summarize.ts:241` declares `scalar("cause")` for
  `discord.role_changed`, but only the unlink path (`discord-roles.ts:95`) ever
  writes one, so it renders empty on the path that matters. Carry the cause
  through: `enqueueSync(tx, { kind: "account", accountId })` at
  `membership.ts:68` is the enqueue that leads to this row, so the tier
  transition's cause is available at the point of enqueue. Write it into the
  role row's details and the line becomes `+Alumni −Member, main left alliance`
  — the whole answer on one row. While there, drop `tierLabelled("tier","tier")`
  from that part list: with the role names already resolved to tier labels it
  restates the same fact in the same words, in the narrowest column on the page.

### 4. There is no "when", in either the filters or the pager

- **Severity:** moderate
- **Where:** `src/app/admin/audit/page.tsx:238-243` (the four params),
  `187-218` (`Pager`), `366-376` (`countLabel`)
- **Cost:** An admin who knows only "it broke sometime last week" has one
  navigation available: press `Older →` and read 100 rows, repeatedly, with no
  indication of how far back any page reaches — and having overshot, no `Newer`
  control to step back one page, only `← Latest`, which restarts the count from
  the top of the result set.
- **Principle:** PRODUCT.md principle 3, "Scanning is the primary act" — this is
  a log people *search*, not one they browse, and the third question after who
  and what is always when.
- **Fix:** Two changes, and the cheap one carries most of the value.
  - Put the page's own range in the count rule's aside beside `renderedAt()`:
    `rows[0].at` and `rows[rows.length - 1].at` are already in hand, so
    `100+ older entries · 2026-07-02 → 2026-07-14` costs one `stamp()` call each
    and makes "am I past it yet" answerable without reading a row.
  - Add a `since` / `until` date pair to `filterHrefBase`'s param set and a
    `gte`/`lte` on `auditLog.at` in `queryAuditLog` — it composes with the
    existing keyset cursor (both narrow the same ordered scan) and it is the one
    filter that turns a multi-page walk into a single page.

### 5. Every investigation ends by leaving this page, and the page does not help you leave

- **Severity:** moderate
- **Where:** `src/app/admin/audit/page.tsx:79-164` (`ActorCell` / `TargetCell`),
  against `src/app/admin/accounts/page.tsx:798-809`
- **Cost:** "Why is the role wrong" is never answered by history alone — the
  admin also has to know whether Zed's Discord is linked at all and whether the
  token is alive. `/admin/accounts` links *into* this page (drawer → "audit
  log"), but a resolved name here links only to a filter the admin has usually
  already applied, so the return trip is: navigate to `/admin/accounts`, which
  has no name search (`accounts/page.tsx:89-96` takes only `tier`, `status`,
  `sort`, `dir`), and find the row by eye.
- **Principle:** cognitive-load reference, "The Context Switch" — co-locate the
  information needed for one decision.
- **Fix:** The resolved name is already a link and already carries the account
  identity. Give the row a second, quieter affordance to the person rather than
  to the filter — the cheapest version that respects the settled hit-target
  rules is a `.btn--micro` in the Target cell for `targetKind === "account" |
  "discord"`, or a `→` link on the `RawId` sibling. Whatever the form, the
  return direction has to exist, and `/admin/accounts` needs a `?q=` the link
  can aim at.

### 6. The exact instant leaves the screen at 1056px with no way to get it back

- **Severity:** minor
- **Where:** `src/app/admin/audit/page.tsx:593-601`;
  `src/app/globals.css:3086-3122`
- **Cost:** An admin on a 1024px laptop or a half-screen window sees only
  `3h ago` in the At column and cannot read or copy the timestamp needed to line
  this row up against Discord's own audit log — every other cell in the row
  carries the full value in `title`, this one does not.
- **Principle:** none.
- **Fix:** Add `title={`${stamp(r.at)} UTC`}` to the `.only-narrow` span at
  `page.tsx:595-600`; the visually-hidden restatement stays for AT. Note also
  that the comments at `page.tsx:555-558` and `580-585` both say "below 40rem",
  but the swap for `.log--audit` fires at `66rem` (`globals.css:3086`) — the
  prose is a breakpoint behind the rule, which is how the missing `title` stayed
  invisible.

### 7. The one filter that most reduces the reading requires vocabulary the page never teaches

- **Severity:** minor
- **Where:** `src/app/admin/audit/page.tsx:473-487`
- **Cost:** `Action prefix` with the hint `e.g. tier.` is the only namespace an
  admin is ever shown; the other nine (`discord.`, `token.`, `character.`,
  `wanderer.`, `status.`, `account.`, `admin.`, `sync.`, `payout.`) have to be
  learned by spotting them in the Action column, so the admin who has not yet
  learned them reads 100 rows instead of 3.
- **Principle:** Nielsen 6, recognition rather than recall.
- **Fix:** The prefixes are already enumerable in source —
  `targetKindFromAction` (`services/audit.ts:89-109`) lists every one of them,
  and `PARTS` (`summarize.ts:183-245`) lists every full action. Export the
  prefix list from one of them and render a `<datalist>` on `#filter-action`;
  it costs no layout, needs no JavaScript, degrades to today's behaviour, and
  does not add a control to a form that is already at four cells.

## What is good and must survive

- **The cross-shape target union.** `resolveFilterIdentity`'s target branch
  (`audit.ts:367-446`) resolving one typed name to account uuid + character ids
  + Discord snowflakes + payout operations is what makes the good path work at
  all: `tier.changed` (account uuid) and `discord.role_changed` (Discord
  snowflake) are the two rows that answer the question and they are stored under
  different ids. Finding 2 asks to widen this, not to narrow it.
- **The actor/target nudge** at `page.tsx:410-421`. It is the single best piece
  of copy on the page: it names the asymmetry, only appears when it can act, and
  hands over a working link rather than an explanation. Finding 2 asks for it to
  reach one more branch, not to change.
- **`idsOf` failing closed** (`page.tsx:227-230`). An unmatched name returning
  `[]` rather than `undefined` is what stops a filter the admin believes is
  applied from silently showing them everything. That is a correctness device;
  a later simplification pass will read it as a redundant ternary.
- **`hasCursor` as the single judgement of the cursor** (`page.tsx:266`). The
  query, `pastEnd`, `pageQualifier` and `Pager`'s `hasLatest` all read it, so
  `?before=abc` cannot produce a heading and a control that disagree.
- **The ambiguity `Notice` firing rarely.** Because EVE character names are
  globally unique, the union threshold is reached almost only when a payout
  operation genuinely shares a person's name — which is exactly the conflation
  it exists for. It does not fire on ordinary reads, so it does not teach
  admins to discount it. Any change that makes it fire on the common case (for
  example, a naive fix for finding 2 that counts alt accounts unconditionally)
  destroys that, and a warning that is always on is worse than none.
- **`summarizeDetails`' declared-keys mechanism** (`summarize.ts:279-286`).
  `+N more` counting only *undeclared* keys is what lets the line be short
  without lying about being complete; `silent()` is not dead code.
- **The `payout.deleted` name recovery** in both `resolveAuditIdentities`
  (`audit.ts:199-214`) and `resolveFilterIdentity` (`audit.ts:387-395`), and the
  comment explaining why only the second is ungated.
- **The pinned At column plus the top pager.** The top `Pager` exists because
  the bottom one is ~300 tab stops down a full page; a tidy-up that renders the
  pager once will re-break keyboard paging.

## Could not evaluate

- **Whether the `discord.role_changed` volume is low enough that a per-user
  failure row (finding 1) stays readable.** `runDiscordRolesJob` iterates every
  linked account each cycle, so a guild-wide outage would write one row per
  member per run. Settling it needs the actual member count and the sync
  cadence; if it is large, the failure row should be written on transition only
  (first failure, and a matching recovery row), not per cycle.
- **How often "why is the role wrong" is actually asked about an alt versus a
  main.** Finding 2's severity turns on this, and only the corp's own support
  history answers it. The crew-manifest premise says alts are the norm; the
  reference deployment's Discord backlog would confirm or deny it in minutes.
- **Whether the 66rem At-column swap (finding 6) is ever hit in practice.**
  Admins are described as working the accounts table, which suggests a wide
  window. Browser-width telemetry, or simply asking the two or three admins,
  settles it; the fix is one attribute either way.

## Contested

Nothing on the settled list. One adjacent note, since it touches the settled
"deliberate omissions" section rather than contradicting it: `discord.role_changed`
rows are suppressed entirely under dry-run (`discord-roles.ts:24, 181`), with a
docblock arguing correctly that recording a suppressed write would corrupt the
record. That is right for the row. It is not right for the page — a fork running
`SYNC_MODE=dry` reads an audit log that is silent about Discord and has nothing
on screen saying why. A one-line `Notice tone="info"` on this page when the
deployment is not live would cost nothing and close the gap without touching the
writer's reasoning.
