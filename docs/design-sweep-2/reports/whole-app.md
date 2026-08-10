# Whole-app composite review

Input: all 30 screenshots in `docs/design-sweep-2/shots/` (15 surfaces × 1440×900 and 390×844, both fullPage) and `PRODUCT.md`. No source read. Colour values below are sampled from the rendered PNGs and are true sRGB hex.

---

## 1. Does this read as authored, or as generated?

**The words are authored. The layout is generated.** That split is the single most important thing in this sweep, and it is visible only across surfaces.

### What is unmistakably authored

The microcopy is written by someone who has had to explain this system to a human being more than once, and got tired of it:

- Payout detail, on Finalize: *"Closes the pools, roster and shares to editing. Reversible with Unlock until the first payment is recorded, and permanent after that."*
- Payout detail, finalized: *"A payment has been recorded, so the loot pools, roster and shares are fixed permanently. Reverting a payment does not reopen editing: it only corrects who was paid, so revert the wrong one and pay the right person while still frozen."*
- New operation: *"One row per fight. Creating an operation pays nobody: it opens a draft you can fill in now or later."*
- Login, on a scope: *"Without it a docked character reads only as docked."*
- 404: *"Check it for a typo, or for a link that was truncated on its way here."*

No generator writes the second one. That is a paragraph that exists because somebody unlocked the wrong operation and lost an hour.

Two other authored moves:

- **The error boundary has a `WHAT TO SEND` block** — `page / seen / ref` in monospace, above the buttons. That is not error-page furniture; it is somebody pre-writing the Discord message so the reporter does not have to. It anticipates the support conversation.
- **Section rules carry a readout.** `LOOT ————— 4,810,000,000.00 ISK`, `SPLIT / ROSTER ————— 6/15`, `9 JOBS ——— CHECKED 11:57:14 UTC`, `62 ENTRIES ——— as of 11:57 UTC`, `LOG ——— 34 total`. The divider label doubles as a value. That is a real instrument idiom, applied consistently across five unrelated surfaces. Somebody decided that.

And the negative evidence is strong: across 30 screenshots there is not one rounded corner on a container, not one gradient, not one glass panel, not one glow, not one drop shadow, not one hero metric. That is discipline, and it is sustained.

### What is unmistakably generated

**Every one of the fifteen surfaces is the same skeleton.** 60px header, seal + wordmark hard left, nav hard right, `SIGN OUT` behind a divider; then h1, then one line of grey description, then an optional filter strip, then a table or a form. Fifteen for fifteen. The only surface that escapes is login — because login is the one page that was drawn rather than assembled.

**Five of fifteen surfaces are an h1, a sentence, and a button in the top-left corner of a 1440×900 viewport** (`02-not-found`, `08-payout-not-found`, `13-error-boundary`, `14-access-lists`, and functionally `03-payouts-empty`). On `14-access-lists.wide` the content ends at x=700, y=270; roughly 89% of the viewport is unbroken `#0a0a0a`. Nothing was decided about those pages. They fell out of the template.

**The narrow viewport was not designed at all.** It is the wide layout permitted to fall over, and I go into what that costs below. A designed 390px layout does not put a 6-line vertical word-stack in a name column.

**A systemic type defect nobody has looked at.** Every word ending in `k` loses the space after it, on every surface, at both widths: "Check**it** for a typo", "That link**points** at an operation", "a link**that** was truncated", "check whether it took**effect**". That is a bad kerning pair in the body face, and it appears in the 404 and the crash page — the two moments a member is already annoyed.

> **Cost:** A member who hits the crash page reads "check whether it tookeffect before you send it again" and now has two problems: the thing that broke, and a tool that visibly cannot set type. The voice PRODUCT.md is built on — *deadpan, precise* — is contradicted by the rendering in the exact place precision is load-bearing. It is one font fix that repairs the impression on all fifteen surfaces at once.

### Verdict

Nobody has *drawn* this application. Somebody has *written* it, carefully, and then let a default admin chrome carry the writing. The chrome is not offensively wrong — it is competent, it avoids the obvious traps — but it makes no argument. If you deleted the copy and the seal, nothing about the remaining pixels would tell you what this product is, who runs it, or that it has a joke at its centre.

---

## 2. Composite character, in one paragraph

A well-written flight manual laid out by a build script. The prose is dry, exact, and quietly funny in the way PRODUCT.md asks for — it states what is true, never exclaims, and explains the irreversible thing before you press it — but it is set on a uniform near-black ground in a uniform left-flush column with a uniform 60px bar on top, so every surface has the same posture regardless of whether it is a 34-row scanning table, a two-button empty state, or a login page. The result reads as *serious and unfinished* rather than *serious and instrumented*: the restraint is real (no cards, no glow, no gradients, no hero numbers) but it has not been converted into any positive quality — no rhythm, no density gradient, no sense that a scanning surface and a reading surface are different kinds of object. It is closest in feel to a well-maintained internal tool at a company with no designer: trustworthy, legible, and completely mute about itself, with a single beautiful hand-inked lander parked in the corner of one page like a photograph on a desk in an otherwise bare office.

---

## 3. Which surfaces disagree about what this product is?

**Login (`01`) disagrees with the other fourteen.** It is the only centred layout, the only framed one (a 480px panel with a hairline gold left edge), the only one on a warmer ground (`#131313` panel over `#0a0a0a` page), the only one with the seal at full size, the only one with a ~64px display h1, and the only one with artwork used as texture. It is genuinely designed. Then you sign in and land on a left-flush admin console that shares none of those properties. Two products in two clicks.

> **Cost:** A first-time member's impression is set by login and immediately withdrawn. The corp's identity — the whole reason PRODUCT.md exists — is spent entirely on the one screen the member sees least often, and absent from the one they return to.

**Account (`12`) disagrees with the admin surfaces about whether artwork exists.** It is the only post-login page with an illustration. On wide, the lander sits in a right rail. On narrow it is at the very bottom of a 2091px page, below the sync schedule, roughly 1,900px down — a member on a phone will essentially never see it.

> **Cost:** Principle 5 says *earn the artwork*. On narrow the artwork is not earned, it is buried; the member gets the bare console and the corp's personality is delivered to nobody.

**Payout detail (`06`/`07`) disagrees about control density.** Every other surface has between zero and three controls. Payout detail draft has ~30 inline `EDIT` buttons, plus `EXCLUDE`/`REMOVE` on all 16 roster rows, plus `DELETE` on both loot pools. It is the only surface where the dominant visual texture is buttons rather than data — and PRODUCT.md's principle 3 is *scanning is the primary act*.

> **Cost:** An admin reconciling a 4.8b ISK split cannot scan the amounts column, because a bordered button sits inside every cell of the neighbouring column at the same size and weight as the numbers. The eye stops sixteen times instead of running down one column.

**Members (`15`) disagrees with Operations (`03`/`04`) and Audit (`09`/`10`) about what a filter is.** Members uses a row of pill toggle buttons that apply instantly (`ALL / QUEUED / TESTERS / FRIENDS / VETERANS`, `ALL / CRYO / ACTIVE`). Operations and Audit use text inputs plus a select plus an explicit `FILTER` submit button. Same job, two entirely different interaction models, one nav click apart.

> **Cost:** An admin who filters Members by clicking a pill, then moves to Audit and clicks in the ACTOR field expecting the same immediacy, types a name and waits for a result that never comes. They have to learn the tool twice — the one thing PRODUCT.md says neither role wants to do.

**Audit (`10`) disagrees with itself across viewports.** Wide shows absolute timestamps (`2026-08-08 17:31:04`); narrow shows relative ones (`42h ago`). Same table, same data, different facts.

> **Cost:** An admin answering "why is this person's role wrong?" needs the exact time to correlate with Discord and in-game logs. On a phone they cannot get it, and cannot tell that the wide view would have given it to them.

**Access lists (`14`) disagrees about whether it is a page.** An h1, two sentences, two buttons, and then nothing — at both widths. It reads like a dialog that got routed.

---

## 4. Could someone guess the palette and theme from "dark tool for a space game"?

**Yes. Plainly, and with one detail that makes it worse than a guess.**

The page ground is **`#0a0a0a`** — sampled, exact, and dominant: 70–88% of every non-login screenshot's pixels. PRODUCT.md's third anti-reference names *"rounded card grid on `#0a0a0a`"*. The document names a hex value as the thing to avoid, and that hex value is the application's ground colour on all fourteen post-login surfaces.

The rest of the palette is what anyone would predict:

| Role | Sampled | Predictable? |
|---|---|---|
| Page ground | `#0a0a0a` | The named anti-reference, verbatim |
| Raised surface | `#151514`, `#171616`, `#21201f` | Yes — three near-black greys |
| Rules | `#373533` | Yes |
| Muted / label text | `#787370` | Yes |
| Body text | `#ece7de` | Slightly warm — a small point of character |
| Accent / primary | `#f1c035` | Gold on near-black: the EVE-tool default |
| Tier blue | `#44abdc` | Yes |
| Alarm | `#f05751`, `#ca2a30` | Yes |
| Warning amber | `#f0965a`, `#d7915f` | Yes |

Gold-on-black for an EVE tool is the same reflex as cyan-on-black; it dodges anti-reference #2 by choosing the *other* obvious hue, not by choosing.

**Be fair about what it does escape.** It is not generic dark SaaS: no rounded cards, no violet-to-blue gradient, no glassmorphism, no hero metric. It avoids the *shapes* of anti-reference #3 completely while adopting its exact *ground colour*. But that lands it on anti-reference **#1** instead — "dense grey admin chrome, Django admin with a hat on." Look at `15-admin-accounts.wide` with the copy blurred: a bordered table of small-caps status chips and paired bordered action buttons per row, above a strip of toggle pills, under a thin fixed bar. That is Django admin in dark mode. The only missing ingredient is Bootstrap blue, and `#44abdc` is nearly supplying it.

The one thing not guessable from the category is the seal and the lander. They are doing 100% of the identity work, on two of fifteen surfaces.

> **Cost:** The corp is replacing Alliance Auth. A member who used the old tool and opens this one sees the same dark table chrome in a different accent hue and concludes the change was cosmetic. The project's stated success condition — *"replace an Alliance Auth install with something the corp actually uses"* — is being argued entirely by the copy, against the palette.

**Also measured, and it undercuts a stated guarantee:** `#787370` on `#0a0a0a` is **4.23:1**; on the table-header ground `#151514` it is **3.90:1**. That colour is the field labels (`NAME`, `STATUS`, `ACTOR`), the section rule labels (`FILTER`, `LOG`, `SCOPES REQUESTED`), and every table column header, at ~11px uppercase. PRODUCT.md claims WCAG 2.2 AA — 4.5:1 for all text. These are small text and they miss.

> **Cost:** An admin scanning at night with a monitor dimmed for a dark room cannot resolve which column is which without leaning in, on the surface they use most; and the accessibility promise in the product document is not true as rendered.

---

## 5. Where does the eye go, and should it?

| Surface | Eye lands on | Should it? |
|---|---|---|
| `01` login | The seal, then "Test Corp", then the EVE button | **Yes.** The best-resolved screen in the app. |
| `02` not-found | The gold-outlined h1 box, then a large gold button | Roughly. But the h1 is wrapped in a full-width gold-bordered box that reads as an alert container for a message that is not an alarm. |
| `03` payouts empty | `NEW OPERATION` (gold, top-right) | **Yes** — the only thing to do. |
| `04` payouts full | `NEW OPERATION` again, then the amount column | **No.** 34 rows exist; the brightest object is still the create button. The eye should go to the four `DRAFT` rows — the only actionable state — and they are the *dimmest* rows (hollow `○` marker, `#787370` text) while the 26 finished rows are brighter. Attention is inverted. |
| `05` new operation | The `Name` field | Yes. |
| `06` payout detail draft | The gold `FINALIZE` button — then it is dragged to the orange unresolved-pricing banner | **Nearly right, wrong order.** The banner says the total is short by two unpriced items; `FINALIZE` sits *above* it and is the loudest thing on a 2,900px page. |
| `07` finalized | Title, then the wall of `MARK PAID` buttons | Yes — that is the job. |
| `08` payout not-found | h1 box, button | Fine. |
| `09` audit empty | `FILTER` button — the only bordered control | Weak, but nothing else exists. |
| `10` audit full | The monospace action column (`status.changed`, `tier.changed`) | **Yes.** Best-tuned table in the app: three type registers (mono timestamps, linked names, mono actions) give the eye a real rail. |
| `11` sync | The red heartbeat banner | **Yes** — then it fails. Seven `▲ OVERDUE` markers are all identical weight, so the one `● OK` row is what actually stands out, which is backwards. |
| `12` account | `▲ 6 characters need attention` in amber beside the h1 | **Yes.** Then the eye has nowhere to go: all six rows are identical, so "which one" is unanswerable without reading all six. |
| `13` error boundary | h1 box, then the red reference banner | Yes. |
| `14` access lists | `GRANT ACCESS` | Yes. |
| `15` members | The red `0/1 HEALTHY` token cluster | **Yes, and it is the best hierarchy decision in the app** — the one genuinely wrong value is the only red on the row. This is what principle 3 asks for, and it exists in exactly one place. |

The pattern: **where a column has variance, the design handles it well (`10`, `15`, `12` header). Where a column is constant, the design still gives it full weight, and the constant column then out-shouts the varying one.**

---

## 6. Which screens run long and empty rather than wide and full?

**The two payout-detail surfaces are the emblem.** `06-payout-detail-draft.wide` is 2,902px tall in a 1440px-wide viewport, and its content is confined to x=83–955 — an 872px column that leaves **485px of the viewport permanently unused**, down all 3.2 screens. `07` is the same: 2,769px tall, content x=86–955. The roster table has five columns and the loot table four; both would fit twice over in the space being refused.

> **Cost:** An admin reconciling a payout scrolls three full screens to compare the loot total at the top against the roster amounts at the bottom, and cannot hold both in view — on a monitor with a third of its width empty the entire time. Every reconciliation is a scroll-and-remember exercise that a two-column layout would make a glance.

Also long and empty:

- `04-payouts-full.narrow` — **5,699px**, 6.7 folds, for 34 rows.
- `06`/`07` narrow — **4,027px** and **3,944px**.
- `12-account.narrow` — 2,091px, with the artwork at the very bottom.
- `02`, `08`, `13`, `14` wide — all four are ~90% empty ground with content pinned to the top-left corner.

**And the exact inverse, which is worse:** `15-admin-accounts.wide` is only **1,022px tall** and shows **4 of 13 members**, the fourth clipped mid-row — the table body has its own capped scroll region. This is the primary admin scanning surface, on the widest viewport, and it is the one page that *should* be long.

> **Cost:** An admin looking for the one member whose tier is wrong must scroll inside a ~420px window to see 13 rows, three or four at a time, losing the column headers' spatial anchor on every scroll. Principle 3 says optimise for the eye moving down a column; this is the one surface where the eye cannot move down the column at all.

---

## 7. Which screens repeat the same value down every row?

Ranked by wasted column-width:

**`15-admin-accounts` — 6 of 10 columns constant.** Across the visible rows: `TIER CHANGED` = `—` (all), `LAST LOGIN` = `—` (all), `ADMIN` = `MEMBER` (all), `DISCORD` = `NONE` (all), `TOKENS` = the identical three-line `0/1 HEALTHY / main dead / 1 dead` (all), `ACTIONS` = `GRANT` + `SYNC NOW` (all). Only `NAME`, `TIER`, `CRYO`, and `MAP` carry information.

> **Cost:** The admin's most-used table spends more than half its width on cells that never differ, which is exactly why only 4 rows fit — the constant columns are pushing the varying ones out of the visible region and the row count down.

**`04-payouts-full` — 68 identical cells.** `PAID` reads `0/5 PAID` on all 34 rows; `YOURS` reads `UNPAID` on all 34. Together ~270px of a ~1,200px table.

> **Cost:** A member opening Operations to find their own unpaid share sees `UNPAID` 34 times and learns nothing; the column that exists to answer their one question answers it identically for every row.

**`06-payout-detail-draft` — 15 of 16 rows identical in three columns at once.** `SHARES` = `1.00` + `EDIT`, `AMOUNT` = `288,600,000.00 ISK`, `STATE` = `UNPAID`, plus `EXCLUDE` and `REMOVE` on every row. Only two rows differ (`Hurricane Main` 2.00, `Kikimora Kid` excluded) — and they are the hardest two to find.

> **Cost:** An admin verifying a split needs to spot the non-default share. The two rows that differ are rendered exactly like the fourteen that do not.

**`11-admin-sync` — `LAST RUN` = `19h ago` on all 8 rows; `HEALTH` = `▲ OVERDUE` on 7 of 8.** An entire column of one value, next to a column of one value with a single exception.

**`12-account` crew manifest — all 6 rows byte-identical:** `NOT REPORTED` / `RE-AUTHORIZE` / `NOT YET RUN` / `OFF`.

> **Cost:** The header says *6 characters need attention*. The manifest is six identical rows, so "which one" has no answer and the member must re-authorise all six or guess. This is the single most common member session PRODUCT.md describes — a stale token, minutes before a fleet — and the page cannot point at it.

**`10-audit` — `DETAILS` = `+ roleId=1284410981234567890, characterId=90000006` on 5 of 13 rows**, each truncated with an ellipsis at the same character. Meanwhile the table leaves ~120px of viewport unused to its right.

---

## Composite finding: narrow is not a viewport, it is a failure mode

Six surfaces put their **most important column off-screen** at 390px, behind horizontal scroll inside the table region:

| Surface | Hidden at 390px |
|---|---|
| `04` payouts | `TOTAL`, `PAID`, `YOURS` — and the `NAME` column collapses to a 6-line vertical letter-stack ("Tama gatecamp 01" becomes six stacked fragments) |
| `06` payout detail | `STATE` + `EXCLUDE`/`REMOVE` |
| `07` payout detail finalized | `STATE` and **every `MARK PAID` button** |
| `10` audit | `TARGET` and `DETAILS` |
| `12` account | Token status and **every `RE-AUTHORIZE` link** |
| `15` members | Everything from `TIER CHANGED` rightward — 7 of 10 columns |

> **Cost:** PRODUCT.md's member is *"alt-tabbed out of a game, often late at night, often minutes before a fleet forms"* — which is to say, frequently on a phone. On `12-account.narrow`, the one control that fixes the one thing they came for is horizontally off-screen. On `07.narrow`, an FC paying out a fleet from their phone cannot see who has been paid or press `MARK PAID`. These are not degraded layouts; on those two screens the page's entire purpose is unreachable, and nothing on screen indicates that content exists to the right.

`04-payouts-full.narrow` is the worst single frame in the sweep: the name column is roughly 40px wide, so operation names render as vertical stacks of one or two characters per line, and the table *still* scrolls horizontally. It is 5,699px tall.

---

## Note, not a finding

The Next.js dev-overlay badge (black `N` circle) appears in all 30 captures, and it reads **`1 Issue`** on `08-payout-not-found` and `11-admin-sync`, and **`2 Issues`** on `13-error-boundary`. Those are capture artefacts rather than design, but the counts indicate real console/hydration errors on three surfaces and are worth someone's attention outside this sweep.

---

## What I would fix first, by cost

1. **Narrow-viewport column hiding on `12-account` and `07-payout-detail`** — the only two places where a user's actual task becomes impossible rather than awkward.
2. **The constant-column problem on `15-members` and `12-account`** — collapse or suppress columns with no variance; it directly buys back row count on the primary scanning surface and makes "which one needs attention" answerable.
3. **`#0a0a0a`** — the ground colour is the anti-reference by name. Nothing else in this report changes the product's character as cheaply.
4. **The `k`-plus-space kerning defect** — one font fix, repairs the voice on all fifteen surfaces.
5. **`#787370` at 4.23:1** — small, and it makes a stated guarantee true.
