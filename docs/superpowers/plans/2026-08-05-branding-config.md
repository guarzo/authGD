# Branding and tier-label configuration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every corp-specific **string** in the running UI come from
configuration, so a fresh clone shows generic vocabulary and this deployment
restores "Zoo Landers / FlyGD / Blue / Green" from its own secrets.

**Images are deliberately not fully configurable, and the goal does not claim
they are.** The spec's revised artwork decision keeps Faoble's artwork in the
repo under a credit-required grant, so the shipped default images still depict
this corp. Only the header mark and the login emblem take URLs
(`BRAND_MARK_URL`, `BRAND_SEAL_URL`); the login background and the account
illustration are referenced directly from CSS and JSX, and replacing the file
is the only route for them. This PR renames all four by role so a forker can
tell what to swap; PR3 documents the swap. A fresh clone therefore shows
generic *text* over this corp's *art* until the operator replaces the files —
an accepted exception, not an oversight.

**Architecture:** Two config groups (`TIER_LABEL_*`, `BRAND_*`) parsed in
`src/config.ts`. Tier label resolution splits across the purity boundary: a pure
`resolveTierLabel()` in `src/core/`, a server-only `tierLabel()` wrapper in the
app layer. Brand values reach the one client boundary that needs them through a
React context provider mounted in the root layout.

**Tech Stack:** Next.js 16 App Router, zod, React context, Vitest, Playwright.

This is PR2 of `docs/superpowers/specs/2026-08-04-open-source-de-branding-design.md`.
PR1 (tier enum rename) shipped as #103.

## Global Constraints

- Defaults are generic: a clone with no `TIER_LABEL_*`/`BRAND_*` set shows
  `Member / Associate / Alumni / Pending` and `authGD`. No corp vocabulary is
  a default value anywhere in the published source.
- Every new env var is **optional with a default** and cannot fail startup.
  `DISCORD_ROLE_ID_*` stay required; nothing about their validation changes.
- `src/core/` stays pure — no `getConfig()`, no `process.env`, no DB.
- E2E specs assert against the **default** labels, never this deployment's, so
  the suite never depends on secrets being set.
- `audit_log` history is not migrated and not aliased (spec D4). Legacy
  `flygd`/`blue`/`green` strings in audit details render verbatim.
- Migrations: none. This PR touches no schema.
- Never claim a command passed without running it and quoting the output.

## Design decisions this plan settles

**D11 — `SiteHeader` takes brand as props; *both* client boundaries read context.**

The spec (D10) provides a context provider so `error.tsx` can render its
hoisted `<title>`. Inspection found two consumers the spec did not anticipate,
both of which render `SiteHeader` from a client bundle:

- `src/app/error.tsx:7,150` — the error boundary, client by App Router
  requirement.
- `src/app/_components/admin-nav.tsx:1,4` — `AdminNav`, `"use client"` because
  it reads `usePathname()` for the active tab. It renders `SiteHeader` on
  **every admin page**, so a props-only fix would leave the admin header
  reading `authGD / Auth` while every other page read the configured name.

React Server Components cannot read context, so "SiteHeader reads the provider"
would force `ui.tsx` client-side wholesale. Instead:

- `SiteHeader` gains optional `brandName` / `brandTagline` / `brandMarkUrl`
  props, defaulting to the generic values. Server callers pass
  `getConfig().brand`.
- Both client callers call `useBrand()` and pass the values down as props.

`AdminNav`'s only caller is the server component `admin/layout.tsx:18`, so it
could take props instead — but `error.tsx` has no server parent and must use
the hook regardless. One mechanism on the client side beats two.

**The context carries `markUrl`, not just `{name, tagline}`.** The spec's D10
named only the two strings it needed for the `<title>`. Without the third, both
client-rendered headers would ignore `BRAND_MARK_URL` and hardcode
`/brand/mark.webp` — a configured deployment showing its mark on most pages and
the default on every admin page.

**D12 — `Tier` moves to its own `server-only` module, and unit tests get an env seam.**

`Tier` must resolve a configured label, which means reading config, which means
`server-only`. But `ui.tsx` is imported by both client boundaries above, so
adding a transitive `server-only` dependency to it poisons their bundles —
deterministically, and regardless of whether they import `Tier` by name, since
`server-only` fails at module resolution rather than at use.

So `Tier` and `TierName` move to `src/app/_components/tier.tsx` from the
outset. `ui.tsx` keeps `SiteHeader`, `Notice`, `RuleHead`, `Status` and stays
client-importable. Four modules import `Tier` and update their import path:
`account/standing.tsx`, `account/page.tsx`, `admin/accounts/page.tsx`,
`payouts/page.tsx`.

That alone is not enough. `tests/account-page.test.ts:215` renders
`StandingTier` with `renderToStaticMarkup` in plain Vitest, and `StandingTier`
renders `<Tier>` (`account/standing.tsx:1,37`). Once `Tier` calls
`getConfig()`, that test throws on the **required** vars — `DATABASE_URL`,
`TOKEN_ENCRYPTION_KEY` and the rest — long before any label default matters.

The seam is a Vitest `setupFiles` entry that seeds `process.env`. It is not a
new fixture: `tests/helpers/config.ts` already holds exactly this env block for
`testConfig()`. Task 6 extracts that block to `tests/helpers/env.ts` as
`BASE_ENV`, has `testConfig()` spread it, and has the setup file assign it — so
the two paths cannot drift.

A `label` prop on `Tier` was the alternative and is rejected: it puts the
resolution at every call site, so a missed one renders `alumni` where the
deployment configured `Green`, silently and only in production.

## File Structure

**Create:**

- `src/core/tier-labels.ts` — pure `resolveTierLabel(tier, labels)`.
- `tests/tier-labels.test.ts` — its unit tests.
- `src/app/_components/labels.ts` — server-only `tierLabel(tier)` wrapper.
- `src/app/_components/tier.tsx` — server-only `Tier` badge and `TierName`,
  moved out of `ui.tsx` (D12).
- `src/app/_components/brand-context.tsx` — `"use client"` provider +
  `useBrand()` hook, carrying `{name, tagline, markUrl}`.
- `tests/helpers/env.ts` — `BASE_ENV`, the shared unit-test environment.
- `tests/helpers/setup-env.ts` — the `setupFiles` hook that applies it.
- `e2e/branding.spec.ts` — the five render paths a brand string reaches the
  DOM by.

**Modify:**

- `src/config.ts` — `TIER_LABEL_*` and `BRAND_*` schema entries; `tierLabels`
  and `brand` on the returned object.
- `vitest.config.ts` — `setupFiles` seeding `process.env` from `BASE_ENV`.
- `tests/helpers/config.ts` — `testConfig()` spreads `BASE_ENV`.
- `src/app/layout.tsx` — static `metadata` → `generateMetadata()`; mount the
  brand provider.
- `src/app/error.tsx` — `useBrand()` for the `<title>` and the `SiteHeader`.
- `src/app/_components/admin-nav.tsx` — `useBrand()`, passed to `SiteHeader`.
- `src/app/_components/ui.tsx` — `SiteHeader` brand props; `Tier` removed.
- `src/app/account/standing.tsx`, `src/app/account/page.tsx`,
  `src/app/admin/accounts/page.tsx`, `src/app/payouts/page.tsx` — `Tier`
  import path.
- `src/app/login/page.tsx` — name, motto, footer, emblem alt and URL from config.
- `src/app/admin/audit/summarize.ts` — accept `labels`, resolve tier values.
- `src/app/admin/audit/page.tsx` — pass `getConfig().tierLabels` to `summarize`.
- `src/app/globals.css` — background URL rename; de-brand the file header comment.
- `src/app/account/page.tsx` — illustration URL rename.
- `.env.example` — document all ten new vars.
- `docs/ops.md` — the two PR1 runbook gaps, plus the PR2 deploy note.
- `playwright.config.ts` — non-default `BRAND_*` / `TIER_LABEL_*` in the
  dev-server env, so the suite proves config is read (Task 7).
- E2E specs asserting `· Zoo Landers` titles.

**Rename (git mv, `public/brand/`):**

| Now | Becomes |
| --- | ------- |
| `seal-sm.webp` | `mark.webp` |
| `seal.webp` | `emblem.webp` |
| `lander.webp` | `hero.webp` |
| `lander-moon.webp` | `hero-account.webp` |

`eve-sso-login-white-large.png` is CCP's and keeps its name.

---

### Task 1: Pure tier-label resolution

**Files:**
- Create: `src/core/tier-labels.ts`
- Test: `tests/tier-labels.test.ts`

**Interfaces:**
- Produces: `resolveTierLabel(tier: string, labels: Record<string, string>): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveTierLabel } from "@/core/tier-labels";

const LABELS = {
  member: "FlyGD",
  associate: "Blue",
  alumni: "Green",
  pending: "Pending",
};

describe("resolveTierLabel", () => {
  it("returns the configured label for a known tier", () => {
    expect(resolveTierLabel("member", LABELS)).toBe("FlyGD");
    expect(resolveTierLabel("associate", LABELS)).toBe("Blue");
    expect(resolveTierLabel("alumni", LABELS)).toBe("Green");
    expect(resolveTierLabel("pending", LABELS)).toBe("Pending");
  });

  // Pre-rename audit rows store the old vocabulary verbatim (spec D4) and
  // reach this function as plain strings with no entry in the label map.
  it("returns the raw string for a legacy tier value", () => {
    expect(resolveTierLabel("flygd", LABELS)).toBe("flygd");
  });

  it("returns the raw string for anything else unrecognised", () => {
    expect(resolveTierLabel("", LABELS)).toBe("");
    expect(resolveTierLabel("nonsense", LABELS)).toBe("nonsense");
  });

  // An empty configured label would render a blank badge, which reads as a
  // rendering bug rather than as configuration. Fall back to the raw value.
  it("falls back to the raw value when the configured label is empty", () => {
    expect(resolveTierLabel("member", { ...LABELS, member: "" })).toBe("member");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/tier-labels.test.ts`
Expected: FAIL — cannot resolve `@/core/tier-labels`.

- [ ] **Step 3: Implement**

```ts
/**
 * Display label for a tier, or the raw value when there is nothing better.
 *
 * Deliberately takes `string`, not `Tier`. Pre-rename `audit_log.details` rows
 * store `flygd`/`blue`/`green` verbatim and are never migrated (spec D4), so
 * historic values reach this function that the enum no longer contains. They
 * render as themselves rather than as a blank or a thrown error — a data
 * artefact stays visibly a data artefact.
 *
 * Pure: `src/core/` reads no config. The label map is supplied by the caller.
 */
export function resolveTierLabel(tier: string, labels: Record<string, string>): string {
  const label = labels[tier];
  return label && label.length > 0 ? label : tier;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/tier-labels.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Format and commit**

```bash
npm run format:check
git add src/core/tier-labels.ts tests/tier-labels.test.ts
git commit -m "feat(core): resolve tier display labels from a supplied map"
```

---

### Task 2: Configuration schema

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.tierLabels: Record<Tier, string>` and
  `config.brand: {name, tagline, motto, footer, markUrl, sealUrl}`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`, following the file's existing helper style:

```ts
describe("branding and tier labels", () => {
  it("defaults to generic vocabulary when nothing is set", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.tierLabels).toEqual({
      member: "Member",
      associate: "Associate",
      alumni: "Alumni",
      pending: "Pending",
    });
    expect(cfg.brand.name).toBe("authGD");
    expect(cfg.brand.tagline).toBe("Auth");
    expect(cfg.brand.motto).toBe("");
    expect(cfg.brand.footer).toBe("");
    expect(cfg.brand.markUrl).toBe("/brand/mark.webp");
    expect(cfg.brand.sealUrl).toBe("/brand/emblem.webp");
  });

  it("takes the configured values when set", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      TIER_LABEL_MEMBER: "FlyGD",
      BRAND_NAME: "Zoo Landers",
      BRAND_MOTTO: "Center for kids\nwho can't fly good",
    });
    expect(cfg.tierLabels.member).toBe("FlyGD");
    // Unset siblings keep their generic defaults — labels are independent.
    expect(cfg.tierLabels.associate).toBe("Associate");
    expect(cfg.brand.name).toBe("Zoo Landers");
    expect(cfg.brand.motto).toBe("Center for kids\nwho can't fly good");
  });
});
```

Use whatever the file's existing valid-env helper is called; do not invent
`baseEnv()` if the file already has an equivalent.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `cfg.tierLabels` is undefined.

- [ ] **Step 3: Add the schema entries**

In the `envSchema` object, after `SYNC_MODE`:

```ts
  // Display only. The enum values are member|associate|alumni|pending and do
  // not change; these decide what a member reads. Optional with generic
  // defaults so a fresh clone carries no deployment's vocabulary, and
  // deliberately unvalidated beyond "is a string" — a corp's own tier names
  // are not ours to constrain.
  TIER_LABEL_MEMBER: z.string().default("Member"),
  TIER_LABEL_ASSOCIATE: z.string().default("Associate"),
  TIER_LABEL_ALUMNI: z.string().default("Alumni"),
  TIER_LABEL_PENDING: z.string().default("Pending"),

  BRAND_NAME: z.string().default("authGD"),
  BRAND_TAGLINE: z.string().default("Auth"),
  // Empty means "render nothing", not "render an empty element" — the login
  // page omits the node entirely. A newline is a line break; the login page
  // splits on it.
  BRAND_MOTTO: z.string().default(""),
  BRAND_FOOTER: z.string().default(""),
  BRAND_MARK_URL: z.string().default("/brand/mark.webp"),
  BRAND_SEAL_URL: z.string().default("/brand/emblem.webp"),
```

And in the returned object, after `syncMode`:

```ts
    tierLabels: {
      member: e.TIER_LABEL_MEMBER,
      associate: e.TIER_LABEL_ASSOCIATE,
      alumni: e.TIER_LABEL_ALUMNI,
      pending: e.TIER_LABEL_PENDING,
    },
    brand: {
      name: e.BRAND_NAME,
      tagline: e.BRAND_TAGLINE,
      motto: e.BRAND_MOTTO,
      footer: e.BRAND_FOOTER,
      markUrl: e.BRAND_MARK_URL,
      sealUrl: e.BRAND_SEAL_URL,
    },
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Document in `.env.example`**

Append, after the existing `STANDINGS_*` block:

```sh
# --- Branding (all optional; defaults are generic) -------------------------
# What members read for each tier. The database enum is always
# member|associate|alumni|pending; these are display only.
# TIER_LABEL_MEMBER=Member
# TIER_LABEL_ASSOCIATE=Associate
# TIER_LABEL_ALUMNI=Alumni
# TIER_LABEL_PENDING=Pending

# BRAND_NAME appears in the header wordmark, every page title, and image alt
# text. BRAND_TAGLINE is the smaller line beneath it.
# BRAND_NAME=authGD
# BRAND_TAGLINE=Auth
# Login page only. Both render nothing when empty. A newline in BRAND_MOTTO
# is a line break.
# BRAND_MOTTO=
# BRAND_FOOTER=
# Header mark (34px) and login emblem (180px). Replace the files in
# public/brand/ or point these at your own URLs. The login background
# (hero.webp) and account illustration (hero-account.webp) are referenced
# directly and can only be changed by replacing the files.
# BRAND_MARK_URL=/brand/mark.webp
# BRAND_SEAL_URL=/brand/emblem.webp
```

- [ ] **Step 6: Format and commit**

```bash
npm run format:check
git add src/config.ts tests/config.test.ts .env.example
git commit -m "feat(config): optional TIER_LABEL_* and BRAND_* with generic defaults"
```

---

### Task 3: Asset renames

**Files:**
- Rename: the four files under `public/brand/`
- Modify: `src/app/globals.css`, `src/app/account/page.tsx`,
  `src/app/_components/ui.tsx`, `src/app/login/page.tsx`

Done before the components change so the later diffs are logic, not paths.

- [ ] **Step 1: Rename**

```bash
git mv public/brand/seal-sm.webp public/brand/mark.webp
git mv public/brand/seal.webp public/brand/emblem.webp
git mv public/brand/lander.webp public/brand/hero.webp
git mv public/brand/lander-moon.webp public/brand/hero-account.webp
```

- [ ] **Step 2: Update the four references**

- `src/app/globals.css:1955` — `url("/brand/lander.webp")` → `url("/brand/hero.webp")`
- `src/app/account/page.tsx:589` — `src="/brand/lander-moon.webp"` → `src="/brand/hero-account.webp"`
- `src/app/_components/ui.tsx:106` — `src="/brand/seal-sm.webp"` → `src="/brand/mark.webp"`
- `src/app/login/page.tsx:49` — `src="/brand/seal.webp"` → `src="/brand/emblem.webp"`

The `login/page.tsx` comment above the image names `seal.webp` at line 43;
update that mention too.

- [ ] **Step 3: Verify nothing else points at the old names**

Run: `grep -rn "seal-sm\|seal\.webp\|lander\.webp\|lander-moon" src/ e2e/ tests/ public/`
Expected: no output. (Spec and plan documents under `docs/` legitimately name
them and are excluded.)

- [ ] **Step 4: Confirm the app still builds and the images resolve**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add -A public/brand src/app
git commit -m "refactor(brand): name the artwork by role rather than by corp"
```

---

### Task 4: Brand context and the two client boundaries

**Files:**
- Create: `src/app/_components/brand-context.tsx`
- Modify: `src/app/layout.tsx`, `src/app/error.tsx`,
  `src/app/_components/admin-nav.tsx`, `src/app/_components/ui.tsx`

**Interfaces:**
- Consumes: `getConfig().brand` from Task 2.
- Produces: `<BrandProvider value={{name, tagline, markUrl}}>`,
  `useBrand(): Brand`, and `SiteHeader`'s new optional `brandName` /
  `brandTagline` / `brandMarkUrl` props.

- [ ] **Step 1: Write the provider**

```tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Brand values for the two boundaries that cannot read config.
 *
 * `src/app/error.tsx` is a client component (App Router requires it) that
 * hoists its own `<title>` and renders `<SiteHeader>`. `AdminNav` is a client
 * component (it needs `usePathname()`) and renders `<SiteHeader>` on every
 * admin page. Neither can call `getConfig()`. A `NEXT_PUBLIC_` var would bake
 * the value at build time, which defeats configuration for anyone deploying a
 * prebuilt image, so the root layout reads config on the server and hands the
 * values down.
 *
 * `markUrl` is here and not just the two strings: both consumers render the
 * header, and without it a deployment that sets BRAND_MARK_URL would show its
 * own mark everywhere except the admin section and the error page.
 *
 * This is not the general route to brand config — server components take
 * `getConfig().brand` directly. It carries only what a client boundary needs.
 */
export type Brand = { name: string; tagline: string; markUrl: string };

const DEFAULT: Brand = {
  name: "authGD",
  tagline: "Auth",
  markUrl: "/brand/mark.webp",
};

const BrandContext = createContext<Brand>(DEFAULT);

export function BrandProvider({ value, children }: { value: Brand; children: ReactNode }) {
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/**
 * Falls back to the generic defaults rather than throwing when no provider is
 * above it. An error boundary is the worst place in the app to add a second
 * failure mode: a missing provider would replace the error page with a crash.
 */
export function useBrand(): Brand {
  return useContext(BrandContext);
}
```

- [ ] **Step 2: Mount it and generate metadata in the root layout**

Replace the static `metadata` export with:

```tsx
export async function generateMetadata(): Promise<Metadata> {
  const { brand } = getConfig();
  return {
    title: {
      default: `${brand.name} · ${brand.tagline}`,
      template: `%s · ${brand.name}`,
    },
    description: `Corporation auth for ${brand.name}.`,
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icon.png", type: "image/png", sizes: "512x512" },
      ],
      apple: "/apple-icon.png",
    },
  };
}
```

and wrap the body:

```tsx
export default function RootLayout({ children }: { children: ReactNode }) {
  const { brand } = getConfig();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <BrandProvider
          value={{ name: brand.name, tagline: brand.tagline, markUrl: brand.markUrl }}
        >
          {children}
        </BrandProvider>
      </body>
    </html>
  );
}
```

Add `import { getConfig } from "@/config";` and the provider import. The layout
now reads config at request time; add `export const dynamic = "force-dynamic";`
matching the convention `login/page.tsx:11` documents, so a Docker build with
no config env present does not fail.

- [ ] **Step 3: Give `SiteHeader` brand props**

In `_components/ui.tsx`, add to `SiteHeader`'s props:

```tsx
  /** Brand values. Defaulted so a caller that forgets them degrades to the
   *  generic names rather than crashing. Server callers pass
   *  `getConfig().brand`; the two client callers pass `useBrand()`. */
  brandName?: string;
  brandTagline?: string;
  brandMarkUrl?: string;
```

and render:

```tsx
          <img src={brandMarkUrl ?? "/brand/mark.webp"} alt="" width={34} height={34} />
          <span className="shell__wordmark">
            <b>{brandName ?? "authGD"}</b>
            <span>{brandTagline ?? "Auth"}</span>
          </span>
```

- [ ] **Step 4: Pass config from every server caller of `SiteHeader`**

Run: `grep -rn "SiteHeader" src/app` and give each **server-side** call site
`brandName`, `brandTagline` and `brandMarkUrl` from `getConfig().brand`.
`error.tsx` and `admin-nav.tsx` are the exceptions — Step 5.

Every call site must be updated. A missed one shows the generic name on that
page only, which is the failure mode Task 7's e2e is written to catch.

- [ ] **Step 5: Wire both client boundaries**

In `error.tsx`:

```tsx
  const brand = useBrand();
```

then `<title>{`Something broke · ${brand.name}`}</title>` and

```tsx
        <SiteHeader
          items={section.items}
          admin={section.admin}
          brandName={brand.name}
          brandTagline={brand.tagline}
          brandMarkUrl={brand.markUrl}
        />
```

Update the comment at line 144 that quotes `"Something broke · Zoo Landers"`
so it describes the mechanism without the corp name.

In `admin-nav.tsx`, the same three props on its `SiteHeader`, from `useBrand()`.

- [ ] **Step 6: Typecheck and build**

```bash
npm run typecheck
npm run build
```
Expected: both clean.

- [ ] **Step 7: Format and commit**

```bash
npm run format:check
git add src/app
git commit -m "feat(brand): title, wordmark and mark from config, via context at both client boundaries"
```

---

### Task 5: Login page from config

**Files:**
- Modify: `src/app/login/page.tsx`

- [ ] **Step 1: Read brand alongside the existing config read**

`const cfg = getConfig();` is already there at line 31. Add `const brand = cfg.brand;`.

- [ ] **Step 2: Replace the four hardcoded sites**

```tsx
        <img
          className="launch__seal"
          src={brand.sealUrl}
          alt={`${brand.name} emblem`}
          width={180}
          height={180}
        />
        <h1 className="launch__title">{brand.name}</h1>
        {/* Omitted entirely when unset rather than rendered empty: an empty
            <p> still occupies the stack's row gap, which reads as a missing
            image rather than as "this deployment has no motto". A newline in
            the value is a line break — the only formatting the field takes. */}
        {brand.motto && (
          <p className="launch__motto">
            {brand.motto.split("\n").map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </p>
        )}
```

and the footer:

```tsx
        {brand.footer && <p className="launch__foot">{brand.footer}</p>}
```

The `alt` text is derived from `BRAND_NAME` rather than configured separately —
one fewer var, and an emblem's alt has no information the name does not carry.

- [ ] **Step 3: Typecheck and build**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 4: Format and commit**

```bash
npm run format:check
git add src/app/login/page.tsx
git commit -m "feat(login): name, motto and footer from brand config"
```

---

### Task 6: Tier labels through the UI

**Files:**
- Create: `src/app/_components/labels.ts`, `src/app/_components/tier.tsx`,
  `tests/helpers/env.ts`, `tests/helpers/setup-env.ts`
- Modify: `src/app/_components/ui.tsx`, `vitest.config.ts`,
  `tests/helpers/config.ts`, `src/app/account/standing.tsx`,
  `src/app/account/page.tsx`, `src/app/admin/accounts/page.tsx`,
  `src/app/payouts/page.tsx`, `src/app/admin/audit/summarize.ts`,
  `src/app/admin/audit/page.tsx`
- Test: `tests/audit-summarize.test.ts`, `tests/account-page.test.ts`

**Interfaces:**
- Consumes: `resolveTierLabel` (Task 1), `config.tierLabels` (Task 2).
- Produces: `tierLabel(tier: string): string`; `Tier` and `TierName` from
  `@/app/_components/tier`.

Do the seam (Steps 1-3) **before** the component change. Otherwise the unit
suite is red in the middle of the task and every later failure is ambiguous.

- [ ] **Step 1: Extract the shared unit-test environment**

Create `tests/helpers/env.ts` holding the env block that
`tests/helpers/config.ts` currently inlines:

```ts
/**
 * The environment a unit test runs in.
 *
 * Two consumers, deliberately one definition: `testConfig()` spreads it to
 * build a Config object explicitly, and `vitest.config.ts` assigns it to
 * `process.env` via setupFiles so components that call `getConfig()` render
 * without each test knowing they do. `<Tier>` is the first such component —
 * see the plan's D12.
 *
 * No TIER_LABEL_* or BRAND_* entries: unit tests assert the generic defaults,
 * so leaving them unset is what proves the defaults exist.
 */
export const BASE_ENV = {
  /* the exact block currently in tests/helpers/config.ts */
} satisfies NodeJS.ProcessEnv;
```

Have `testConfig()` spread `BASE_ENV` rather than repeating it. Its
`SYNC_MODE: "live"` comment moves with the block — it is load-bearing.

- [ ] **Step 2: Seed it in `vitest.config.ts`**

Add a `setupFiles` entry assigning `BASE_ENV` onto `process.env` without
clobbering anything a test already set:

```ts
// tests/helpers/setup-env.ts
import { BASE_ENV } from "./env";
for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] ??= v;
```

`getConfig()` caches on first call, so this must run before any test module —
which is exactly what `setupFiles` guarantees.

- [ ] **Step 3: Run the existing unit suite unchanged**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_open_source_de_branding npm test
```
Expected: same pass count as before the task. The seam is inert until Step 5.

- [ ] **Step 4: The server-only wrapper**

```ts
import "server-only";
import { resolveTierLabel } from "@/core/tier-labels";
import { getConfig } from "@/config";

/**
 * Display label for a tier, using this deployment's configured names.
 *
 * `server-only`: it reads config, so importing it from a client component is a
 * build error rather than a runtime one. That guarantee is the reason `Tier`
 * lives in its own module — see the plan's D12.
 */
export function tierLabel(tier: string): string {
  return resolveTierLabel(tier, getConfig().tierLabels);
}
```

- [ ] **Step 5: Move `Tier` into its own module**

Create `src/app/_components/tier.tsx` and move `Tier` and `TierName` there
verbatim from `ui.tsx` (`ui.tsx:230-273`), keeping both doc comments. Add
`import "server-only";` and the `tierLabel` import, and replace the bare
`{tier}` child with `{tierLabel(tier)}`.

The `known` check and the tone classes keep using the **raw** `tier` value —
the CSS keys off the enum, not the label. A deployment that sets
`TIER_LABEL_MEMBER="FlyGD"` must still get `.tier--member`.

Then update the four importers to take `Tier` from the new path:
`account/standing.tsx:1`, `account/page.tsx`, `admin/accounts/page.tsx`,
`payouts/page.tsx`. Remove `Tier`/`TierName` from `ui.tsx`.

- [ ] **Step 6: Confirm the split held**

```bash
npm run typecheck
npm run build
```

The build is the real gate here: if `server-only` still reaches a client
bundle, it fails with a "This module cannot be imported from a Client
Component" error naming the chain. Expected: clean.

- [ ] **Step 7: Make `summarize` take labels**

`summarizeDetails` is pure and already takes `roleNames` as a parameter
(around line 168). Add a `labels: Record<string, string>` parameter in the same
style and resolve tier values through `resolveTierLabel`.

**Four renderers, not three.** `summarize.ts:153` declares
`"tier.approved": [transition("from", "to"), ...]` — the same transition
renderer as `tier.changed`, and its own comment says an approval *is* a tier
transition. Missing it would leave every new approval row reading `alumni`
where the deployment configured `Green`. The full set:

- `tier.changed` — `transition("from", "to")`
- `tier.approved` — `transition("from", "to")`
- `tier.unlocked` — `labelled("was", "tier")`
- `discord.role_changed` — `labelled("tier", "tier")`

Prefer resolving inside the shared `transition`/`labelled` part builders for
the tier-bearing keys over patching four call sites, if that fits the file's
existing shape — a fifth tier action added later should not be able to miss it.

- [ ] **Step 8: Pass labels from the audit page**

`src/app/admin/audit/page.tsx` calls `summarizeDetails`; give it
`getConfig().tierLabels`.

- [ ] **Step 9: Update the summarize tests**

`tests/audit-summarize.test.ts:343` asserts
`summarizeDetails("tier.changed", { from: "green", to: "flygd", ... })` renders
`"green → flygd, admin"`. That is the **legacy-value** case (spec D4) and must
keep passing — it now proves an unmapped legacy string survives the label
lookup. Add sibling cases with current enum values and a corp-style label map:

- `tier.changed` → `"FlyGD → Green, admin"`
- `tier.approved` → the same map, proving Step 7's fourth renderer

Update every other call in the file for the new parameter.

- [ ] **Step 10: Run the unit suite**

```bash
npx vitest run tests/audit-summarize.test.ts tests/tier-labels.test.ts tests/account-page.test.ts
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_open_source_de_branding npm test
npm run typecheck
```

`account-page.test.ts` is the one that proves the D12 seam works: it renders
`StandingTier` → `<Tier>` → `getConfig()` with no explicit config.

- [ ] **Step 11: Format and commit**

```bash
npm run format:check
git add src/app src/core tests vitest.config.ts
git commit -m "feat(tiers): render configured tier labels in badges and the audit log"
```

---

### Task 7: De-brand the remaining strings and the tests

**Files:**
- Create: `e2e/branding.spec.ts`
- Modify: `src/app/globals.css`, `e2e/not-found.spec.ts`, `e2e/payouts.spec.ts`,
  `e2e/error-boundary.spec.ts`, `playwright.config.ts`

- [ ] **Step 1: The CSS file-header comment**

`src/app/globals.css:2` reads `Zoo Landers / authGD — flight operations at
night.` Replace the corp name; keep the sentence's description of the palette.

- [ ] **Step 2: Give the e2e server non-default branding**

The suite runs one dev server for every spec, so it proves **one**
configuration. Make it a configured one, not the defaults: a suite asserting
`authGD` / `Auth` / `Alumni` passes just as well against hardcoded generic
strings, which is the exact bug this PR could introduce.

Add to `playwright.config.ts`'s `env` block, alongside the other fake values:

```ts
  // Deliberately not the defaults. A spec asserting the fallback strings
  // cannot tell "config was read" from "the string was hardcoded"; these
  // values appear nowhere in src/, so seeing them in the DOM proves the
  // whole path. Defaults are covered by the unit tests instead.
  BRAND_NAME: "Test Corp",
  BRAND_TAGLINE: "Test Ops",
  BRAND_MARK_URL: "/brand/emblem.webp",
  BRAND_MOTTO: "Test motto line",
  BRAND_FOOTER: "Test footer line",
  TIER_LABEL_MEMBER: "Testers",
  TIER_LABEL_ASSOCIATE: "Friends",
  TIER_LABEL_ALUMNI: "Veterans",
```

`BRAND_MARK_URL` points at `emblem.webp` — a real file, but not the mark's
default — so the assertion distinguishes "config read" from "default served".
None of these are secrets; all are visibly test fixtures.

- [ ] **Step 3: Update the five title assertions**

Five specs assert `· Zoo Landers`; with Step 2's env they become `· Test Corp`:

- `e2e/not-found.spec.ts:42` — `"Not found · Test Corp"`
- `e2e/not-found.spec.ts:116` — `"No such operation · Test Corp"`
- `e2e/not-found.spec.ts:174` — `"No such operation · Test Corp"`
- `e2e/payouts.spec.ts:324` — `"Short appraisal · Test Corp"`
- `e2e/error-boundary.spec.ts:71` — `"Something broke · Test Corp"`

Each one now doubles as a `generateMetadata()` config assertion.

- [ ] **Step 4: Add `e2e/branding.spec.ts`**

A new file rather than an addition to `shell.spec.ts`: this covers five
independent render paths and deserves its own name in the failure output.
Follow the file's neighbours for seeding and sign-in (`e2e/helpers.ts`).

Five assertions, one per path a brand string can reach the DOM by — each is a
path that Task 4 or Task 6 wires separately, so a miss in any one of them is
invisible to the other four:

1. **Server header** — sign in as a member, load `/account`, assert the
   wordmark reads `Test Corp` / `Test Ops`. (`SiteHeader` via a server caller.)
2. **Client header via `AdminNav`** — sign in as an admin, load
   `/admin/accounts`, assert the same wordmark. This is the P1 the plan review
   caught: it renders through `useBrand()`, not through server props.
3. **Configured mark URL** — on either page, assert the header `img`'s `src`
   is `/brand/emblem.webp`, not the default.
4. **Error boundary** — reuse `error-boundary.spec.ts`'s existing mechanism for
   forcing a render error, and assert the wordmark there too. The error page is
   the third and last `SiteHeader` caller and the only one whose header renders
   with no server data at all.
5. **Tier label** — on `/admin/accounts`, assert a row's tier badge reads
   `Veterans` and that no badge on the page reads `alumni`. The negative half
   matters: it fails if the badge renders the raw enum beside the label.

Also assert the login page shows `Test motto line` and `Test footer line`, in
whichever spec already visits `/login` — those two strings have no other
coverage.

- [ ] **Step 5: Confirm no corp vocabulary remains in shipping code**

Run: `grep -rn "Zoo Landers\|FLYGD\|Flight Ops" src/ e2e/ tests/ playwright.config.ts .env.example`
Expected: no output. Matches under `docs/` are expected and out of scope
(spec's *Publication prerequisites*).

- [ ] **Step 6: Full verification**

```bash
npm run typecheck
npm run format:check
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_open_source_de_branding npm test
npm run test:e2e
```

Running e2e rewrites `tsconfig.json` and `AGENTS.md` — both tracked. Restore
with `git checkout -- tsconfig.json AGENTS.md`; never delete, never stage.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: assert the default branding, and prove config reaches the page"
```

---

### Task 8: Runbook

**Files:**
- Modify: `docs/ops.md`

- [ ] **Step 1: Fix the two gaps PR1's deploy exposed**

1. The tier-rename section says to copy the old Discord role values "verbatim
   from the old one". Fly secrets are write-only — `fly secrets list` shows
   digests only. Say that the values must be read off a running machine with
   `fly ssh console -C "printenv DISCORD_ROLE_ID_..."`, and note that the
   command prints the value into the terminal.
2. The scale-down-then-merge ordering cannot hold when auto-merge is armed:
   during PR1 the merge fired ~90 minutes after the click and took the deploy
   with it, with machines still up. Say plainly: do not arm auto-merge on a
   migration PR.

- [ ] **Step 2: Add the PR2 deploy note**

This PR has no migration and needs no window. Before merging, set:

```
fly secrets set BRAND_NAME='Zoo Landers' BRAND_TAGLINE='Flight Ops' \
  BRAND_MOTTO=$'Center for kids\nwho can\'t fly good' \
  BRAND_FOOTER='Est. MMXXV · [FLYGD]' \
  TIER_LABEL_MEMBER='FlyGD' TIER_LABEL_ASSOCIATE='Blue' TIER_LABEL_ALUMNI='Green'
```

Setting them **before** the merge means the new image boots with the right
vocabulary; every one has a default, so the wrong order costs a brief window of
generic names, not an outage. Note that `BRAND_MOTTO` needs `$'...'` for the
newline.

- [ ] **Step 3: Commit**

```bash
npm run format:check
git add docs/ops.md
git commit -m "docs(ops): the two gaps PR1's deploy found, and PR2's secrets"
```

---

## Verification strategy

- Unit: `tests/tier-labels.test.ts` (new), `tests/config.test.ts`,
  `tests/audit-summarize.test.ts`, `tests/account-page.test.ts`. These are
  where the **defaults** are asserted — the unit env (`tests/helpers/env.ts`)
  deliberately sets no `BRAND_*` or `TIER_LABEL_*`.
- E2E: runs against **non-default** branding (Task 7 Step 2), so the five
  retitled assertions plus `e2e/branding.spec.ts` prove configuration is read
  rather than that a fallback string exists. The two halves are complementary:
  neither alone would catch a hardcoded value.
- Build: `npm run build` after Tasks 3, 4 and 6 — `generateMetadata()`, the
  `force-dynamic` layout, and the `server-only` split (D12) each fail only at
  build time.
- Every command's output is quoted in the PR, not asserted.

## Assumptions that may change

1. `tests/config.test.ts` has a reusable valid-env helper. If not, Task 2's
   test builds its env inline in the file's existing style.
2. `vitest.config.ts` accepts a `setupFiles` entry without disturbing its
   existing `globalSetup` (Task 6 Step 2). If the two interact badly, have
   `testConfig()` assign `BASE_ENV` to `process.env` itself and call it from
   `account-page.test.ts` — same seam, worse ergonomics.
3. `error-boundary.spec.ts` has a reusable way to force a render error that
   Task 7 Step 4 can borrow. If it is inline and specific to that spec, assert
   the error-boundary header there rather than in `branding.spec.ts`.

## Explicitly excluded

- README / PRODUCT.md / DESIGN.md / CONTRIBUTING.md — PR3.
- Moving `art/` and `docs/assets/` out of the repo — PR3.
- Migration history, `docs/superpowers/` contents, git history — the spec's
  *Publication prerequisites*, decided at publish time.
- Any change to `DISCORD_ROLE_ID_*` validation or the tier enum.
