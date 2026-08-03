import type { ReactNode } from "react";

export type NavItem = { href: string; label: string; key: string };

/**
 * The ruled header bar. `current` is passed in rather than read from a hook so
 * this stays a server component — every page that renders it is already
 * force-dynamic and knows its own route.
 */
export function SiteHeader({ items, current }: { items: NavItem[]; current?: string }) {
  return (
    <header className="shell">
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

export function Tier({ tier, locked }: { tier: string; locked?: boolean }) {
  const known = tier === "flygd" || tier === "blue" || tier === "green";
  // An unknown tier is a data problem, not a blue member: give it a neutral
  // badge rather than borrowing another tier's colour and asserting a lie.
  return (
    <span className={known ? `tier tier--${tier}` : "tier tier--unknown"}>
      {tier}
      {locked && (
        <>
          <span aria-hidden="true">🔒</span>
          <span className="visually-hidden">pinned by an admin</span>
        </>
      )}
    </span>
  );
}

/**
 * A JSON payload in a table cell. The collapsed line is truncated to keep the
 * readable columns on screen, but the full value has to stay reachable: role
 * IDs and trailing failure counters live at the end of these blobs, and a
 * CSS-only ellipsis would put them out of reach for good.
 */
export function Json({ value }: { value: unknown }) {
  return (
    <details className="json">
      <summary>
        <span className="json__peek">{JSON.stringify(value)}</span>
      </summary>
      <pre className="json__full">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

/**
 * A horizontally scrollable region for wide tables. tabIndex makes the
 * overflow reachable by keyboard, which a plain overflow container is not.
 */
export function Scroller({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="scroller" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
