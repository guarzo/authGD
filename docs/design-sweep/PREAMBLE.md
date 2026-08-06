# Design sweep — shared preamble

Every reviewer in this sweep gets this document verbatim. Your per-surface block
follows it in your own prompt.

Repo: `/home/tng/workspace/authGD/.claude/worktrees/design-sweep-2026-08-05`
Commit: `e5d76df`. Work only in that worktree, never in the parent checkout.

## What you are

You are running one `impeccable` command against one surface of authGD, a small
internal tool for an EVE Online corporation. Read `PRODUCT.md` and `DESIGN.md` at
the repo root first — they are the design record and they are dense; the answer
to most "is this deliberate?" questions is in them.

## Rules of engagement

**Read the target and everything it imports before judging.** Not the headings,
not the first fifty lines. If your surface is 900 lines, read 900 lines. Then
read the components it pulls from `src/app/_components/` and the CSS rules it
uses from `src/app/globals.css` (3,331 lines — read the parts that matter to
your surface, not the whole file). Trace at least one full interaction path end
to end: what a user presses, what the server action does, what comes back, what
the page looks like after.

**Do not review from structure alone.** A review that could have been written
from a file listing is not worth the tokens it cost.

**Read-only on source.** The single write you are permitted is your own report,
at the path named in your block. Do not edit, format, or "fix" anything.

**This codebase is unusually heavily commented, and the comments are load-bearing.**
Nearly every non-obvious decision carries a docblock explaining why. Before you
file a finding, check whether the code already argues against you — if it does,
your finding needs to engage that argument or it is noise. A docblock is
evidence about intent, not proof of correctness: a decision can be documented and
still wrong. Say which you think it is.

## Settled — do not re-open

These were decided. Proposing to reverse one wastes the finding slot and the
recommendation that comes back is worse than what is there. If you genuinely
believe one is wrong, say so once, briefly, in the "contested" section at the end
of your report — not as a ranked finding.

**Domain vocabulary.** Standing / standings, Cryo (a member's self-requested
pause), Crew manifest (the characters on one account), Flight log, operation (one
fight's payout), the job groups Sweep / On-demand / Housekeeping, the tier names
Member / Associate / Alumni / pending, and "derole, don't boot". These are the
product's own nouns. Do not propose generic replacements.

**Theme and palette.**
- Dark only. There is no light theme and there will not be one; the driving scene
  in DESIGN.md is a player alt-tabbed at 1am.
- No cards. Structure is hairline rules plus section headers. The login panel is
  the one deliberate exception.
- Radii are near-zero: 2px on controls, 0 on rules and table edges.
- No cyan, no glow, no scanlines, no clipped corners. That is an explicit
  anti-reference, not an oversight.
- `--signal-warn` sits at hue 50. The reasoning, including the OKLab distances,
  is written out in DESIGN.md. Do not propose moving it.
- Pending tier renders achromatic in `--ink-dim`, deliberately.

**Controls and focus.**
- Disabled controls keep `opacity: 1` and take an explicit `--ink-faint`.
  DESIGN.md says in as many words: do not simplify this back to an opacity.
- Two hit-target sizes exist and only two: 36px for standalone `.btn`, 28px for
  the in-row controls of admin tables. `quiet` is a colour grade, not a size.
- Buttons are **not** disabled while a submit is in flight. `submit-guard.ts`
  stops the second click; `aria-busy` plus a swapped `pendingLabel` is the whole
  in-flight signal. Proposing `disabled` here is proposing to lose focus.
- `ConfirmSubmit` has **no** revert timer. One existed and was removed as a WCAG
  2.2.1 violation. Do not re-add one.
- On `/admin/accounts`, the Discord-unlink cost sentence stays permanently
  `.visually-hidden`. Revealing it on arm was tried and reverted: inside a `td`
  the reveal widens the cell, the button moves out from under a stationary
  mouse, `pointerLeave` fires, and the control disarms itself. The account
  page's Discord row can reveal because it is a `dd` in a grid that already
  reserves a wrapping line.
- `Disclosure` is built on `<details>`, not an ARIA accordion, so it works with
  no JavaScript and find-in-page reaches collapsed text.

**Deliberate omissions and lint escapes.**
- There is no `global-error.tsx`. The reasoning is at `src/app/error.tsx:26-34`.
- `src/app/payouts/[id]/not-found.tsx` exports no `metadata`. A segment-scoped
  not-found does not get to set the title; `page.tsx`'s `generateMetadata`
  returns "No such operation" instead.
- Several plain `<a>` elements carry
  `eslint-disable-next-line @next/next/no-html-link-for-pages`, each with a
  justification comment: the payouts pager, `payouts/[id]/not-found.tsx`, and
  `/admin/sync`'s Refresh. Each argues its case at the call site.
- `/login` uses `<img>` rather than `next/image`, twice, with reasons — PRODUCT.md
  principle 5, "earn the artwork".
- `/admin/sync` does not poll. An admin reading an expanded failed row must not
  have the page move under them.

**Layout.**
- The page box is `--measure-page` on every route so the H1's left edge lands on
  one vertical everywhere. `.page--narrow` caps its *contents*, never the column
  — capping the column moved the whole page 144px sideways on a nav click.
- Body prose caps at 68ch.

**Corrected after dispatch — do not reuse.** This brief told all eighteen
reviewers that `.st` (the Status token) declares no `font-weight` and renders at
400, as a known open defect they could cite without discovering. That is wrong,
and was wrong when they were dispatched: `.st` declares `font-weight: 600`, and
`DESIGN.md` was the stale half. Five reviewers pushed back; thirteen took it as
given. The paragraph is kept here rather than deleted because SYNTHESIS.md's
"Correction to the brief" and COMPARISON.md both refer to what this document
said — but anyone reusing this preamble for another sweep must drop it.

**Out of scope for this sweep.** Screenshots and starting a dev server. The
source answers the questions, and a dev server rewrites `tsconfig.json` here.

## Report format

Write to the path in your block. Use exactly this structure — the synthesis
merges eleven of these and a varying format turns that into an essay-merging
exercise.

```markdown
# <command> — <surface>

## Findings

### 1. <one-line title>
- **Severity:** blocking | serious | moderate | minor
- **Where:** `path/to/file.tsx:120-134`
- **Cost:** <ONE sentence: who, at what moment, loses what.>
- **Principle:** <PRODUCT.md principle, DESIGN.md rule, or WCAG SC — or "none">
- **Fix:** <concrete and specific enough to act on without re-deriving it>

### 2. ...
```

Then:

```markdown
## What is good and must survive
<Things a later fix pass could break by accident. Be specific.>

## Could not evaluate
<What you could not judge from source, and what would settle it.>

## Contested
<Anything on the settled list you think is genuinely wrong. Brief.>
```

Findings worst-first, by what they cost a user.

**The Cost line is the one that decides your finding's rank.** The synthesis
sorts on it, not on severity and not on whether you found a citation. Write it
concretely: *"An operator working a 200-item pool is returned to the top of the
page after every save"* is a cost. *"Violates 2.4.3"* is not — it is a citation
that has not yet said what goes wrong for anyone. If you cannot write the
sentence, the finding sorts to the bottom regardless of how solid its criterion
is.

**A finding with no principle to cite is not a weaker finding.** The Principle
field takes "none" and means it. The observations only a real read produces —
this screen does not do the job it exists for, this control lies about what it
did — usually have nothing to cite, and they are the most valuable thing a sweep
returns. Do not drop them, and do not reach for a criterion that half-fits;
a fabricated citation gets ranked as if it were real.

**Do not pad.** Eight findings that each cost someone something beat thirty that
include nine restatements of the label register. If your surface is genuinely in
good shape, say so and file four findings.
