import type { ReactNode } from "react";
// Type-only: erased at compile time, so this never pulls drizzle-orm/pg or
// the `pg` driver into whatever bundle renders <Tier> — schema.ts itself
// only imports drizzle-orm/pg-core, and `import type` guarantees zero
// runtime import regardless. Same pattern already used for the sync status
// enum at admin/sync/page.tsx.
import type { tierEnum } from "@/db/schema";

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
 * bottom hairline stay full-bleed, and the contents sit on one fixed measure —
 * `--measure-page` — on every route.
 *
 * The bar used to take a `measure` prop and track whichever column the page
 * under it used, so the seal and the nav landed on that page's H1 vertical.
 * That bought alignment at the price of a 288px width change (and so a 144px
 * lateral jump for the seal and the nav) whenever a route crossed between the
 * two measures. It was priced as an admin-only cost, on the premise that a
 * member only ever sees `/account`. Payouts falsified that premise 26 PRs
 * later: `/payouts` is wide, `/payouts/new` is narrow, and a plain member walks
 * that list -> form path in sequence, watching the chrome slide under them
 * mid-task.
 *
 * Worth knowing before reopening this: #39 shipped the fixed measure first and
 * reversed itself to the tracking one within the same PR. This is the third
 * position, not a fresh idea, so the argument below is the one that has to be
 * beaten.
 *
 * Chrome that holds still beats chrome aligned to the column below it. The
 * ground was always full-bleed, so the contents were never read as being "in"
 * the page column to begin with. The cost is symmetric and it is the whole of
 * it: on the two narrow routes the seal sits 144px outboard of the H1, and the
 * nav's right edge sits 144px outboard of the content's right edge.
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
  admin = false,
}: {
  items: NavItem[];
  current?: string;
  admin?: boolean;
}) {
  return (
    <header className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="shell__bar">
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
 *
 * `size="lead"` is for a status that is the subject of the page rather than a
 * cell in a list — the account page's verdict line. Reserve it for states that
 * ask something of the reader: a large token saying everything is fine is a
 * page shouting its own silence.
 */
export function Status({
  tone = "neutral",
  size,
  children,
}: {
  tone?: Tone;
  size?: "lead";
  children: ReactNode;
}) {
  const classes = ["st"];
  if (tone !== "neutral") classes.push(`st--${tone}`);
  if (size === "lead") classes.push("st--lead");
  return <span className={classes.join(" ")}>{children}</span>;
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
