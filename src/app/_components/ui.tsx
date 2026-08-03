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
          <a key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined}>
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
 */
export function RuleHead({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="rule-head">
      <span>{children}</span>
      {aside && <span className="rule-head__aside">{aside}</span>}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "off" | "neutral";

/**
 * Machine state. The glyph and the word both carry the meaning, so colour is
 * never the only signal.
 */
export function Status({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={tone === "neutral" ? "st" : `st st--${tone}`}>{children}</span>;
}

export function Tier({ tier, locked }: { tier: string; locked?: boolean }) {
  const known = tier === "flygd" || tier === "blue" || tier === "green";
  return (
    <span className={known ? `tier tier--${tier}` : "tier tier--blue"}>
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
