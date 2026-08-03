import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { syncRunStatusEnum } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { cadenceFor } from "@/core/schedules";
import {
  countColumns,
  formatDuration,
  humanizeKey,
  isNoChange,
} from "@/core/run-summary";
import { Json, Scroller, Status, type Tone } from "@/app/_components/ui";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { formatAgo } from "@/app/_components/format-ago";
import { RelativeTime } from "@/app/_components/relative-time";
import { recheckInvalidAction, syncAllAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sync",
};

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

/**
 * Typed against the enum rather than string, so adding a status to the schema
 * is a compile error here instead of a silently grey badge. "partial" means
 * some of the job's work failed, which is a warning an admin must see, not an
 * inactive state. A null status is a job still running: not a failure and not
 * inactive either, so it stays neutral rather than borrowing the warn colour
 * PRODUCT.md reserves for things the admin can and should fix.
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
 * Which jobs open on their own. "Not OK" is read as "actionable", so a run
 * still in flight does not count: a null status resolves on its own within
 * seconds, and expanding on it would mean the page flaps open and shut through
 * every sweep instead of pointing at the one job that needs an admin.
 */
function needsAttention(status: SyncRunStatus | null): boolean {
  return status === "partial" || status === "failed";
}

export default async function AdminSyncPage({
  searchParams,
}: {
  searchParams: Promise<{ queued?: string }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const { queued } = await searchParams;
  const groups = await getSyncStatus(getDb());
  const now = Date.now();
  // The cadence column is dropped entirely rather than filled with dashes when
  // nothing on the page is scheduled — an empty column is exactly the noise
  // this page is being cleaned of.
  const anyCadence = groups.some((g) => cadenceFor(g.jobType) !== null);

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
          never announced. */}
      {queued === "all" && (
        <p className="notice" role="status" data-glyph="·">
          Sync queued for every account. The worker picks it up within a few seconds; the
          strip below updates as runs finish.
        </p>
      )}
      {queued === "recheck" && (
        <p className="notice" role="status" data-glyph="·">
          Affiliation recheck queued. The worker picks it up within a few seconds.
        </p>
      )}

      <div className="btn-row">
        <form action={syncAllAction}>
          <Submit className="btn btn--primary" pendingLabel="Queueing…">
            Sync everything now
          </Submit>
        </form>
        <form action={recheckInvalidAction}>
          <Submit className="btn" pendingLabel="Queueing…">
            Recheck invalid affiliations
          </Submit>
        </form>
      </div>

      {groups.length === 0 && (
        <p className="notice" data-glyph="·">
          No runs recorded yet. Either the worker has not started, or nothing has come
          due.
        </p>
      )}

      {groups.length > 0 && (
        <ul className={anyCadence ? "strip strip--cadence" : "strip"}>
          {/* aria-hidden: these label the summary rows visually, but each row
              is a single disclosure control whose accessible name already
              carries job, health and age in that order. */}
          <li className="strip__head" aria-hidden="true">
            <span />
            <span>Job</span>
            <span>Health</span>
            <span>Last run</span>
            {anyCadence && <span>Cadence</span>}
          </li>
          {groups.map((g) => {
            const latest = g.runs[0];
            const latestAt = latest ? (latest.finishedAt ?? latest.startedAt) : null;
            const latestIso = latestAt ? latestAt.toISOString() : null;
            const cadence = cadenceFor(g.jobType);
            const cols = countColumns(g.jobType, g.runs);
            const span = cols.length || 1;
            return (
              <li key={g.jobType} className="strip__job">
                <Disclosure
                  className="strip__disc"
                  defaultOpen={latest ? needsAttention(latest.status) : false}
                  summary={
                    <>
                      <h2 className="strip__name">{g.jobType}</h2>
                      {latest ? (
                        <Status tone={tone(latest.status)}>
                          {latest.status ?? "running"}
                        </Status>
                      ) : (
                        <Status tone="off">no runs</Status>
                      )}
                      <RelativeTime iso={latestIso} initial={formatAgo(latestIso, now)} />
                      {anyCadence && (
                        <span className="strip__cadence mono">
                          {cadence ?? "on demand"}
                        </span>
                      )}
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
                            <th>Started</th>
                            <th>Took</th>
                            <th>Status</th>
                            {cols.length > 0 ? (
                              cols.map((k) => (
                                <th key={k} className="num">
                                  {humanizeKey(k)}
                                </th>
                              ))
                            ) : (
                              <th>Counts</th>
                            )}
                            <th>Raw</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.runs.map((r) => (
                            <tr key={r.id}>
                              <td className="mono nowrap">{fmt(r.startedAt)}</td>
                              <td className="mono nowrap num">
                                {formatDuration(r.startedAt, r.finishedAt) ?? (
                                  <span className="dim">…</span>
                                )}
                              </td>
                              {/* The error lives here rather than in a column of
                                  its own: it is populated on a small minority
                                  of runs, and a column that is an em-dash on
                                  every row is width spent on nothing. */}
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
                              {!r.counts ? (
                                // Two different absences: a run still in
                                // flight has not reported yet, a finished one
                                // that recorded nothing never will. The failed
                                // runs are the second kind, and an ellipsis
                                // there reads as "still working".
                                <td colSpan={span} className="dim">
                                  {r.finishedAt ? <>&mdash;</> : <>&hellip;</>}
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
                          ))}
                        </tbody>
                      </table>
                    </Scroller>
                  )}
                </Disclosure>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
