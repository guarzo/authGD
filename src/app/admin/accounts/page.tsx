import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getConfig, type Config } from "@/config";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { isContactsTarget } from "@/services/desired";
import {
  getAdminAccountsList,
  type AdminAccountRow,
  type AdminCharacterRow,
  type AdminListSort,
} from "@/services/account-view";
import { RuleHead, Scroller, Status, Tier } from "@/app/_components/ui";
// Shared with the member's own character table rather than reimplemented here:
// the near-miss label copy and the "not managed" wording are the same question
// asked about the same character, and two copies drift.
import { ContactState } from "@/app/account/contact-state";
import { RowDisclosure } from "@/app/_components/row-disclosure";
import { Submit } from "@/app/_components/submit";
import { ConfirmArmScope, ConfirmSubmit } from "@/app/_components/confirm-submit";
import { renderedAt } from "@/app/_components/utc-time";
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

const ERRORS: Record<string, string> = {
  last_admin: "Cannot demote the last admin.",
  not_admin:
    "Your admin access changed since this page loaded. Refresh to see the current state.",
};

// The columns after the sortable ones, in render order. A list rather than a
// count because three separate things depend on the table's width — the
// header row, the empty-state row's colSpan, and the drawer row's — and a
// hand-kept number drifts the moment someone adds a column and updates two of
// the three. Adding a label here is the only edit a new column needs.
const FIXED_COLUMNS = [
  "Tokens",
  "Discord",
  "Map",
  "Last login",
  "Admin",
  "Actions",
] as const;

const COLUMN_COUNT = SORTS.length + FIXED_COLUMNS.length;

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
  const cfg = getConfig();
  const rows = await getAdminAccountsList(getDb(), cfg, {
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

      {params.error && ERRORS[params.error] && (
        <p className="notice notice--bad" data-glyph="!" role="alert">
          {ERRORS[params.error]}
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

      <RuleHead as="h2" aside={<span className="dim mono">{renderedAt()}</span>}>
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
            <col className="log__col--fit" span={COLUMN_COUNT - 1} />
          </colgroup>
          <thead>
            <tr>
              {SORTS.map((s) => (
                <th
                  key={s.key}
                  scope="col"
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
              {FIXED_COLUMNS.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <ConfirmArmScope>
              {rows.map((r) => (
                <AccountRow
                  key={r.accountId}
                  r={r}
                  cfg={cfg}
                  syncQueuedHref={syncQueuedHref}
                />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={COLUMN_COUNT}>
                    {filtered
                      ? "No accounts match this filter."
                      : "No accounts yet. They appear here after someone signs in with EVE."}
                  </td>
                </tr>
              )}
            </ConfirmArmScope>
          </tbody>
        </table>
      </Scroller>
    </main>
  );
}

/**
 * Token colour is proportional, not absolute. A long-dead token on a
 * forgotten alt is a routine standing state, not an alarm; the one case that
 * actually means the account is cut off is the main going dark, so that is
 * the only thing that forces red on its own. Short of that, red is reserved
 * for zero healthy tokens (every character is dead or needs re-auth), and
 * amber covers everything short of that. "nothing reads as punishment"
 * (PRODUCT.md) otherwise fails on any account with one stale alt.
 */
function tokenTone(r: AdminAccountRow): "ok" | "warn" | "bad" | "off" {
  const tokens = r.tokenSummary;
  if (tokens.total === 0) return "off";
  const main = r.characters.find((c) => c.isMain);
  const mainDead =
    main !== undefined &&
    (main.tokenStatus === "invalid" || main.tokenStatus === "missing");
  if (tokens.healthy === 0 || mainDead) return "bad";
  if (tokens.dead > 0 || tokens.needsReauth > 0) return "warn";
  return "ok";
}

/** The token cell's per-character badge, admin's finer-grained view of the
 *  same states the member page's Token column shows in summary. */
function TokenState({ c }: { c: AdminCharacterRow }) {
  if (c.tokenStatus === "invalid") return <Status tone="bad">invalid</Status>;
  if (c.tokenStatus === "missing") return <Status tone="bad">missing</Status>;
  if (c.tokenStatus === "needs_reauth")
    return <Status tone="warn">re-auth needed</Status>;
  if (c.needsReauthForScopes) return <Status tone="warn">scope shortfall</Status>;
  return <Status tone="ok">valid</Status>;
}

function AccountRow({
  r,
  cfg,
  syncQueuedHref,
}: {
  r: AdminAccountRow;
  cfg: Config;
  syncQueuedHref: string;
}) {
  const tokens = r.tokenSummary;

  // Shown once above the crew table rather than once per character on the map:
  // the ACL observation is a single job run, so every character on it shares
  // the same timestamp, and repeating it per row is the same information N
  // times over.
  const mapObservedAt = r.characters.reduce<Date | null>(
    (latest, c) =>
      c.mapObservedAt && (!latest || c.mapObservedAt > latest) ? c.mapObservedAt : latest,
    null,
  );

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
    <RowDisclosure
      label={pinLabel}
      colSpan={COLUMN_COUNT}
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
      cells={
        <>
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
              <Status tone={tokenTone(r)}>
                {tokens.healthy}/{tokens.total} ok
              </Status>
              {tokens.needsReauth > 0 && (
                <span className="dim mono nowrap">{tokens.needsReauth} re-auth</span>
              )}
              {tokens.dead > 0 && (
                <span className="dim mono nowrap">{tokens.dead} dead</span>
              )}
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

          <td>
            {r.isAdmin ? <Status>admin</Status> : <Status tone="off">member</Status>}
          </td>

          {/* One grade, one group. Revoke and sync now are both row actions; before,
              revoke was a bordered danger button and sync now was bare text, which
              read as one button with a broken half rather than two peers.

              All four names here name their row, the way the drawer's controls
              already do: on a table with one row per account the visible word
              names the verb and nothing else, and "grant" read out of its row
              does not say whose admin is about to change. Each name leads with
              the visible label, so speech input still reaches the control by
              what is written on it (WCAG 2.5.3). */}
          <td>
            <div className="btn-row btn-row--tight">
              {r.isAdmin ? (
                <form action={demoteAdminAction.bind(null, r.accountId)}>
                  <ConfirmSubmit
                    className="btn btn--micro btn--danger"
                    label="revoke"
                    restName={`revoke admin for ${identity}`}
                    confirmName={`confirm revoke admin for ${identity}`}
                  />
                </form>
              ) : (
                <form action={promoteAdminAction.bind(null, r.accountId)}>
                  <Submit
                    className="btn btn--micro"
                    pendingLabel="granting…"
                    aria-label={`grant admin to ${identity}`}
                  >
                    grant
                  </Submit>
                </form>
              )}
              <form action={syncAccountAction.bind(null, r.accountId, syncQueuedHref)}>
                <Submit
                  className="btn btn--micro nowrap"
                  pendingLabel="queueing…"
                  aria-label={`sync now for ${identity}`}
                >
                  sync now
                </Submit>
              </form>
            </div>
          </td>
        </>
      }
    >
      {/* The admin opened the row to act, not to read a manifest: tier, cryo,
          and note come first, and the crew list — the thing that scrolls
          longest on an eight-alt account — sits below them. */}
      <div className="drawer__controls">
        <section className="drawer__group">
          <span className="drawer__label">Set tier</span>
          <div className="btn-group">
            {TIERS.map((t) => (
              <form
                key={t}
                action={setTierAction.bind(null, r.accountId, t)}
                className="inline-form"
              >
                {/* No `pendingLabel` here, unlike every other control in this
                    drawer: the label is the tier itself, and swapping it for
                    "setting…" would erase which of the three was pressed at
                    exactly the moment the admin is checking. `disabled` plus
                    `aria-busy` still report the in-flight state.

                    Same principle as the note field for the accessible name: a
                    speech-input or screen-reader user reaches this control with
                    only the tier word to go on, and this is the control
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
                  pendingLabel="resetting…"
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
            {r.status === "cryo" ? (
              <Submit
                className="btn btn--micro"
                pendingLabel="waking…"
                aria-label={`wake ${identity}`}
              >
                wake
              </Submit>
            ) : (
              <ConfirmSubmit
                className="btn btn--micro"
                armedClassName="btn btn--micro btn--danger"
                label="freeze"
                restName={`freeze ${identity}`}
                confirmName={`confirm freeze ${identity}`}
              />
            )}
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
            <Submit
              className="btn btn--micro"
              pendingLabel="saving…"
              aria-label={`save note for ${identity}`}
            >
              save note
            </Submit>
          </form>
        </section>
      </div>

      <section className="drawer__crew">
        <span className="drawer__label">Crew</span>
        {mapObservedAt && (
          <span className="dim mono">
            Map observed {mapObservedAt.toISOString().slice(0, 16)}Z
          </span>
        )}
        <Scroller label={`${identity} crew`}>
          <table className="log log--crew">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Token</th>
                <th scope="col">Standings</th>
                <th scope="col">Map</th>
              </tr>
            </thead>
            <tbody>
              {r.characters.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="char">
                      {c.name}{" "}
                      {c.isMain && <strong className="char__main">(main)</strong>}
                    </span>
                  </td>
                  <td>
                    <div className="stack">
                      <TokenState c={c} />
                      {c.affiliationInvalid && (
                        <span className="dim">affiliation invalid</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="stack">
                      <ContactState
                        result={c.contactSyncResult}
                        detail={c.contactSyncDetail}
                        label={cfg.standings.label}
                        target={isContactsTarget({
                          tier: r.tier,
                          affiliationInvalid: c.affiliationInvalid,
                        })}
                      />
                    </div>
                  </td>
                  <td>
                    {c.mapObservedAt ? (
                      <Status tone="ok">on</Status>
                    ) : (
                      <Status tone="off">off</Status>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      </section>
    </RowDisclosure>
  );
}
