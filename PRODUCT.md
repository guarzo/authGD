# Product

## Register

product

## Users

Members of **Zoo Landers** (ticker FlyGD), a small EVE Online corporation. Two roles,
very different sessions:

- **Members** (most people, a few times a month). They arrive because something needs
  attention: a new alt to link, a token that went stale, a Discord role that never
  showed up. The session is short and interruptive — they are alt-tabbed out of a
  game, often late at night, often minutes before a fleet forms. They want to confirm
  state and leave.
- **Admins** (2–4 people, weekly). They work the accounts table: setting tiers,
  marking people cryo/AFK, reading the audit log, kicking a sync when something looks
  wrong. Their session is scanning-heavy — many rows, looking for the one that is off.

Neither group wants to learn this tool. It sits between them and playing.

## Product Purpose

Replace an Alliance Auth install with something the corp actually uses: EVE SSO login,
alt linking, and automatic distribution of membership state to three places — in-game
contacts (standings), the Wanderer map ACL, and Discord roles.

Success is being boring and trustworthy. A member links an alt and the right things
happen without anyone asking in chat. An admin can answer "why is this person's role
wrong?" from the audit log in under a minute. Nobody has to think about the tool.

The core promise is **derole, don't boot**: leaving the alliance drops your tier but
keeps your account, characters, tokens, and Discord link intact. The UI must never
make a state change feel like a punishment or a deletion.

## Brand Personality

**Deadpan, precise, warm underneath.**

The corp's identity is a joke told with a completely straight face: a NASA mission
patch reading *"Center for Kids Who Can't Fly Good"* — Zoolander, rendered as
hand-inked cartoon animals in a lunar lander. The humor works because the patch is
drawn with real craft and real gravity.

The interface takes the same position. The chrome behaves like flight-operations
instrumentation: dense, ruled, monospaced where data lives, never cute at the user's
expense. The joke lives in the artwork, the mission-patch furniture, and dry
microcopy — never in the controls. A tool that plays it straight is funnier, and more
usable, than one that winks in every label.

Voice: terse, factual, lowercase-technical for data, sentence-case for prose. States
what is true. Never exclaims. Never apologizes twice.

## Anti-references

- **Alliance Auth and the EVE third-party tool genre at large.** Bootstrap panels,
  bright primary buttons, dense grey admin chrome, "Django admin with a hat on."
  This is the incumbent being replaced; looking like it defeats the point.
- **Neon sci-fi HUD.** Cyan-on-black, angular clipped corners, glow, scanlines,
  faux-holographic panels. The first reflex for anything space-adjacent, and the
  reason every EVE tool looks the same.
- **Generic dark SaaS.** Rounded card grid on `#0a0a0a`, violet-to-blue gradients,
  glassmorphism, a hero metric with a big number and a small label.
- **Cartoon-forward UI.** The artwork is beloved and must not be diluted by
  restating it in every button and border. It appears deliberately, at full
  strength, in a few places.

## Design Principles

1. **Play it straight.** The instrument is serious so the joke can land. Comedy goes
   in the art and the copy, never in the controls or the data.
2. **State before action.** Every screen answers "what is true right now?" before it
   offers anything to press. A member should be able to leave without clicking.
3. **Scanning is the primary act.** Admin surfaces are read far more than they are
   operated. Optimize for the eye moving down a column and catching the one wrong
   value, not for the beauty of a single row.
4. **Nothing reads as punishment.** Green tier, cryo status, and a dead token are
   ordinary states, not failures. Reserve alarm colour for things the user can and
   should fix.
5. **Earn the artwork.** Faoble's illustrations appear at full size and full quality
   or not at all. No cropping into decoration, no tinting into wallpaper.

## Accessibility & Inclusion

- **WCAG 2.2 AA.** All text meets 4.5:1 against its background; large display text
  and UI boundaries meet 3:1.
- **Never colour alone.** Tier, token health, Discord link, and map presence all
  carry a text or glyph label in addition to any colour. The palette is checked
  against deuteranopia and protanopia, where the gold/blue/green tier set stays
  distinguishable by lightness as well as hue.
- **`prefers-reduced-motion`** is honoured globally; all transitions collapse.
- **Keyboard first.** Every control is reachable and has a visible focus ring with
  3:1 contrast against both its own background and the adjacent surface. Focus is
  never suppressed.
- **Zoom and reflow.** Usable to 200% zoom and down to 320px width without
  horizontal scrolling of the page. Wide data tables scroll within their own region,
  which is focusable and labelled.
- Artwork is decorative and carries empty `alt`; the seal used as identity carries a
  real name.
