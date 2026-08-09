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
export type NavItem = {
  href: string;
  label: string;
  /** A count rendered beside the item. `description` is the visually-hidden
   *  text naming what the number counts; it lives on the item rather than in
   *  SiteHeader because this component is shared with the member nav. */
  badge?: { count: number; description: string };
};

/**
 * The ruled header bar. `current` is passed in rather than read from a hook so
 * this stays a server component — every page that renders it is already
 * force-dynamic and knows its own route. It must be the item's `href` — see
 * the `NavItem` comment — and is optional: `error.tsx` renders this with no
 * route of its own to claim, and every item then correctly shows as inactive
 * rather than matching `undefined` against itself.
 *
 * `section` says the highlighted item names the *section* this page belongs to
 * rather than this page itself, and it changes only which `aria-current` token
 * is emitted: `"page"` claims the link's target is the document you are on, and
 * `/payouts/new`, `/payouts/[id]` and the payout 404 all passed `current`
 * `"/payouts"` while being none of those things — so a screen reader was told
 * "Payouts, link, current page" on a page that was not `/payouts`. `"true"`
 * means "current within this set", which is what the section highlight actually
 * asserts, and it leaves the visual treatment to `globals.css` (whose
 * `[aria-current="page"]` selectors need widening to bare `[aria-current]` for
 * the gold hairline to survive the token change).
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
  section = false,
  admin = false,
  brandName,
  brandTagline,
  brandMarkUrl,
}: {
  items: NavItem[];
  current?: string;
  /** Set when `current` names the section this page sits under rather than
   *  this page's own route (`/payouts/new` under `/payouts`). */
  section?: boolean;
  admin?: boolean;
  /** Brand values. Defaulted so a caller that forgets them degrades to the
   *  generic names rather than crashing. Server callers pass
   *  `getConfig().brand`; the two client callers pass `useBrand()`. */
  brandName?: string;
  brandTagline?: string;
  brandMarkUrl?: string;
}) {
  return (
    <header className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <div className="shell__bar">
        <a className="shell__mark" href={admin ? "/admin/accounts" : "/account"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- BRAND_MARK_URL
              is documented as accepting an external URL (README, "Brand"), and
              next/image would need every such host allowlisted in
              next.config.ts's remotePatterns at build time — which a deploy-time
              env var cannot be. Nothing else next/image offers applies: the mark
              is a fixed 34px at a known intrinsic size, so there is no layout
              shift to prevent and no art direction to do. Matches the seal on
              the login page, suppressed for the same reason. */}
          <img src={brandMarkUrl ?? "/brand/mark.webp"} alt="" width={34} height={34} />
          <span className="shell__wordmark">
            <b>{brandName ?? "authGD"}</b>
            <span>{brandTagline ?? "Auth"}</span>
          </span>
        </a>
        {admin && <span className="shell__register">Admin</span>}
        <nav className="shell__nav" aria-label={admin ? "Admin" : "Main"}>
          {items.map((i) => {
            // Derived from href, not useId: SiteHeader renders on both sides of
            // the client boundary and cannot use hooks, and href is already the
            // nav's identity key.
            const badgeId = `nav-badge-${i.href}`;
            const badge = i.badge && i.badge.count > 0 ? i.badge : undefined;
            return (
              // The pair is ONE flex child. .shell__nav wraps, so a bare
              // sibling span can land on the next line away from the link it
              // belongs to.
              <span key={i.href} className="shell__navitem">
                <a
                  href={i.href}
                  aria-current={
                    i.href === current ? (section ? "true" : "page") : undefined
                  }
                  // Described-by rather than inside the link: inside, the
                  // accessible NAME becomes "Members 3 awaiting approval" on
                  // one load and "Members" on the next — the same destination
                  // named two ways, which is what WCAG 3.2.4 Consistent
                  // Identification forbids and what the ITEMS comment in
                  // admin-nav.tsx exists to protect. A bare sibling would keep
                  // the name but associate nothing: screen-reader link
                  // navigation jumps link to link and would skip it entirely.
                  aria-describedby={badge ? badgeId : undefined}
                >
                  {i.label}
                </a>
                {badge && (
                  <span id={badgeId} className="shell__badge">
                    {badge.count}
                    <span className="visually-hidden"> {badge.description}</span>
                  </span>
                )}
              </span>
            );
          })}
          {/* The one control in the bar that isn't a destination, so it's a
              form/POST rather than a link — see auth/signout/route.ts for why
              a GET here would be CSRF-triggerable. Quiet grade, reused rather
              than invented: it has to sit among the nav's own text links
              without out-shouting them or the page's one primary action. The
              `shell__signout` hairline is what actually tells it apart from
              those links — same face, size, weight and case as the four
              destinations beside it, so nothing but a rule says "this one ends
              the session instead of loading a page." Colour is the one thing
              that differs (`--ink-faint` here against the links'
              `--ink-dim`), which is too small a delta to carry the
              distinction on its own — see `.shell__signout` in globals.css. */}
          <form
            action="/auth/signout"
            method="post"
            className="inline-form shell__signout"
          >
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
  id,
}: {
  children: ReactNode;
  aside?: ReactNode;
  as?: "span" | "h2" | "h3";
  /** Set only when something needs to move focus here. Carrying an `id`
   *  implies `tabIndex={-1}`: a heading is a legitimate place to *land* after
   *  an action that removed the control you were on, but it must never become
   *  a stop in the tab order on the way to the controls. The two always travel
   *  together, so the call site cannot get one without the other. */
  id?: string;
}) {
  return (
    <div className="rule-head">
      <As className="rule-head__label" id={id} tabIndex={id ? -1 : undefined}>
        {children}
      </As>
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
 * `<Status tone="ok">dead</Status>` a type error — but the 56 call sites
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
 * `.notice` (globals.css) hand-rolled at 8+ call sites had already drifted:
 * some had `role="alert"`, some `role="status"`, some no role at all, and
 * each hand-typed its own `data-glyph`. `tone` derives both, so a call site
 * can't drop the role by omission. `bad` is the only tone that interrupts
 * (role="alert"); `warn`/`info` are ambient confirmations a screen reader
 * announces without stealing focus (role="status").
 *
 * Empty children render the reserved slot rather than nothing, so the call
 * site can mount this unconditionally — `<Notice tone="bad">{err}</Notice>` —
 * instead of `{err && <Notice tone="bad">{err}</Notice>}`. The `&&` form is
 * the one shape that defeats the live region it just asked for: it inserts a
 * `role="alert"` node with its text already inside it, and AT announces a
 * *change* to a region far more reliably than a region born holding text.
 * `admin/sync/page.tsx` hand-rolled exactly this and was the reference; it now
 * renders this primitive instead, so there is one copy of the behaviour rather
 * than two. `note-form.tsx:62-78` makes the same argument for its own region.
 * Keeping the behaviour in the primitive is the point: the next caller cannot
 * omit it by writing `&&`. An empty slot carries no `notice--bad`/`notice--warn`
 * class and no glyph, so "is there a message" is still `p.notice--bad`.
 *
 * `live={false}` opts out of the region entirely, for the one case where a
 * second announcement is worse than none: a surface that already announces
 * itself by moving focus (`error.tsx` focuses its `h1`) gets its heading
 * preempted by an assertive region rendering in the same commit.
 *
 * `id` is for the opposite case: a surface with nothing else moving focus,
 * where a sighted operator can stand at a control well below this notice and
 * never see it arrive (item 10 — `/payouts/new`'s rejection lands ~1000px
 * above the submit button the operator is still looking at). Carrying an
 * `id` implies `tabIndex={-1}`, the same paired contract `RuleHead` already
 * documents on its own `id` prop: a landing place a caller moves focus to
 * after a rejection must never also become a stop in the tab order on the
 * way to the form's controls. The two travel together so a call site cannot
 * get one without the other. This primitive only carries the plumbing —
 * moving focus here on a rejection is still the call site's own effect, the
 * same way `error.tsx` focuses its own `h1`.
 */
export function Notice({
  tone = "info",
  live = true,
  id,
  children,
}: {
  tone?: "bad" | "warn" | "info";
  /** Set `false` to render the notice with no `role`, when something else on
   *  the page already announces the same arrival. */
  live?: boolean;
  /** Set only when a caller needs to move focus here, e.g. on a rejection
   *  that lands out of the sighted operator's view. Implies `tabIndex={-1}`
   *  — see the doc above. */
  id?: string;
  children: ReactNode;
}) {
  const empty =
    children === null || children === undefined || children === false || children === "";
  const glyph = tone === "info" ? "·" : "!";
  const role = tone === "bad" ? "alert" : "status";
  const className = tone === "info" ? "notice" : `notice notice--${tone}`;
  return (
    <p
      className={empty ? "notice-slot" : className}
      data-glyph={empty ? undefined : glyph}
      role={live ? role : undefined}
      id={id}
      tabIndex={id ? -1 : undefined}
    >
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
 * audit log's `alumni → member`) rather than falling back to raw JSON.
 *
 * `pretty` controls only the *expanded* block. It defaults to the indented
 * form, which is what a nested payload needs to be readable at all. Pass
 * `pretty={false}` for a flat payload whose every value is a scalar: the
 * one-key-per-line indent then buys nothing a compact string doesn't already
 * say, and in a table it costs real height — see the measured case at
 * `@/app/admin/sync/page` (Raw column), where it was the difference between a
 * 227px row and a ~116px one. Deliberately not inferred from the value's own
 * shape: which form reads better depends on the surface it renders into, not
 * on the payload, and a component that silently changed layout when a
 * payload's shape changed would be worse than one that asks.
 */
export function Json({
  value,
  summary,
  pretty = true,
}: {
  value: unknown;
  summary?: string;
  pretty?: boolean;
}) {
  return (
    <details className="json">
      <summary>
        <span className="json__peek">{summary ?? JSON.stringify(value)}</span>
      </summary>
      <pre className="json__full">
        {pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}
      </pre>
    </details>
  );
}

// Scroller needs scroll-position state, which means a client component; kept
// in its own file so this one doesn't drag "use client" onto SiteHeader,
// Status, Tier and Json, none of which need it.
export { Scroller } from "./scroller";
