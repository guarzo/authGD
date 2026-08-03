import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import {
  getAdminAccountsList,
  type AdminAccountRow,
  type AdminListSort,
} from "@/services/account-view";
import {
  demoteAdminAction,
  promoteAdminAction,
  returnToAutoAction,
  saveNoteAction,
  setStatusAction,
  setTierAction,
  syncAccountAction,
} from "./actions";

export const dynamic = "force-dynamic";

const SORTS: Array<{ key: AdminListSort; label: string }> = [
  { key: "name", label: "Name" },
  { key: "tier", label: "Tier" },
  { key: "status", label: "Cryo" },
  { key: "tierChangedAt", label: "Tier changed" },
];
const TIERS = ["flygd", "blue", "green"] as const;

function fmt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tier?: string;
    status?: string;
    sort?: string;
    dir?: string;
    error?: string;
  }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const params = await searchParams;
  const sort = (
    SORTS.some((s) => s.key === params.sort) ? params.sort : "name"
  ) as AdminListSort;
  const dir = params.dir === "desc" ? "desc" : "asc";
  const tier = TIERS.includes(params.tier as (typeof TIERS)[number])
    ? (params.tier as (typeof TIERS)[number])
    : undefined;
  const status =
    params.status === "cryo" || params.status === "active" ? params.status : undefined;
  const rows = await getAdminAccountsList(getDb(), getConfig(), {
    tier,
    status,
    sort,
    dir,
  });

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tier, status, sort, dir, ...over })) {
      if (v) p.set(k, v);
    }
    return `/admin/accounts?${p.toString()}`;
  };

  return (
    <main>
      <h1>Accounts</h1>
      {params.error === "last_admin" && <p role="alert">Cannot demote the last admin.</p>}
      <p>
        Filter tier: <a href={qs({ tier: undefined })}>all</a>{" "}
        {TIERS.map((t) => (
          <a key={t} href={qs({ tier: t })} style={{ marginRight: 8 }}>
            {tier === t ? <strong>{t}</strong> : t}
          </a>
        ))}
        · Status: <a href={qs({ status: undefined })}>all</a>{" "}
        <a href={qs({ status: "cryo" })}>
          {status === "cryo" ? <strong>cryo</strong> : "cryo"}
        </a>{" "}
        <a href={qs({ status: "active" })}>
          {status === "active" ? <strong>active</strong> : "active"}
        </a>
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {SORTS.map((s) => (
              <th key={s.key} style={{ textAlign: "left" }}>
                <a
                  href={qs({
                    sort: s.key,
                    dir: sort === s.key && dir === "asc" ? "desc" : "asc",
                  })}
                >
                  {s.label}
                  {sort === s.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
                </a>
              </th>
            ))}
            <th>Tokens</th>
            <th>Discord</th>
            <th>Map</th>
            <th>Last login</th>
            <th>Admin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <AccountRow key={r.accountId} r={r} />
          ))}
        </tbody>
      </table>
    </main>
  );
}

function AccountRow({ r }: { r: AdminAccountRow }) {
  return (
    <tr style={{ borderTop: "1px solid #ccc", verticalAlign: "top" }}>
      <td>
        <details>
          <summary>
            {r.mainName ?? <em>no main</em>}
            {r.characters.length > 1 && ` (+${r.characters.length - 1})`}
          </summary>
          <ul style={{ margin: "0.25rem 0" }}>
            {r.characters.map((c) => (
              <li key={c.id}>
                {c.name}
                {c.isMain && " (main)"} — token: {c.tokenStatus}
                {c.needsReauthForScopes && " (scope shortfall)"}
                {c.affiliationInvalid && " · affiliation invalid"}
                {c.contactSyncResult && ` · contacts: ${c.contactSyncResult}`}
                {c.mapObservedAt &&
                  ` · on map (observed ${c.mapObservedAt.toISOString().slice(0, 16)}Z)`}
              </li>
            ))}
          </ul>
          <form action={saveNoteAction.bind(null, r.accountId)}>
            <input name="note" defaultValue={r.statusNote ?? ""} placeholder="notes" />
            <button type="submit">save note</button>
          </form>
        </details>
      </td>
      <td>
        {r.tier}
        {r.tierLocked && " 🔒"}
        <div style={{ fontSize: "0.8em", opacity: 0.8 }}>
          {fmt(r.tierChangedAt)}
          {r.tierChangedByName && ` by ${r.tierChangedByName}`}
        </div>
        <div>
          {(["flygd", "blue", "green"] as const).map((t) => (
            <form
              key={t}
              action={setTierAction.bind(null, r.accountId, t)}
              style={{ display: "inline" }}
            >
              <button type="submit" disabled={r.tierLocked && r.tier === t}>
                {t}
              </button>
            </form>
          ))}
          {r.tierLocked && (
            <form
              action={returnToAutoAction.bind(null, r.accountId)}
              style={{ display: "inline" }}
            >
              <button type="submit">auto</button>
            </form>
          )}
        </div>
      </td>
      <td>
        {r.status}
        {r.status === "cryo" && (
          <div style={{ fontSize: "0.8em", opacity: 0.8 }}>
            since {fmt(r.statusChangedAt)}
          </div>
        )}
        {r.statusNote && <div style={{ fontSize: "0.8em" }}>{r.statusNote}</div>}
        <form
          action={setStatusAction.bind(
            null,
            r.accountId,
            r.status === "cryo" ? "active" : "cryo",
          )}
        >
          <button type="submit">{r.status === "cryo" ? "wake" : "cryo"}</button>
        </form>
      </td>
      <td>{fmt(r.tierChangedAt)}</td>
      <td>
        {r.tokenSummary.healthy}/{r.tokenSummary.total} ok
        {r.tokenSummary.needsReauth > 0 && ` · ${r.tokenSummary.needsReauth} re-auth`}
        {r.tokenSummary.dead > 0 && ` · ${r.tokenSummary.dead} dead`}
      </td>
      <td>{r.discordLinked ? "✓" : "✗"}</td>
      <td>{r.mapCount > 0 ? `${r.mapCount}/${r.tokenSummary.total}` : "✗"}</td>
      <td>{fmt(r.lastLoginAt)}</td>
      <td>
        {r.isAdmin ? (
          <form action={demoteAdminAction.bind(null, r.accountId)}>
            <button type="submit">revoke ✓</button>
          </form>
        ) : (
          <form action={promoteAdminAction.bind(null, r.accountId)}>
            <button type="submit">grant</button>
          </form>
        )}
      </td>
      <td>
        <form action={syncAccountAction.bind(null, r.accountId)}>
          <button type="submit">sync now</button>
        </form>
      </td>
    </tr>
  );
}
