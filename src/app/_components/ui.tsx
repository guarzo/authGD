import type { ReactNode } from "react";
// Type-only: erased at compile time, so this never pulls drizzle-orm/pg or
// the `pg` driver into whatever bundle renders <Tier> — schema.ts itself
// only imports drizzle-orm/pg-core, and `import type` guarantees zero
// runtime import regardless. Same pattern already used for the sync status
// enum at admin/sync/page.tsx.
import type { tierEnum } from "@/db/schema";

export type NavItem = { href: string; label: string; key: string };

/**
 * The ruled header bar. `current` is passed in rather than read from a hook so
 * this stays a server component — every page that renders it is already
 * force-dynamic and knows its own route.
 *
 * The `.shell__bar` wrapper is what carries the layout: the bar's ground and
 * bottom hairline stay full-bleed, while the contents sit on the same measure
 * as the page's own column, so the seal and the nav land on the H1's verticals
 * instead of the viewport's. `measure` is passed for the same reason `current`
 * is — the page knows which column it uses, and deriving it here would cost
 * either a hook or a `:has()` bet on Next's DOM shape. A page rendering
 * `.page--narrow` must pass `measure="narrow"` to stay aligned.
 */
export function SiteHeader({
  items,
  current,
  measure = "wide",
}: {
  items: NavItem[];
  current?: string;
  measure?: "wide" | "narrow";
}) {
  return (
    <header className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div
        className={measure === "narrow" ? "shell__bar shell__bar--narrow" : "shell__bar"}
      >
        <a className="shell__mark" href="/account">
          <img src="/brand/seal-sm.webp" alt="" width={34} height={34} />
          <span className="shell__wordmark">
            <b>Zoo Landers</b>
            <span>Flight Ops</span>
          </span>
        </a>
        <nav className="shell__nav" aria-label="Main">
          {items.map((i) => (
            <a
              key={i.key}
              href={i.href}
              aria-current={i.key === current ? "page" : undefined}
            >
              {i.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}

/**
 * A typed label with a hairline running to the container edge. `aside` sits
 * between the label and the rule, for a status the label alone can't carry.
 * Pass `as` when the label titles a real section, so assistive navigation gets
 * a heading rather than an anonymous span.
 */
export function RuleHead({
  children,
  aside,
  as: As = "span",
}: {
  children: ReactNode;
  aside?: ReactNode;
  as?: "span" | "h2" | "h3";
}) {
  return (
    <div className="rule-head">
      <As className="rule-head__label">{children}</As>
      {aside && <span className="rule-head__aside">{aside}</span>}
    </div>
  );
}

export type Tone = "ok" | "warn" | "bad" | "off" | "neutral";

/**
 * Machine state. The glyph and the word both carry the meaning, so colour is
 * never the only signal.
 *
 * `tone` and `children` stay separate props rather than one bound
 * `{tone, label}` pair. A bound pair was considered — it's what would make
 * `<Status tone="ok">dead</Status>` a type error — but the 18 call sites
 * don't share a vocabulary: "ok" tone alone backs "ok", "valid", "linked",
 * "on" and a computed "3/5 ok" across four unrelated domains (token health,
 * map presence, Discord link, cryo), and two sites pass a tone computed from
 * a `syncRunStatusEnum` value (`admin/sync/page.tsx`) whose label is that
 * same run's raw status string. A single closed word list would either have
 * to include every domain's vocabulary (defeating the "hard to mismatch"
 * goal by being permissive again) or force each call site through a
 * per-domain lookup table, which is a bigger change than this primitive
 * should make unilaterally. Binding is better done at the domain layer
 * (e.g. a `tokenStatusTone()` helper next to `tokenTone()`), not here.
 */
export function Status({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return <span className={tone === "neutral" ? "st" : `st st--${tone}`}>{children}</span>;
}

/**
 * The tier enum's own value set, not re-typed here. `(string & {})` keeps the
 * union open: the audit log renders historic tier values straight from the
 * DB (`admin/accounts/page.tsx`'s audit rows), and those can outlive the enum
 * if a tier is ever renamed or retired, so this prop must still accept a
 * plain string rather than close on today's three tiers.
 */
export type TierName = (typeof tierEnum.enumValues)[number] | (string & {});

/**
 * `size="lead"` is for the one place a tier is the subject of the page rather
 * than a cell in a list. It buys hierarchy with size alone: the badge already
 * carries its tier's hue, so growing it spends no extra colour against
 * DESIGN.md's ration.
 */
export function Tier({
  tier,
  locked,
  size,
}: {
  tier: TierName;
  locked?: boolean;
  size?: "lead";
}) {
  const known = tier === "flygd" || tier === "blue" || tier === "green";
  // An unknown tier is a data problem, not a blue member: give it a neutral
  // badge rather than borrowing another tier's colour and asserting a lie.
  const tone = known ? `tier tier--${tier}` : "tier tier--unknown";
  return (
    <span className={size === "lead" ? `${tone} tier--lead` : tone}>
      {tier}
      {locked && (
        <>
          {/* CSS-drawn, not the 🔒 emoji: a vendor glyph ignored --tone (a
              fourth uncommanded colour on the one badge that carries exactly
              one) and its advance width broke the mono column's tabular
              rhythm. .tier__lock::after draws in currentColor at the mono
              advance instead. */}
          <span className="tier__lock" aria-hidden="true" />
          <span className="visually-hidden">pinned by an admin</span>
        </>
      )}
    </span>
  );
}

/**
 * `.notice` (globals.css) hand-rolled at 8+ call sites had already drifted:
 * some had `role="alert"`, some `role="status"`, some no role at all, and
 * each hand-typed its own `data-glyph`. `tone` derives both, so a call site
 * can't drop the role by omission. `bad` is the only tone that interrupts
 * (role="alert"); `warn`/`info` are ambient confirmations a screen reader
 * announces without stealing focus (role="status").
 */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "bad" | "warn" | "info";
  children: ReactNode;
}) {
  const glyph = tone === "info" ? "·" : "!";
  const role = tone === "bad" ? "alert" : "status";
  const className = tone === "info" ? "notice" : `notice notice--${tone}`;
  return (
    <p className={className} data-glyph={glyph} role={role}>
      {children}
    </p>
  );
}

/**
 * A JSON payload in a table cell. The collapsed line is truncated to keep the
 * readable columns on screen, but the full value has to stay reachable: role
 * IDs and trailing failure counters live at the end of these blobs, and a
 * CSS-only ellipsis would put them out of reach for good. Pass `summary` when
 * the caller can render a one-line, human summary of the payload (e.g. the
 * audit log's `green → flygd`) rather than falling back to raw JSON.
 */
export function Json({ value, summary }: { value: unknown; summary?: string }) {
  return (
    <details className="json">
      <summary>
        <span className="json__peek">{summary ?? JSON.stringify(value)}</span>
      </summary>
      <pre className="json__full">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

// Scroller needs scroll-position state, which means a client component; kept
// in its own file so this one doesn't drag "use client" onto SiteHeader,
// Status, Tier and Json, none of which need it.
export { Scroller } from "./scroller";
