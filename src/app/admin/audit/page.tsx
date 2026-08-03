import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { AUDIT_PAGE_SIZE, queryAuditLog } from "@/services/audit";
import { RuleHead, Json, Scroller } from "@/app/_components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Audit log",
};

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    actor?: string;
    action?: string;
    target?: string;
    before?: string;
  }>;
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

  const filtered = Boolean(params.actor || params.action || params.target);

  return (
    <main className="page">
      <div className="page__head">
        <h1>Audit log</h1>
        <p className="page__lede">
          Every state change, append only, newest first. Nothing here can be edited or
          removed.
        </p>
      </div>

      <RuleHead>Filter</RuleHead>
      <form method="get" className="filter-form">
        <label className="filter-form__cell">
          <span className="filter-form__label">Actor</span>
          <input className="field" name="actor" defaultValue={params.actor ?? ""} />
        </label>
        <label className="filter-form__cell">
          <span className="filter-form__label">Action prefix</span>
          <input
            className="field"
            name="action"
            placeholder="tier."
            defaultValue={params.action ?? ""}
          />
        </label>
        <label className="filter-form__cell">
          <span className="filter-form__label">Target</span>
          <input className="field" name="target" defaultValue={params.target ?? ""} />
        </label>
        <div className="filter-form__actions">
          <button type="submit" className="btn btn--primary">
            Filter
          </button>
          {filtered && (
            <a className="btn btn--quiet" href="/admin/audit">
              clear
            </a>
          )}
        </div>
      </form>

      <RuleHead>
        {rows.length === 0
          ? "No entries"
          : `${rows.length}${rows.length === AUDIT_PAGE_SIZE ? "+" : ""} entries`}
      </RuleHead>
      <Scroller label="Audit entries">
        <table className="log">
          <thead>
            <tr>
              <th>At (UTC)</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dot = r.action.indexOf(".");
              return (
                <tr key={r.id}>
                  <td className="mono nowrap">
                    {r.at.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td>{r.actor}</td>
                  <td className="mono nowrap">
                    {dot === -1 ? (
                      r.action
                    ) : (
                      <>
                        <span className="dim">{r.action.slice(0, dot + 1)}</span>
                        {r.action.slice(dot + 1)}
                      </>
                    )}
                  </td>
                  <td className="mono">{r.target}</td>
                  <td>
                    {r.details ? (
                      <Json value={r.details} />
                    ) : (
                      <span className="dim">&mdash;</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className="log__empty" colSpan={5}>
                  {filtered
                    ? "Nothing matches this filter."
                    : "Nothing has happened yet."}
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
