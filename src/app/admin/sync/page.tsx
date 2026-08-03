import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { recheckInvalidAction, syncAllAction } from "./actions";

export const dynamic = "force-dynamic";

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

export default async function AdminSyncPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const groups = await getSyncStatus(getDb());

  return (
    <main>
      <h1>Sync</h1>
      <div style={{ margin: "1rem 0", display: "flex", gap: "0.5rem" }}>
        <form action={syncAllAction}>
          <button type="submit">Sync everything now</button>
        </form>
        <form action={recheckInvalidAction}>
          <button type="submit">Recheck invalid affiliations</button>
        </form>
      </div>
      {groups.length === 0 && <p>No runs recorded yet.</p>}
      {groups.map((g) => (
        <section key={g.jobType}>
          <h2>{g.jobType}</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Started</th>
                <th style={{ textAlign: "left" }}>Finished</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Counts</th>
                <th style={{ textAlign: "left" }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {g.runs.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #ccc" }}>
                  <td>{fmt(r.startedAt)}</td>
                  <td>{fmt(r.finishedAt)}</td>
                  <td>
                    {r.status === "failed" ? <strong>failed</strong> : (r.status ?? "running")}
                  </td>
                  <td>
                    <code>{r.counts ? JSON.stringify(r.counts) : ""}</code>
                  </td>
                  <td>{r.errorSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
