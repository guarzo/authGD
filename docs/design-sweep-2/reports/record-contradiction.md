# Record contradiction — where the code disagrees with its own written rule

Reviewer B. Inputs: `DESIGN.md`, `PRODUCT.md`, `src/app/globals.css` (all 5477
lines), `src/app/_components/`, every `page.tsx` under `src/app/`, and the wide
shots for `/login`, `/payouts`, `/payouts/[id]`, `/admin/accounts`,
`/admin/audit`, `/admin/sync`, `/admin/access-lists`, `/account`, `error.tsx`.

**Method note on the numbers.** Every OKLCH token was converted to sRGB and every
ratio recomputed from 8-bit hex. DESIGN.md's colour tables survive that check
almost exactly — see "What is genuinely good" — so the findings below are about
rules the *code* left behind, plus a small cluster of stale figures in
`globals.css` comments. Rendered hex for the tokens this report cites:

| Token | Rendered sRGB |
|---|---|
| `--void` | `#0a0a0a` (R/B 1.00) |
| `--hull` | `#151514` |
| `--hull-hi` | `#21201f` |
| `--rule` | `#373533` |
| `--rule-strong` | `#787370` |
| `--ink` | `#ece7de` |
| `--ink-dim` | `#bab3a9` |
| `--ink-faint` | `#90877e` |
| `--gold` / `--tier-member` | `#f1c035` |
| `--signal-ok` / `--tier-alumni` | `#81bb8d` |
| `--signal-warn` | `#ff9f5f` |
| `--signal-bad` | `#f05751` |
| `--tier-associate` | `#52b0e2` |

---

## 1. The label register has one undeclared member, and it renders the same word in two weights on one screen

- **Severity:** Serious
- **Where:** `src/app/globals.css:2404-2410`; markup at
  `src/app/account/page.tsx:994`, `:1018`, `:1027`. Visible in
  `12-account.wide.png`.

DESIGN.md, "The label register":

> Small mono uppercase is the most reused type in the system, and it is **one**
> style, declared once in `globals.css` under `--- Label register ---` and
> applied by adding a selector to that list. Weight is `600` for every one of
> them; **a label that inherits `400` because its rule simply never said is a
> bug, not a variant.**

The register list (`globals.css:373-391`) holds fourteen selectors. I checked all
fourteen: every one takes `font-weight: 600`, none is overridden to another
weight anywhere in the file, and all fourteen are live in markup. The three
documented non-members (`.btn`, `.tier`, `.st`) each declare their own explicit
`600` — including `.st` at `:2457`, so DESIGN.md's claim that the `.st` 400 bug
is fixed is true. The five documented deliberate exclusions (`.page__stamp`,
`.launch__motto`, `.btn-row__stamp`, `.worker`, `.push__next`) are all
value-or-furniture, all reach for `--track-value` or `--track-furniture`, and
all are argued in place.

There is exactly one selector that is register-shaped, is not in the list, and is
not argued anywhere:

```css
.status-line__label {
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: var(--t-label);
  letter-spacing: var(--track-value);
  text-transform: uppercase;
  color: var(--ink-faint);
}
```

Mono, `--t-label`, uppercase, `--ink-faint` — the register's exact type, minus
the weight. Its rule simply never said, so it renders 400.

What it holds is `token`, `standings`, `map` (`account/page.tsx:994-1029`) — a
fixed word naming a field, which is DESIGN.md's own definition of a label ("The
register is for **labels** — a fixed word naming a field"). It is not one of the
value cases: the value sits beside it in a separate `.st`.

The consequence is on screen and is the precise failure the register block was
written to close. Its own docblock (`globals.css:311-315`) cites the original
bug as `.log th` (600) and `.strip__head` (400) rendering "labels at the same
size, the same tracking and the same colour about 40px apart, which reads as two
kinds of label rather than one applied twice." On `/account` the same collision
is rebuilt at larger scale and with *identical copy*: the crew manifest's
`STANDINGS` and `MAP` (this rule, 400) sit on the same viewport as the sync
rail's `STANDINGS` and `MAP` (`.facts dt`, register, 600) — same words, same
size, same colour, ~430px apart in `12-account.wide.png`.

Secondary: `--track-value` is the wrong token by the register's own test —
"a component asking for the value tracking is telling you what it holds," and
this holds a field name. The register's default is `--track-label`.

- **Cost:** A member at 1am scanning the manifest for what's wrong reads two
  visual grades of field label on one screen and has to work out whether the
  fainter ones mean something different. They don't. It is the one typographic
  rule this system states in absolute terms, and the reference surface breaks it.
- **Fix:** Add `.status-line__label` to the register list at
  `globals.css:373-386` and delete the four properties it duplicates, leaving it
  its own `color` and (if a variance is wanted) its own tracking — but pick
  `--track-label`, not `--track-value`. If it is genuinely meant to be excluded,
  the exclusion has to be argued in the register docblock beside the other five,
  because right now nothing records a decision here at all.
- **Principle:** DESIGN.md, "The label register."

---

## 2. `--signal-ok` is a dead token, and both documents cite a `.notice--ok` that does not exist

- **Severity:** Moderate
- **Where:** `DESIGN.md:105`; `src/app/globals.css:61`, `:2505-2507`

DESIGN.md's Signal table:

> `--signal-ok` | `oklch(0.74 0.09 150)` | Reserved for where health is genuinely
> the subject (`.notice--ok`). **Not** the default `ok` status token…

`globals.css:2505` repeats it:

> `--signal-ok` is not deleted — it is still right where health is genuinely the
> subject rather than the default (see `.notice--ok`)

`.notice--ok` does not exist. `grep -rn "notice--ok" src/` returns nothing but
those two comments. And `var(--signal-ok)` appears zero times in the whole
stylesheet — I counted every `var(--…)` reference in `globals.css`;
`--signal-ok` and `--dur-move` are the only two declared tokens with no
consumer.

So the token's stated reason to exist ("kept only for the few places health is
genuinely the subject", `globals.css:56-60`) is satisfied by no place at all.
The green still ships, but under a different name and a different meaning:
`--tier-alumni` is `oklch(0.74 0.09 150)`, byte-identical, so `#81bb8d` on screen
is always "Alumni", never "healthy."

- **Cost:** The next person who needs a genuinely-health-is-the-subject surface
  reads the record, goes looking for `.notice--ok` to copy, finds nothing, and
  either invents a second convention or — the likelier failure — concludes the
  green was removed and reaches for `.notice--warn`. It also costs a reviewer:
  a token with a stated use site is not something you check.
- **Fix:** Decide which is true and make the record say it. Either build
  `.notice--ok` (the notice family already has `--warn` and `--bad` at
  `globals.css:3451-3457`, so it is one rule), or drop `--signal-ok` and rewrite
  DESIGN.md's Signal row to say the green now lives only as `--tier-alumni`.
  Do not change the token's value — that is settled for this sweep.
- **Principle:** none needed; this is the record describing something that is not
  there.

---

## 3. The gold ration is stated three different ways, and the app follows none of the sentence in DESIGN.md's Rules

- **Severity:** Moderate
- **Where:** `DESIGN.md:103` vs `DESIGN.md:130-131`; `src/app/globals.css:2925`.
  Evidence in `15-admin-accounts.wide.png`, `12-account.wide.png`.

Three counts of the ration exist:

| Source | Sanctioned standing uses |
|---|---|
| `DESIGN.md:130-131` (Rules) | "the gold is rationed: **one primary action per view, plus the mark**" — two |
| `DESIGN.md:103` (Signal table) | "Brand mark, active nav, primary action, Member tier" — four |
| `globals.css:2925` | "DESIGN.md rations gold to **four** sanctioned uses" — four |

The four-use reading is the operative one and the shipped app is consistent with
it. I counted golds per surface against the wide shots:

| Surface | Golds |
|---|---|
| `/login` | seal (artwork) + registration ticks (`--gold-dim`) — no nav, no primary |
| `/account` | mark + active nav underline + `TESTERS` tier badge (`--tier-member`) |
| `/payouts` | mark + nav underline + `NEW OPERATION` |
| `/payouts/[id]` | mark + nav underline + `FINALIZE` |
| `/admin/accounts` | mark + nav underline + `TESTERS` chip and every Member-tier badge in the table |
| `/admin/audit` | mark + nav underline |
| `/admin/sync` | mark + nav underline + `SYNC NOW` |
| `/admin/access-lists` | mark + nav underline + `GRANT ACCESS` |

Every view has at most one primary action, which is the half of the Rules
sentence that holds. The half that does not is "plus the mark": three of the
eight surfaces spend gold on the active nav underline *and* on tier badges, and
`/admin/accounts` spends it on an unbounded number of badges — one per
Member-tier row plus the filter chip. That is not drift; it is what the Signal
table sanctions. But a reader who reaches the Rules bullet first — it is the
bullet, it reads as the rule — will file every gold tier badge as a violation, or
worse, "fix" one.

The related area claim holds everywhere I could measure it: on the densest
saturated screen, `/admin/sync`, the two notice fills plus eight orange `OVERDUE`
tokens come to roughly 4% of a 1440×1317 viewport, and the fills are 12% tints
rather than saturated ground. Nothing in the shots approaches 10%.

- **Cost:** A future contributor gets a contradictory answer depending on which
  paragraph they read, and the ambiguity falls hardest on the one gold use that
  scales with data volume (tier badges), which is exactly where a wrong ruling is
  expensive.
- **Fix:** Rewrite `DESIGN.md:130-131` to match the Signal table it contradicts:
  four standing uses — mark, active nav, one primary action per view, Member
  tier — plus the two focus surfaces (the ring and the skip link) that
  `DESIGN.md:341-345` already argues are not standing uses. Leave the code alone.
- **Principle:** DESIGN.md, "Rules" (colour).

---

## 4. Four page-level disclosures take the 28px in-row grade on `/payouts/[id]`

- **Severity:** Moderate
- **Where:** `src/app/globals.css:3799-3807`; call sites at
  `src/app/payouts/[id]/page.tsx:135`, `:833`, `:1148`, and
  `src/app/payouts/[id]/appraise-form.tsx:183`. Visible in
  `06-payout-detail-draft.wide.png`.

DESIGN.md, hit targets:

> The `28px` grade is scoped by the *reason* for it, not by the tag it lands in:
> it applies to rows that each carry a control set and are read many at a time.
> A disclosure drawer is **not** in-row for this purpose even though
> `Disclosure as="row"` renders a literal second `<tr>`. One drawer is open at a
> time, it spans the full table width, and nothing is competing with it for
> vertical space, so the density argument that buys the `28px` grade does not
> apply and its controls take `36px`.

`.disc > summary` sets `min-height: 1.75rem` — 28px. Its own docblock states, in
its first sentence, that it is *not* in a table:

> Page-level disclosures that sit directly in document flow rather than nested
> inside a `.log` table — the payouts detail page's "Or enter a flat value",
> "Add another paste", "Replace roster from a paste" and "Add one participant".
> `.log summary` above never matched these: the selector needs a `.log`-classed
> ANCESTOR, and these summaries sit in a plain `.form-stack`.

Nothing about these four is in-row. They are one-per-section controls in the page
flow of a long form, separated by hundreds of pixels in the shot. The density
argument DESIGN.md attaches to 28px ("rows that each carry a control set and are
read many at a time") does not reach any of them, by the record's own scoping —
the same argument that gave `/admin/sync`'s drawer Re-run, `/admin/accounts`'
drawer controls, and `.manifest-panel__controls .btn--quiet` the 36px grade.

This is the only surviving instance I found. Every other 28px consumer is
genuinely in-row: `.btn--micro` (accounts table cells), `.cell-link` (audit
filter links), `.row-toggle` (accounts name column), `.log summary` and
`.json > summary` (table cells).

- **Cost:** An operator building a payout on a phone — `06-payout-detail-draft`
  runs 2900px tall at 1440 and far longer at 390 — taps a 28px target for
  "Add one participant" sixteen times while every standalone control on the same
  page is 36px. It is 4px over the AA floor rather than 12px, on the app's
  densest and most-operated surface.
- **Fix:** Raise `.disc > summary` to `min-height: 2.25rem` at
  `globals.css:3806`. Nothing else matches the selector — I checked all four call
  sites — so this is a one-line change with no in-row collateral. Alternatively,
  if the 28px is wanted, DESIGN.md's scoping paragraph has to grow a third case,
  which by its own framing ("There are **two** sizes and no others") it should
  not.
- **Principle:** DESIGN.md, "Focus and states" → hit targets, ruling R1.

---

## 5. "No decorative gradients at all" versus a gradient whose own comment calls it decorative

- **Severity:** Moderate
- **Where:** `DESIGN.md:132` vs `src/app/globals.css:1108-1124`

DESIGN.md, Rules:

> No gradients on text, ever. **No decorative gradients at all.**

`globals.css`:

```css
.scroller-fade--start {
  left: 0;
  background: linear-gradient(
    to right,
    color-mix(in oklab, var(--rule-strong) 75%, transparent),
    transparent
  );
}
```

and its docblock, closing (`:1092-1093`):

> **Decorative and inert** — `pointer-events: none` keeps it clear of scrolling
> and any hit-testing.

This is a visible left-to-right colour ramp, on every scrollable table region in
the app (`/admin/accounts`, `/admin/audit`, `/admin/sync`, `/account`,
`/payouts`), described by its author in the same word the rule forbids. The
comment even reasons about its contrast (2.55:1, "deliberately under WCAG
1.4.11's 3:1… so it is styled to stay quiet rather than to pass as the
affordance") — i.e. it is explicitly reinforcement, not information, which is
the definition of decorative.

I do not think the fade should go: a scroll affordance on a table that clips at
390px is worth having, and it is the quietest available device. The record is
what is wrong — it states an absolute that the system found a good reason to
break and then never came back to amend.

(For completeness: the second `linear-gradient` in the file, `.st::before` at
`:2494`, is `linear-gradient(currentColor, currentColor)` — a single flat colour
used as a sized background box, with no visible ramp. That one is a geometry
trick, not a gradient in the sense the rule means, and its comment says so.)

- **Cost:** Small but real: the absolute reads as load-bearing, so the next
  person who wants a soft edge either files the fade as a bug or quietly copies
  it, and the rule stops meaning anything either way.
- **Fix:** Amend `DESIGN.md:132` to name the exception — "no decorative
  gradients, with one exception: the scroll-region edge fades, which are the
  quietest available affordance for content clipped past a region edge and are
  deliberately held under 3:1." Leave the CSS alone.
- **Principle:** DESIGN.md, "Rules" (colour).

---

## 6. DESIGN.md gives two different contrast figures for the same disabled-text pair, and neither is the measured one

- **Severity:** Moderate
- **Where:** `DESIGN.md:350` vs `DESIGN.md:63-64`; `src/app/globals.css:2706`

`DESIGN.md:346-350`, on disabled controls:

> Disabled controls keep `opacity: 1` and take an explicit `--ink-faint`… **The
> explicit colour is 4.85:1 on `--hull-hi`** and does not move.

`DESIGN.md:60-64`, on the palette as a whole:

> Every text token below was measured against all three grounds rather than
> asserted; **the worst case is `--ink-faint` at 4.63:1 on a hovered row**

Those two sentences describe the same pair. `.btn:disabled` sets
`color: var(--ink-faint); background: transparent` (`globals.css:2712-2715`), and
"on a hovered row" is `--hull-hi`, so both are `--ink-faint` on `--hull-hi`.
Measured from rendered hex — `#90877e` on `#21201f` — the answer is **4.61:1**.
`globals.css:2706` carries the 4.85 as well.

The behaviour is correct and the conclusion survives: 4.61 still clears text AA,
and the whole point of the rule (an opacity fade measured 2.88:1 on the same
ground) is unaffected. But the record states a number that is 0.24 high, right
next to a "do not simplify this back to an opacity" instruction whose force comes
from its measurements being trustworthy.

- **Cost:** Someone retuning `--ink-faint` — or introducing a fourth, lighter
  ground — checks their new value against 4.85 and believes they have 0.35 of
  headroom over AA when they have 0.11.
- **Fix:** Replace 4.85 with 4.61 at `DESIGN.md:350` and `globals.css:2706`, and
  update DESIGN.md's own worst case at `:64` from 4.63 to 4.61 while you are
  there so the two agree.
- **Principle:** PRODUCT.md, "WCAG 2.2 AA."

---

## 7. `--dur-move` is declared and documented and used nowhere

- **Severity:** Minor
- **Where:** `DESIGN.md:308-309`; `src/app/globals.css:168`

> Transitions are 140ms on colour and border, **220ms on transforms**, both on
> `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint).

`--dur-move: 220ms` has zero consumers. Every one of the nine `transition`
declarations in the file uses `--dur-color`, and every one transitions
`color`, `background-color`, `border-color` or `opacity`. No transform is
transitioned anywhere in the app; the only transform in the stylesheet is inside
`@keyframes seal-settle` and `@keyframes btn-pulse`, which are animations, not
transitions, and set their own durations (620ms, 900ms).

The Motion section is otherwise accurate: `--dur-color` is 140ms, `--ease` is
`cubic-bezier(0.22, 1, 0.36, 1)`, no layout property is animated anywhere, the
only entrance animation is `seal-settle` and it is opacity-and-scale, and the
`prefers-reduced-motion` block collapses everything to `0.01ms` globally at
`:295-304`. Only the transform grade is fictional.

- **Cost:** Small. It costs the next person adding motion a wrong assumption
  about what the house style already does, and it costs a reader of DESIGN.md a
  belief that transforms are part of this system's vocabulary when nothing
  transitions one.
- **Fix:** Either delete the token and the half-sentence, or keep both and say
  the grade is reserved rather than in use.

---

## 8. DESIGN.md's nav rule is missing a destination

- **Severity:** Minor
- **Where:** `DESIGN.md:236-240` vs `src/app/_components/nav-items.ts:78-83`,
  `:109-115`. Visible in every header shot.

> The bar offers every destination this viewer is *provably authorized* to
> reach — `Your account` always, `Operations` when they can read payouts,
> `Members`/`Audit log`/`Sync` when they are an admin — in one fixed order,
> broadest access first.

Five destinations. `navFor` returns six: `ACCESS_LISTS` (`/admin/access-lists`,
label "Access lists") is in the admin branch and renders in the bar on every
admin shot. `nav-items.ts`'s own docblock lists all six correctly. DESIGN.md is
the copy that is out of date, and `/admin/access-lists` appears nowhere else in
either record document either.

Everything else about the nav rule verifies. `navFor` is the single derivation;
`isAdmin` and `canReadPayouts` are taken as independent bits so an admin does not
get `Operations` for free; the order is fixed and each role sees a strict prefix.

- **Cost:** A maintainer auditing the bar against the record concludes an extra
  link is a bug. Lower stakes than it looks, but this is the one rule the record
  claims is derived in exactly one place, so an inaccurate statement of it is
  worse here than elsewhere.
- **Fix:** Add `Access lists` to the DESIGN.md list, in the position `navFor`
  puts it (last, with the other admin items).

---

## 9. `navFromPath` serves one boundary, not the three its docblock names

- **Severity:** Minor
- **Where:** `src/app/_components/nav-items.ts:59-62`, `:136-142` vs
  `src/app/not-found.tsx:48` and `src/app/payouts/[id]/not-found.tsx:80`

> `navFor` is the rule. `navFromPath` is the same rule run with weaker evidence,
> **for the three surfaces that cannot read a session at all (`error.tsx`,
> `not-found.tsx`, `payouts/[id]/not-found.tsx`)** and have only the URL to go
> on. It is written as calls to `navFor`, not as a second literal list, so that
> "the boundary is the same rule under weaker evidence" is a fact about the code
> rather than a claim in a comment.

Only `error.tsx` calls `navFromPath` (three times, `:83`, `:91`, `:97`). The
other two named surfaces call `navFor` directly with the bits written out:

```
not-found.tsx:48            navFor({ canReadPayouts: false, isAdmin: false })
payouts/[id]/not-found.tsx:80  navFor({ canReadPayouts: true, isAdmin: false })
```

Those are exactly what `navFromPath` would return for their paths, so nothing is
wrong on screen today, and both files are honest — each says "the nav below is
`navFor({…})`" in its own docblock. The inaccuracy is in `nav-items.ts`, and it
inverts the reasoning it offers: the module argues that expressing the boundaries
as `navFromPath` calls makes the shared-rule claim a fact about the code, and
then two of the three boundaries hardcode that function's *output* instead. The
one change the argument was built to survive — altering what a path branch proves
— would reach `error.tsx` and silently miss the other two.

- **Cost:** Latent. It costs a reviewer who takes the docblock at face value and
  does not check, which is the point of the docblock.
- **Fix:** Either switch the two not-founds to `navFromPath(...)` (root passes
  its own pathname; the payout one can pass `"/payouts"`), or correct the
  docblock to say `navFromPath` exists for `error.tsx` and the other two apply
  the same rule at their own call sites.

---

## 10. Two raw tracking numbers at call sites

- **Severity:** Minor
- **Where:** `src/app/globals.css:2654` (`.tier--lead`), `:3700`
  (`.launch__foot`)

> Tracking is the one property that legitimately varies, so it is **tokenised by
> the job the label is doing rather than left as a number at the call site**.

Both of these write `letter-spacing: 0.12em` — the literal value of
`--track-label` — instead of the token. `.tier--lead` is the more interesting of
the two: it overrides `.tier`'s `--track-control` (0.1em) with the *form-and-table
label* tracking on a badge, which is a job change the token vocabulary would have
made visible and the raw number hides. `.launch__foot` is fine-print furniture
sitting beside `.launch__motto` and `.shell__wordmark span`, both of which take
`--track-furniture` (0.14em).

The other five raw `letter-spacing` values in the file are all legitimate: the
three negative display trackings (`h1`, `h2`, `.launch__title`) match DESIGN.md's
scale table exactly, `.shell__wordmark b` is a positive wordmark tracking outside
the label vocabulary, and `.st--lead` zeroes tracking with an argued reason.

- **Cost:** Two sites where the rule stops being enforceable by grep, on a
  property the record specifically says was tokenised *because* "a new label got
  whichever number its neighbour happened to carry."
- **Fix:** `var(--track-label)` at both, or `var(--track-furniture)` at
  `.launch__foot` if the intent was to match its neighbours — that is a visual
  change and should be measured, so the safe move is `--track-label` at both and
  a note.

---

## 11. A cluster of stale figures and stale prose in `globals.css` comments

- **Severity:** Minor
- **Where:** `src/app/globals.css:1027-1031`, `:1088-1091`, `:588-594`,
  `:1583`, `:3577-3578`

None of these changes behaviour; each is a place where the file argues from a
number or a fact that is no longer true. Collected rather than filed separately
because the fix is the same edit pass.

| Line | Claim | Measured / actual |
|---|---|---|
| `:1030-1031` | "`--rule` measures 1.76:1 on `--void`, 1.59:1 on `--hull` and 1.39:1 on `--hull-hi`" | 1.62 / 1.50 / 1.33 |
| `:1031` | "`--rule-strong` clears 3:1 on every ground (4.11 / 3.72 / 3.24)" | 4.23 / 3.90 / 3.47 — and this *contradicts DESIGN.md's own table*, which says 4.24 / 3.92 / 3.48 and is right |
| `:1089` | edge fade "mixed to 75% it measures 2.55:1" | ≈2.84:1 composited over `--void` |
| `:589-590` | nav states "clear 3:1 against the ground (8.67 / 10.21 / 12.67:1)" | on `--hull`: `--ink-dim` 8.80, `--gold` 10.73, `--ink` 14.84 |
| `:588` | "`--gold` vs `--ink-dim` … is only 1.18:1" | 1.22:1 |
| `:1583` | "every control inside `.drawer__controls` is `.btn--micro`" | every control in `.drawer__controls` is now plain `.btn` (`admin/accounts/page.tsx:942`, `:1006`, `:1032`, `:1091`, `:1099`, `:1151`, `:1219`) — that is ruling R1 having landed, and this sentence is what it left behind |
| `:3578` | "inside the system's own declared **1.25 minimum ratio**" | DESIGN.md now explicitly retracts that ratio: "'ratio 1.25 minimum between adjacent steps' is what this section used to claim and it has never been true of the shipped scale" |

Every conclusion these comments draw still holds — `--rule-strong` does clear
3:1, the fade is under 3:1, the nav states do clear their grounds, `.btn--quiet`
was a third size. Only the figures and one tense are wrong.

- **Cost:** These comments are the file's memory, and the file is unusually
  dependent on them — 5477 lines with roughly half of them prose. A reader who
  spot-checks one and finds it off by 0.13 loses confidence in the eighty that
  are exact.
- **Fix:** Correct in place. The `:1031` one matters most because it disagrees
  with a table in DESIGN.md rather than merely being imprecise.

---

## 12. `.btn--quiet`'s base size is bought back four times

- **Severity:** Minor
- **Where:** `src/app/globals.css:2813-2819` and the four override rules at
  `:538`, `:1602`, `:2837`, `:2880-2884`

> There are **two** sizes and no others: `quiet` is a **colour grade**, like
> `primary` and `default`, **not a third size**.

`.btn--quiet` nonetheless sets `min-height: 1.75rem` as its base — the record
acknowledges this ("`.btn--quiet` does carry its own `min-height: 1.75rem`… but
that is not the last word wherever it lands") and names one override. There are
four, covering five selectors:

- `.shell__signout .btn` (`:538`) — header sign-out
- `.manifest-panel__controls .btn--quiet` (`:1602`) — `/account` unlink
- `.inline-edit--standalone .btn--quiet` (`:2837`) — `/payouts/[id]` page-level edits
- `.filters .btn--quiet`, `.filter-form__actions .btn--quiet` (`:2880`) — both filter rows

Each carries its own multi-paragraph justification, and each says roughly the
same thing: this quiet control is standalone, so it needs 36px back. The base
rule is right in one context — controls inside `.log` rows — and wrong in five,
plus the unfixed sixth in finding 4. A colour grade that has to have its size
corrected in five scoped rules is functioning as a size.

- **Cost:** Not on screen — the overrides work. It costs the next person who adds
  a quiet control outside a table row and does not know to add a sixth override,
  which is exactly how `.disc > summary` ended up where it is.
- **Fix:** Out of scope for a report to specify, but the shape is: make 36px the
  base and scope 28px to `.log tbody .btn--quiet` / `.btn--micro`, which inverts
  five overrides into one. Worth a measurement pass before anyone does it.

---

## PRODUCT.md's five principles against what ships

1. **Play it straight.** Holds throughout. The joke is confined to the seal, the
   `hero-account` illustration, and the motto line; no control, label or status
   word is cute. `/admin/audit`'s copy — "Every state change, append only,
   newest first. Nothing here can be edited or removed." — is the register
   exactly.
2. **State before action.** Holds. `/account` opens with a verdict token and a
   tier before any control; `/payouts` carries a `YOURS` column so "was I paid?"
   is answerable without a click; `/admin/sync` states worker liveness above the
   job table.
3. **Scanning is the primary act.** Holds structurally — the value/control split
   (`globals.css:2443-2449`: every value carries a leading dot in its own hue,
   every control is a neutral box and never carries one) is a genuinely good
   scanning device and works in `15-admin-accounts.wide.png`. Per-surface
   scanning failures are the surface reviewers' territory.
4. **Nothing reads as punishment.** Holds, and is enforced in code rather than
   asserted: `payouts/page.tsx:314-324` deliberately renders a draft
   mid-payment neutral rather than amber ("rendering them amber burned the alarm
   colour on nothing"), cryo is amber only in the admin table and `--ink-dim` on
   the member's own page, `.st--ok` is `--ink-dim`, and `.btn--danger-quiet`
   exists precisely so an ordinary destructive choice is not permanently the
   loudest thing on its page. Alumni is `#81bb8d`, not a warning colour.
5. **Earn the artwork.** Partly. The header mark is a purpose-cut 34px asset
   rather than a scaled seal (`ui.tsx:117`), and the night-cut
   `hero-account.webp` is argued at `DESIGN.md:330-337`. But `.closing img` draws
   that 1120px asset at `min(420px, 100%)`, and `.closing--compact` at
   `min(260px, 100%)` — a 4.3× downscale — while `account/page.tsx:1382-1384`
   describes the compact case as "the same asset for a smaller frame rather than
   cropping or downscaling it." At 2× DPR the 420px case is fine; the 260px case
   is downscaling by any reading. This is adjacent to the known-open
   "oversized images with no `sizes`/priority" item, so I am not filing it
   separately — but the *prose* is a separate defect from the byte weight, and
   the known-open entry does not cover it.

Accessibility claims in PRODUCT.md that I could check all hold: no `outline:
none` anywhere in the stylesheet, the focus ring is `2px --gold` at `2px` offset
globally (`:289-293`) with two scoped `-2px`-offset variants for regions that
would clip it, the skip link takes `--gold` ground and `--void` text as
described (`:4963-4972`), `prefers-reduced-motion` collapses globally,
`.visually-hidden` is a proper clip-path implementation, and no text token
measures under 4.5:1 on any of the three grounds (worst case `--ink-faint` on
`--hull-hi` at 4.61:1).

One thing I noticed in passing and am not filing as a record contradiction
because it belongs to that surface's own reviewer: `/admin/access-lists`
(`page.tsx:133`) is the only `<main>` in the app without `tabIndex={-1}`, so the
skip link's target is not focusable there.

---

## What is genuinely good and should survive

- **DESIGN.md's colour tables are honest.** I recomputed every measured ratio
  from rendered sRGB and they land within 0.02: `--rule-strong` 4.23/3.90/3.47
  against the stated 4.24/3.92/3.48; `--signal-bad` 5.83/5.38/4.79 against
  5.83/5.39/4.79; `--signal-warn` 9.78/9.03/8.04 against 9.75/9.01/8.00;
  `--void` renders `#0a0a0a` at a red-to-blue ratio of exactly 1.00. The one bad
  figure (finding 6) is an outlier in an otherwise trustworthy table. Do not let
  a fix pass "tidy" these.
- **The type scale's self-correction.** DESIGN.md's retracted 1.25 claim is
  replaced by an accurate one: `--t-body`/`--t-data` is 1.071, and the four steps
  from `--t-body` to `--t-label` are 1.071 / 1.077 / 1.083 / 1.091 — inside the
  stated 1.07–1.09 band. `--t-h2` → `--t-body` is 1.467, matching the stated
  1.47. And the scale is genuinely closed: exactly three raw `font-size` values
  exist in 5477 lines (`0.9em` on inline `code`, and the two documented one-offs),
  each used once, each argued in place.
- **The two card exceptions hold, and the third was refused in writing.**
  `.launch__panel` and `.form-panel` are the only two rules in the file pairing a
  ground with a border on a content container, and `globals.css:3216-3221`
  records the decision *not* to give `/payouts/new` registration ticks, quoting
  the rule it would have broken. `.manifest-panel` has no ground of its own,
  `.drawer` is a hairline, `.escalation` and `.json__full` are `--void` insets in
  the Field idiom.
- **The label register itself.** Fourteen selectors, all at 600, none overridden,
  all live, and the five deliberate non-members each argued from the same test
  (`--track-value` is the tell). It is one undeclared selector away from being
  exactly what the record claims.
- **`.shell__nav a` stayed fixed.** `globals.css:561-570` is
  `display: inline-flex; align-items: center; min-height: 2.25rem` — the
  documented idiom, not a padding-sized box, so the third undocumented ~33.05px
  grade is gone and the underline offset is preserved. Pinned by
  `e2e/shell.spec.ts`.
- **Ruling R1 landed where it was claimed.** Every control inside
  `.drawer__controls` on `/admin/accounts` is plain `.btn` at 36px; the
  `.manifest-panel__controls .btn--quiet` buy-back is present and does win on
  both specificity and source order as DESIGN.md states.
- **`.st--ok` is `--ink-dim` and the argument is preserved beside it.**

## What I could not evaluate

- **Rendered weight and tracking.** Everything about type here is read from the
  cascade, not from a browser. The `.status-line__label` finding is a cascade
  fact (no `font-weight` in any matching rule) confirmed against a screenshot,
  but I could not run `getComputedStyle`.
- **The `.tier--unknown` / `.tier--pending` tint measurements**
  (`globals.css:2628-2632`: 4.56 / 3.94 / 5.67). These are `--ink-faint` and
  `--ink-dim` over a 14% `color-mix` tint over a hovered row — three composites
  deep, and `color-mix(in oklab, …, transparent)` composites differently than a
  naive alpha blend. I could not reproduce them confidently enough to affirm or
  challenge, so I left them alone. Everything around them checked out, which is
  weak evidence they are fine.
- **Hover, focus and armed states.** All static shots. `.btn--danger-quiet`'s
  row-hover red, `.field:focus-visible`'s gold border, `ConfirmSubmit`'s armed
  swap and the `.scroller-fade` `data-visible` toggle are read from CSS only.
- **Saturated-colour area below ~4%.** I estimated from the shots rather than
  sampling pixels. Nothing came near 10%, so the claim holds with room, but the
  per-surface figures in finding 3 are estimates, not measurements.
- **Narrow-viewport register behaviour.** `.crew__label`'s stacked-block mode
  below 29.9375rem is only reachable at 320px; the narrow shots are 390px, where
  the real `<thead>` is still showing.

## Contested — settled taste I think is worth one challenge

None. Every settled item I touched (the `.st--ok` neutral, `--void` at chroma 0,
two card exceptions, registration ticks on login only, near-zero radii, the tight
type ramp, the two-family split) verified as shipped and I have no argument
against any of them. Finding 3 reads as a challenge to the gold ration but is
not: I am asking the record to state the ration the app already implements, not
to change the ration.
