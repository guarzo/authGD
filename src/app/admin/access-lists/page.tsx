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
import { StopWatching } from "./stop-watching";
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
  // page. `missingAccess` entries name a ROSTER character's corp, not an
  // access-list entity — the job's `readWatched` fetches those alongside the
  // list entities precisely so this read can find them.
  const names = await lookupEntityNames(
    db,
    compared.flatMap((c) => [
      ...c.comparison.nonMembers,
      ...c.comparison.broadGrants.flatMap((g) =>
        g.entityId === null ? [] : [g.entityId],
      ),
      ...c.comparison.missingAccess.flatMap((m) =>
        m.corporationId === null ? [] : [m.corporationId],
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
      <div className="page__head">
        <h1>Access lists</h1>
        <p className="page__lede">{monitorSentence(state)}</p>
      </div>

      <ConfirmNotice text={notice} at={at} />

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
          <RuleHead as="h2">Watched lists</RuleHead>

          {/* Its own class rather than `.btn-row`: same four declarations
              today, but the two answer to different things — `.btn-row` is
              the shape of a row of buttons, and a change to it should not
              have to reason about a label bound to a control. No `aside` on
              the `RuleHead` above either — `aside` is a metadata slot (every
              other user in `src/app` carries a fact: an ISK total, a
              "checked … UTC" stamp, a filter summary — never an action name),
              so the affordance's name was rendering as inert prose at the
              rule's trailing edge rather than owning a control.

              Not `.btn--primary`: this form renders in four of the five
              states `showsObservations` admits (every one but `catalog-empty`,
              which by definition has nothing addable), and in the three
              dark-monitor ones the gold is already spent on `monitorRemedy`'s
              link — re-granting a dropped scope outranks adding a list when
              nothing is being read at all. Rather than paint it gold in
              `normal` and plain elsewhere, which would make the emphasis a
              function of an unrelated fault, it stays plain everywhere and
              earns its place by sitting directly under the section it adds
              to. */}
          {addable.length > 0 && (
            <form action={addWatchAction} className="acl-add">
              <label className="acl-add__label" htmlFor="add-list">
                Catalog
              </label>
              <select
                id="add-list"
                name="accessListId"
                className="field"
                defaultValue=""
                required
              >
                {/* A real option for the default, not an absent one: every
                    option below comes from `addable`, so with no placeholder
                    the browser's ask-for-reset step selected the first list in
                    the catalog and an untouched submit added a list the admin
                    never chose, which the redirect then confirmed as a
                    deliberate act.

                    `required` is what makes the placeholder a guard rather
                    than a label. `disabled` alone only stops the option being
                    re-chosen; it does NOT stop the form submitting, and a
                    disabled selected option contributes no entry at all — so
                    an untouched submit sent no `accessListId`, `parseId` threw
                    `invalid_id` on the resulting `null`, and an ordinary
                    mis-click landed on the "Something broke" boundary
                    (measured: the form's entry list held only `$ACTION_ID_…`).
                    With `required` the browser refuses the submit and points
                    at the field, and `parseId` goes back to being what its own
                    docblock says it is — the backstop for a hand-crafted POST,
                    not the only thing between a mis-click and the error
                    page. */}
                <option value="" disabled>
                  Choose a list…
                </option>
                {addable.map((c) => (
                  <option key={c.accessListId} value={c.accessListId}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Submit pendingLabel="Adding…">Add to watchlist</Submit>
            </form>
          )}

          {/* One `ConfirmingForm` for the whole region, not one per row: both
              halves of the confirm pair — the host `ConfirmGroup` AND the
              reporting `ConfirmingForm` — must outlive a row's removal, or
              neither paints. `src/app/admin/accounts/page.tsx:1075-1097`
              documents hoisting the host alone failing for exactly this
              reason ("the reporter went down with the section"); the list
              itself, not any row inside it, is the only element guaranteed to
              survive `compared` shrinking to zero. Each row's "Stop watching"
              is a plain submit button carrying its own `accessListId`, not a
              form of its own — the button's job ends at the press, and
              submitting a shared form by name/value is ordinary HTML. */}
          <ConfirmGroup>
            <ConfirmingForm action={removeWatchAction}>
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
                    // One label for the visible name and for "Stop watching"'s
                    // accessible name, so the two can never disagree about what
                    // an unnamed list is called.
                    const label = c.name ?? `#${c.accessListId}`;
                    const head = (
                      <span className="acl-list__head">
                        <span className="acl-list__name">{label}</span>
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
                          <StopWatching accessListId={c.accessListId} name={label} />
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
                          <StopWatching accessListId={c.accessListId} name={label} />
                        </Disclosure>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ConfirmingForm>
          </ConfirmGroup>
        </>
      )}
    </main>
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
export function AccessListDetail({
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
