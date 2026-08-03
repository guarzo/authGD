import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { syncRunStatusEnum } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { Json, RuleHead, Scroller, Status, type Tone } from "@/app/_components/ui";
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

  return (
    <main id="main" className="page">
      <div className="page__head">
        <h1>Sync</h1>
        <p className="page__lede">
          The five jobs that keep tiers, roles and standings in step with the game. The
          buttons enqueue work; the worker picks it up within a few seconds.
        </p>
      </div>

      {queued === "all" && (
        <p className="notice" data-glyph="·">
          Sync queued for every account. The worker picks it up within a few seconds.
        </p>
      )}
      {queued === "recheck" && (
        <p className="notice" data-glyph="·">
          Affiliation recheck queued. The worker picks it up within a few seconds.
        </p>
      )}

      <div className="btn-row">
        <form action={syncAllAction}>
          <Submit className="btn btn--primary">Sync everything now</Submit>
        </form>
        <form action={recheckInvalidAction}>
          <Submit className="btn">Recheck invalid affiliations</Submit>
        </form>
      </div>

      {groups.length === 0 && (
        <p className="notice" data-glyph="·">
          No runs recorded yet. Either the worker has not started, or nothing has come
          due.
        </p>
      )}

      {groups.map((g) => {
        const latest = g.runs[0];
        const latestAt = latest ? (latest.finishedAt ?? latest.startedAt) : null;
        const latestIso = latestAt ? latestAt.toISOString() : null;
        return (
          <section key={g.jobType}>
            <RuleHead
              as="h2"
              aside={
                latest && (
                  <>
                    <Status tone={tone(latest.status)}>
                      {latest.status ?? "running"}
                    </Status>
                    <RelativeTime iso={latestIso} initial={formatAgo(latestIso, now)} />
                  </>
                )
              }
            >
              {g.jobType}
            </RuleHead>
            <Scroller label={`${g.jobType} runs`}>
              <table className="log log--runs">
                {/* Fixed widths so the four job tables line up with each other;
                    auto layout gives every section a different ragged grid.
                    The first four are sized to their content so the leftover
                    goes to the error column, which is the only one that wraps. */}
                <colgroup>
                  <col style={{ width: "13rem" }} />
                  <col style={{ width: "13rem" }} />
                  <col style={{ width: "7rem" }} />
                  <col style={{ width: "14rem" }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Finished</th>
                    <th>Status</th>
                    <th>Counts</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {g.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="mono nowrap">{fmt(r.startedAt)}</td>
                      <td className="mono nowrap">{fmt(r.finishedAt)}</td>
                      <td>
                        <Status tone={tone(r.status)}>{r.status ?? "running"}</Status>
                      </td>
                      <td>
                        {r.counts ? (
                          <Json value={r.counts} />
                        ) : (
                          <span className="dim">&mdash;</span>
                        )}
                      </td>
                      <td className="detail">
                        {r.errorSummary ?? <span className="dim">&mdash;</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          </section>
        );
      })}
    </main>
  );
}
