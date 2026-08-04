import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getConfig } from "@/config";
import { getAdminContext } from "@/lib/admin-guard";
import { AUDIT_PAGE_SIZE, queryAuditLog, resolveFilterIdentity } from "@/services/audit";
import type { FilterResolution, ResolvedAuditRow } from "@/services/audit";
import { RuleHead, Json, Scroller } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { formatAgo } from "@/app/_components/format-ago";
import { RelativeTime } from "@/app/_components/relative-time";
import { renderedAt } from "@/app/_components/utc-time";
import { summarizeDetails } from "@/app/admin/audit/summarize";

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
  field: "actor" | "target",
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
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
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
        beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
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

  // tier -> role id in config; this table needs role id -> tier.
  const roleNames = new Map(
    Object.entries(getConfig().discord.roleIds).map(([tier, id]) => [id, tier]),
  );

  const filtered = Boolean(params.actor || params.action || params.target);
  const activeFilters = [
    params.actor && `actor: ${params.actor}`,
    params.action && `action: ${params.action}`,
    params.target && `target: ${params.target}`,
  ].filter(Boolean) as string[];

  // One note per field whose name spans more than one account, so a widened
  // result never looks like a narrow one. Text, not colour.
  const ambiguityNotes = (
    [
      ["actor", actorRes],
      ["target", targetRes],
    ] as const
  )
    .map(([field, r]) =>
      r && r.kind === "name" && r.accountCount > 1
        ? `${field} "${r.name}" matches ${r.accountCount} accounts`
        : null,
    )
    .filter(Boolean) as string[];

  // The cursor ran past the end of a non-empty log, distinct from the log
  // (or the filtered subset of it) genuinely having zero rows. Mirrors the
  // priority `emptyMessage` below uses: an unmatched name still names the
  // field that failed, even if `before` also happens to be set.
  const pastEnd =
    !unmatched.length &&
    beforeId !== undefined &&
    Number.isFinite(beforeId) &&
    rows.length === 0;

  const countLabel =
    rows.length === 0
      ? pastEnd
        ? "No older entries"
        : filtered
          ? "No matching entries"
          : "No entries"
      : `${rows.length}${rows.length === AUDIT_PAGE_SIZE ? "+" : ""} ${
          filtered ? "matching entries" : "entries"
        }`;

  const emptyMessage: ReactNode = unmatched.length ? (
    `No account or character named ${unmatched
      .map(([field, r]) => `"${r.name}" (${field})`)
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
    "Nothing matches this filter."
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
        <label className="filter-form__cell">
          <span className="filter-form__label">Actor</span>
          <input className="field" name="actor" defaultValue={params.actor ?? ""} />
        </label>
        {/* This cell is a div with an explicit label, unlike its two siblings:
            the hint has to live outside the <label> or it gets concatenated
            into the input's accessible name ("Action prefix e.g. tier."). */}
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
        <label className="filter-form__cell">
          <span className="filter-form__label">Target</span>
          <input className="field" name="target" defaultValue={params.target ?? ""} />
        </label>
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

      <RuleHead
        as="h2"
        aside={
          // The render stamp joins the ambiguity notes on the same rule rather
          // than taking a line of its own: both answer "how much should I trust
          // what I'm reading", and the aside is already the slot for that.
          <span className="dim">{[...ambiguityNotes, renderedAt()].join(" · ")}</span>
        }
      >
        {countLabel}
      </RuleHead>
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
                      it and touch cannot reach it. */}
                  <td className="mono nowrap">
                    <span className="only-wide">{stamp(r.at)}</span>
                    <span className="only-narrow">
                      <RelativeTime iso={iso} initial={formatAgo(iso, now)} />
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
                        already do, rather than painting over the next column. */}
                    <span className="ellipsis-cell" title={r.action}>
                      {dot === -1 ? (
                        r.action
                      ) : (
                        <>
                          <span className="dim">{r.action.slice(0, dot + 1)}</span>
                          {r.action.slice(dot + 1)}
                        </>
                      )}
                    </span>
                  </td>
                  <td>
                    <TargetCell r={r} params={params} />
                  </td>
                  <td>
                    {r.details ? (
                      <Json
                        value={r.details}
                        summary={summarizeDetails(r.action, r.details, roleNames)}
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

      {rows.length === AUDIT_PAGE_SIZE && (
        <div className="btn-row pager">
          <a className="btn" href={`/admin/audit?${older.toString()}`}>
            Older <span aria-hidden="true">→</span>
          </a>
        </div>
      )}
    </main>
  );
}
