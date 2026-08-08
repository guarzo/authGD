import type { Metadata } from "next";
import { getConfig, type Config } from "@/config";
import { getDb } from "@/db";
import { requireAdminPage } from "@/lib/admin-guard";
import { ADMIN_ACCOUNTS_ERRORS, lookupErrorMessage } from "@/lib/error-redirects";
import { isContactsTarget } from "@/services/desired";
import {
  getAdminAccountsList,
  type AdminAccountRow,
  type AdminCharacterRow,
  type AdminListSort,
} from "@/services/account-view";
import { Notice, RuleHead, Scroller, Status } from "@/app/_components/ui";
import { CharacterLocation } from "@/app/_components/character-location";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { Tier } from "@/app/_components/tier";
import { tierLabel } from "@/app/_components/labels";
import { accountsConfirmation, isDoneCode, matchesAccountSearch } from "./view";
import { ConfirmGroup, ConfirmingForm } from "@/app/_components/confirm-group";
// Shared with the member's own character table rather than reimplemented here:
// the near-miss label copy and the "not managed" wording are the same question
// asked about the same character, and two copies drift.
import {
  ContactRemedy,
  ContactState,
  hasContactRemedy,
} from "@/app/account/contact-state";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { ConfirmArmScope, ConfirmSubmit } from "@/app/_components/confirm-submit";
import { NoteForm } from "@/app/_components/note-form";
import { renderedAt } from "@/app/_components/utc-time";
import { countPendingCached } from "../pending-count";
import {
  approveAction,
  demoteAdminAction,
  promoteAdminAction,
  returnToAutoAction,
  saveNoteAction,
  setStatusAction,
  setTierAction,
  syncAccountAction,
  unlinkDiscordAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Members",
};

const SORTS: Array<{ key: AdminListSort; label: string }> = [
  { key: "name", label: "Name" },
  { key: "tier", label: "Tier" },
  { key: "status", label: "Cryo" },
  { key: "tierChangedAt", label: "Tier changed" },
];

/**
 * Which way a column opens on the FIRST click, before it has a direction of
 * its own. Only the direction of that first press; once a column is active it
 * toggles as it always did.
 *
 * `name`, `tier` and `status` open ascending because A-first and
 * `member`-first are how someone looks for a value they already have in mind.
 * `tierChangedAt` is not that kind of column. Nobody clicks "Tier changed"
 * to find the account nothing has happened to since last spring; they click it
 * to answer "what moved while I was away", and ascending answers the opposite
 * question — the top of the table fills with the most settled accounts on the
 * roster and the answer sits at the bottom, one more click away, on a page
 * whose whole reason to exist is that the sync jobs change things without
 * telling anyone.
 */
const SORT_OPENS: Record<AdminListSort, "asc" | "desc"> = {
  name: "asc",
  tier: "asc",
  status: "asc",
  tierChangedAt: "desc",
};
// What an admin may manually assign. Pending is deliberately absent: it is a
// state accounts are born in, and setTierManual locks whatever it sets.
const TIERS = ["member", "associate", "alumni"] as const;
// What an admin may filter by — a superset, since pending accounts exist and
// have to be findable. Drives the ?tier= whitelist and the filter chips only.
const TIER_FILTERS = ["pending", ...TIERS] as const;
// What an approval may grant, in the order the rest of the page renders tiers.
// Derived from TIERS rather than written out, because the drawer's two tier
// control groups sit in the same `.btn-group` position and an admin scans
// straight from one to the other: hand-listing this set let the approve pair
// drift into alumni-before-associate while the filter chips and the set-tier
// row both ran member-associate-alumni.
//
// The predicate excludes `member` by `Exclude` rather than by naming the two
// survivors, and the difference matters the day TIERS grows. A hand-written
// `t is "associate" | "alumni"` is a legal predicate for a wider union, so a
// fourth tier would land in this array at runtime while the type narrowed it
// away — and the `approveAction.bind` below would typecheck against the stale
// pair and fail only when someone pressed the button. Derived, the new tier
// widens the element type instead, and the bind stops compiling against
// `approveAccount` (services/admin-accounts.ts:121-146), which accepts only
// what it accepts. That failure is the check this derivation relies on.
const APPROVE_TIERS = TIERS.filter(
  (t): t is Exclude<(typeof TIERS)[number], "member"> => t !== "member",
);

// Every code this page renders lives in src/lib/error-redirects.ts, beside the
// builder actions.ts and admin-guard.ts go through. All of them are races
// between two legitimate admins rather than faults, which is why they are
// notices on a refreshed list and not error-boundary throws.

// The columns after the sortable ones, in render order. A list rather than a
// count because three separate things depend on the table's width — the
// header row, the empty-state row's colSpan, and the drawer row's — and a
// hand-kept number drifts the moment someone adds a column and updates two of
// the three. Adding a label here is the only edit a new column needs.
const FIXED_COLUMNS = [
  "Tokens",
  "Discord",
  "Map",
  "Last login",
  "Admin",
  "Actions",
] as const;

const COLUMN_COUNT = SORTS.length + FIXED_COLUMNS.length;

function fmt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

/** Collapses a possibly-repeated query param to one value, last wins —
 *  matching `/admin/audit`'s `one`, for the same reason: a duplicate arises by
 *  appending `&q=x` to a URL that already has one, so the appended value is
 *  the intent. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/** Id of the always-visible "locking a tier" sentence in one row's drawer, and
 *  the `describedBy` target the two arming tier buttons in that row point at.
 *  Per-account, not per-button: all three tier presses in a row lock the same
 *  account the same way, so one sentence per row covers all of them. */
function tierLockNoteId(accountId: string): string {
  return `tier-lock-note-${accountId}`;
}

export default async function AdminAccountsPage({
  searchParams,
}: {
  // Next passes `string | string[]` for any param. A repeated one
  // (`?q=Azzy&q=Zed`) reaching `.trim()` on an array takes the whole roster
  // down with a 500 — the same defect `/admin/audit` already fixed, and the
  // same fix: declare the real type and collapse it before anything reads it.
  searchParams: Promise<{
    tier?: string | string[];
    status?: string | string[];
    sort?: string | string[];
    dir?: string | string[];
    error?: string | string[];
    done?: string | string[];
    name?: string | string[];
    at?: string | string[];
    q?: string | string[];
  }>;
}) {
  await requireAdminPage();
  const raw = await searchParams;
  const params = {
    tier: one(raw.tier),
    status: one(raw.status),
    sort: one(raw.sort),
    dir: one(raw.dir),
    error: one(raw.error),
    done: one(raw.done),
    name: one(raw.name),
    at: one(raw.at),
    q: one(raw.q),
  };
  const sort = (
    SORTS.some((s) => s.key === params.sort) ? params.sort : "name"
  ) as AdminListSort;
  const dir = params.dir === "desc" ? "desc" : "asc";
  const tier = TIER_FILTERS.includes(params.tier as (typeof TIER_FILTERS)[number])
    ? (params.tier as (typeof TIER_FILTERS)[number])
    : undefined;
  const status =
    params.status === "cryo" || params.status === "active" ? params.status : undefined;
  // Trimmed the same way audit's actor/target filters are: a trailing space
  // off a pasted name falls through to "no match" otherwise, and a
  // whitespace-only value collapses to "unfiltered" rather than hiding the
  // whole roster on a stray space.
  const q = params.q?.trim() || undefined;
  const filtered = Boolean(tier || status || q);
  const cfg = getConfig();
  const allRows = await getAdminAccountsList(getDb(), cfg, {
    tier,
    status,
    sort,
    dir,
  });
  // The search runs in-memory, over rows the service already assembled in
  // full for tier/status filtering (services/account-view.ts) — one more
  // predicate over the same array, not a second query shape. See
  // `matchesAccountSearch` (view.ts) for what it matches and why.
  const rows = q ? allRows.filter((r) => matchesAccountSearch(r, q)) : allRows;
  // Independent of every active filter. `rows` is narrowed by tier AND status
  // (above), so counting it would hide the queue from an admin who is looking
  // at ?status=cryo — precisely when a standing reminder is most useful. A
  // single `count(*)` rather than another getAdminAccountsList call: that
  // call assembles a full row (five unbounded scans plus per-character work)
  // for every account just to get thrown away for a length.
  const pendingCount = await countPendingCached();
  const errorMessage = lookupErrorMessage(ADMIN_ACCOUNTS_ERRORS, params.error);
  // Only the four cell-level actions (unlinkDiscordAction, promoteAdminAction,
  // demoteAdminAction, syncAccountAction — actions.ts) reach this: they're the
  // ones that redirect through `doneUrl`, and none of their `done` codes
  // ("discord", "grant", "revoke", "sync") read the third argument, so this
  // never carries a tier label. The other four mutating actions build their
  // own confirmation directly (see view.ts's docblock) and never touch
  // `?done=` at all.
  //
  // `params.done` is a raw query-string value — `string | undefined`, with no
  // way for Next.js to know about `AdminAccountsDoneCode` — so it's narrowed
  // here with `isDoneCode` before the call, rather than `accountsConfirmation`
  // itself accepting a bare string. This is the one real boundary an
  // unrecognised code (a hand-edited URL, or a build that has since dropped
  // one) can reach; `undefined` renders no confirmation either way.
  const doneCode = isDoneCode(params.done) ? params.done : undefined;
  const confirmation = accountsConfirmation(doneCode, params.name, undefined);

  const listParams = (over: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tier, status, sort, dir, q, ...over })) {
      if (v) p.set(k, v);
    }
    return p;
  };
  const qs = (over: Record<string, string | undefined>) =>
    `/admin/accounts?${listParams(over).toString()}`;
  // The admin's current view — tier, status, sort, dir — as a bare query
  // string. Bound into every mutation below so that a redirect — success or
  // error — can rebuild the list the admin was actually scanning instead of
  // dropping them on the unfiltered default. `syncAccountAction` used to take
  // a full pre-built href on this same principle; it now takes the bare
  // string like every sibling, since `doneUrl` (actions.ts) owns the path for
  // every success redirect the way `adminAccountsErrorUrl` owns it for every
  // failure.
  const listSearch = listParams().toString();

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="page__head">
        <h1>Members</h1>
        <p className="page__lede">
          One row per member. Tier and cryo are set here; everything else is what the sync
          jobs last observed.
        </p>
      </div>

      {/* Mounted unconditionally, not `&&`-gated: every mutation on this page
          ends in a server-action redirect that re-renders without a document
          load, so an `&&` would insert the region and its text in the same
          commit — the shape `Notice`'s own docblock calls out as the one that
          defeats the live region it just asked for. Empty children render the
          reserved `.notice-slot`, which is out of flow and draws nothing. */}
      <Notice tone="bad">{errorMessage}</Notice>

      {/* #131's third slot on this page was `{params.queued === "account" &&
          …}`, converted there to an unconditional `Notice`. It is gone rather
          than merged: `?queued=account` was `syncAccountAction`'s own scheme
          and this branch supersedes it with the `?done=&name=&at=` triple every
          cell-level action now shares (see `doneUrl` in actions.ts, which drops
          `queued` deliberately). Its text lives on in `accountsConfirmation`'s
          `sync` case, rendered by the ConfirmNotice below — which is already
          mounted unconditionally and carries `live={false}` on purpose, since
          focus rather than the live region does the announcing there.

          `ConfirmNotice`, not a bare `{cond && <Notice>}`: the four cell-level
          row actions — unlink Discord, grant/revoke admin, sync now — each
          round-trip through a server action that redirects back here, and
          each changes the very control that was pressed out from under
          itself (a Discord unlink turns its button into a bare "none"
          status; grant/revoke and freeze/wake-adjacent admin controls swap
          branches; a sync request has nothing left to confirm the press with
          otherwise). Left as a bare conditional, an admin's focus fell to
          `<body>` after every single press — the same defect `/account` and
          `/admin/sync` each fixed with this component. The other four
          mutating actions (tier, approve, auto, freeze/wake) live inside the
          row's drawer and use `ConfirmGroup`/`ConfirmingForm`
          (`confirm-group.tsx`) instead — a redirect back to this page would
          reset the drawer's own open/closed state, which this page-level
          notice cannot avoid since it only exists after the navigation that
          causes the problem. See `view.ts`'s and `confirm-group.tsx`'s
          docblocks for the full reasoning. */}
      <ConfirmNotice text={confirmation} at={params.at} />

      <Notice>
        {pendingCount > 0 ? (
          /* `.btn`, not a bare anchor. This is the page's only standing call
             to action — the one control that routes an admin to the work
             waiting for them — and as a bare `<a>` inside `.notice`'s flex row
             its hit target was the `--t-data` line box, 21.7px tall (measured):
             under WCAG 2.5.8's 24px floor and under both of the two hit-target
             grades DESIGN.md:277-278 allows, "and no others". An admin on a
             trackpad or a touch screen who misses it falls back to
             hand-filtering `?tier=pending`.

             A plain `.btn` rather than the `.filters .btn--quiet` buy-back the
             filter row needs: `.btn` is already at the 36px standalone grade
             with no override at all, and it is the exact class the tier and
             status chips beside it carry — this link goes to the same list
             those chips filter, so it reads as one of them rather than as a
             third thing. Keeping the grade on the element rather than in a
             `.notice a` rule also keeps it from reaching the other eleven
             `Notice` call sites, none of which renders a control today. */
          <a className="btn" href="/admin/accounts?tier=pending">
            {pendingCount} account{pendingCount === 1 ? "" : "s"} awaiting approval
          </a>
        ) : null}
      </Notice>

      {/* Not a RuleHead. The two groups below already carry their own visible
          labels ("Tier", "Status") and their own `role="group"` names, so a
          third visible heading saying "Filter" was furniture restating them —
          and a rule plus its --s-7 gap cost ~79px of a vertical budget this
          page does not have (the table region below it starts ~445px down).
          The heading itself still has to exist, so screen-reader heading
          navigation can reach the filters as a landmark-sized unit; it just
          has nothing left to say on screen. The search box added below is a
          filter too (it narrows the same `rows`), so it shares this landmark
          rather than earning a second heading. */}
      <h2 className="visually-hidden">Filter</h2>
      <div className="filters">
        {/* The one thing this page had no answer for: "find this one member"
            on a roster with no in-page search, only scroll and browser
            find-in-page — which misses a name sitting inside a collapsed
            drawer. A GET form, like /admin/audit's filter row, not a
            client-side filter: `rows` is already the full, server-sorted
            list by the time this renders, and a client filter would either
            duplicate `matchesAccountSearch` in the browser or ship the whole
            roster as a data island to filter over — for a page that is
            `force-dynamic` and already re-fetches on every navigation
            anyway. Submitting it is a navigation, same as clicking a tier
            chip; unlike the four drawer-scoped actions below, no drawer is
            open yet when an admin is searching for a row to open, so the
            "a redirect resets Disclosure's state" trap those actions work
            around does not apply here.

            Tier, status, and sort survive the search as hidden fields — an
            admin narrowing to `?status=cryo` and then searching a name
            expects both to hold, not the search to reset every other choice
            they already made. `q` itself needs no hidden field: the visible
            input already carries it. */}
        <form
          method="get"
          className="filters__group"
          role="search"
          aria-label="Find a member"
        >
          {/* Not "Find" — that is the submit button's name three lines down,
              and a screen-reader user tabbing this form heard "Find" twice
              with nothing to tell the box from the button. Naming the field
              for what goes IN it also says more than the verb did: the hint
              below expands it, but the label alone now answers "type what?". */}
          <label className="filters__label" htmlFor="accounts-search">
            Name or handle
          </label>
          {tier && <input type="hidden" name="tier" value={tier} />}
          {status && <input type="hidden" name="status" value={status} />}
          {sort !== "name" && <input type="hidden" name="sort" value={sort} />}
          {dir !== "asc" && <input type="hidden" name="dir" value={dir} />}
          <input
            id="accounts-search"
            className="field"
            type="search"
            name="q"
            defaultValue={params.q ?? ""}
            aria-describedby="accounts-search-hint"
          />
          <span className="visually-hidden" id="accounts-search-hint">
            Matches a main, an alt, or a linked Discord handle.
          </span>
          {/* Full 36px on both, not the 28px in-row grade: this is the filter
              row, and the tier and status chips beside it (`:338` onward) are
              already bare `.btn`. `clear` additionally needs the
              `.filters .btn--quiet` buy-back in globals.css — dropping
              `--micro` alone leaves it at `.btn--quiet`'s own 1.75rem. */}
          <Submit className="btn">Find</Submit>
          {q && (
            <a className="btn btn--quiet" href={qs({ q: undefined })}>
              clear
            </a>
          )}
        </form>
        <span className="filters__sep" aria-hidden="true" />
        <div className="filters__group" role="group" aria-label="Filter by tier">
          <span className="filters__label">Tier</span>
          <a
            className="btn"
            href={qs({ tier: undefined })}
            aria-current={!tier ? "true" : undefined}
          >
            all
          </a>
          {TIER_FILTERS.map((t) => (
            <a
              key={t}
              className="btn"
              href={qs({ tier: t })}
              aria-current={tier === t ? "true" : undefined}
            >
              {tierLabel(t)}
            </a>
          ))}
        </div>
        <span className="filters__sep" aria-hidden="true" />
        <div className="filters__group" role="group" aria-label="Filter by status">
          <span className="filters__label">Status</span>
          <a
            className="btn"
            href={qs({ status: undefined })}
            aria-current={!status ? "true" : undefined}
          >
            all
          </a>
          <a
            className="btn"
            href={qs({ status: "cryo" })}
            aria-current={status === "cryo" ? "true" : undefined}
          >
            cryo
          </a>
          <a
            className="btn"
            href={qs({ status: "active" })}
            aria-current={status === "active" ? "true" : undefined}
          >
            active
          </a>
        </div>
      </div>

      <RuleHead as="h2" aside={<span className="dim mono">{renderedAt()}</span>}>
        {rows.length === 1 ? "1 member" : `${rows.length} members`}
      </RuleHead>
      <Scroller label="Members" tall>
        <table className="log log--dense log--sticky-head log--sticky-col">
          {/* The scanning anchor gets the surplus. Every other column holds a
              single badge, date, or button pair, so `width: 1%` collapses it to
              its own content and hands the leftover width to Name. Before the
              tier controls moved into the drawer, Tier was the widest column in
              the table purely because it carried a stack of buttons. */}
          <colgroup>
            <col />
            <col className="log__col--fit" span={COLUMN_COUNT - 1} />
          </colgroup>
          <thead>
            <tr>
              {SORTS.map((s) => (
                <th
                  key={s.key}
                  scope="col"
                  aria-sort={
                    sort === s.key ? (dir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  {/* Both glyphs are aria-hidden because aria-sort on the
                      header already carries the state; they keep the link's
                      accessible name stable at just the column label.

                      The inactive `↕` is not decoration: four of these ten
                      columns sort and six do not, and at rest the two kinds of
                      header were pixel-identical — nothing said a column could
                      be sorted until the pointer was already on it, which a
                      keyboard or touch user never discovers. */}
                  <a
                    href={qs({
                      sort: s.key,
                      // Active column: toggle. Inactive: open the way the
                      // column is worth reading (`SORT_OPENS`), rather than
                      // ascending for everything — which cost a second click
                      // on the one column where ascending is never the
                      // question being asked.
                      dir:
                        sort === s.key
                          ? dir === "asc"
                            ? "desc"
                            : "asc"
                          : SORT_OPENS[s.key],
                    })}
                  >
                    {s.label}
                    {sort === s.key ? (
                      <span aria-hidden="true"> {dir === "asc" ? "↑" : "↓"}</span>
                    ) : (
                      <span aria-hidden="true" className="log__sortable">
                        {" "}
                        ↕
                      </span>
                    )}
                  </a>
                </th>
              ))}
              {FIXED_COLUMNS.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <ConfirmArmScope>
              {rows.map((r) => (
                <AccountRow key={r.accountId} r={r} cfg={cfg} listSearch={listSearch} />
              ))}
              {rows.length === 0 && (
                <tr>
                  {/* The cell spans every column, so under this table's width
                      its box is far wider than the scroller and the message
                      centred out at x≈375 — entirely off screen at 320px, with
                      the start fade deliberately suppressed on sticky-column
                      tables so nothing cued scrolling to it either. The inner
                      span pins to the scrollport's left edge and wraps within
                      it; the cell keeps its layout width. Same element and
                      same reason as /admin/audit's empty state. */}
                  <td className="log__empty" colSpan={COLUMN_COUNT}>
                    <span className="log__empty-text">
                      {filtered
                        ? "No members match this filter."
                        : "No accounts yet. They appear here after someone signs in with EVE."}
                    </span>
                  </td>
                </tr>
              )}
            </ConfirmArmScope>
          </tbody>
        </table>
      </Scroller>
    </main>
  );
}

/**
 * The token cell's two outputs, derived together.
 *
 * `mainDead` — whether the character that went dark is the account's main — is
 * not only a colour input: it is the one token fact that has to be readable as
 * text. Two accounts with the same 4/5 summary and the same single dead
 * character rendered byte-identical text and differed only in the tone of the
 * badge, which is colour carrying meaning on its own (WCAG 1.4.1).
 *
 * Returned as a pair rather than computed by two functions the caller has to
 * keep in step. The tone and the `main dead` marker are two renderings of one
 * fact, so the only way they can disagree is if something lets them be derived
 * separately — and a `tokenTone(r, mainDead)` taking the boolean as an argument
 * is exactly that something. Here there is no second input to get wrong.
 *
 * Tone itself is proportional, not absolute. A long-dead token on a forgotten
 * alt is a routine standing state, not an alarm; the one case that actually
 * means the account is cut off is the main going dark, so that is the only
 * thing that forces red on its own. Short of that, red is reserved for zero
 * healthy tokens (every character is dead or needs re-auth), and amber covers
 * everything short of that. "nothing reads as punishment" (PRODUCT.md)
 * otherwise fails on any account with one stale alt.
 */
function tokenState(r: AdminAccountRow): {
  tone: "ok" | "warn" | "bad" | "off";
  mainDead: boolean;
} {
  const main = r.characters.find((c) => c.isMain);
  const mainDead =
    main !== undefined &&
    (main.tokenStatus === "invalid" || main.tokenStatus === "missing");

  const tokens = r.tokenSummary;
  const tone =
    tokens.total === 0
      ? "off"
      : tokens.healthy === 0 || mainDead
        ? "bad"
        : tokens.dead > 0 || tokens.needsReauth > 0
          ? "warn"
          : "ok";

  return { tone, mainDead };
}

/** The token cell's per-character badge, admin's finer-grained view of the
 *  same states the member page's Token column shows in summary. */
function TokenState({ c }: { c: AdminCharacterRow }) {
  if (c.tokenStatus === "invalid") return <Status tone="bad">invalid</Status>;
  if (c.tokenStatus === "missing") return <Status tone="bad">missing</Status>;
  if (c.tokenStatus === "needs_reauth")
    return <Status tone="warn">re-auth needed</Status>;
  if (c.needsReauthForScopes) return <Status tone="warn">scope shortfall</Status>;
  return <Status tone="ok">valid</Status>;
}

function AccountRow({
  r,
  cfg,
  listSearch,
}: {
  r: AdminAccountRow;
  cfg: Config;
  listSearch: string;
}) {
  const tokens = r.tokenSummary;
  const { tone: tokenBadgeTone, mainDead } = tokenState(r);

  // Shown once above the crew table rather than once per character on the map:
  // the ACL observation is a single job run, so every character on it shares
  // the same timestamp, and repeating it per row is the same information N
  // times over.
  const mapObservedAt = r.characters.reduce<Date | null>(
    (latest, c) =>
      c.mapObservedAt && (!latest || c.mapObservedAt > latest) ? c.mapObservedAt : latest,
    null,
  );

  // The pinned first column exists so a 28px tier control is never pressed with
  // nothing on screen saying whose it is, and "no main" was the same string on
  // every account that lacks one — identifying the row as well as no pin at all.
  // Fall through to something that actually names it.
  //
  // Every name here reaches this page as a character's `name` — `mainName` is
  // one too (services/account-view.ts) — and ESI has handed back names that are
  // empty or whitespace. Whitespace is the dangerous shape: it is truthy, so it
  // takes the identity slot and then renders as nothing, which is the one
  // outcome this column exists to prevent. Normalize once here so the pick, the
  // visible label and the accessible name cannot disagree about whether a name
  // names anything.
  const named = (n: string | null | undefined) => n?.trim() || null;
  const mainName = named(r.mainName);
  // The service returns characters unordered, so pick by name rather than by
  // array position, or the identity of a row changes between two renders of the
  // same data. Blank names are dropped rather than sorted: "" sorts first, so a
  // whitespace-only name would otherwise win the pick.
  const firstName = mainName
    ? null
    : [...r.characters]
        .flatMap((c) => named(c.name) ?? [])
        .sort((a, b) => a.localeCompare(b))[0];
  const idLabel = `acct ${r.accountId.slice(0, 8)}`;
  // The same identity as one string, for accessible names with nowhere to put
  // markup. Both operands are already normalized to a real name or null, so the
  // fallback cannot walk past a blank into `aria-label="Note for "` — a row
  // with no identity at all, in the column whose whole job is saying whose tier
  // is about to change.
  const identity = mainName ?? firstName ?? idLabel;
  // Disclosure (as="row") puts its label on the toggle as `aria-label`, which
  // overrides the visible text, so this mirrors that text verbatim — an
  // accessible name has to stay a superset of its visible label (WCAG 2.5.3).
  // That includes the "(+N)" alt count in the summary below: without it a
  // voice-control user reading "Sam Alt no main plus one" off the screen
  // matches nothing, since the spoken name stops before the count.
  const altCount = r.characters.length > 1 ? ` (+${r.characters.length - 1})` : "";
  const pinLabel = `${firstName ? `${identity} ·no main` : identity}${altCount}`;

  return (
    <Disclosure
      as="row"
      label={pinLabel}
      colSpan={COLUMN_COUNT}
      summary={
        <>
          {mainName || (
            <>
              {firstName || <span className="mono">{idLabel}</span>}
              {/* Marked in text, not by styling: the row is named by a
                  character that is not its main, and that distinction has
                  to be perceivable without seeing the dimming. */}
              {firstName && <span className="mono dim-ink"> ·no main</span>}
            </>
          )}
          {r.characters.length > 1 && ` (+${r.characters.length - 1})`}
        </>
      }
      cells={
        <>
          <td>
            <Tier tier={r.tier} locked={r.tierLocked} />
          </td>

          <td>
            {r.status === "cryo" ? (
              <Status tone="warn">cryo</Status>
            ) : (
              <Status tone="off">active</Status>
            )}
          </td>

          <td className="mono nowrap">{fmt(r.tierChangedAt)}</td>

          <td>
            <div className="stack">
              <Status tone={tokenBadgeTone}>
                {tokens.healthy}/{tokens.total} ok
              </Status>
              {/* First, and undimmed. This is the severe case — the account is
                  cut off, not merely ragged — so it leads the sub-lines, and it
                  is told apart from them by lightness and by different words
                  rather than by colour, which the badge above already spends.
                  Without it, "4/5 ok · 1 dead" reads identically whether the
                  dead token is a forgotten alt or the main. */}
              {mainDead && <span className="mono nowrap">main dead</span>}
              {tokens.needsReauth > 0 && (
                <span className="dim mono nowrap">{tokens.needsReauth} re-auth</span>
              )}
              {tokens.dead > 0 && (
                <span className="dim mono nowrap">{tokens.dead} dead</span>
              )}
            </div>
          </td>

          <td>
            {r.discordLinked ? (
              // Already inside the tbody-wide ConfirmArmScope (:282), like every
              // other confirm in this row. Names its row for the same reason the
              // Actions cell does: "unlink" read out of context says whose Discord
              // is about to be disconnected to nobody.
              //
              // No `linked` token beside it. The else-branch renders `none`
              // because an unlinked row has no control and the cell would
              // otherwise be empty; a linked row has the button, and the verb
              // answers the column's question on its own. Two objects per linked
              // row against one per unlinked row was the asymmetry that made
              // this cell read as cluttered — and this column is scanned far
              // more often than it is used (PRODUCT.md principle 3).
              <>
                {/* Handle only. The account page pairs a display name with the
                    handle; here the row's identity is already the member's EVE
                    name, pinned in the first column, so a second soft name for
                    the same person is noise in a column being scanned for
                    something else. The @handle is the one thing this screen
                    cannot already tell an admin — it is what they need to go
                    find the person in the guild, and what tells them the link
                    points where they think it does before disconnecting it.

                    One line with the button, not stacked above it: two lines
                    per linked row against one per unlinked row is the same
                    asymmetry #115 removed from this cell, and it would set the
                    row height for the whole table. `.discord-cell` wraps rather
                    than overflowing, so a long handle at 320px drops the button
                    to a second line for that row alone.

                    Null until a roles sync has seen the member (and forever for
                    someone who has left the guild), in which case this renders
                    exactly what shipped in #115: the button alone. */}
                <div className="discord-cell">
                  {r.discordUsername && (
                    <span className="dim mono">@{r.discordUsername}</span>
                  )}
                  <form
                    action={unlinkDiscordAction.bind(
                      null,
                      r.accountId,
                      listSearch,
                      identity,
                    )}
                  >
                    <ConfirmSubmit
                      className="btn btn--micro"
                      armedClassName="btn btn--micro btn--danger"
                      label="unlink"
                      restName={`unlink Discord for ${identity}`}
                      confirmName={`confirm unlink Discord for ${identity}`}
                      describedBy={`discord-unlink-cost-${r.accountId}`}
                    />
                  </form>
                </div>
                {/* Hidden always, rather than revealed on arm like the account
                    page's `ConfirmCost`. That component reads scope-level arm
                    state, and this scope is the whole tbody — three confirms per
                    row (unlink, revoke/promote, freeze/wake) times every row.
                    Arming any one of them would reveal every row's cost. Its own
                    doc says as much. Switch to it once it takes a per-control
                    id; giving this one cell its own ConfirmArmScope to get there
                    would instead break the single-armed-control-per-table
                    invariant the shared scope exists to hold.

                    Revealing on arm is also wrong for a table row on its own
                    terms: the hint would reflow the row, and ConfirmSubmit
                    disarms on pointerleave for mouse users
                    (confirm-submit.tsx:162-170), so the button sliding out from
                    under a stationary pointer would disarm the control the
                    admin just armed. Absolute positioning is no escape —
                    `.scroller` is a scroll container, so the hint would extend
                    the scrollable area rather than float clear of it.
                    `.visually-hidden` is itself `position: absolute`, so this
                    span costs no row height, which matters when scanning is the
                    primary act (PRODUCT.md principle 3) and this renders once
                    per account.

                    "queues removal", not "removes": unlinkDiscord ends in
                    enqueueSync (services/discord-link.ts:135-138) and the roles
                    come off in the worker. The account page keeps the same verb
                    for the same reason. */}
                <span
                  className="visually-hidden"
                  id={`discord-unlink-cost-${r.accountId}`}
                >
                  Unlinking queues removal of the Discord roles authGD manages for this
                  member.
                </span>
              </>
            ) : (
              <Status tone="off">none</Status>
            )}
          </td>

          <td>
            {/* Sweep item #3. Reads `mapStatus` (desired vs. observed), NOT the
                old `mapCount`/`tokens.total` pair: the denominator has to be
                the set the wanderer job actually wants on the ACL, not every
                character the account has. Against the total, a member with a
                biomassed alt sat permanently amber with nothing to fix, and —
                the costly direction — an alumni account whose characters were
                never removed from the ACL showed a healthy count, hiding the
                one failure on this row that still grants map access to someone
                who no longer has a tier.

                Three outcomes, and a surplus must not read like a shortfall:
                both are `warn`, so the TEXT is what separates them ("2 extra"
                vs "1/3"). Not `bad` — DESIGN.md reserves `--signal-bad` for
                destructive acts, and per PRODUCT.md nothing that is merely
                out of sync should read as punishment. A surplus prints the
                overage alone because the in-sync denominator can be 0 (the
                alumni case), which has no ratio worth printing. */}
            {r.mapStatus.desired === 0 && r.mapStatus.observed === 0 ? (
              <Status tone="off">off</Status>
            ) : r.mapStatus.observed > r.mapStatus.desired ? (
              <Status tone="warn">
                {r.mapStatus.observed - r.mapStatus.desired} extra
              </Status>
            ) : (
              <Status tone={r.mapStatus.observed === r.mapStatus.desired ? "ok" : "warn"}>
                {r.mapStatus.observed}/{r.mapStatus.desired}
              </Status>
            )}
          </td>

          <td className="mono nowrap">{fmt(r.lastLoginAt)}</td>

          <td>
            {r.isAdmin ? <Status>admin</Status> : <Status tone="off">member</Status>}
          </td>

          {/* One grade, one group. Revoke and sync now are both row actions; before,
              revoke was a bordered danger button and sync now was bare text, which
              read as one button with a broken half rather than two peers.

              All four names here name their row, the way the drawer's controls
              already do: on a table with one row per account the visible word
              names the verb and nothing else, and "grant" read out of its row
              does not say whose admin is about to change. Each name leads with
              the visible label, so speech input still reaches the control by
              what is written on it (WCAG 2.5.3). */}
          <td>
            <div className="btn-row btn-row--tight">
              {r.isAdmin ? (
                <form
                  action={demoteAdminAction.bind(null, r.accountId, listSearch, identity)}
                >
                  <ConfirmSubmit
                    className="btn btn--micro btn--danger"
                    label="revoke"
                    restName={`revoke admin for ${identity}`}
                    confirmName={`confirm revoke admin for ${identity}`}
                  />
                </form>
              ) : (
                <form
                  action={promoteAdminAction.bind(
                    null,
                    r.accountId,
                    listSearch,
                    identity,
                  )}
                >
                  {/* Armed, like its own opposite beside it. `revoke` has
                      confirmed since the arming pass, on the reasoning
                      recorded at `docs/settled-design-decisions.md:32` — it is
                      "too easy to hit a destructive action by accident
                      scanning a dense table". That argument is about the
                      density of the table, not about the direction of the
                      verb, and it applies here at least as hard: `grant` is
                      the half that cannot be undone by the person who
                      mis-pressed it. A stray click one row off hands an
                      arbitrary member the power to change every tier and
                      revoke every other admin, including the admin who
                      slipped. `revoke` is recoverable — press `grant` again.

                      Name and visible label are unchanged (`grant`, "grant
                      admin to X"), so speech input still reaches the rest
                      state by what is written on it (WCAG 2.5.3); the armed
                      state gets its own name the way every other
                      `ConfirmSubmit` on this page does. No `armedClassName`:
                      arming a *constructive* action must not paint it as
                      destructive, so the grade stays put and only the word
                      changes — the one place this control deliberately
                      differs from the `revoke` it mirrors.

                      No `pendingLabel`, unlike the plain `Submit`s around it.
                      `ConfirmSubmit` reserves its width from
                      `max(label, confirmLabel)` (`confirm-submit.tsx:291`) and
                      cannot see a pending string (the reason is recorded at
                      `confirm-submit.tsx:242-250`), so "granting…" (9)
                      against a 7-character reservation would widen the button
                      mid-flight. `aria-busy` still carries the in-flight
                      state, which is what every other `ConfirmSubmit` on this
                      page relies on. */}
                  <ConfirmSubmit
                    className="btn btn--micro"
                    label="grant"
                    restName={`grant admin to ${identity}`}
                    confirmName={`confirm grant admin to ${identity}`}
                  />
                </form>
              )}
              <form
                action={syncAccountAction.bind(null, r.accountId, listSearch, identity)}
              >
                <Submit
                  className="btn btn--micro nowrap"
                  pendingLabel="queueing…"
                  aria-label={`sync now for ${identity}`}
                >
                  sync now
                </Submit>
              </form>
            </div>
          </td>
        </>
      }
    >
      {/* The admin opened the row to act, not to read a manifest: tier, cryo,
          and note come first, and the crew list — the thing that scrolls
          longest on an eight-alt account — sits below them. */}
      <div className="drawer__controls">
        <section className="drawer__group">
          <span className="drawer__label">Set tier</span>
          {/* `ConfirmGroup` (confirm-group.tsx), not a plain `<form>` per
              button: this action lives in the drawer, and a redirect here
              would reset the drawer's own open/closed state (an e2e run of
              the earlier, redirect-based version of this fix caught it —
              the drawer closed on the very first tier change). One shared
              confirmation slot per group, not one per button: only one of
              these mutually-exclusive tier presses can ever land at a time,
              and a `Notice` inside each button's own `.inline-form` would
              also grow that button's box, widening this `<td>`'s `1%`-width
              column for every row in the table. */}
          <ConfirmGroup>
            <div className="btn-group">
              {r.tier === "pending" ? (
                <>
                  {/* The row goes AFTER the visible label, not into the middle of
                      it: "Approve as Alumni" has to survive in the accessible name
                      as one contiguous run, or a speech-control user saying what
                      is written on the button matches nothing (WCAG 2.5.3). Same
                      convention as the Actions cell above. */}
                  {APPROVE_TIERS.map((t) => (
                    <ConfirmingForm
                      key={t}
                      action={approveAction.bind(
                        null,
                        r.accountId,
                        t,
                        listSearch,
                        identity,
                      )}
                      className="inline-form"
                    >
                      <Submit
                        className="btn btn--micro"
                        pendingLabel="approving…"
                        aria-label={`Approve as ${tierLabel(t)} for ${identity}`}
                      >
                        Approve as {tierLabel(t)}
                      </Submit>
                    </ConfirmingForm>
                  ))}
                </>
              ) : (
                TIERS.map((t) => {
                  const selected = r.tier === t;
                  return (
                    <ConfirmingForm
                      key={t}
                      action={setTierAction.bind(
                        null,
                        r.accountId,
                        t,
                        listSearch,
                        identity,
                      )}
                      className="inline-form"
                    >
                      {/* One `ConfirmSubmit` for all three tiers, selected or
                          not: `setTierManual` locks the account on a press to
                          the tier it already holds just as much as on a press
                          to a different one (admin-accounts.ts) — that IS the
                          pin an admin reaches for before a member leaves the
                          alliance — so the selected chip needs the same arm
                          step as the other two, not an exemption from it.
                          `ariaPressed`/`disabled` (confirm-submit.tsx) are
                          what let this one control also carry the "you are
                          already here" semantics the CSS keys off
                          `aria-pressed` for, so the chip's rest-state
                          appearance stays exactly what it was.

                          `disabled` only for the selected chip once the
                          account is ALREADY locked: at that point every OTHER
                          tier press still needs to work (moving a locked
                          account to a different tier is a real, one-click
                          change, same as before), but re-submitting the tier
                          already held and already locked is the true no-op
                          `setTierManual`'s own guard short-circuits — nothing
                          to arm, nothing to press.

                          `confirm={!r.tierLocked}` for all three: once
                          locked, no tier press here does anything new to the
                          membership job's reach (it already isn't touching
                          this account), so there's nothing fresh to arm
                          against and every press stays the single click it
                          was before this fix. `describedBy` points at the
                          same per-row lock note for the same reason — it's
                          about what THIS press does to an unlocked account,
                          not about which tier word is on the button.

                          Same accessible-name reasoning as every other
                          control in this drawer: the visible text stays the
                          bare tier word (WCAG 2.5.3), and `restName`/
                          `confirmName` carry the row identity a
                          screen-reader or speech-input admin can't otherwise
                          reach out of visual context — the exact audience
                          derole-don't-boot exists to protect. */}
                      <ConfirmSubmit
                        className="btn btn--micro"
                        label={tierLabel(t)}
                        restName={`Set ${identity} to ${tierLabel(t)}`}
                        confirmName={`confirm set ${identity} to ${tierLabel(t)}`}
                        describedBy={
                          r.tierLocked ? undefined : tierLockNoteId(r.accountId)
                        }
                        confirm={!r.tierLocked}
                        ariaPressed={selected}
                        disabled={selected && r.tierLocked}
                      />
                    </ConfirmingForm>
                  );
                })
              )}
              {r.tierLocked && (
                <ConfirmingForm
                  action={returnToAutoAction.bind(
                    null,
                    r.accountId,
                    listSearch,
                    identity,
                  )}
                  className="inline-form"
                >
                  <Submit
                    className="btn btn--micro"
                    pendingLabel="resetting…"
                    aria-label={`return ${identity} to auto tier`}
                  >
                    auto
                  </Submit>
                </ConfirmingForm>
              )}
            </div>
          </ConfirmGroup>
          {/* Static, not `ConfirmCost`'s reveal-on-arm: #111/#112 already
              established that a sentence appearing inside a `td` on THIS
              table moves the armed button out from under the pointer and
              disarms it before it can be read. Rendered unconditionally
              whenever a press here can still lock the account — and gone
              entirely once `tierLocked` is already true, where none of the
              three presses above can newly cause it. Not shown on a `pending`
              row either: `approveAccount` has its own, already-documented lock
              rule (alumni unlocked, associate locked), and this sentence is
              about `setTierManual`'s rule, not that one.

              BELOW the group, not above it, and the position is load-bearing:
              `.drawer__controls` lays its sections out as columns whose control
              rows line up across, and prose above the buttons pushes this
              column's `.btn-group` a full row below the freeze control it is
              meant to sit level with (e2e/admin.spec.ts measures exactly that).
              Nothing is lost by moving it — it is still adjacent and still read
              before any press, the buttons carry it as `aria-describedby` so a
              screen reader hears it WITH the control regardless of DOM order,
              and `set by` below already establishes prose-after-the-group as
              this section's shape. */}
          {r.tier !== "pending" && !r.tierLocked && (
            <p className="dim drawer__note" id={tierLockNoteId(r.accountId)}>
              Setting a tier here locks it: the membership job stops raising or lowering
              it automatically (including moving it to {tierLabel("alumni")} if this
              member leaves the alliance) until you press auto.
            </p>
          )}
          {r.tierChangedByName && (
            <span className="dim mono">set by {r.tierChangedByName}</span>
          )}
        </section>

        <section className="drawer__group">
          <span className="drawer__label">Cryo</span>
          {/* Same reasoning as the tier group above: this action lives in the
              drawer too, so it uses `ConfirmingForm`/`ConfirmGroup` rather
              than a redirect, to leave the drawer's own open state alone. */}
          <ConfirmGroup>
            <ConfirmingForm
              action={setStatusAction.bind(
                null,
                r.accountId,
                r.status === "cryo" ? "active" : "cryo",
                listSearch,
                identity,
              )}
            >
              {r.status === "cryo" ? (
                <Submit
                  className="btn btn--micro"
                  pendingLabel="waking…"
                  aria-label={`wake ${identity}`}
                >
                  wake
                </Submit>
              ) : (
                <ConfirmSubmit
                  className="btn btn--micro"
                  armedClassName="btn btn--micro btn--danger"
                  label="freeze"
                  restName={`freeze ${identity}`}
                  confirmName={`confirm freeze ${identity}`}
                />
              )}
            </ConfirmingForm>
          </ConfirmGroup>
          {r.status === "cryo" && (
            <span className="dim mono nowrap">since {fmt(r.statusChangedAt)}</span>
          )}
        </section>

        <section className="drawer__group">
          <span className="drawer__label">Note</span>
          <NoteForm
            action={saveNoteAction.bind(null, r.accountId, listSearch)}
            identity={identity}
            defaultValue={r.statusNote ?? ""}
          />
        </section>

        {/* "Why is this person's role wrong?" is the question PRODUCT.md gives
            the audit log a minute to answer, and until now the only route into
            it was the nav item — so answering it started by retyping a name
            from memory into the filter.

            In the drawer rather than as an eleventh column: the table is
            already ten columns wide and width-constrained at 320px, and this is
            a follow-up action on one account, not a value to scan down.

            Filtered by NAME when the row has one, not by account id.
            `resolveFilterIdentity` (services/audit.ts) expands a name into the
            account, every character carrying it, AND the linked discord id —
            all three of the identifier forms a person's target rows are spread
            across. A bare uuid is treated as `kind: "raw"` and matches only the
            rows that happen to name the account itself, which is strictly less
            of the person's history. The uuid is the fallback for a row with no
            character name at all, where it is the only handle that exists. */}
        <section className="drawer__group">
          <span className="drawer__label">History</span>
          <a
            className="btn btn--micro"
            href={`/admin/audit?${new URLSearchParams({
              target: mainName ?? firstName ?? r.accountId,
            }).toString()}`}
            aria-label={`audit log for ${identity}`}
          >
            audit log
          </a>
        </section>
      </div>

      <section className="drawer__crew">
        <span className="drawer__label">Crew</span>
        {mapObservedAt && (
          <span className="dim mono">
            Map observed {mapObservedAt.toISOString().slice(0, 16)}Z
          </span>
        )}
        {/* One label for the manifest, like `Map observed` above — but derived
            differently: `mapObservedAt` reduces newest-wins because the ACL
            observation is a single job run, while `locationAsOf` is the OLDEST
            reading because location has a per-character clock. See
            buildManifestLocations in services/account-view.ts. */}
        {r.locationAsOf && (
          <span className="dim mono">
            Locations as of {r.locationAsOf.toISOString().slice(0, 16)}Z
          </span>
        )}
        <Scroller label={`${identity} crew`}>
          <table className="log log--crew">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Token</th>
                <th scope="col">Standings</th>
                <th scope="col">Map</th>
              </tr>
            </thead>
            <tbody>
              {r.characters.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="stack">
                      <span className="char">
                        {c.name}{" "}
                        {c.isMain && <strong className="char__main">(main)</strong>}
                      </span>
                      <CharacterLocation location={c.location} stale={c.locationStale} />
                    </div>
                  </td>
                  <td>
                    <div className="stack">
                      <TokenState c={c} />
                      {c.affiliationInvalid && (
                        <span className="dim">affiliation invalid</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="stack">
                      <ContactState
                        result={c.contactSyncResult}
                        target={isContactsTarget({
                          tier: r.tier,
                          affiliationInvalid: c.affiliationInvalid,
                        })}
                      />
                      {/* Gated on the same predicate the token is: splitting the
                          prose out of ContactState moved its `!target` early
                          return with it, and a non-target character holding a
                          stale result from when it was a target would otherwise
                          read "— not managed" and then explain how to fix it. */}
                      {hasContactRemedy(
                        c.contactSyncResult,
                        isContactsTarget({
                          tier: r.tier,
                          affiliationInvalid: c.affiliationInvalid,
                        }),
                      ) && (
                        <ContactRemedy
                          result={c.contactSyncResult}
                          detail={c.contactSyncDetail}
                          label={cfg.standings.label}
                        />
                      )}
                    </div>
                  </td>
                  <td>
                    {c.mapObservedAt ? (
                      <Status tone="ok">on</Status>
                    ) : (
                      <Status tone="off">off</Status>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      </section>
    </Disclosure>
  );
}
