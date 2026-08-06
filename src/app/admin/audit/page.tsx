import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getDb } from "@/db";
import { getConfig } from "@/config";
import { requireAdminPage } from "@/lib/admin-guard";
import { AUDIT_PAGE_SIZE, queryAuditLog, resolveFilterIdentity } from "@/services/audit";
import type { FilterResolution, ResolvedAuditRow } from "@/services/audit";
import { RuleHead, Json, Notice, Scroller } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { formatAgo } from "@/app/_components/format-ago";
import { renderedAt } from "@/app/_components/utc-time";
import { summarizeDetails } from "@/app/admin/audit/summarize";
import { tierLabel } from "@/app/_components/labels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit log",
};

/** The exact UTC instant, `2026-08-03 22:19:24`. */
function stamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Collapses a possibly-repeated query param to one value, last wins: a
 * duplicate arises in practice by appending `&actor=x` to a URL that already
 * has one, so the appended value is the intent. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/**
 * A link that sets one filter field to `value`, keeps every other active
 * filter, and drops `before` -- clicking a name narrows the query, so the
 * keyset cursor from the previous, wider query is meaningless and would page
 * into the middle of the new result set.
 */
function filterHref(
  params: Record<string, string | undefined>,
  field: "actor" | "target" | "action",
  value: string,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "before" && k !== field) q.set(k, v);
  }
  q.set(field, value);
  return `/admin/audit?${q.toString()}`;
}

/**
 * The raw id behind a resolved name, for anyone not using a pointer. The cells
 * put it in `title`, which is hover-only: VoiceOver and TalkBack do not
 * announce it, touch cannot reach it, and it is genuinely different
 * information from the name beside it rather than a restatement of it. So it
 * is also stated in text a screen reader reads out, clipped to nothing.
 *
 * Only where the visible text and the raw value actually differ. `system`, the
 * reserved literals and an unresolved id all render the raw value already, and
 * repeating it there would announce every one of them twice.
 */
function RawId({ id }: { id: string }) {
  return <span className="visually-hidden">{` (id ${id})`}</span>;
}

/**
 * The actor column. `system` is a job, not a person, so it gets the monospace
 * dimmed treatment used for machine output elsewhere in this table -- a
 * font-family signal, not a colour-only one. A resolved human name renders
 * plain; an unresolved actor falls back to the raw id in mono so it still
 * reads as "an id", not as a name that happened not to load.
 *
 * Resolved values (and `system`) link to themselves as a filter, so the admin
 * never retypes what is already on screen. Unresolved ids stay inert: they are
 * already exactly filterable by pasting, and linking them would add a tab stop
 * per row for nothing.
 */
function ActorCell({
  r,
  params,
}: {
  r: ResolvedAuditRow;
  params: Record<string, string | undefined>;
}) {
  if (r.actorKind === "system") {
    return (
      <a
        className="mono dim cell-link"
        href={filterHref(params, "actor", "system")}
        title={r.actor}
      >
        system
      </a>
    );
  }
  if (r.actorName) {
    return (
      <a
        className="ellipsis-cell cell-link"
        href={filterHref(params, "actor", r.actorName)}
        title={r.actor}
      >
        {r.actorName}
        <RawId id={r.actor} />
      </a>
    );
  }
  return (
    <span className="mono ellipsis-cell" title={r.actor}>
      {r.actor}
    </span>
  );
}

/**
 * The target column. A literal (e.g. the string "all") reads as what it is,
 * not as a mystery id; an unresolved reference stays in mono so it still
 * reads as raw data rather than a name. Every branch also gets
 * `ellipsis-cell`: a resolved display name, a raw UUID, and a Discord
 * snowflake all lack natural break points, and any of them left unbounded
 * wraps and inflates the row height exactly like the actor column used to.
 *
 * A name links to the NAME, not to this row's raw id -- one person's target
 * rows are spread across an account uuid, a character id and a discord
 * snowflake, and filtering by whichever one this row happens to carry would
 * hide the other two thirds of their history.
 */
function TargetCell({
  r,
  params,
}: {
  r: ResolvedAuditRow;
  params: Record<string, string | undefined>;
}) {
  if (r.targetName) {
    return (
      <a
        className="ellipsis-cell cell-link"
        href={filterHref(params, "target", r.targetName)}
        title={r.target}
      >
        {r.targetName}
        <RawId id={r.target} />
      </a>
    );
  }
  if (r.targetKind === "literal") {
    return (
      <a
        className="mono dim ellipsis-cell cell-link"
        href={filterHref(params, "target", r.target)}
        title={r.target}
      >
        {r.target}
      </a>
    );
  }
  return (
    <span className="mono ellipsis-cell" title={r.target}>
      {r.target}
    </span>
  );
}

/**
 * Both ends of the keyset pager.
 *
 * Renders whenever there is a full page OR a valid cursor is set. The old
 * condition was `rows.length === AUDIT_PAGE_SIZE` alone, which made the last
 * page a dead end: at exactly AUDIT_PAGE_SIZE rows there is a page 2, page 2
 * has fewer rows, so page 2 rendered no pager at all -- no way back, and no
 * indication you were not looking at the newest entries.
 *
 * `hasLatest` is passed in rather than read off `params.before` here: a
 * malformed cursor (`?before=abc`) is truthy but is discarded by the query, so
 * reading the raw param would offer a `← Latest` control that leads to the
 * result set already on screen.
 *
 * `← Latest` reuses `filterHrefBase`, so it keeps the active filter and drops
 * only the cursor.
 *
 * Both labels carry a visually-hidden qualifier. "Older" alone is not a link
 * purpose once the arrow is `aria-hidden` (WCAG 2.4.4), and a screen reader
 * listing links off this page would otherwise get two bare directions.
 */
function Pager({
  rows,
  hasLatest,
  older,
  filterHrefBase,
  top = false,
}: {
  rows: ResolvedAuditRow[];
  hasLatest: boolean;
  older: URLSearchParams;
  filterHrefBase: string;
  top?: boolean;
}) {
  const hasOlder = rows.length === AUDIT_PAGE_SIZE;
  if (!hasOlder && !hasLatest) return null;
  return (
    <div className={`btn-row pager${top ? " pager--top" : ""}`}>
      {hasLatest && (
        <a className="btn" href={filterHrefBase}>
          <span aria-hidden="true">←</span> Latest
          <span className="visually-hidden"> entries</span>
        </a>
      )}
      {hasOlder && (
        <a className="btn" href={`/admin/audit?${older.toString()}`}>
          Older<span className="visually-hidden"> entries</span>{" "}
          <span aria-hidden="true">→</span>
        </a>
      )}
    </div>
  );
}

/** The ids to filter by, or undefined when the field isn't filtered at all.
 * A `kind: "none"` resolution yields an EMPTY list, never `undefined`:
 * `queryAuditLog` reads `undefined` as "this field is unfiltered" and an empty
 * list as "resolved to nothing", so failing closed here keeps an unmatched name
 * returning zero rows even if the caller's short-circuit below is ever
 * refactored away. The alternative failure mode is the bad one -- a filter the
 * admin believes is applied silently showing them everything. */
function idsOf(r: FilterResolution | null): string[] | undefined {
  if (!r) return undefined;
  return r.kind === "none" ? [] : r.ids;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  // Next passes `string | string[]` for any param, and the page used to
  // declare only `string`. A repeated param (`?actor=a&actor=b`) then reached
  // `.trim()` on an array and took the whole page down with a 500.
  searchParams: Promise<{
    actor?: string | string[];
    action?: string | string[];
    target?: string | string[];
    before?: string | string[];
  }>;
}) {
  await requireAdminPage();
  const raw = await searchParams;
  // Trim the two name-resolvable filters. They are typed or pasted by hand,
  // and a trailing space off a copied uuid or name would otherwise fall
  // through to "no such name" rather than matching. Whitespace-only collapses
  // to absent. Normalized here, before anything reads `params`, so the chips,
  // the filter links and the pager all carry the same value the query used.
  // `action` is deliberately untouched: it is a prefix match whose semantics
  // are out of scope for this branch.
  const params = {
    actor: one(raw.actor)?.trim() || undefined,
    action: one(raw.action) || undefined,
    target: one(raw.target)?.trim() || undefined,
    before: one(raw.before),
  };
  const beforeId = params.before ? Number(params.before) : undefined;
  // The one place the cursor is judged valid, so the query, the past-the-end
  // state, the heading and the pager cannot disagree about it. `?before=abc`
  // is truthy but parses to NaN, and the query discards it and returns the
  // newest page -- anything reading the raw param would then label those rows
  // "older" and offer a way "back" to the page already on screen.
  const hasCursor = beforeId !== undefined && Number.isFinite(beforeId);

  const db = getDb();
  // Both filters resolve concurrently; each costs 0 queries when absent or
  // when the admin pasted a raw id.
  const [actorRes, targetRes] = await Promise.all([
    params.actor ? resolveFilterIdentity(db, "actor", params.actor) : null,
    params.target ? resolveFilterIdentity(db, "target", params.target) : null,
  ]);

  // A name that matched nothing guarantees zero rows, so don't scan audit_log
  // at all -- and remember WHICH field failed, since the fix differs.
  const unmatched = (
    [
      ["actor", actorRes],
      ["target", targetRes],
    ] as const
  ).filter(([, r]) => r?.kind === "none") as ReadonlyArray<
    readonly [string, { kind: "none"; name: string }]
  >;

  const rows: ResolvedAuditRow[] = unmatched.length
    ? []
    : await queryAuditLog(db, {
        actorIds: idsOf(actorRes),
        action: params.action || undefined,
        targetIds: idsOf(targetRes),
        beforeId: hasCursor ? beforeId : undefined,
      });

  // The active filters, cursor dropped. Shared by the pager (which then adds
  // its own `before`) and the past-the-end exit link (which must not), so the
  // two round-trip through the same params instead of drifting apart.
  const filterParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v && k !== "before") filterParams.set(k, v);
  const filterHrefBase = filterParams.toString()
    ? `/admin/audit?${filterParams.toString()}`
    : "/admin/audit";

  const older = new URLSearchParams(filterParams);
  if (rows.length > 0) older.set("before", String(rows[rows.length - 1].id));

  const now = Date.now();

  // tier -> role id in config; this table needs role id -> tier. Through
  // tierLabel(), because the value is rendered to an admin as a role's name:
  // a deployment that calls its members "Pilot" wants `+Pilot`, not `+member`.
  const roleNames = new Map(
    Object.entries(getConfig().discord.roleIds).map(([tier, id]) => [
      id,
      tierLabel(tier),
    ]),
  );
  const tierLabels = getConfig().tierLabels;

  const filtered = Boolean(params.actor || params.action || params.target);
  const activeFilters = [
    params.actor && `actor: ${params.actor}`,
    params.action && `action: ${params.action}`,
    params.target && `target: ${params.target}`,
  ].filter(Boolean) as string[];

  // One note per field whose name spans more than one account OR operation, so
  // a widened result never looks like a narrow one. Text, not colour.
  //
  // The threshold is the UNION, not either count alone: 1 account + 1
  // operation still warns, because that pair is exactly the conflation this
  // notice exists for -- the rows below are a mix of two unrelated subjects,
  // even though neither subject alone is ambiguous.
  const ambiguityNotes = (
    [
      ["actor", actorRes],
      ["target", targetRes],
    ] as const
  )
    .map(([field, r]) => {
      if (!r || r.kind !== "name") return null;
      const { accountCount, operationCount } = r;
      if (accountCount + operationCount <= 1) return null;
      const parts = [
        accountCount > 0 && `${accountCount} account${accountCount === 1 ? "" : "s"}`,
        operationCount > 0 &&
          `${operationCount} operation${operationCount === 1 ? "" : "s"}`,
      ].filter(Boolean);
      return `${field} "${r.name}" matches ${parts.join(" and ")}`;
    })
    .filter(Boolean) as string[];

  // The cursor ran past the end of a non-empty log, distinct from the log
  // (or the filtered subset of it) genuinely having zero rows. Mirrors the
  // priority `emptyMessage` below uses: an unmatched name still names the
  // field that failed, even if `before` also happens to be set.
  const pastEnd = !unmatched.length && hasCursor && rows.length === 0;

  // "older" whenever a valid cursor is set. Without it the heading read
  // `100+ entries` byte-identical on page 1 and page 7, so the one piece of
  // text describing the result set never admitted you had paged away from the
  // newest rows. It says which KIND of page this is; the `← Latest` control
  // beside it is the way back.
  const pageQualifier = hasCursor ? "older " : "";
  const countLabel =
    rows.length === 0
      ? pastEnd
        ? "No older entries"
        : filtered
          ? "No matching entries"
          : "No entries"
      : `${rows.length}${rows.length === AUDIT_PAGE_SIZE ? "+" : ""} ${pageQualifier}${
          filtered ? "matching entries" : "entries"
        }`;

  const emptyMessage: ReactNode = unmatched.length ? (
    // Each clause carries its own kind, not just the field label, because the
    // two columns can resolve to different kinds of thing. A target can be an
    // account, a character OR a payout operation (TargetCell links an
    // operation's name the same way it links a person's). An actor is never a
    // payout operation -- every logAudit call site writes an account uuid or
    // "system" to `actor`, so an operation uuid only ever reaches `target` --
    // and offering "operation" as a reason the actor filter came up empty
    // would send the admin looking in a place this column can never resolve
    // to.
    `No ${unmatched
      .map(
        ([field, r]) =>
          `${field === "target" ? "account, character or operation" : "account or character"} named "${r.name}" (${field})`,
      )
      .join(" or ")}.`
  ) : pastEnd ? (
    // The log is not empty, the cursor is simply past its end. Saying
    // "nothing has happened yet" here is false, and the `Older ->` button
    // is gone (it renders only on a full page), so this state had no exit
    // at all. The exit link keeps whatever filter got the admin here.
    <>
      Nothing older than this point.{" "}
      <a href={filterHrefBase}>Back to the latest entries</a>
    </>
  ) : filtered ? (
    // The actor/target asymmetry bites hardest here: a member appears as an
    // actor only for what they did to their own account, so "no results" for
    // an actor filter usually means the filter was pointed at the wrong
    // column, not that the log is silent about that person. The nudge only
    // appears when it can actually help -- when actor is set and target is
    // not.
    <>
      Nothing matches this filter.
      {params.actor && !params.target && (
        <>
          {" "}
          Members are usually the target of an entry, not the actor.{" "}
          <a href={filterHref({ action: params.action }, "target", params.actor)}>
            Search {params.actor} as a target
          </a>
          .
        </>
      )}
    </>
  ) : (
    "Nothing has happened yet."
  );

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="page__head">
        <h1>Audit log</h1>
        <p className="page__lede">
          Every state change, append only, newest first. Nothing here can be edited or
          removed.
        </p>
      </div>

      <RuleHead
        as="h2"
        aside={filtered && <span className="dim">{activeFilters.join(" · ")}</span>}
      >
        Filter
      </RuleHead>
      <form method="get" className="filter-form">
        {/* All three cells are a div with an explicit label rather than a
          wrapping <label>: the hint has to live outside the <label> or it gets
          concatenated into the input's accessible name ("Action prefix e.g.
          tier."), so it is wired up with aria-describedby instead.

          Actor and Target are not symmetrical and nothing on the page said so.
          A member reaches `actor` only for what they did to their own account
          -- linking or reauthing a character, changing their main, leaving
          cryo, linking Discord (accounts.ts, discord-link.ts). Everything done
          TO them is on `target` with `system` or an admin as the actor, and
          that is most of the log: every tier change, every derole, every token
          event. Guessing wrong gets you "Nothing matches this filter." --
          true, and completely misleading about whether the log has anything on
          that person. */}
        <div className="filter-form__cell">
          <label className="filter-form__label" htmlFor="filter-actor">
            Actor
          </label>
          <input
            id="filter-actor"
            className="field"
            name="actor"
            defaultValue={params.actor ?? ""}
            aria-describedby="filter-actor-hint"
          />
          <span className="filter-form__hint" id="filter-actor-hint">
            who did it
          </span>
        </div>
        <div className="filter-form__cell">
          <label className="filter-form__label" htmlFor="filter-action">
            Action prefix
          </label>
          <input
            id="filter-action"
            className="field"
            name="action"
            defaultValue={params.action ?? ""}
            aria-describedby="filter-action-hint"
          />
          <span className="filter-form__hint" id="filter-action-hint">
            e.g. tier.
          </span>
        </div>
        <div className="filter-form__cell">
          <label className="filter-form__label" htmlFor="filter-target">
            Target
          </label>
          <input
            id="filter-target"
            className="field"
            name="target"
            defaultValue={params.target ?? ""}
            aria-describedby="filter-target-hint"
          />
          <span className="filter-form__hint" id="filter-target-hint">
            who it happened to
          </span>
        </div>
        <div className="filter-form__cell filter-form__cell--actions">
          <div className="filter-form__actions">
            {/* Filter is routine and reversible, not the page's primary act —
                gold (btn--primary) is rationed for the one thing that is. */}
            <Submit className="btn">Filter</Submit>
            {filtered && (
              <a className="btn btn--quiet" href="/admin/audit">
                clear
              </a>
            )}
          </div>
        </div>
      </form>

      <RuleHead as="h2" aside={<span className="dim">{renderedAt()}</span>}>
        {countLabel}
      </RuleHead>
      {/* Hoisted out of the rule's aside, where it sat dimmed and joined to the
          render stamp by a middot and was typographically indistinguishable
          from it. "actor Zed matches 2 accounts" is not a freshness note: it
          says the rows below are a UNION of two people's histories, which is
          the one thing that can make this page answer the question wrongly
          while looking right. */}
      {/* Mounted unconditionally rather than `&&`-gated: this note appears and
          disappears as the filter changes, which is exactly the transition a
          live region exists to announce, and an `&&` would rebuild the region
          holding its text instead. See `Notice`'s docblock. */}
      <Notice tone="warn">
        {ambiguityNotes.length > 0 ? ambiguityNotes.join(" · ") : null}
      </Notice>
      {/* Also above the table. The bottom pager is roughly 300 tab stops past
          the top of a full page, so on a keyboard the only way to reach the
          next page was to traverse every link in every row. */}
      <Pager
        rows={rows}
        hasLatest={hasCursor}
        older={older}
        filterHrefBase={filterHrefBase}
        top
      />
      <Scroller label="Audit entries" tall>
        <table className="log log--audit log--sticky-head log--sticky-col">
          <caption className="visually-hidden">Audit log entries</caption>
          <colgroup>
            {/* Widths live in globals.css, not in `style` here: they have to
                change at the narrow breakpoint, and an inline width outranks a
                media query without `!important`. Five bare cols so the
                `col:nth-child()` rules have something to bind to. */}
            <col />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              {/* "(UTC)" qualifies an absolute stamp; below 40rem the cells
                  below read as elapsed time instead, and a heading claiming UTC
                  over "12h ago" is simply wrong. The exact instant is still in
                  each cell for assistive tech. */}
              <th scope="col">
                <span className="only-wide">At (UTC)</span>
                <span className="only-narrow">At</span>
              </th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Target</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dot = r.action.indexOf(".");
              const iso = r.at.toISOString();
              return (
                <tr key={r.id}>
                  {/* At 320px the 19ch ISO stamp was 196px of a 286px region —
                      69% — and it is the pinned column, so it painted over
                      whatever the scroll had brought alongside it. Below 40rem
                      it reads as elapsed time instead, which is the question a
                      phone-sized audit read is actually asking. The exact
                      instant may not leave the accessibility tree for that, so
                      it is restated in text a screen reader reads out; `title`
                      would not do, since VoiceOver and TalkBack do not announce
                      it and touch cannot reach it.

                      The elapsed text is rendered once on the server rather
                      than by a client component that re-ticks: a full page is
                      AUDIT_PAGE_SIZE rows, so the live version cost 100
                      setIntervals and 100 client-component boundaries in the
                      RSC payload at every viewport. The page is
                      `force-dynamic` and the rule above it already stamps
                      "as of HH:MM UTC", so the reading is dated in the same
                      way the rest of the page is. */}
                  <td className="mono nowrap">
                    <span className="only-wide">{stamp(r.at)}</span>
                    <span className="only-narrow">
                      <time className="ago dim mono" dateTime={iso}>
                        {formatAgo(iso, now)}
                      </time>
                      <span className="visually-hidden">{`at ${stamp(r.at)} UTC`}</span>
                    </span>
                  </td>
                  <td>
                    <ActorCell r={r} params={params} />
                  </td>
                  <td className="mono">
                    {/* Sized to fit the current action vocabulary, but bounded
                        anyway: a longer action name added later truncates with
                        the full value in `title`, the way actor and target
                        already do, rather than painting over the next column.

                        Links to itself as a filter, like actor and target. It
                        is one of the three filterable fields and was the only
                        one you could not click, on a page that already splits
                        it at the dot and dims the prefix -- so it looked
                        interactive and was not. The exact action, not the
                        prefix: `action` is a prefix match, so filtering by the
                        whole string is the narrowest reading of "show me this
                        one", and the admin can shorten it in the form. */}
                    <a
                      className="ellipsis-cell cell-link"
                      href={filterHref(params, "action", r.action)}
                      title={r.action}
                    >
                      {dot === -1 ? (
                        r.action
                      ) : (
                        <>
                          <span className="dim">{r.action.slice(0, dot + 1)}</span>
                          {r.action.slice(dot + 1)}
                        </>
                      )}
                    </a>
                  </td>
                  <td>
                    <TargetCell r={r} params={params} />
                  </td>
                  <td>
                    {r.details ? (
                      <Json
                        value={r.details}
                        summary={summarizeDetails(
                          r.action,
                          r.details,
                          roleNames,
                          tierLabels,
                        )}
                      />
                    ) : (
                      <span className="dim">&mdash;</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                {/* The cell spans five fixed-width columns, so at 320px its box
                    is far wider than the scroller and the text used to wrap
                    out of view. The inner span pins to the scroller's visible
                    left edge and wraps within it; the cell keeps its layout
                    width. */}
                <td className="log__empty" colSpan={5}>
                  <span className="log__empty-text">{emptyMessage}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Scroller>

      <Pager
        rows={rows}
        hasLatest={hasCursor}
        older={older}
        filterHrefBase={filterHrefBase}
      />
    </main>
  );
}
