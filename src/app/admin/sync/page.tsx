import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { RuleHead, Scroller, Status } from "@/app/_components/ui";
import { recheckInvalidAction, syncAllAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sync",
};

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

/** "3m ago" style, coarse on purpose: the point is freshness, not precision. */
function ago(d: Date | null, now: number): string {
  if (!d) return "running";
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function tone(status: string | null): "ok" | "warn" | "bad" | "off" {
  if (status === "failed") return "bad";
  if (status === "ok" || status === "success") return "ok";
  if (status === null) return "warn";
  return "off";
}

export default async function AdminSyncPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const groups = await getSyncStatus(getDb());
  const now = Date.now();

  return (
    <main className="page">
      <div className="page__head">
        <h1>Sync</h1>
        <p className="page__lede">
          The five jobs that keep tiers, roles and standings in step with the game. The
          buttons enqueue work; the worker picks it up within a few seconds.
        </p>
      </div>

      <div className="btn-row">
        <form action={syncAllAction}>
          <button type="submit" className="btn btn--primary">
            Sync everything now
          </button>
        </form>
        <form action={recheckInvalidAction}>
          <button type="submit" className="btn">
            Recheck invalid affiliations
          </button>
        </form>
      </div>

      {groups.length === 0 && (
        <p className="notice" data-glyph="·">
          No runs recorded yet. Either the worker has not started, or nothing has come due.
        </p>
      )}

      {groups.map((g) => {
        const latest = g.runs[0];
        return (
          <section key={g.jobType}>
            <RuleHead
              aside={
                latest && (
                  <>
                    <Status tone={tone(latest.status)}>{latest.status ?? "running"}</Status>
                    <span className="dim mono">
                      {ago(latest.finishedAt ?? latest.startedAt, now)}
                    </span>
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
                          <code className="json">{JSON.stringify(r.counts)}</code>
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
