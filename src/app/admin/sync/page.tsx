import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { syncRunStatusEnum } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { newestSyncRun } from "@/services/health";
import { evaluateFreshness } from "@/core/health";
import { rowHealth, type RowHealth } from "@/core/run-health";
import { cadenceFor, JOB_CRON, nextOccurrence } from "@/core/schedules";
import {
  countColumns,
  formatDuration,
  humanizeKey,
  isNoChange,
} from "@/core/run-summary";
import { Json, Scroller, Status, type Tone } from "@/app/_components/ui";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { elapsedShort, formatAgo } from "@/app/_components/format-ago";
import { RelativeTime } from "@/app/_components/relative-time";
import { recheckInvalidAction, syncAllAction, syncJobAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sync",
};

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

function utcHhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

function utcHhmmss(d: Date): string {
  return d.toISOString().slice(11, 19);
}

/**
 * True when the cron's hour field is a fixed number rather than `*` or a
 * step — the same test `formatCadence` uses to decide whether it can print a
 * wall-clock time itself. When it's fixed, the cadence string already names
 * the time (`daily 03:00 UTC`, `Sun 04:00 UTC`) and a next-run line under it
 * would either repeat that number or, worse, read as "soon" for a job that
 * only fires once a week. Read off the raw expression rather than the
 * humanized cadence string, so a rewording of `formatCadence` can't silently
 * break this.
 */
function cadenceNamesTime(cron: string): boolean {
  const hour = cron.trim().split(/\s+/)[1];
  return /^\d+$/.test(hour ?? "");
}

/**
 * Mirrors `nextCheck` in account-view.ts: a missing or unsupported cadence
 * degrades to "we don't know when" rather than throwing and taking the whole
 * sync page down over a decoration.
 */
function nextRunFor(jobType: string, now: Date): Date | null {
  const cron = JOB_CRON[jobType];
  if (!cron || cadenceNamesTime(cron)) return null;
  try {
    return nextOccurrence(cron, now);
  } catch {
    return null;
  }
}

/**
 * Typed against the enum rather than string, so adding a status to the schema
 * is a compile error here instead of a silently grey badge. "partial" means
 * some of the job's work failed, which is a warning an admin must see, not an
 * inactive state. A null status is a run still in flight: not a failure and
 * not inactive either, so it stays neutral rather than borrowing the warn
 * colour PRODUCT.md reserves for things the admin can and should fix.
 *
 * This is the *recorded* status of one historical run, which is all the runs
 * table below needs. The summary row asks a different question — is this job
 * healthy *now* — and that one has to consult the clock: see `rowHealth`.
 */
type SyncRunStatus = (typeof syncRunStatusEnum.enumValues)[number];

function tone(status: SyncRunStatus | null): Tone {
  switch (status) {
    case "ok":
      return "ok";
    case "partial":
      return "warn";
    case "failed":
      return "bad";
    case null:
      return "neutral"; // still running
  }
}

/**
 * Colour for a row's live health. Keyed off `RowHealth` and not off the run
 * status, so "the last run said ok six hours ago on a 30-minute cadence" can
 * be amber while "the last run said ok four minutes ago" is green.
 *
 * `overdue` and `stuck` are warn, not bad: nothing has reported a failure, the
 * schedule has simply not been kept. `never` is off rather than bad for the
 * same reason PRODUCT.md keeps green tier and a dead token out of alarm
 * colour — a job that has not run yet is a state, not a fault.
 */
const HEALTH_TONE: Record<RowHealth, Tone> = {
  ok: "ok",
  partial: "warn",
  failed: "bad",
  running: "neutral",
  stuck: "warn",
  overdue: "warn",
  never: "off",
};

/**
 * The word beside the glyph, so colour is never the only carrier. Deliberately
 * only the word: `running` and `stuck` differ from each other only in how long
 * they have held the same shape, and the obvious answer — baking the elapsed
 * time into the label — puts a second, frozen clock on a row that already
 * carries a ticking one. The `.ago` beside this reads the *start* time of an
 * in-flight run (`latestAt` falls back to `startedAt` when `finishedAt` is
 * null) and re-renders every 30s, so it is already the duration this label
 * would have restated. One number per row, and it stays true on a tab left
 * open for an hour.
 */
function healthLabel(health: RowHealth): string {
  return health === "never" ? "no runs" : health;
}

/**
 * Which rows open on their own. "Not OK" is read as "actionable", which rules
 * out two states that look unhealthy but are not one job's problem:
 *
 * `running` resolves on its own within seconds, and expanding on it would mean
 * the page flaps open and shut through every sweep instead of pointing at the
 * one job that needs an admin. `stuck` is the same shape held far too long, so
 * that one does open.
 *
 * `overdue` is excluded for a bigger reason: when the worker dies, every row
 * goes overdue at once, so opening on it would expand all seven drawers
 * together and destroy exactly the "this one job needs you" signal auto-open
 * exists to create. A dead worker is a page-level condition and it is the
 * worker line above the strip that says so.
 */
function needsAttention(health: RowHealth): boolean {
  return health === "partial" || health === "failed" || health === "stuck";
}

/**
 * The one-line outcome of the press that got us here. Per-job re-runs redirect
 * with the job type itself, and that value is checked against the schedules
 * table before it is echoed: a hand-typed `?queued=` is untrusted input, and
 * this is copy, not a lookup that fails safe on its own.
 */
function queuedNotice(queued: string | undefined): string {
  if (queued === "all") {
    return "Membership, contacts, map and Discord queued for every account. The worker picks them up within a few seconds; use Refresh to see the runs land.";
  }
  if (queued === "recheck") {
    return "Affiliation recheck queued. The worker picks it up within a few seconds; use Refresh to see the run land.";
  }
  if (queued && Object.hasOwn(JOB_CRON, queued)) {
    return `${queued} queued. The worker picks it up within a few seconds; use Refresh to see the run land.`;
  }
  return "";
}

export default async function AdminSyncPage({
  searchParams,
}: {
  searchParams: Promise<{ queued?: string }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const { queued } = await searchParams;
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
  const notice = queuedNotice(queued);

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="page__head">
        <h1>Sync</h1>
        <p className="page__lede">
          The jobs that keep tiers, roles and standings in step with the game. The buttons
          enqueue work; the worker picks it up within a few seconds.
        </p>
      </div>

      {/* role="status" because a server action redirect re-renders without a
          document load: without it the outcome of the press is visible but
          never announced. The element is always in the tree and only its text
          changes — a live region *inserted* with its content already in place
          is announced unreliably, NVDA and JAWS especially, because the region
          has to be registered before the mutation it is meant to report. */}
      <p
        role="status"
        className={notice ? "notice" : "notice-slot"}
        data-glyph={notice ? "·" : undefined}
      >
        {notice}
      </p>

      {/* Every row below reports on one job. This line reports on the process
          that runs all of them: without it a worker that died at 02:00 leaves
          seven rows still showing whatever they last succeeded at, and the
          page looks perfect through the outage that brought the admin here. */}
      {worker.fresh ? (
        <p className="worker">{workerLine}</p>
      ) : (
        <p className="notice notice--bad" data-glyph="!">
          <span className="worker">{workerLine}</span>
        </p>
      )}

      {/* No empty state above this: `getSyncStatus` seeds a row for every key
          in JOB_CRON whether or not it has ever run, so the list is never
          empty and a "nothing has come due" message could only ever be a lie
          about a state the page cannot reach. */}
      <ul className="strip">
        {/* aria-hidden: these label the summary rows visually, but each row
            is a single disclosure control whose accessible name already
            carries job, health and age in that order. */}
        <li className="strip__head" aria-hidden="true">
          <span />
          <span>Job</span>
          <span>Health</span>
          <span>Last run</span>
          <span>Cadence</span>
        </li>
        {groups.map((g) => {
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
            cron: JOB_CRON[g.jobType] ?? null,
            now: renderedAt,
          });
          // Null for a job type found in `sync_run` but absent from JOB_CRON —
          // a retired or hand-queued job. Every *seeded* row has a cadence by
          // construction, so the column always earns its width, but that one
          // still has to say something.
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
                    <h2 className="strip__name">{g.jobType}</h2>
                    <Status tone={HEALTH_TONE[health]}>{healthLabel(health)}</Status>
                    <RelativeTime iso={latestIso} initial={formatAgo(latestIso, now)} />
                    <span className="strip__cadence mono">
                      {cadence ?? "on demand"}
                      {nextRun && (
                        <>
                          <br />
                          next {utcHhmm(nextRun)}
                        </>
                      )}
                    </span>
                  </>
                }
              >
                {g.runs.length === 0 ? (
                  <p className="dim strip__empty">No runs recorded for this job yet.</p>
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
                        {g.runs.map((r) => {
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
                                <span className="only-wide">{fmt(r.startedAt)}</span>
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
                                  <span className="dim">…</span>
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
                                      <>&mdash;</>
                                    ) : (
                                      <>&hellip;</>
                                    )
                                  ) : isNoChange(r.counts) ? (
                                    "no change"
                                  ) : (
                                    <>&mdash;</>
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
                                      {v ?? "—"}
                                    </td>
                                  );
                                })
                              )}
                              <td>
                                {r.counts ? (
                                  <Json value={r.counts} summary="json" />
                                ) : (
                                  <span className="dim">&mdash;</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </Scroller>
                )}
                {/* Below the history, not above it: the admin opened this row
                    to read why it failed, and the error string is the top
                    row of that table. Only for jobs the worker actually has
                    a queue for — the action rejects anything else, and a
                    control that can only fail is worse than none. */}
                {JOB_CRON[g.jobType] && (
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

      {/* State before action (PRODUCT.md principle 2): the strip answers "what
          is true right now" before the gold button, which is the most
          saturated thing on the page, gets to pull the eye. */}
      <div className="btn-row btn-row--controls">
        <form action={syncAllAction}>
          <Submit className="btn btn--primary" pendingLabel="Queueing…">
            Sync membership, contacts, map, Discord
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
            entitled to serve from its own cache. It drops `?queued=` on the
            way, which is the point — otherwise a refresh three hours later
            re-shows "queued a few seconds ago" as if it were fresh.

            No polling behind it: an admin reading an expanded failed row must
            not have the page move under them. */}
        <a className="btn" href="/admin/sync">
          Refresh
        </a>
        <span className="btn-row__stamp mono">checked {utcHhmmss(renderedAt)} UTC</span>
      </div>
    </main>
  );
}
