# Aug-5 sweep vs. Aug-4 sweep

Same app, same reviewer commands, same eighteen-agent fan-out. The only variable
is Phase 3's sort key and the addition of Phase 4. This document is the evidence
for whether that changed anything, including where it did not.

Aug-4: `.claude/worktrees/design-sweep-2026-08-04/docs/design-sweep/SYNTHESIS.md`
(804 lines). Aug-5: `./SYNTHESIS.md` (404 lines).

---

## The finding that moved

`Notice` loses its live region when it is conditionally mounted, so a
`tone="bad"` message that arrives via `{x && <Notice>}` is announced to nobody.
Both sweeps found it. Both described it correctly.

- **Aug-4 ranked it 3rd of 12** (`A3`).
- **Aug-5 ranked it 12th of 24** (item 12).

Nothing about the defect changed between the two runs. What changed is that
Aug-5 had to say what it costs a person, and the honest answer — a member misses
one spoken error message on a form they are already looking at — does not
outrank a member being told their successful re-authorization failed. Under
recurrence it outranked all of it, because it lives in a shared primitive and
therefore recurs everywhere the primitive does.

That is the whole mechanism, visible in one row.

---

## What the top of each list is about

**Aug-4's top 12 are cross-surface without exception.** Eight of the twelve
headings state their own recurrence count (`6 independent confirmations`,
`4 confirmations`, `3 surfaces`, `6 sites`, `2 surfaces`, `4 confirmations`,
`3 surfaces`, and `A3`'s shared primitive); the remaining four are global by
construction (`anywhere in the app`, `the wide tables`, a shell-level measure
bug, and a WCAG criterion applied app-wide). Not one is about a single screen
failing the job it exists to do.

**Aug-5's top five are single-surface without exception.** `/account`'s
re-authorization, `/admin/sync`'s dead-worker blindness, `/payouts/[id]`'s
discarded edit, `/admin/accounts`' row actions, `/account`'s silent actions.
The first shared-primitive item is 12th.

## Where Aug-4 put its best material

Aug-4 found the `/account` defects. It found them well — `computeAccountHealth`
never consults `discordLinked` or push freshness, so an account whose standings
have not been written since Tuesday renders `NOMINAL`, on the page PRODUCT.md
says exists to answer "why didn't my Discord role show up." Its own prose calls
this "the page's whole reason to exist is partly broken."

It sits at **line 381 of 804**, in a section titled **"One-off findings worth
fixing anyway."** Below twelve ranked items, a 56-line change plan, and seven
adjudicated contradictions.

"Worth fixing anyway" is the tell. Single-surface was a lower tier by
construction, so the sweep's deepest read got filed as an afterthought and the
recommended command chain was derived from the twelve above it.

---

## What Phase 4 changed

Aug-4 ended at "§10. Recommended next commands." Nothing ran. The user's own
account of that sweep was that they "ran the recommended commands" — manually,
one at a time, after the fact.

Aug-5 ran a 14-step chain from a single gate. Four blocking items (1–4) are
closed. 1127 unit tests and 204 e2e tests pass, up from 201 — the three new ones
cover `/login`, which had no spec at all before this.

Two things the chain taught that no amount of reviewing would have:

**`redirect()` resets client `useState`.** It replaces the whole route tree even
when the destination is the route you are already on, so any action whose
control lives inside a `Disclosure` collapses the drawer on press. This was
invisible to eighteen reviewers reading source. It surfaced only because step 6
introduced it, step 6's own 19-case e2e run missed it (no case opened a drawer
first), and step 8 then hit the identical wall on a different page. The root
cause was a docblock asserting "a soft navigation reconciles this component in
place" — true at its first two call sites, false at the third. Reading finds
what a component does. Only editing finds what its documentation quietly
assumes.

**A CSS class rename is invisible to the unit suite by construction.** Step 2's
`.dim` → `.dim-ink` swap broke two `e2e/audit.spec.ts` selectors. `npm test`
stayed green. Caught two steps later, which is exactly the compounding the
one-command-at-a-time rule exists to prevent — and it still cost two steps
because I ran the wrong check. Procedure changed mid-chain: the relevant e2e
spec after every step, not just at the end.

---

## Where Aug-5 was not better

Three of the 24 items did not survive contact with the code. The backlog should
not be read as 24-for-24.

- **Item 18, second half.** "The queued marker misattributes its own age" is
  wrong. `queuedMarkerText` derives from `g.queuedSince` and labels it
  correctly; `queuedNotice` keeps enqueue instant and heartbeat age as
  separately labelled facts. Closed as not-a-defect.
- **Item 19, timestamp half.** Already fixed. `bb20102` (Aug-4) is an ancestor
  of HEAD and the 1056/1057px cases are already in `e2e/audit.spec.ts`. The
  previous sweep fixed it; this synthesis carried it forward as open.
- **Item 16's stated mechanism.** I described the porthole as an unbounded
  `calc(100svh - 29rem)`. A floor already existed. The real defect is that the
  floor is *flat* — 286px measured at both 400px and 460px viewport heights.
  Right finding, wrong reason.
- **Item 24's `.st` bullet was backwards**, and its `e2e/admin.spec.ts:735-737`
  bullet cites a comment that does not exist at HEAD or now.

All four are Phase 0 failures, not Phase 3 failures — derived claims stated with
the confidence of read ones, which is the exact trap the skill's own table names
and which I walked into anyway. Ranking by consequence does not protect a
backlog whose facts are wrong; it just makes the wrong facts more prominent.

The one I made against my own reviewers is worth naming separately: the shared
`PREAMBLE.md` told all eighteen agents that `.st` renders at weight 400. It does
not, and has not for as long as the rule has existed — `DESIGN.md` was the stale
half, and I propagated it. Five reviewers corrected me. Thirteen did not. A
brief's errors do not stay in the brief.

---

## Net

The sort key change did what it was meant to do, and the evidence is a single
finding moving from rank 3 to rank 12 while its description stayed identical.
Phase 4 converted a document into 14 landed changes and found two classes of
defect that reading cannot reach.

Phase 0 is now the weak link, and it is the phase the skill already spends the
most words on. That is worth knowing before the next run: the failure mode did
not move to a part of the process nobody thought about, it stayed in the part
everyone is told to be careful about and is under the most pressure to hurry.
