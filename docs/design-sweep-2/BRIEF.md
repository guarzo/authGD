# Design sweep 2 — dispatch brief

Worktree: `.claude/worktrees/design-sweep-2026-08-10`. Base: `main` @ `a9777e7`.

Screenshots for every surface are in `docs/design-sweep-2/shots/`, captured
2026-08-09 at 1440×900 (`.wide.png`) and 390×844 (`.narrow.png`), both
`fullPage`, against a seeded realistic fixture (34 payout operations, 62 audit
rows, 9 job types × 5 runs, a 16-participant roster, 12 members across four
tiers) plus the empty and error states.

---

## Preamble — every reviewer gets this verbatim

**Look at your surface's screenshot before you open a file.** Say what you see
before you explain it. Then read the target and everything it imports, and trace
at least one full interaction path. Do not review from structure alone — and do
not review from source alone, which is the same mistake wearing better clothes.
Both viewports. The narrow one is not an afterthought; several of these pages
are read on a phone at 1am.

**You are read-only on source.** The single write you may make is your report,
at the path named in your block. Do not edit, format, or "fix in passing."

### What this sweep is hunting

Three failure patterns were found on `/account` (the reference surface, already
worked — see `12-account.*.png` and `src/app/account/page.tsx` for what "done"
looks like). Look for them specifically, and say plainly if your surface does
not have them:

1. **Unshaped field.** Content occupying a fraction of a 78rem column with the
   remainder empty, and the page running long instead of wide.
2. **Total enumeration.** A value repeated identically on every row of a table
   when it is really one fact about the whole set. `crewNorms` in
   `src/app/account/page.tsx` is the pattern for fixing it: measure deviation
   against the set, state the shared fact once, keep both channels in parity.
   `/admin/sync`'s "Cadence (UTC)" column header is the same fix in miniature —
   the shared timezone is said once in the header, stripped from every row's
   visible text, and restored per-row in a `visually-hidden` span so the
   accessible name does not lose it.
3. **Repeated identical controls at uniform weight, where nothing directs the
   eye.**

Also: **an explanatory subtitle under an H1 is a smell.** A caption explaining
what a table means usually means the table needs work, not that it needs a
caption.

### Report format — identical for everyone

Findings worst-first. Each one:

- **Severity** — Critical / Serious / Moderate / Minor.
- **Where** — a `file:line` *when the finding has one*. `**Where:** whole
  surface` and `**Where:** across surfaces` are first-class values, not
  fallbacks. See below.
- **Cost** — one sentence naming who is harmed and what it costs them. Concrete.
  "A member checking a stale token at 1am scrolls past four screens of identical
  rows to find the one that is red" is a cost. "Violates hierarchy" is not.
- **Fix** — concrete, and scoped to what you would actually change.
- **Principle** — the violated principle where one exists.

Then: **what is genuinely good and should survive** (name it, so the fix pass
does not break it), and **what you could not evaluate** and why.

### Four things about that format, each of which is load-bearing

- **`file:line` is optional and I mean it.** The findings that cannot produce
  one are the ones about what a screen *adds up to*: ten individually-defensible
  decisions composing a page with no focal point, a table whose every row is
  defensible and whose aggregate is noise. A format that demands a line number
  selects against exactly those. If you have no location, give the observation
  that supports the finding instead.
- **A missing principle citation is not a defect in the finding.** Do not drop a
  finding because you cannot cite a rule for it, and do not manufacture a
  criterion that half-fits — a fabricated criterion gets ranked as if it were
  real.
- **State colour in rendered sRGB hex, never in the authoring space.** OKLCH is
  the right space to tune in and the wrong one to judge in. At near-black, judge
  the red-to-blue *ratio*, not the absolute difference — `#0c0a08` is a gap of 4
  and visibly brown. Convert before filing and quote the hex.
- **Counts and comparisons are claims.** "Sixteen branches", "the only client
  component", "these two rules are identical" — check them before you state
  them, and cut the ones that carry no decision.

### Settled — constraints (closed, do not re-open)

These are closed by something outside the design. Proposing to change them wastes
the finding.

- **Dark only.** EVE's client is dark and its players expect dark. A light ground
  is not on the table. Literal-paper and paper-panel-on-dark were both built and
  rejected.
- **WCAG 2.2 AA** is the floor: 4.5:1 text, 3:1 for large text and UI
  boundaries, 24px hit targets (2.5.8 AA), 320px reflow, 200% zoom, focus never
  suppressed, colour never the only carrier.
- **`--void` is chroma 0** (`#0a0a0a`). Two warm grounds shipped and both read as
  brown. Do not propose restoring a tint "for consistency with the ramp."
- **Do not change colour tokens.** Explicit instruction from the owner for this
  sweep. You may report that a token is *used* wrongly; do not propose retuning
  its value.
- **Two hit-target grades, 36px and 28px, and no third.** 28px is scoped by the
  reason for it — rows that each carry a control set and are read many at a
  time. A disclosure drawer is not in-row for this purpose and takes 36px.
- **`.st--ok` is `--ink-dim`, not green.** An `ok` that has to shout is an `ok`
  competing with the one row that isn't. Do not propose restoring the green.
- **Disabled controls keep `opacity: 1` and take explicit `--ink-faint`.** An
  opacity fade measured 2.88:1 on a hovered row. Do not simplify back to opacity.
- **Nav membership is keyed to the viewer, not the section**, derived once in
  `src/app/_components/nav-items.ts`. The three boundary surfaces run the same
  rule on the strongest membership the *path* alone proves.
- **One column origin.** The page box is `--measure-page` on every route;
  narrow surfaces cap their *contents*, never the column.
- **Artwork carries empty `alt`**, including the seal, because it sits directly
  above an `<h1>` holding the same name.
- **Migrations are generated, never hand-written**, and an applied one is never
  edited.

### Settled — taste (decided, and open to challenge ONCE)

These were closed by someone's judgement, not by an external constraint. They are
decided. If you think one is wrong, say so **in a clearly-marked contested
section at the end of your report**, with your reasoning. Do not spend the body
of the report re-litigating them.

- Gold as the single emphasis colour, rationed to one primary action per view
  plus the mark.
- `--signal-warn` at hue 50 (moved from 70 for separation from gold).
- The two-family split: Archivo for prose, IBM Plex Mono for all state. "Prose is
  proportional, state is monospaced."
- The tight type ramp below `--t-h2` (1.07–1.09 between steps); size carries
  little signal down there and face/weight/case/colour carry it instead.
- **No cards.** Structure is hairline rules and section headers. Exactly two
  exceptions exist — the login panel and `/payouts/new`'s form panel — and a
  third would mean the rule has stopped being true.
- Registration ticks on the login panel only.
- Near-zero radii (2px controls, 0 rules).
- Deadpan voice: terse, factual, never exclaims, joke lives in artwork and
  microcopy and never in the controls.

### Do NOT re-report — closed by the Aug-5 sweep

Verified against `docs/design-sweep/SYNTHESIS.md` and `SECOND-PASS.md` this
session. If you find one of these still broken, that is a *regression* finding
and worth filing — but say explicitly that you are re-opening a closed item and
give the evidence.

Re-auth stale state; dead worker reading healthy; rejected inline edit losing
input; `/admin/accounts` focus + tier disable; four silent `/account` actions;
`/payouts` "was I paid?"; alt-name audit search; the "Try again" control;
three `&&`-mounted `Notice`s; Discord unlink self-disarm; `/login`'s scope-list
`<dl>` inversion; `/admin/accounts` search; 200% zoom portholes; pinned-column
focus ring; `/admin/sync` enqueue confirmations and the queued/last-run
separator; `/admin/audit`'s UUID recital and lost timestamp; `.dim` font-size and
the orphan `.dim-ink`; typographic drift; nav membership between sections
(resolved 2026-08-06 by the viewer-keyed rule); the `discord-roles` audit gap;
the `audit_log` action index; `workerHeartbeat`'s null conflation; both
add-forms' duplicate-submit hazard; `accountsConfirmation`'s loose signature.

### Known-open — report only if you can add something

These are already on the backlog. Do not spend a finding restating them; do file
if your surface shows a *consequence* the existing entry does not name.

- The first "mark paid" freezes the operation and the warning renders after the
  press.
- Members are shown live draft amounts the service refuses to pay.
- `/payouts`' future-date guard is client-only.
- Oversized images with no `sizes`/priority on `/account` and `/login` (the
  82 KB seal is the LCP element).
- `<caption>` prose length on `/account`.
- `.launch__foot`'s sixth type size; `.escalation`'s 1.00:1 ground; `Tone`'s
  missing docblock; `RuleHead`'s dead `as="span"` default.
- Duplicate pagers on `/admin/audit`.

### Domain vocabulary — these are correct, do not propose generic replacements

*Corp*, *alt*, *fleet*, *cryo* (a pause the member asked for, not a fault),
*derole* (drops tier, keeps account — never a deletion), *tier* (Member /
Associate / Alumni / Pending), *operation* (one fight, one payout row), *ACL*
(the Wanderer map access list), *ESI* (EVE's API), *scope* (an OAuth grant),
*Flight log* / *manifest* / mission-patch furniture. "Center for Kids Who Can't
Fly Good" is the corp's real joke, told straight.

---

## Surface blocks

Every block gets the preamble above. Register determines which impeccable
reference you work from.

### 1. `/login` — **register: brand**

- Source: `src/app/login/page.tsx`
- Shots: `01-login.wide.png`, `01-login.narrow.png`
- The only unauthenticated surface, and the only one where the artwork is the
  subject. It carries the seal (the LCP element), the login panel (one of the
  two sanctioned card exceptions), the registration ticks (used here and nowhere
  else), and the hero line art held back as texture.
- Judge it on: does it establish the flight-operations-at-night theme in one
  screen, and does it read as authored rather than generated? A member's first
  impression of the whole tool is this page.
- Report: `docs/design-sweep-2/reports/login-critique.md` /
  `login-audit.md`

### 2. `/payouts` — **register: product**

- Source: `src/app/payouts/page.tsx`, `src/app/payouts/access.ts`, and the
  co-located components in `src/app/payouts/`
- Shots: `04-payouts-full.*` (34 operations — the realistic case), and
  `03-payouts-empty.*` (the empty state)
- Judge it on: principle 3, scanning is the primary act. And principle 2, state
  before action — can a member answer "was I paid?" without pressing anything?
- This is a prime candidate for patterns 1 and 2. Check the column set against
  what actually varies row to row.
- Report: `docs/design-sweep-2/reports/payouts-critique.md` / `payouts-audit.md`

### 3. `/payouts/new` — **register: product**

- Source: `src/app/payouts/new/page.tsx` (58 lines) and
  `src/app/payouts/new/new-operation-form.tsx`
- Shots: `05-payouts-new.*`
- The second of the two sanctioned card exceptions (`.form-panel`). The page is
  `page--narrow` with one short form on it — pattern 1 is the obvious risk, and
  the panel exists precisely to answer it. Say whether it does.
- Operator-only: a non-operator is redirected out rather than handed a form that
  would reject on submit.
- Report: `docs/design-sweep-2/reports/payouts-new-critique.md` /
  `payouts-new-audit.md`

### 4. `/payouts/[id]` — **register: product**

- Source: `src/app/payouts/[id]/page.tsx` and every co-located component
  (`lifecycle-submit.tsx`, `notes-form.tsx`, `flat-pool-form.tsx`,
  `add-participant-form.tsx`, the appraise form)
- Shots: `06-payout-detail-draft.*` (a draft with a 16-participant roster and
  both pool kinds), `07-payout-detail-finalized.*`
- The densest surface in the app and the one with the most controls. Pattern 3 is
  the primary risk: count the pressable things and say what directs the eye.
- `ConfirmCost`'s `"visible"` case lives here (Finalize/Unlock sit alone outside
  a table, so their permanent caption is wanted copy, not a fault appearing).
  That is settled — do not propose hiding it.
- Report: `docs/design-sweep-2/reports/payout-detail-critique.md` /
  `payout-detail-audit.md`

### 5. `/admin/audit` — **register: product**

- Source: `src/app/admin/audit/page.tsx`, `src/app/admin/audit/summarize.ts`,
  `src/services/audit.ts`'s `queryAuditLog`
- Shots: `10-audit-full.*` (62 rows), `09-audit-empty.*`
- Judge it on the promise in PRODUCT.md: an admin can answer "why is this
  person's role wrong?" in under a minute. Time that path.
- Pattern 2 is the standing risk on a log table — check what every row repeats.
  The duplicate-pager item is already known; do not spend a finding on it.
- The empty state is also one `<tr>`, so do not assert a filter worked from a row
  count alone.
- Report: `docs/design-sweep-2/reports/audit-critique.md` / `audit-audit.md`

### 6. `/admin/sync` — **register: product**

- Source: `src/app/admin/sync/page.tsx` (1143 lines — read all of it),
  `src/app/admin/sync/actions.ts`, `src/app/admin/sync/view.ts`,
  `src/core/schedules.ts`
- Shots: `11-admin-sync.*`
- This surface has already solved pattern 2 once ("Cadence (UTC)"), and folds
  housekeeping behind a `Disclosure` keyed to whether the group needs attention.
  Say what still enumerates.
- Pattern 3 is live at the bottom control row: `Sync now` (primary) /
  `Recheck invalid affiliations` / `Refresh`, plus a per-job `Re-run` in every
  drawer.
- The `Absent` component pairs an aria-hidden glyph with the words it stands
  for — that is the R4 parity rule working. Do not break it.
- Report: `docs/design-sweep-2/reports/sync-critique.md` / `sync-audit.md`

### 7. The boundaries — **register: product**

One reviewer pair covers all three; they are small, related, and share a nav
derivation.

- Source: `src/app/error.tsx` (317 lines, client component),
  `src/app/not-found.tsx`, `src/app/payouts/[id]/not-found.tsx`
- Shots: `13-error-boundary.*`, `02-not-found-root.*`, `08-payout-not-found.*`
- A user meets these on their worst day with the app, and they are the surfaces
  least likely to have been designed. That is the whole reason they are in scope.
- Settled and deliberate: no `global-error.tsx`; gold is *not* spent on "Try
  again"; `error.tsx` hoists a `<title>` because it beats the segment's static
  metadata; all three are `page--narrow`.
- `error.tsx`'s escalation block is the one thing a user is asked to copy. Judge
  whether it is copyable.
- Report: `docs/design-sweep-2/reports/boundaries-critique.md` /
  `boundaries-audit.md`

### 8. `/admin/access-lists` — **register: product**

- Source: `src/app/admin/access-lists/page.tsx`
- Shots: `14-access-lists.*`
- **This surface appears in neither the owner's scope list nor the Aug-5 sweep.**
  It has never been reviewed. Mark your report as covering an out-of-scope
  addition so its findings can be separated cleanly if the owner does not want
  them.
- Report: `docs/design-sweep-2/reports/access-lists-critique.md` /
  `access-lists-audit.md`

---

## The two surface-less reviewers

### A. Whole-app

Gets **every screenshot in `docs/design-sweep-2/shots/` and `PRODUCT.md`, and
nothing else.** No source. No file tree. No per-surface block.

Questions, all of which have no location:

- Does this read as authored or as generated?
- What is its composite character, in one paragraph?
- Which surfaces disagree with the others about what this product is?
- Could someone guess the palette and theme from the product category alone?
- Where does the eye go on each screen, and is that where it should go?

**Exempt from `file:line` entirely.** Do not go looking for source you do not
have. Prose about the composite is the deliverable; a paper cut is not.

Note the anti-references it is being measured against: Alliance Auth / Django
admin, neon sci-fi HUD, generic dark SaaS, cartoon-forward UI.

Report: `docs/design-sweep-2/reports/whole-app.md`

### B. Record contradiction

Gets `DESIGN.md`, `PRODUCT.md`, and the code implementing them. One question:
**where does the code contradict its own written rule?**

This is nearly mechanical and it is most productive in the codebases that look
best maintained. Two from the last sweep of this project: a status-token rule
saying "colour only when the state is actionable" while the CSS painted every
healthy state full-chroma green, and a predicate whose docblock argued the
opposite of what it did.

Check specifically, and quote the rule text next to the code:

- Every claim in DESIGN.md's tables that names a measured number (contrast
  ratios, hit-target pixel sizes, type-scale steps, tracking tokens).
- The label register: is every selector in the `--- Label register ---` list
  actually inheriting 600, and does anything outside it duplicate the style?
- "Saturated colour occupies well under 10% of any screen" and "one primary
  action per view, plus the mark" — check per surface against the shots.
- The two-card exception, the two hit-target grades, the two type one-offs
  (`0.625rem`, `0.5625rem`) that are supposed to be used exactly once each.
- PRODUCT.md's five design principles against what actually ships.

Report: `docs/design-sweep-2/reports/record-contradiction.md`
