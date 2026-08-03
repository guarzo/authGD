import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { queryAuditLog } from "@/services/audit";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; target?: string; before?: string }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const params = await searchParams;
  const beforeId = params.before ? Number(params.before) : undefined;
  const rows = await queryAuditLog(getDb(), {
    actor: params.actor || undefined,
    action: params.action || undefined,
    target: params.target || undefined,
    beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
  });
  const older = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && k !== "before") older.set(k, v);
  if (rows.length > 0) older.set("before", String(rows[rows.length - 1].id));

  return (
    <main>
      <h1>Audit log</h1>
      <form method="get" style={{ marginBottom: "1rem" }}>
        <input name="actor" placeholder="actor" defaultValue={params.actor ?? ""} />{" "}
        <input name="action" placeholder="action prefix (tier.)" defaultValue={params.action ?? ""} />{" "}
        <input name="target" placeholder="target" defaultValue={params.target ?? ""} />{" "}
        <button type="submit">Filter</button> <a href="/admin/audit">clear</a>
      </form>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>At</th>
            <th style={{ textAlign: "left" }}>Actor</th>
            <th style={{ textAlign: "left" }}>Action</th>
            <th style={{ textAlign: "left" }}>Target</th>
            <th style={{ textAlign: "left" }}>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #ccc" }}>
              <td>{r.at.toISOString().replace("T", " ").slice(0, 19)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td>{r.target}</td>
              <td>
                <code>{r.details ? JSON.stringify(r.details) : ""}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 100 && <p><a href={`/admin/audit?${older.toString()}`}>Older →</a></p>}
    </main>
  );
}
