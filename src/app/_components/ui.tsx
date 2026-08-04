import type { ReactNode } from "react";

/**
 * `href` is the only identity a nav item has — there used to be a separate
 * `key` field too, and nothing stopped one caller from keying it to the route
 * (`"/admin/accounts"`) while another keyed it to an arbitrary label
 * (`"account"`). Two conventions that happened to both typecheck, matched by
 * bare `===`, and silently produced no active tab the moment they disagreed.
 * Matching on `href` — the one value every item already carries and every
 * caller already knows the true form of, its own route — removes the second,
 * duplicated identity, so there is one string per item instead of two that had
 * to be kept in agreement. That kills the key-vs-href divergence by
 * construction. It does not make every mismatch impossible: `current` is a
 * plain `string`, so a typo'd `current="/acount"` still compiles and still
 * shows no active tab. `e2e/shell.spec.ts` covers that residual gap by
 * asserting exactly one `aria-current` on every shell route.
 */
export type NavItem = { href: string; label: string };

/**
 * The ruled header bar. `current` is passed in rather than read from a hook so
 * this stays a server component — every page that renders it is already
 * force-dynamic and knows its own route. It must be the item's `href` — see
 * the `NavItem` comment — and is optional: `error.tsx` renders this with no
 * route of its own to claim, and every item then correctly shows as inactive
 * rather than matching `undefined` against itself.
 *
 * The `.shell__bar` wrapper is what carries the layout: the bar's ground and
 * bottom hairline stay full-bleed, while the contents sit on the same measure
 * as the page's own column, so the seal and the nav land on the H1's verticals
 * instead of the viewport's. `measure` is passed for the same reason `current`
 * is — the page knows which column it uses, and deriving it here would cost
 * either a hook or a `:has()` bet on Next's DOM shape. A page rendering
 * `.page--narrow` must pass `measure="narrow"` to stay aligned.
 *
 * `admin` names which register the bar is framing. It drives three things
 * together rather than three separate props, because all three answer the
 * same question: the mark's destination (the admin index, not `/account`,
 * so the one link that promises "home" doesn't quietly walk an admin out of
 * the admin section), the nav's accessible name (so a screen reader user can
 * tell the two bars apart by more than which links happen to be in them), and
 * the `ADMIN` marker after the wordmark (the only on-screen signal that isn't
 * "which tab happens to be lit").
 */
export function SiteHeader({
  items,
  current,
  measure = "wide",
  admin = false,
}: {
  items: NavItem[];
  current?: string;
  measure?: "wide" | "narrow";
  admin?: boolean;
}) {
  return (
    <header className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div
        className={measure === "narrow" ? "shell__bar shell__bar--narrow" : "shell__bar"}
      >
        <a className="shell__mark" href={admin ? "/admin/accounts" : "/account"}>
          <img src="/brand/seal-sm.webp" alt="" width={34} height={34} />
          <span className="shell__wordmark">
            <b>Zoo Landers</b>
            <span>Flight Ops</span>
          </span>
        </a>
        {admin && <span className="shell__register">Admin</span>}
        <nav className="shell__nav" aria-label={admin ? "Admin" : "Main"}>
          {items.map((i) => (
            <a
              key={i.href}
              href={i.href}
              aria-current={i.href === current ? "page" : undefined}
            >
              {i.label}
            </a>
          ))}
          {/* The one control in the bar that isn't a destination, so it's a
              form/POST rather than a link — see auth/signout/route.ts for why
              a GET here would be CSRF-triggerable. Quiet grade, reused rather
              than invented: it has to sit among the nav's own text links
              without out-shouting them or the page's one primary action. */}
          <form action="/auth/signout" method="post" className="inline-form">
            <button type="submit" className="btn btn--quiet btn--micro">
              sign out
            </button>
          </form>
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
  tier: string;
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
