# audit — /login

## Findings

### 1. The bounce-back reason is visible but never announced, and the only focusable control does not carry it

- **Severity:** serious
- **Where:** `src/app/login/page.tsx:78`, `src/app/_components/ui.tsx:267-292`, `src/lib/error-redirects.ts:88-101`
- **Cost:** A member whose sign-in link expired is redirected to `/login`, tabs once to reach the only control on the page, hears nothing about why they are back here, and presses the same button that just failed.
- **Principle:** none (the mechanism does not do the job it was built for; WCAG 4.1.3 does not cover it because this is a document load, not a status change)
- **Fix:** `Notice`'s slot mode is built for a live region that is registered before its text arrives, and `error-redirects.ts:95` already concedes the region is "inert in practice, since this page only ever fills that slot by a full navigation." That concession is the whole finding: `/login` is only ever reached by `redirect()` / `NextResponse.redirect`, so the region and its text arrive in the same parse, and AT does not announce a live region that is already populated at load. On this one surface the message has to reach the user through the control instead of through a region. Wrap the `Notice` in `<div id="login-reason">` and put `aria-describedby="login-reason"` on the `<a className="launch__action">`. No change to the primitive is needed (the description is computed from the wrapper's subtree, and an empty slot contributes no text, so an ordinary visit announces nothing extra). Keep the slot and the tone split exactly as they are; this is additive.

### 2. The scope list, the one thing on the page that exists for the consent moment, is the one thing a member cannot read

- **Severity:** serious
- **Where:** `src/app/login/page.tsx:92-104`, `src/app/globals.css:2279-2308`
- **Cost:** A member deciding whether to hand authGD their character reads `esi-characters.read_contacts.v1`, `esi-characters.write_contacts.v1`, `esi-ui.open_window.v1` and learns nothing they could act on, three lines below a paragraph that explains the same grant in plain English.
- **Principle:** PRODUCT.md principle 2, "State before action" — the screen has to answer what is true before it offers something to press
- **Fix:** Invert the `<dl>` so it carries the mapping instead of a heading. `dt` becomes the scope identifier, `dd` becomes the one sentence it buys ("read the contacts on your characters", "add, update and remove contacts under the `{label}` label", "open the in-game window when authGD sends you somewhere"), from a lookup keyed on the identifier with a fallback of no `dd` for a scope the map does not know. Move "Scopes requested" to a `<p>` above the list carrying `.launch__scopes-head` with the register's type, so the label register keeps its member. This preserves everything the docblock at `page.tsx:95-99` argues for (one row per scope, real boundaries, no space-joined blob) and it makes the `<dl>` semantically honest at the same time: today a screen reader announces each identifier as a *definition of* "Scopes requested" four times over, which is the wrong relationship. Keep `overflow-wrap: anywhere` on the identifier.

### 3. The LCP element is the one image on the page with no priority, while the 2.2 KB one is boosted

- **Severity:** moderate
- **Where:** `src/app/login/page.tsx:48-54` and `122-128`, `src/app/globals.css:2223-2246`
- **Cost:** Every visitor watches an empty 180px box above the corp name while an 82 KB seal downloads behind an explicitly-prioritised 2.2 KB button mark, and the 620ms `seal-settle` entrance has usually finished playing on that empty box before the artwork arrives, so the seal pops in with no settle at all.
- **Principle:** PRODUCT.md principle 5, "earn the artwork" — an entrance the artwork misses is worse than no entrance
- **Fix:** Three parts, all small. (a) `fetchPriority="high"` belongs on the seal: at 180x180 (132x132 under 40rem) it is the largest paint candidate on this page, larger than the display-size `h1` at every viewport, and `/brand/emblem.webp` is 81,694 bytes against the button's 2,248. Move it, do not duplicate it, or neither is prioritised. (b) Emit a real preload so the fetch starts from the head rather than after body parse: `preload(brand.sealUrl, { as: "image", fetchPriority: "high" })` from `react-dom` at the top of the component. `BRAND_SEAL_URL` can point off-origin in a fork, which makes this more valuable, not less. (c) The docblock at `page.tsx:44-47` names the missing 1x srcset entry as a real cost paid deliberately to keep the encode untouched. That trade is not forced: `srcset="/brand/emblem-256.webp 256w, /brand/emblem.webp 512w" sizes="180px"` adds the 1x entry without re-encoding the 512 source at all, only cutting one new derivative. A 1x phone currently pulls 82 KB to draw 132 CSS px, a 3.9x oversample.

### 4. A long corp name is clipped by `overflow: hidden` with no way to scroll to the rest

- **Severity:** moderate
- **Where:** `src/app/globals.css:2169-2176` and `2248-2251`
- **Cost:** A fork whose `BRAND_NAME` is one unbroken word ("TheBigRedFleetCoalition") sees it cut off mid-word on a phone, on the page whose entire job is to say whose auth this is, with no horizontal scroll available to recover it.
- **Principle:** WCAG 1.4.10 Reflow (content lost at 320px)
- **Fix:** `.launch__title` inherits `overflow-wrap: normal`, so an unbroken token overruns the panel, and `.launch` carries `overflow: hidden` (there for `::before`, correctly) which clips the overrun instead of letting the page scroll to it. At 320px the content box is 256px and `--t-display` floors at 2.5rem, so ~14 unbroken characters is the ceiling. Add `overflow-wrap: anywhere` to `.launch__title` and `.launch__motto`, exactly as `.launch__scopes dd` already does at `globals.css:2295-2308` for the same reason. This is not hypothetical for this repo: PRODUCT.md and DESIGN.md both open by telling forks to rebrand, and `BRAND_NAME` takes any `z.string()`.

### 5. The one control on the page does not grow when the user makes text bigger

- **Severity:** minor
- **Where:** `src/app/globals.css:2311-2325`, `src/app/login/page.tsx:122-128`
- **Cost:** A member running a 24px default font size, or Firefox's zoom-text-only, gets a panel and body copy that scale with the setting and the same 270x45 button they had before, so the sole action ends up visually smaller relative to everything around it at exactly the setting chosen by people who need it larger.
- **Principle:** none (page zoom satisfies 1.4.4; this is the text-only path, which is not a conformance failure)
- **Fix:** The mark itself cannot grow without upscaling a raster CCP publishes at 270, but the target can. Add `padding: var(--s-2) var(--s-3)` to `.launch__action`. The spacing scale is rem-based, so the hit area tracks the root size; the padding is static so the box does not resize under the pointer, which is the concern the docblock at `globals.css:2310` raises about the hover border, and the existing transparent border still holds the hover geometry.

### 6. `.launch__foot` is the only type on the surface that is off the scale and off the register

- **Severity:** minor
- **Where:** `src/app/globals.css:2327-2336`
- **Cost:** The smallest text in the product renders at a size no token declares, so a future scale change moves everything on the page except the footer.
- **Principle:** DESIGN.md label register ("one style, declared once")
- **Fix:** `font-size: 0.625rem` is 10px, below `--t-label`'s 11px and outside the scale table entirely; `letter-spacing: 0.12em` is `--track-label` written as a raw number. The register comment at `globals.css:217-249` enumerates thirteen sites and argues three out by name, and `.launch__motto` is separately argued out at `globals.css:511-518` as running masthead rather than label. `.launch__foot` appears in neither list, so it is unaccounted for rather than deliberately excluded. Either fold it into the register selector list and drop its own family/size/case, or, if 10px is wanted for fine print, declare it as a token and say in a comment why the scale gets a fourteenth size.

### 7. The seal's alt text repeats the `h1` immediately below it

- **Severity:** minor
- **Where:** `src/app/login/page.tsx:48-55`
- **Cost:** A screen reader reads "Zoo Landers emblem, heading level one, Zoo Landers" on the app's front door.
- **Principle:** PRODUCT.md Accessibility ("Artwork is decorative and carries empty `alt`; the seal used as identity carries a real name")
- **Fix:** The repo's own precedent is `ui.tsx:109`, where the header mark takes `alt=""` precisely because `.shell__wordmark` names the corp beside it. `/login` has the same adjacency with a stronger text carrier (`<h1>{brand.name}</h1>` on the next line). The principle's "seal used as identity carries a real name" is about the case where the seal is the only carrier, which is not this one. Set `alt=""`.

## What is good and must survive

- **Every text pair on this surface clears AA against its real ground, including the underlay.** Computed against the composited panel (88% `--hull` over `--void` plus the 7% hero): `--ink` title 14.75:1, `--ink-dim` disclosure prose 8.79:1, `--ink-faint` motto / `dt` / `dd` / footer 5.65:1, `--ink` on the bad-notice tint 12.89:1, and the notice border at 3.77:1 against the panel. Pushing the hero underlay to a worst-case pure-white line moves `--ink-faint` only to 5.54:1. Nothing here is close to the floor and nothing should be darkened to "quiet it down".
- **The `img { max-width: 100%; height: auto }` pairing at `globals.css:137-149`.** Its comment names this page's SSO button at 200% zoom on 375px as the measured worst case, a 55% horizontal crush. Removing `height: auto` or the `max-width` re-breaks it, and the seal's fixed box survives only because `.launch__seal` sets both axes from a class and outranks the reset.
- **`.launch__action` as `inline-block`, and the transparent resting border.** `globals.css:2300-2325` documents that the block form outlined a 414px strip on focus, made dead space clickable, and left the product's only entry control with no observable hover. Both properties are load-bearing.
- **The reduced-motion path on `seal-settle` is correct and easy to break.** The global collapse at `globals.css:206-215` sets `animation-duration: 0.01ms`, and because the keyframe runs `opacity: 0 -> 1` with `animation-fill-mode: both`, the fill state is the visible end frame. Reversing the keyframe direction, or dropping `both`, would freeze the seal invisible for reduced-motion users.
- **`loginErrorTone`'s refusal to put `role="alert"` on an empty region** (`error-redirects.ts:88-101`) and the `scopes.length > 0` guard (`page.tsx:92`). Both are the right call and both are the kind of thing a cleanup pass deletes as redundant.
- **Dimension read:** accessibility 3, performance 2, responsive 3, theming 3, anti-patterns 4. No AI tells: the registration ticks, the hairline-and-type structure, the 0.07 underlay and the single 2px radius are a committed, specific system, and the one card on the surface is the documented exception rather than a reflex.

## Could not evaluate

- **Whether the seal actually wins LCP in the field.** I computed it from geometry (180x180 = 32,400 px² against a balanced `h1` at `--t-display`, roughly 22,000 px² at 1000px viewport and under 10,000 at 375px), not from a trace. A field measurement, or a single Lighthouse run against a deployed build, would settle finding 3's premise. The priority inversion in that finding stands either way: an 82 KB in-viewport image at default priority behind an explicitly-boosted 2.2 KB one is wrong regardless of which element is named LCP.
- **Whether Next still injects the default `width=device-width, initial-scale=1`** when `layout.tsx:51-54` exports a `viewport` object carrying only `themeColor` and `colorScheme`. `node_modules` is not installed in this worktree so I could not read the metadata resolver. If the defaults do not merge, every reflow judgement in this report is moot because the page would render at desktop width on a phone. One `curl` against a running build, grepping the emitted `<meta name="viewport">`, settles it.
- **Whether the CCP legal attribution is required on this page and, if so, where it goes.** `.launch__foot` is the obvious home and `BRAND_FOOTER` defaults to empty (`config.ts:131`), so the reference deployment's front door renders no notice unless an operator sets one. I do not know CCP's current third-party terms well enough to call this a defect, but it is worth someone checking, since this is the page that shows CCP's own SSO mark.
- **How the panel composition reads once the seal is 132px and the title is at its 2.5rem floor.** That is a critique question, not an audit one, and it needs eyes on a render.

## Contested

Nothing on the settled list looks wrong from this surface. Two notes rather than objections. First, the `<img>` decision is better defended than the docblock claims: `BRAND_SEAL_URL` is arbitrary config, so `next/image` would need `remotePatterns` for every fork, which is a stronger argument than the quality-75 re-encode and is not written down. Second, the settled item "`/login` uses `<img>` rather than `next/image`, twice, with reasons" is not in tension with finding 3 — `srcset`, `fetchPriority` and `rel=preload` are all plain-HTML mechanisms and none of them reopens the `next/image` question.
