# critique — /login

Judged in the **brand** register: this is the one screen that is an object on an
empty field rather than an instrument, and the only URL a stranger can reach.

Verdict up front: it passes the slop test decisively. Nobody would look at the
navy panel, the 7% lander, the registration ticks and the mono motto and say "AI
made that." Where it is weak is not the aesthetic. It is that the paragraph doing
the trust work under-describes what is being asked for, and attributes it to a
name the page never introduces.

## Findings

### 1. The scope list asks for a capability the disclosure never names

- **Severity:** serious
- **Where:** `src/app/login/page.tsx:80-104`; scope set at `docs/ops.md:21,219`; capability at `src/lib/esi/client.ts:18`, `src/app/payouts/access.ts:74`
- **Cost:** A member at the EVE consent moment is asked to grant `esi-ui.open_window.v1` — the app's ability to make windows appear inside their game client — and the only place the page describes it is as that identifier, in the faintest ink on the screen.
- **Principle:** PRODUCT.md principle 2, "state before action"; PRODUCT.md voice, "states what is true"
- **Fix:** The `.launch__disclosure-note` covers three of the reference deployment's capabilities (Discord role, Wanderer ACL, the `{label}` contact set) and every one of them maps to a scope in `EVE_SSO_SCOPES` — except `esi-ui.open_window.v1`, which has no prose counterpart at all. Add its clause: it is used by the payout flow (`payouts/actions.ts:590`) to open a character's info window in the client, and it is genuinely the least alarming thing on the list, which is exactly why leaving it as a bare identifier is the wrong trade. One more clause: "It can also open an info window in your EVE client from the payouts page." Being deliberately configurable, the prose cannot enumerate a fork's scope set — but the reference deployment's own prose should match the reference deployment's own `EVE_SSO_SCOPES`, and today it does not.

### 2. The paragraph attributes every action to "authGD", a word that appears nowhere else on the page

- **Severity:** serious
- **Where:** `src/app/login/page.tsx:55,81-86`
- **Cost:** A member reads a 4rem corp name, then a paragraph in which some party called "authGD" sets their Discord role and writes contacts to their characters, with nothing on the screen saying who that is or that it is the thing they are about to sign into.
- **Principle:** none
- **Fix:** The `h1` is `brand.name` ("Zoo Landers" in the reference deployment). Every other user-visible name on this page is configured. The prose alone hardcodes the product name. Two coherent options, and the current state is neither: (a) use `{brand.name}` in the prose so the paragraph and the heading are the same party, or (b) keep "authGD" and introduce it, once, so the panel says what it is — the `.launch__foot` slot or a line under the motto can carry "authGD · corporation auth for {brand.name}" and the paragraph then has an antecedent. Note the same page already resolves this correctly elsewhere: `SiteHeader` renders the mark with the configured name, and `brand-context.tsx:26` only falls back to "authGD" when a caller forgot to pass one. On `/account` the same hardcoding is defensible because the reader is already signed in and has seen the tool; on the front door, at the consent moment, it is a stranger's name in the sentence asking for permission.

### 3. The error notice's top border touches the element above it

- **Severity:** moderate
- **Where:** `src/app/login/page.tsx:78`; `src/app/globals.css:2104-2116` (`.notice`), `:2253-2264` (`.launch__motto`)
- **Cost:** A member bounced back here after a cancelled or failed sign-in — the one arrival where the page has to look composed — sees the notice box jammed flush against the motto, or against the display-size `h1` when `BRAND_MOTTO` is unset, which reads as the page having broken rather than as an explanation.
- **Principle:** DESIGN.md Layout, "rhythm comes from varying the step"
- **Fix:** `.notice` declares `margin-bottom: var(--s-5)` and, under the global `* { margin: 0 }` reset, no top margin. It works everywhere else because the preceding element supplies the gap; here `.launch__motto` sets only `margin-top: var(--s-2)`, and when the motto is absent the `h1` supplies nothing either. Add `margin-top: var(--s-5)` to `.launch .notice` (not to `.notice` globally, which would double the gap on the six pages that already reserve it, and not to `.notice-slot`, which must stay zero so the empty slot draws nothing). Verify against both `BRAND_MOTTO` set and unset — the unset case is the worse of the two and the one no test covers.

### 4. The consent list is the quietest type on the panel

- **Severity:** moderate
- **Where:** `src/app/globals.css:2275-2303`
- **Cost:** At the moment a member decides whether to grant access, the list of what is being granted is set in `--ink-faint` (5.65:1 on the panel), while the prose above it sits in `--ink-dim` (8.79:1) — so the eye reads the reassurance clearly and skips the specifics, which is the opposite of the intended order.
- **Principle:** PRODUCT.md principle 2, "state before action"
- **Fix:** Both values clear AA, so this is hierarchy and not contrast; do not "fix" it as a contrast bug. The code comments around this block argue at length, and correctly, about scope *boundaries* — one `dd` per scope so a line break cannot be mistaken for a scope end. Nobody argued the colour, and it inherited the metadata grade by default. The `dd` values are the load-bearing content of this section, not its metadata: move `.launch__scopes dd` to `--ink-dim` and leave `.launch__scopes dt` at `--ink-faint`, so the label recedes and the values do not. This costs nothing structurally and is the single cheapest change on this list.

### 5. At the moment of the press, the product stops speaking

- **Severity:** moderate
- **Where:** `src/app/login/page.tsx:106-129`; `src/app/globals.css:2311-2325`
- **Cost:** The only control on the app's only public screen is a 270x45 white pill in CCP's typography and CCP's corner radius, preceded by 2rem of empty space and no word of the product's own — so the last thing a stranger reads before committing is a vendor asset.
- **Principle:** DESIGN.md Visual Theme, "paper, ink, and rules"; brand.md, "communicate, not transact"
- **Fix:** The asset itself is not negotiable, and the self-hosting and white-cut reasoning in the docblock is right and should not be touched. What is missing is the frame. The page's own imperative — "Sign in with any EVE character" — is currently the *first* clause of the densest paragraph on the screen, about 140px above the button and read before all the disclosure copy rather than at the point of action. Either promote that sentence out of `.launch__disclosure-note` into its own line directly above `.launch__action`, or add a short `--track-furniture` mono line in the system's own voice immediately above the button. One line is enough for the panel to be the thing making the offer instead of merely hosting someone else's button.

### 6. The corp's own mark loses the load race to CCP's button

- **Severity:** moderate
- **Where:** `src/app/login/page.tsx:48-54` vs `:122-128`; `src/app/globals.css:2223-2246`
- **Cost:** On a cold load the 81KB emblem fetches at default priority while the 2.2KB vendor PNG is marked `fetchPriority="high"`, so the 620ms `seal-settle` animation — the only entrance motion in the entire system — routinely plays against an empty 180px box and the brand's identity mark pops in afterwards, unanimated.
- **Principle:** PRODUCT.md principle 5, "earn the artwork"
- **Fix:** `emblem.webp` is 81,694 bytes and `hero.webp` (the CSS background) is another 47,616, both on the critical path; the button is 2,248. Give the seal `fetchPriority="high"` too, or add a `<link rel="preload" as="image">` for `brand.sealUrl`. The button's high priority is defensible on its own (it is the action), but the current ordering means the one thing principle 5 exists to protect is the one thing that arrives late and skips its own animation. This is not visible in dev and would not have shown up in any local read; it is worth confirming on a throttled profile before and after.

### 7. `.launch__foot` invents a sixth type size and forces operator prose to caps

- **Severity:** minor
- **Where:** `src/app/globals.css:2327-2336`
- **Cost:** The credit line is set at 10px, uppercase, 0.12em tracked, in the faintest ink, at weight 400 — the least readable configuration available in the system — and it renders arbitrary text an operator typed.
- **Principle:** DESIGN.md Scale table (five steps, no 0.625rem); DESIGN.md label register weight rule; brand.md, "all-caps body copy" ban
- **Fix:** Four separate small breaks in one six-line rule. `font-size: 0.625rem` is off the declared scale entirely (`--t-label` is 0.6875rem). `letter-spacing: 0.12em` is `--track-label` spelled as a number, in a file whose whole point is that those numbers are tokenised. No `font-weight`, so it renders 400 where everything else that looks like this renders 600 — the identical class of defect DESIGN.md names for `.st`. And `text-transform: uppercase` is applied to a free-text environment variable: the reference value (`Est. MMXXV · [<TICKER>]`, `docs/ops.md:836`) survives it, but any fork writing a sentence there gets a caps ribbon. Take `--t-label` and `--track-furniture` (it is mission furniture), declare `font-weight: 600`, and drop the `text-transform` so the operator's own casing renders.

### 8. The seal's alt text duplicates the `h1` directly below it

- **Severity:** minor
- **Where:** `src/app/login/page.tsx:48-55`; compare `src/app/_components/ui.tsx:109`
- **Cost:** A screen-reader user entering the page hears the corp name twice in a row, as "Zoo Landers emblem" followed by "heading level 1, Zoo Landers", before reaching anything that tells them what the screen is for.
- **Principle:** none (WCAG 1.1.1 is satisfied either way)
- **Fix:** PRODUCT.md's "the seal used as identity carries a real name" is the argument here, and it is right where it was written for — a mark with no adjacent text. This is the other case: the `h1` supplies the name immediately after, which is precisely why `SiteHeader` gives its mark `alt=""` and lets the adjacent `.shell__wordmark` speak. The login seal should do the same. Note this only holds because the `h1` is present and carries `brand.name`; if finding 2 is resolved by changing what the heading says, re-check this.

### 9. `BRAND_NAME` is operator input rendered at 40 to 64px with no wrap guard

- **Severity:** minor
- **Where:** `src/app/login/page.tsx:55`; `src/app/globals.css:2248-2252`, `:67-69`
- **Cost:** A fork whose name is longer than about eleven characters gets a three-line title block on desktop, and a single long unbroken token overflows a panel whose parent sets `overflow: hidden`, so it is clipped rather than scrollable.
- **Principle:** PRODUCT.md accessibility, "usable to 200% zoom and down to 320px width"
- **Fix:** `--t-display` is `clamp(2.5rem, 6vw, 4rem)`, and 6vw only exceeds the 2.5rem floor above a 667px viewport, so every phone renders the name at a fixed 40px in a roughly 256px box regardless of length. `text-wrap: balance` handles the multi-word case gracefully; the unhandled case is a single long token. Add `overflow-wrap: anywhere` to `.launch__title` — `.launch__scopes dd` already makes exactly this argument for exactly this reason. The reference deployment's own name is short and this will never fire for it, which is why it is minor and why it will only ever be discovered by a fork.

## What is good and must survive

- **The `dd`-per-scope structure and its `overflow-wrap: anywhere`.** A later pass "tidying" this into one space-joined string undoes a documented fix. Finding 4 changes only the colour of these; the structure is correct.
- **The unconditional `<Notice>` in slot mode.** This page is the reference implementation of the primitive's intended use. `/account:231` still uses the `{message && ...}` form the docblock argues against, so a future consistency pass could easily "align" login *downward*. It must not.
- **Per-code tone (`loginErrorTone`).** A cancelled sign-in and an expired cookie rendering as `info` rather than `bad` is principle 4 working on the surface where it matters most, and the reasoning about not leaving an empty assertive region on the front door is genuinely subtle. Do not collapse this to `tone="bad"`.
- **`.launch__action` as `inline-block`.** The comment enumerates three separate bugs the block form caused (focus ring outlining a 414px strip, dead clickable space, no observable hover). Finding 5 adds a line *above* this element and must not touch its display or margins.
- **The disclosure's left alignment inside a centred panel.** It is the one asymmetry on the screen and it is what stops the prose reading as a slogan.
- **The registration ticks and the 7% lander.** Two devices, each used exactly once in the system. They are most of why this does not read as generated, and they are the first things a "consistency" pass would either delete or start repeating elsewhere. Both would be wrong.
- **The `.launch__title` display step.** The comment recording that this was 1.5rem, smaller than the `h1` on an admin table, is worth keeping attached to the rule.

## Could not evaluate

- **Whether the seal actually loses the load race in production.** Finding 6 is derived from file sizes and the absence of a priority hint, not observed. A throttled trace on the deployed app would settle it in a minute; screenshots and a dev server are out of scope for this sweep.
- **The rendered weight of the panel against the lander at 7%.** Whether the field reads as "an object on an empty field" or as "a box centred on nothing" depends on how much of `hero.webp` is actually visible at that opacity behind a panel occupying the centre of the viewport, which the source cannot tell me. If the answer is "nothing is visible", the composition collapses to a centred stack in a bordered box, which is the one generic move available here.
- **The reference deployment's actual `BRAND_MOTTO` and `BRAND_FOOTER`.** Neither is in the repo; the e2e spec uses placeholders and `docs/ops.md` documents the shape. Whether the deadpan lands rests almost entirely on the motto, and I judged the container rather than the joke.

## Contested

Nothing on the settled list. One adjacent note: DESIGN.md calls the corner marks "print register marks", and real registration marks are crosshairs in the bleed rather than corner brackets. The device is right for this panel and I am not proposing to change it. The name is slightly off, and it matters only because "registration ticks" is the phrase a future contributor will search for when they want to add a fifth one somewhere it does not belong.
