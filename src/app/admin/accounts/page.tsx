import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import {
  getAdminAccountsList,
  type AdminAccountRow,
  type AdminListSort,
} from "@/services/account-view";
import { RuleHead, Scroller, Status, Tier } from "@/app/_components/ui";
import { RowDisclosure } from "@/app/_components/row-disclosure";
import { Submit } from "@/app/_components/submit";
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

export const metadata: Metadata = {
  title: "Accounts",
};

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
    queued?: string;
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
  const filtered = Boolean(tier || status);
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
  const syncQueuedHref = qs({ queued: "account" });

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="page__head">
        <h1>Accounts</h1>
        <p className="page__lede">
          One row per account. Tier and cryo are set here; everything else is what the
          sync jobs last observed.
        </p>
      </div>

      {params.error === "last_admin" && (
        <p className="notice notice--bad" data-glyph="!" role="alert">
          Cannot demote the last admin.
        </p>
      )}

      {params.queued === "account" && (
        <p className="notice" data-glyph="·">
          Sync queued. The worker picks it up within a few seconds.
        </p>
      )}

      <RuleHead as="h2">Filter</RuleHead>
      <div className="filters">
        <div className="filters__group" role="group" aria-label="Filter by tier">
          <span className="filters__label">Tier</span>
          <a
            className="btn"
            href={qs({ tier: undefined })}
            aria-current={!tier ? "true" : undefined}
          >
            all
          </a>
          {TIERS.map((t) => (
            <a
              key={t}
              className="btn"
              href={qs({ tier: t })}
              aria-current={tier === t ? "true" : undefined}
            >
              {t}
            </a>
          ))}
        </div>
        <span className="filters__sep" aria-hidden="true" />
        <div className="filters__group" role="group" aria-label="Filter by status">
          <span className="filters__label">Status</span>
          <a
            className="btn"
            href={qs({ status: undefined })}
            aria-current={!status ? "true" : undefined}
          >
            all
          </a>
          <a
            className="btn"
            href={qs({ status: "cryo" })}
            aria-current={status === "cryo" ? "true" : undefined}
          >
            cryo
          </a>
          <a
            className="btn"
            href={qs({ status: "active" })}
            aria-current={status === "active" ? "true" : undefined}
          >
            active
          </a>
        </div>
      </div>

      <RuleHead as="h2">
        {rows.length === 1 ? "1 account" : `${rows.length} accounts`}
      </RuleHead>
      <Scroller label="Accounts" tall>
        <table className="log log--dense log--sticky-head log--sticky-col">
          {/* The scanning anchor gets the surplus. Every other column holds a
              single badge, date, or button pair, so `width: 1%` collapses it to
              its own content and hands the leftover width to Name. Before the
              tier controls moved into the drawer, Tier was the widest column in
              the table purely because it carried a stack of buttons. */}
          <colgroup>
            <col />
            <col className="log__col--fit" span={9} />
          </colgroup>
          <thead>
            <tr>
              {SORTS.map((s) => (
                <th
                  key={s.key}
                  aria-sort={
                    sort === s.key ? (dir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  {/* The arrow is aria-hidden because aria-sort on the header
                      already carries the state; it keeps the link's accessible
                      name stable at just the column label. */}
                  <a
                    href={qs({
                      sort: s.key,
                      dir: sort === s.key && dir === "asc" ? "desc" : "asc",
                    })}
                  >
                    {s.label}
                    {sort === s.key && (
                      <span aria-hidden="true"> {dir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </a>
                </th>
              ))}
              <th>Tokens</th>
              <th>Discord</th>
              <th>Map</th>
              <th>Last login</th>
              <th>Admin</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <AccountRow key={r.accountId} r={r} syncQueuedHref={syncQueuedHref} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="log__empty" colSpan={10}>
                  {filtered
                    ? "No accounts match this filter."
                    : "No accounts yet. They appear here after someone signs in with EVE."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Scroller>
    </main>
  );
}

function AccountRow({
  r,
  syncQueuedHref,
}: {
  r: AdminAccountRow;
  syncQueuedHref: string;
}) {
  const tokens = r.tokenSummary;
  const tokenTone =
    tokens.dead > 0
      ? "bad"
      : tokens.needsReauth > 0
        ? "warn"
        : tokens.total === 0
          ? "off"
          : "ok";

  // The pinned first column exists so a 28px tier control is never pressed with
  // nothing on screen saying whose it is, and "no main" was the same string on
  // every account that lacks one — identifying the row as well as no pin at all.
  // Fall through to something that actually names it.
  //
  // Every name here reaches this page as a character's `name` — `mainName` is
  // one too (services/account-view.ts) — and ESI has handed back names that are
  // empty or whitespace. Whitespace is the dangerous shape: it is truthy, so it
  // takes the identity slot and then renders as nothing, which is the one
  // outcome this column exists to prevent. Normalize once here so the pick, the
  // visible label and the accessible name cannot disagree about whether a name
  // names anything.
  const named = (n: string | null | undefined) => n?.trim() || null;
  const mainName = named(r.mainName);
  // The service returns characters unordered, so pick by name rather than by
  // array position, or the identity of a row changes between two renders of the
  // same data. Blank names are dropped rather than sorted: "" sorts first, so a
  // whitespace-only name would otherwise win the pick.
  const firstName = mainName
    ? null
    : [...r.characters]
        .flatMap((c) => named(c.name) ?? [])
        .sort((a, b) => a.localeCompare(b))[0];
  const idLabel = `acct ${r.accountId.slice(0, 8)}`;
  // The same identity as one string, for accessible names with nowhere to put
  // markup. Both operands are already normalized to a real name or null, so the
  // fallback cannot walk past a blank into `aria-label="Note for "` — a row
  // with no identity at all, in the column whose whole job is saying whose tier
  // is about to change.
  const identity = mainName ?? firstName ?? idLabel;
  // RowDisclosure puts its label on the summary as `aria-label`, which
  // overrides the visible text, so this mirrors that text verbatim — an
  // accessible name has to stay a superset of its visible label (WCAG 2.5.3).
  const pinLabel = firstName ? `${identity} ·no main` : identity;

  return (
    <tr>
      <td>
        <RowDisclosure
          label={pinLabel}
          summary={
            <>
              {mainName || (
                <>
                  {firstName || <span className="mono">{idLabel}</span>}
                  {/* Marked in text, not by styling: the row is named by a
                      character that is not its main, and that distinction has
                      to be perceivable without seeing the dimming. */}
                  {firstName && <span className="mono dim"> ·no main</span>}
                </>
              )}
              {r.characters.length > 1 && ` (+${r.characters.length - 1})`}
            </>
          }
        >
          <section className="drawer__group">
            <span className="drawer__label">Crew</span>
            <ul className="crew">
              {r.characters.map((c) => (
                <li key={c.id}>
                  <b>{c.name}</b>
                  {c.isMain && " (main)"}
                  {" — token: "}
                  {c.tokenStatus}
                  {c.needsReauthForScopes && " (scope shortfall)"}
                  {c.affiliationInvalid && " · affiliation invalid"}
                  {c.contactSyncResult &&
                    ` · contacts: ${c.contactSyncResult}${
                      c.contactSyncDetail
                        ? // The job joins near-miss candidates with ", " (src/jobs/contacts.ts).
                          // Quoting each one separately keeps this from reading as one
                          // (wrong) label name when there are two or more.
                          ` (${c.contactSyncDetail
                            .split(", ")
                            .map((name) => `"${name}"`)
                            .join(", ")})`
                        : ""
                    }`}
                  {c.mapObservedAt &&
                    ` · on map (observed ${c.mapObservedAt.toISOString().slice(0, 16)}Z)`}
                </li>
              ))}
            </ul>
          </section>

          <section className="drawer__group">
            <span className="drawer__label">Set tier</span>
            <div className="btn-group">
              {TIERS.map((t) => (
                <form
                  key={t}
                  action={setTierAction.bind(null, r.accountId, t)}
                  className="inline-form"
                >
                  {/* Same principle as the note field, and the same reason: a
                      speech-input or screen-reader user reaches this control
                      with only the tier word to go on, and this is the control
                      derole-don't-boot turns on. The visible text stays the bare
                      tier word, so the accessible name keeps it verbatim (WCAG
                      2.5.3) and adds the row in front of it. */}
                  <Submit
                    className="btn btn--micro"
                    disabled={r.tierLocked && r.tier === t}
                    aria-pressed={r.tier === t}
                    aria-label={`Set ${identity} to ${t}`}
                  >
                    {t}
                  </Submit>
                </form>
              ))}
              {r.tierLocked && (
                <form
                  action={returnToAutoAction.bind(null, r.accountId)}
                  className="inline-form"
                >
                  <Submit
                    className="btn btn--micro"
                    aria-label={`return ${identity} to auto tier`}
                  >
                    auto
                  </Submit>
                </form>
              )}
            </div>
            {r.tierChangedByName && (
              <span className="dim mono">set by {r.tierChangedByName}</span>
            )}
          </section>

          <section className="drawer__group">
            <span className="drawer__label">Cryo</span>
            <form
              action={setStatusAction.bind(
                null,
                r.accountId,
                r.status === "cryo" ? "active" : "cryo",
              )}
            >
              <Submit
                className="btn btn--micro"
                aria-label={`${r.status === "cryo" ? "wake" : "freeze"} ${identity}`}
              >
                {r.status === "cryo" ? "wake" : "freeze"}
              </Submit>
            </form>
            {r.status === "cryo" && (
              <span className="dim mono nowrap">since {fmt(r.statusChangedAt)}</span>
            )}
          </section>

          <section className="drawer__group">
            <span className="drawer__label">Note</span>
            <form action={saveNoteAction.bind(null, r.accountId)} className="note-form">
              <input
                className="field"
                name="note"
                defaultValue={r.statusNote ?? ""}
                placeholder="notes"
                aria-label={`Note for ${identity}`}
              />
              <Submit className="btn btn--micro">save note</Submit>
            </form>
          </section>
        </RowDisclosure>
      </td>

      <td>
        <Tier tier={r.tier} locked={r.tierLocked} />
      </td>

      <td>
        {r.status === "cryo" ? (
          <Status tone="warn">cryo</Status>
        ) : (
          <Status tone="off">active</Status>
        )}
      </td>

      <td className="mono nowrap">{fmt(r.tierChangedAt)}</td>

      <td>
        <div className="stack">
          <Status tone={tokenTone}>
            {tokens.healthy}/{tokens.total} ok
          </Status>
          {tokens.needsReauth > 0 && (
            <span className="dim mono nowrap">{tokens.needsReauth} re-auth</span>
          )}
          {tokens.dead > 0 && <span className="dim mono nowrap">{tokens.dead} dead</span>}
        </div>
      </td>

      <td>
        {r.discordLinked ? (
          <Status tone="ok">linked</Status>
        ) : (
          <Status tone="off">none</Status>
        )}
      </td>

      <td>
        {/* Every character of a flygd account is meant to be on the map ACL, so
            a partial count is a gap to chase, not a healthy state. Non-flygd
            accounts have none by design, which is the "off" case. */}
        {r.mapCount === 0 ? (
          <Status tone="off">off</Status>
        ) : (
          <Status tone={r.mapCount === tokens.total ? "ok" : "warn"}>
            {r.mapCount}/{tokens.total}
          </Status>
        )}
      </td>

      <td className="mono nowrap">{fmt(r.lastLoginAt)}</td>

      <td>{r.isAdmin ? <Status>admin</Status> : <Status tone="off">member</Status>}</td>

      {/* One grade, one group. Revoke and sync now are both row actions; before,
          revoke was a bordered danger button and sync now was bare text, which
          read as one button with a broken half rather than two peers. */}
      <td>
        <div className="btn-row btn-row--tight">
          {r.isAdmin ? (
            <form action={demoteAdminAction.bind(null, r.accountId)}>
              <Submit className="btn btn--micro btn--danger">revoke</Submit>
            </form>
          ) : (
            <form action={promoteAdminAction.bind(null, r.accountId)}>
              <Submit className="btn btn--micro">grant</Submit>
            </form>
          )}
          <form action={syncAccountAction.bind(null, r.accountId, syncQueuedHref)}>
            <Submit className="btn btn--micro nowrap">sync now</Submit>
          </form>
        </div>
      </td>
    </tr>
  );
}
