import type { Metadata } from "next";
import { Fragment } from "react";
import { getDb } from "@/db";
import { requireAdminPage } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { newestSyncRun } from "@/services/health";
import { evaluateFreshness } from "@/core/health";
import { rowHealth } from "@/core/run-health";
import { cadenceFor, cronFor, groupFor, type JobGroup } from "@/core/schedules";
import {
  collapseRuns,
  countColumns,
  formatDuration,
  humanizeKey,
  isNoChange,
} from "@/core/run-summary";
import { Json, Notice, RuleHead, Scroller, Status } from "@/app/_components/ui";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { elapsedShort, formatAgo } from "@/app/_components/format-ago";
import { RelativeTime } from "@/app/_components/relative-time";
import { recheckInvalidAction, syncAllAction, syncJobAction } from "./actions";
import {
  evidenceSince,
  healthLabel,
  HEALTH_TONE,
  needsAttention,
  nextRunFor,
  queuedNotice,
  tone,
} from "./view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sync",
};

/**
 * The order the strip's three groups render in, and the label above each —
 * so the primary button's scope ("sweep") is answerable by looking at the
 * strip rather than by parsing 50 characters of uppercase mono on the button
 * itself. `"other"` is not a `JobGroup`: it catches a job type present in
 * `sync_run` but absent from `JOB_CRON` (retired or hand-queued), which
 * `groupFor` reports as `null` rather than assigning to any of the three real
 * groups — the row still has to render somewhere rather than silently drop.
 */
const GROUP_ORDER: JobGroup[] = ["sweep", "on-demand", "housekeeping"];

const GROUP_LABEL: Record<JobGroup | "other", string> = {
  sweep: "Sweep",
  "on-demand": "On-demand",
  housekeeping: "Housekeeping",
  other: "Other",
};

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

/**
 * An absence glyph and the words it stands for. The runs table distinguishes
 * several kinds of absence by eye — `—` for a finished run that recorded
 * nothing, `…` for one still in flight, `—` again for a counter this run did
 * not report — but at the default punctuation verbosity of NVDA, JAWS and
 * VoiceOver an em dash and an ellipsis are both dropped, so every one of those
 * cells announced as empty: indistinguishable from each other and from a
 * missing cell. Each call site supplies the words its own glyph means, which
 * is why this takes the string rather than deriving it.
 *
 * `fmt()` above still returns a bare `…` for a null start instant. It is left
 * alone deliberately: it returns a string into several call sites, only one of
 * which is a table cell, and no run in the schema reaches it with a null
 * `startedAt`.
 *
 * The hidden span is `position: absolute` and takes its containing block from
 * `.scroller`'s `position: relative`, so it costs no layout and cannot stretch
 * the table it sits in — or inflate the `scrollWidth` the Scroller measures.
 */
function Absent({ glyph, children }: { glyph: string; children: string }) {
  return (
    <>
      <span aria-hidden="true">{glyph}</span>
      <span className="visually-hidden">{children}</span>
    </>
  );
}

function utcHhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

function utcHhmmss(d: Date): string {
  return d.toISOString().slice(11, 19);
}

export default async function AdminSyncPage({
  searchParams,
}: {
  searchParams: Promise<{ queued?: string; at?: string }>;
}) {
  await requireAdminPage();
  const { queued, at } = await searchParams;
  const db = getDb();
  const [groups, newest] = await Promise.all([getSyncStatus(db), newestSyncRun(db)]);
  // One instant for the whole render: the worker line, every row's health and
  // the "checked at" stamp all have to agree, and reading the clock per row
  // would let them disagree by however long the page takes to build.
  const renderedAt = new Date();
  const now = renderedAt.getTime();
  const worker = evaluateFreshness(newest?.startedAt ?? null, renderedAt);
  const workerAge = worker.ageSec === null ? null : elapsedShort(worker.ageSec * 1000);
  const workerLine =
    workerAge === null
      ? "worker · no runs recorded"
      : worker.fresh
        ? `worker · last run ${workerAge} ago`
        : `worker · no run in ${workerAge}`;
  const notice = queuedNotice(queued, at, worker.fresh);
  // How far back this page can see the worker doing anything at all. Only this
  // lets a never-run row escalate: see `evidenceSince` and `rowHealth`.
  const seenSince = evidenceSince(worker.fresh, groups);
  // Partitioned for display only — `groups` itself is untouched, and each
  // bucket keeps the relative order `KNOWN_ORDER` (in the service) already
  // gave its members, so grouping never becomes a second sort. A job absent
  // from `JOB_CRON` reports `null` from `groupFor` and falls into "other"
  // rather than being dropped: every row from `getSyncStatus` still renders.
  const buckets = [
    ...GROUP_ORDER.map((key) => ({
      key,
      jobs: groups.filter((g) => groupFor(g.jobType) === key),
    })),
    { key: "other" as const, jobs: groups.filter((g) => groupFor(g.jobType) === null) },
  ].filter((b) => b.jobs.length > 0);

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="page__head">
        <h1>Sync</h1>
        <p className="page__lede">
          The jobs that keep tiers, roles and standings in step with the game. The buttons
          enqueue work;{" "}
          {worker.fresh
            ? "the worker picks it up within a few seconds."
            : "the worker is not running right now, so queued work waits until it is — see the line below."}
        </p>
      </div>

      {/* Mounted unconditionally, empty string and all. A live region
          *inserted* with its content already in place is announced unreliably,
          NVDA and JAWS especially, because the region has to be registered
          before the mutation it is meant to report — and a server action
          redirect re-renders without a document load, so this element stays in
          the tree across the press and only its text changes. This page
          hand-rolled that behaviour before `Notice` had it; the slot mode in
          the primitive is the same thing, so the local copy is gone. */}
      <Notice>{notice}</Notice>

      {/* Every row below reports on one job. This line reports on the process
          that runs all of them: without it a worker that died at 02:00 leaves
          seven rows still showing whatever they last succeeded at, and the
          page looks perfect through the outage that brought the admin here. */}
      {worker.fresh ? (
        <p className="worker">{workerLine}</p>
      ) : (
        <Notice tone="bad">
          <span className="worker">{workerLine}</span>
        </Notice>
      )}

      {/* The strip's own section header, the signature component every other
          admin table (accounts, audit) heads its data region with — sync had
          none. The stamp lives here now, not at the bottom of the page: it is
          a fact about this render, and an admin scanning down should not have
          to reach past seven rows and however many open drawers to find out
          how current the table above them is.

          `as="h2"`, not the job names' own level: this is the strip's parent
          in the outline, not an eighth sibling next to the seven job names —
          see `.strip__name`, which moved to `h3` for exactly this reason. */}
      <RuleHead
        as="h2"
        aside={
          <span className="btn-row__stamp">checked {utcHhmmss(renderedAt)} UTC</span>
        }
      >
        {groups.length} job{groups.length === 1 ? "" : "s"}
      </RuleHead>

      {/* No empty state above this: `getSyncStatus` seeds a row for every key
          in JOB_CRON whether or not it has ever run, so the list is never
          empty and a "nothing has come due" message could only ever be a lie
          about a state the page cannot reach. */}
      {/* The one thing hiding the group labels from the accessibility tree
          would have deleted: which jobs the primary button's own scope
          covers — the fact the button's label used to spell out in 50
          characters of uppercase mono ("Sync membership, contacts, wanderer,
          discord-roles") before it shrank to "Sync now" on the strength of
          the strip now carrying that answer visually. A screen reader user
          who lost the four nouns and gained an aria-hidden label would be
          strictly worse off than before this task. So `.strip` is no longer
          one `role="list"` of seven items with the grouping painted over it
          — it is `.strip__head`'s aria-hidden column labels, then one
          `role="list"` PER group, each one's accessible name the group's own
          visible heading via `aria-labelledby`. VoiceOver reports "list,
          4 items" / "list, 1 item" / "list, 2 items" instead of one "list, 7
          items" — a real loss for anyone who relied on the flat count — but
          the alternative was a grouping only sighted users could act on,
          which is the one thing this whole task exists to fix. */}
      <div className="strip">
        {/* aria-hidden: these label the summary rows visually, but each row
            is a single disclosure control whose accessible name already
            carries job, health, age and cadence in that order. */}
        <div className="strip__head" aria-hidden="true">
          <span />
          <span>Job</span>
          <span className="strip__h-health">Health</span>
          <span className="strip__h-last">Last run</span>
          <span className="strip__h-cadence">Cadence</span>
        </div>
        {buckets.map((bucket) => {
          const headingId = `strip-group-${bucket.key}`;
          return (
            <Fragment key={bucket.key}>
              <p id={headingId} className="strip__group">
                {GROUP_LABEL[bucket.key]}
              </p>
              <ul className="strip__sub" role="list" aria-labelledby={headingId}>
                {bucket.jobs.map((g) => {
                  const latest = g.runs[0];
                  const startedAt = latest?.startedAt ?? null;
                  const finishedAt = latest?.finishedAt ?? null;
                  // finish-time for a completed run, start-time for one in flight:
                  // in both cases the last moment this job is known to have been
                  // doing something.
                  const latestAt = finishedAt ?? startedAt;
                  const latestIso = latestAt ? latestAt.toISOString() : null;
                  const health = rowHealth({
                    status: latest?.status ?? null,
                    startedAt,
                    finishedAt,
                    cron: cronFor(g.jobType),
                    now: renderedAt,
                    seenSince,
                  });
                  // Null for a job type found in `sync_run` but absent from
                  // JOB_CRON — a retired or hand-queued job. Every *seeded* row
                  // has a cadence by construction, so the column always earns its
                  // width, but that one still has to say something.
                  const cadence = cadenceFor(g.jobType);
                  const nextRun = nextRunFor(g.jobType, renderedAt);
                  const cols = countColumns(g.jobType, g.runs);
                  const span = cols.length || 1;
                  return (
                    <li key={g.jobType} className="strip__job">
                      <Disclosure
                        className="strip__disc"
                        defaultOpen={needsAttention(health)}
                        summary={
                          <>
                            <h3 className="strip__name">{g.jobType}</h3>
                            {/* One grid item, not two: `.strip__disc > summary > .st`
                        used to be the health track's own grid item, and a
                        second sibling here would spill the queued marker into
                        the *next* track — the last-run column — on rows that
                        have one and leave every other row's last-run cell
                        exactly where it was, breaking the single scannable
                        column this grid exists for. Wrapping both in one span
                        keeps the health track one item wide whether or not
                        `queued` is set. */}
                            <span className="strip__health">
                              <Status tone={HEALTH_TONE[health]}>
                                {healthLabel(health)}
                              </Status>
                              {g.queued && (
                                // A ring, not a second `.st` word: the health
                                // track is a fixed 7.5rem, and "cadence unknown"
                                // — the longest label — already spends most of
                                // that on its own. `queued`'s own word would
                                // overflow the track next to it on exactly the
                                // rows most likely to carry it (an on-demand job
                                // fanned out to). The ring is aria-hidden and the
                                // full word is the accessible one, same pattern
                                // as `Absent` below — this isn't `Absent` itself
                                // because that component's own doc reserves it
                                // for a run recording nothing, not a job that has
                                // something coming.
                                //
                                // Not "your request queued": a member-triggered
                                // account merge or Discord link fans out to the
                                // same jobs and reads identically here — this
                                // says work targets the job, not who asked for
                                // it. Also honest about how long it stays true:
                                // the dispatcher polls every ~2s, so this is only
                                // up for the couple of seconds before an
                                // in-flight `sync_run` row — and the `inflight`
                                // health above, a `RowHealth` member this
                                // deliberately is not — takes over the signal.
                                <>
                                  <span className="strip__queued" aria-hidden="true" />
                                  <span className="visually-hidden">, queued</span>
                                </>
                              )}
                            </span>
                            <RelativeTime
                              iso={latestIso}
                              initial={formatAgo(latestIso, now)}
                            />
                            <span className="strip__cadence mono">
                              {cadence ?? "on demand"}
                              {nextRun && (
                                <>
                                  {/* An explicit space: accessible-name computation
                              inserts no separator for a <br> in Chromium, and
                              the row's whole accessible name is this
                              four-value concatenation, because the column
                              header above is aria-hidden. Without it the last
                              two values compute as "every 30mnext 14:30". */}{" "}
                                  <br />
                                  next {utcHhmm(nextRun)}
                                </>
                              )}
                            </span>
                          </>
                        }
                      >
                        {g.runs.length === 0 ? (
                          <p className="dim strip__empty">
                            No runs recorded for this job yet.
                          </p>
                        ) : (
                          <Scroller label={`${g.jobType} runs`}>
                            {/* No colgroup: each job now shows only the counters it
                        actually moves, so the tables deliberately no longer
                        share a column set and cannot be aligned to each
                        other. Widths come from content. */}
                            <table className="log log--runs">
                              <thead>
                                <tr>
                                  <th scope="col">Started</th>
                                  <th scope="col">Took</th>
                                  <th scope="col">Status</th>
                                  {cols.length > 0 ? (
                                    cols.map((k) => (
                                      <th key={k} scope="col" className="num">
                                        {humanizeKey(k)}
                                      </th>
                                    ))
                                  ) : (
                                    <th scope="col">Counts</th>
                                  )}
                                  <th scope="col">Raw</th>
                                </tr>
                              </thead>
                              <tbody>
                                {collapseRuns(g.runs).map((entry) => {
                                  if (entry.kind === "group") {
                                    const first = entry.runs[0];
                                    const last = entry.runs[entry.runs.length - 1];
                                    const sameStamp =
                                      entry.from &&
                                      entry.to &&
                                      entry.from.getTime() === entry.to.getTime();
                                    return (
                                      <tr
                                        key={`group-${first.id}-${last.id}`}
                                        className="log--group"
                                      >
                                        {/* "N runs" is table-cell text, read the same
                                    way any other cell is — not a badge whose
                                    count needs an aria-label to be more than a
                                    shape. The range beside it in Started is the
                                    other half of "how many runs are behind it":
                                    a count alone says five identical outcomes
                                    happened, not over what span. */}
                                        <td className="mono nowrap">
                                          <span className="only-wide">
                                            {fmt(entry.from)}
                                            {!sameStamp && entry.to
                                              ? ` – ${fmt(entry.to)}`
                                              : ""}
                                          </span>
                                          <span className="only-narrow">
                                            <RelativeTime
                                              iso={
                                                entry.from
                                                  ? entry.from.toISOString()
                                                  : null
                                              }
                                              initial={formatAgo(
                                                entry.from
                                                  ? entry.from.toISOString()
                                                  : null,
                                                now,
                                              )}
                                            />
                                            <span className="visually-hidden">
                                              {`started ${fmt(entry.from)} UTC`}
                                            </span>
                                          </span>
                                        </td>
                                        <td className="mono nowrap num">
                                          {entry.count} runs
                                        </td>
                                        <td>
                                          <Status tone={tone(entry.status)}>
                                            {entry.status ?? "running"}
                                          </Status>
                                          {/* `sameOutcome` requires every run in
                                      the group to agree on `errorSummary` too,
                                      so this is the one message the whole
                                      group shares — not a representative
                                      picked from the first run. Read off the
                                      group's own field, which `collapseRuns`
                                      has already normalized, rather than
                                      re-deriving the same fact from `runs[0]`. */}
                                          {entry.errorSummary && (
                                            <span className="detail strip__err">
                                              {entry.errorSummary}
                                            </span>
                                          )}
                                        </td>
                                        {!entry.counts || cols.length === 0 ? (
                                          <td colSpan={span} className="dim">
                                            {!entry.counts ? (
                                              <Absent glyph="—">not recorded</Absent>
                                            ) : isNoChange(entry.counts) ? (
                                              "no change"
                                            ) : (
                                              <Absent glyph="—">nothing counted</Absent>
                                            )}
                                          </td>
                                        ) : isNoChange(entry.counts) ? (
                                          <td colSpan={span} className="dim">
                                            no change
                                          </td>
                                        ) : (
                                          cols.map((k) => {
                                            const v = entry.counts?.[k];
                                            return (
                                              <td
                                                key={k}
                                                className={
                                                  v ? "mono num" : "mono num dim"
                                                }
                                              >
                                                {v ?? (
                                                  <Absent glyph="—">not reported</Absent>
                                                )}
                                              </td>
                                            );
                                          })
                                        )}
                                        <td>
                                          {entry.counts ? (
                                            <Json value={entry.counts} summary="json" />
                                          ) : (
                                            <span className="dim">
                                              <Absent glyph="—">no payload</Absent>
                                            </span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  }
                                  const r = entry.run;
                                  const startedIso = r.startedAt
                                    ? r.startedAt.toISOString()
                                    : null;
                                  return (
                                    <tr key={r.id}>
                                      {/* At 320px the 19ch ISO stamp is the widest
                                  cell in the row and the least of its
                                  meaning, and it is most of what the table's
                                  44rem floor was buying. Below 40rem it reads
                                  as elapsed time instead — but the exact
                                  value may not leave the accessibility tree
                                  for that, so it is restated in text a screen
                                  reader reads out. `title` would not do:
                                  VoiceOver and TalkBack do not announce it
                                  and touch cannot reach it. */}
                                      <td className="mono nowrap">
                                        <span className="only-wide">
                                          {fmt(r.startedAt)}
                                        </span>
                                        <span className="only-narrow">
                                          <RelativeTime
                                            iso={startedIso}
                                            initial={formatAgo(startedIso, now)}
                                          />
                                          <span className="visually-hidden">
                                            {`started ${fmt(r.startedAt)} UTC`}
                                          </span>
                                        </span>
                                      </td>
                                      <td className="mono nowrap num">
                                        {formatDuration(r.startedAt, r.finishedAt) ?? (
                                          <span className="dim">
                                            <Absent glyph="…">still running</Absent>
                                          </span>
                                        )}
                                      </td>
                                      {/* The error lives here rather than in a column
                                  of its own: it is populated on a small
                                  minority of runs, and a column that is an
                                  em-dash on every row is width spent on
                                  nothing. */}
                                      <td>
                                        <Status tone={tone(r.status)}>
                                          {r.status ?? "running"}
                                        </Status>
                                        {r.errorSummary && (
                                          <span className="detail strip__err">
                                            {r.errorSummary}
                                          </span>
                                        )}
                                      </td>
                                      {!r.counts || cols.length === 0 ? (
                                        // Three absences that read differently: a run
                                        // still in flight has not reported yet, a
                                        // finished one that recorded nothing never
                                        // will, and a recorded all-zero result is a
                                        // real answer. cols is empty only when no run
                                        // in the window moved a counter, so there is
                                        // one header cell to span.
                                        <td colSpan={span} className="dim">
                                          {!r.counts ? (
                                            r.finishedAt ? (
                                              <Absent glyph="—">not recorded</Absent>
                                            ) : (
                                              <Absent glyph="…">not reported yet</Absent>
                                            )
                                          ) : isNoChange(r.counts) ? (
                                            "no change"
                                          ) : (
                                            // Not "not recorded": counts *were*
                                            // recorded, the Raw column beside this
                                            // renders them, and they are simply not
                                            // all zero and not countable either — a
                                            // payload like `{ removed: 0, lastError:
                                            // null }` clears isNoChange and yields no
                                            // columns. The glyph was ambiguous about
                                            // that; hidden words would state it as a
                                            // fact, so they have to state the right
                                            // one.
                                            <Absent glyph="—">nothing counted</Absent>
                                          )}
                                        </td>
                                      ) : isNoChange(r.counts) ? (
                                        <td colSpan={span} className="dim">
                                          no change
                                        </td>
                                      ) : (
                                        cols.map((k) => {
                                          const v = r.counts?.[k];
                                          return (
                                            <td
                                              key={k}
                                              className={v ? "mono num" : "mono num dim"}
                                            >
                                              {/* The column exists because some other
                                          run in the window moved this counter;
                                          this run did not report it. Same
                                          absence as the cells above, in the
                                          same table, so it gets the same
                                          treatment rather than announcing as
                                          an empty cell. */}
                                              {v ?? (
                                                <Absent glyph="—">not reported</Absent>
                                              )}
                                            </td>
                                          );
                                        })
                                      )}
                                      <td>
                                        {r.counts ? (
                                          <Json value={r.counts} summary="json" />
                                        ) : (
                                          <span className="dim">
                                            <Absent glyph="—">no payload</Absent>
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </Scroller>
                        )}
                        {/* The window, stated. This table shows a fixed handful of the
                    most recent runs, so a job that has failed forty times
                    looks identical to one that has failed five — on the row
                    most likely to be open. Counted from the rendered rows
                    rather than restating the service's `runsPerJob`, so it
                    cannot claim a depth the table does not have. */}
                        {g.runs.length > 0 && (
                          <p className="dim strip__window">
                            last {g.runs.length === 1 ? "run" : `${g.runs.length} runs`}
                          </p>
                        )}
                        {/* Below the history, not above it: the admin opened this row
                    to read why it failed, and the error string is the top
                    row of that table. Only for jobs the worker actually has
                    a queue for — the action rejects anything else, and a
                    control that can only fail is worse than none. */}
                        {cronFor(g.jobType) !== null && (
                          <form action={syncJobAction} className="btn-row strip__act">
                            <input type="hidden" name="jobType" value={g.jobType} />
                            <Submit className="btn btn--micro" pendingLabel="Queueing…">
                              Re-run {g.jobType}
                            </Submit>
                          </form>
                        )}
                      </Disclosure>
                    </li>
                  );
                })}
              </ul>
            </Fragment>
          );
        })}
      </div>

      {/* State before action (PRODUCT.md principle 2): the strip answers "what
          is true right now" before the gold button, which is the most
          saturated thing on the page, gets to pull the eye. */}
      <div className="btn-row btn-row--controls">
        <form action={syncAllAction}>
          <Submit className="btn btn--primary" pendingLabel="Queueing…">
            {/* Short verb, not the four nouns it used to spell out: the
                "Sweep" group header above the strip is now what answers
                "which jobs" — repeating that list on the button just made it
                the widest label on the page for no reading anything else on
                the page didn't already say. */}
            Sync now
          </Submit>
        </form>
        <form action={recheckInvalidAction}>
          <Submit className="btn" pendingLabel="Queueing…">
            Recheck invalid affiliations
          </Submit>
        </form>
        {/* A plain anchor, not a router link: this page is the only thing on
            screen that can answer "did the run land", and a soft navigation to
            the URL you are already on is exactly the case a client router is
            entitled to serve from its own cache. It drops `?queued=` and
            `?at=` on the way, which is still worth having even now that the
            notice stamps itself: the canonical URL is the one an admin leaves
            open, and it should not carry a press from an hour ago at all.

            No polling behind it: an admin reading an expanded failed row must
            not have the page move under them. The notice copy names the
            browser reload rather than this control, because the notice renders
            at the top of the page and this sits below seven rows and however
            many open drawers. */}
        <a className="btn" href="/admin/sync">
          Refresh
        </a>
      </div>
    </main>
  );
}
