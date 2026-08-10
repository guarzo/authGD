import type { Metadata } from "next";
import { getDb } from "@/db";
import { requireAdminPage } from "@/lib/admin-guard";
import {
  compareAccessList,
  type AccessListComparison,
  type RosterCharacter,
} from "@/core/access-list-compare";
import { getMemberCharacters } from "@/services/desired";
import { lookupEntityNames } from "@/services/entity-names";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";
import { type AccessListReadStatus } from "@/db/schema";
import {
  getCatalog,
  getHolderView,
  getOwnCharacters,
  getWatchedListViews,
} from "@/services/access-lists";
import { Notice, RuleHead, Scroller, Status } from "@/app/_components/ui";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { ConfirmGroup, ConfirmingForm } from "@/app/_components/confirm-group";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import {
  addWatchAction,
  checkNowAction,
  designateHolderAction,
  removeWatchAction,
} from "./actions";
import {
  doneNotice,
  monitorRemedy,
  monitorSentence,
  monitorState,
  rowHasDetail,
  rowSummary,
  rowTone,
  showsObservations,
  type WatchedRow,
} from "./view";

/**
 * The access-list monitor. It reads Postgres and nothing else: a live ESI
 * fetch on render would burn a refresh-token rotation per page load (EVE
 * rotates on use), block on two round-trips, have no staleness concept to
 * display, and be dead in dry-run. "Check now" enqueues; the worker reads.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Access lists",
};

export default async function AdminAccessListsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; at?: string }>;
}) {
  // Its own guard, not the layout's: a layout does not re-run on soft
  // navigation and never sees a server action.
  const { accountId } = await requireAdminPage();
  const { done, at } = await searchParams;
  const db = getDb();

  const [holder, catalog, watched, roster, mine] = await Promise.all([
    getHolderView(db),
    getCatalog(db),
    getWatchedListViews(db),
    getMemberCharacters(db),
    getOwnCharacters(db, accountId),
  ]);

  // The viewer's own characters decide between "Grant access" and "Designate
  // as holder": there is no point offering designation to an admin who has
  // nothing to designate. Read tier-independently — `roster` is the member set
  // and an admin is often an alumnus, so filtering it by `accountId` would come
  // back empty for exactly the people who administer this page.
  const grantable = mine.find((c) => c.scopes.includes(ACCESS_LISTS_SCOPE)) ?? null;

  const state = monitorState({
    holder,
    viewerHasScope: grantable !== null,
    catalogSize: catalog.length,
  });
  const remedy = monitorRemedy(state);

  const rosterForCompare: RosterCharacter[] = roster.map((c) => ({
    characterId: c.characterId,
    name: c.name,
    accountId: c.accountId,
    corporationId: c.corporationId,
    allianceId: c.allianceId,
  }));

  const compared = watched.map((w) => ({
    ...w,
    comparison: compareAccessList({
      allowEveryone: w.allowEveryone ?? false,
      entries: w.entries,
      roster: rosterForCompare,
    }),
  }));

  // One batched cache read for every id the detail panels will print, rather
  // than one per row. Unresolved ids render bare — `lookupEntityNames` is a
  // cache read, and a name we have never fetched is not a reason to fail a
  // page.
  const names = await lookupEntityNames(
    db,
    compared.flatMap((c) => [
      ...c.comparison.nonMembers,
      ...c.comparison.broadGrants.flatMap((g) =>
        g.entityId === null ? [] : [g.entityId],
      ),
    ]),
  );

  const watchedIds = new Set(compared.map((c) => c.accessListId));
  const addable = catalog.filter((c) => !watchedIds.has(c.accessListId));
  const notice = doneNotice(done, at);
  // One instant for the whole render, so every row's "ago" text and the
  // client's first tick agree on what "now" meant when the page was built.
  const now = Date.now();

  return (
    <main id="main" className="page page--wide">
      <h1>Access lists</h1>
      <ConfirmNotice text={notice} at={at} />

      <p className="lede">{monitorSentence(state)}</p>

      <div className="btn-row btn-row--controls">
        {remedy.kind === "link" && (
          <a className="btn btn--primary" href={remedy.href}>
            {remedy.label}
          </a>
        )}
        {remedy.kind === "designate" && grantable !== null && (
          <form action={designateHolderAction}>
            <input type="hidden" name="characterId" value={grantable.characterId} />
            <Submit className="btn btn--primary" pendingLabel="Designating…">
              Designate as holder
            </Submit>
          </form>
        )}
        <form action={checkNowAction}>
          <Submit
            className={remedy.kind === "check-now" ? "btn btn--primary" : "btn"}
            pendingLabel="Queueing…"
          >
            Check now
          </Submit>
        </form>
      </div>

      {showsObservations(state) && (
        <>
          <RuleHead as="h2" aside={addable.length === 0 ? undefined : "add a list"}>
            Watched lists
          </RuleHead>

          {addable.length > 0 && (
            <form action={addWatchAction} className="btn-row">
              <label htmlFor="add-list">List</label>
              <select id="add-list" name="accessListId" defaultValue="">
                {addable.map((c) => (
                  <option key={c.accessListId} value={c.accessListId}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Submit pendingLabel="Adding…">Add to watchlist</Submit>
            </form>
          )}

          {compared.length === 0 ? (
            <Notice>No lists are being watched yet.</Notice>
          ) : (
            <ul className="acl-list">
              {compared.map((c) => {
                const row: WatchedRow = {
                  accessListId: c.accessListId,
                  name: c.name,
                  readStatus: c.readStatus,
                  observedAt: c.observedAt,
                  allowEveryone: c.allowEveryone,
                  missingAccess: c.comparison.missingAccess.length,
                  nonMembers: c.comparison.nonMembers.length,
                  broadGrants: c.comparison.broadGrants.length,
                };
                const observedIso =
                  c.observedAt === null ? null : c.observedAt.toISOString();
                const head = (
                  <span className="acl-list__head">
                    <span className="acl-list__name">
                      {c.name ?? `#${c.accessListId}`}
                    </span>
                    <Status tone={rowTone(row)}>{rowSummary(row)}</Status>
                    {/* Honest staleness: the last SUCCESSFUL read, never the
                        last attempt. A row whose latest attempt failed still
                        shows how old the answer under it is. */}
                    {observedIso !== null && (
                      <RelativeTime
                        iso={observedIso}
                        initial={formatAgo(observedIso, now)}
                      />
                    )}
                  </span>
                );
                // Only rows with something to report expand. A clean list gets
                // no disclosure control at all, rather than a toggle that opens
                // an empty box — but it still gets its own "Stop watching",
                // inline. Putting that control only inside the drawer would
                // make a clean or never-read list permanently unremovable,
                // which is precisely the list an admin is most likely to want
                // off the page.
                if (!rowHasDetail(row)) {
                  return (
                    <li key={c.accessListId} className="acl-list__row">
                      {head}
                      <StopWatching accessListId={c.accessListId} />
                    </li>
                  );
                }
                return (
                  <li key={c.accessListId} className="acl-list__row">
                    <Disclosure summary={head} className="acl-list__disc">
                      <AccessListDetail
                        detail={c.detail}
                        readStatus={c.readStatus}
                        comparison={c.comparison}
                        names={names}
                      />
                      <StopWatching accessListId={c.accessListId} />
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

/**
 * The one control every watched row carries, expandable or not.
 *
 * `ConfirmGroup`/`ConfirmingForm`, not a bare form, in BOTH placements. Inside
 * the `Disclosure` that is load-bearing: a redirect would reset the drawer's
 * `useState` and close it on the very press that used it. Outside, it is
 * uniformity — one component, one confirm affordance, one label, so the two
 * branches cannot drift into two different removal experiences. `removeWatch`
 * is idempotent (Task 6), so a double submit is harmless either way.
 */
function StopWatching({ accessListId }: { accessListId: number }) {
  return (
    <ConfirmGroup>
      <ConfirmingForm action={removeWatchAction}>
        <input type="hidden" name="accessListId" value={accessListId} />
        <Submit className="btn btn--quiet" pendingLabel="Removing…">
          Stop watching
        </Submit>
      </ConfirmingForm>
    </ConfirmGroup>
  );
}

/**
 * Names lead and ids are secondary throughout: the admin retypes these in-game,
 * where the id is not what the client accepts.
 *
 * Broad grants always carry the "plus an unknown number of others" clause. We
 * store a corporation per character and hold no corp or alliance roster, so the
 * covered-member count is OUR members only — the page must never imply a
 * corp-granted list is fully accounted for.
 */
function AccessListDetail({
  detail,
  readStatus,
  comparison,
  names,
}: {
  detail: string | null;
  readStatus: AccessListReadStatus | null;
  comparison: AccessListComparison;
  names: Map<number, string>;
}) {
  return (
    <div className="acl-detail">
      {readStatus !== null && readStatus !== "ok" && (
        <Notice tone="warn">
          {readStatus === "not_visible"
            ? "The holder can no longer see this list. The membership below is the last successful read."
            : `The last read failed${detail === null ? "" : `: ${detail}`}. The membership below is the last successful read.`}
        </Notice>
      )}

      {comparison.missingAccess.length > 0 && (
        <>
          <RuleHead as="h3">Missing access ({comparison.missingAccess.length})</RuleHead>
          <Scroller label="Members missing access">
            <table>
              <thead>
                <tr>
                  <th scope="col">Character</th>
                  <th scope="col">Corporation</th>
                </tr>
              </thead>
              <tbody>
                {comparison.missingAccess.map((m) => (
                  <tr key={m.characterId}>
                    <td>{m.name}</td>
                    <td>
                      {m.corporationId === null
                        ? "—"
                        : (names.get(m.corporationId) ?? `#${m.corporationId}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </>
      )}

      {comparison.nonMembers.length > 0 && (
        <>
          <RuleHead as="h3">
            Has access, not a member ({comparison.nonMembers.length})
          </RuleHead>
          <ul className="acl-detail__names">
            {comparison.nonMembers.map((id) => (
              <li key={id}>{names.get(id) ?? `#${id}`}</li>
            ))}
          </ul>
        </>
      )}

      {comparison.broadGrants.length > 0 && (
        <>
          <RuleHead as="h3">Broad grants ({comparison.broadGrants.length})</RuleHead>
          <ul className="acl-detail__names">
            {comparison.broadGrants.map((g) => (
              <li key={`${g.kind}:${g.entityId ?? "all"}`}>
                {g.kind === "everyone"
                  ? "Open to everyone"
                  : `${g.kind === "corporation" ? "Corporation" : "Alliance"} ${
                      g.entityId === null
                        ? ""
                        : (names.get(g.entityId) ?? `#${g.entityId}`)
                    }`}
                {" — covers "}
                {g.coveredMembers} of our members, plus an unknown number of others
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
