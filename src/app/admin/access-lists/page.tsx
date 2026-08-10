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
  sharedCorporation,
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
  // What a list is called, by the same precedence the audit path already uses:
  // catalog first, snapshot second (`watchedListName`,
  // src/services/access-lists.ts:88-103). A list added to the watchlist a
  // minute ago has no snapshot row at all, so `w.name` is null and the row was
  // printing a bare `#4104` — while the catalog it was picked FROM knew the
  // name the whole time. Deriving both from one rule also stops the page and
  // the audit log naming the same list differently.
  const catalogNames = new Map(catalog.map((c) => [c.accessListId, c.name]));
  const notice = doneNotice(done, at);
  // One instant for the whole render, so every row's "ago" text and the
  // client's first tick agree on what "now" meant when the page was built.
  const now = Date.now();

  // Whether the watched-lists region has anything to put in the page. Narrower
  // than `showsObservations`, deliberately: that predicate asks "is there a
  // stale answer worth showing", and its answer is yes for the three holder
  // faults — correct when rows exist, and an empty promise when they do not.
  // With no rows and nothing addable, the region is a heading over a notice
  // saying the heading has nothing under it.
  const showsRegion =
    showsObservations(state) && (compared.length > 0 || addable.length > 0);

  return (
    // `tabIndex={-1}` so the skip link lands here rather than merely scrolling
    // here. A fragment link moves focus only to elements the platform already
    // considers focusable, and `<main>` is not one — without it the viewport
    // jumps and the caret stays in the header, so the next Tab walks back
    // through the nav the member just skipped (SC 2.4.1). Ten of the app's
    // eleven `id="main"` elements carry it; this was the one that didn't,
    // because it landed after the sweep that added the rest.
    // `page--wide` only once there is a table to be wide for. The fault states
    // put one sentence and one link on the page, and a 78rem column turns that
    // into a ribbon across an otherwise empty field — the measure the prose
    // needs is the one `.page--narrow` sets. It caps CONTENTS rather than the
    // page box, so the `h1`'s left edge and every rule's origin stay on the
    // same vertical as the other admin routes either way; only the line length
    // changes.
    <main
      id="main"
      tabIndex={-1}
      className={`page ${showsRegion ? "page--wide" : "page--narrow"}`}
    >
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
        {/*
          Only where a check can actually read something. The button used to
          render in every state, including the one a fresh deployment opens on:
          no holder, so `runAccessListsJob` returns at its first branch having
          read nothing (src/jobs/access-lists.ts:59-62) — and the admin was told
          "Check queued at 09:41:22.418 UTC. Reload this page once the worker
          has run." They reload to a byte-identical page, with no way to tell a
          dead worker from a stuck queue from a feature that was never
          configured. The confirmation was true about the enqueue and false
          about everything the admin cared about.

          Gated on the remedy rather than on `showsObservations(state)`, which
          is the wider predicate this page already uses for the table below.
          The two differ on the three holder-fault states, and the job cannot
          read in those either: a dropped scope returns at branch 2
          (`access-lists.ts:80-83`) and both token faults return `failed`
          without a read (`:101-121`). `showsObservations` asks "is there a
          stale answer worth showing" — true there, which is why the table
          stays. This asks "can a check change anything", and the honest answer
          in all three is no; the link beside it is the action that helps.

          Since the form now renders only when `remedy.kind === "check-now"`,
          the class is unconditionally primary — it is the state's one remedy,
          not a secondary sitting next to a link.
        */}
        {remedy.kind === "check-now" && (
          <form action={checkNowAction}>
            <Submit className="btn btn--primary" pendingLabel="Queueing…">
              Check now
            </Submit>
          </form>
        )}
      </div>

      {showsObservations(state) && (
        <>
          {showsRegion && (
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
            </>
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
              submitting a shared form by name/value is ordinary HTML.

              Which is also why this pair sits OUTSIDE the `showsRegion` gate
              above while everything visible sits inside it. Removing the last
              watched list can empty `compared` and `addable` in the same
              commit — a list dropped from the catalog is watched but not
              addable — so gating the pair on `showsRegion` would unmount the
              reporter on exactly the press it exists to report. Empty, it
              renders a `<form>` with nothing in it and costs the page
              nothing. */}
          <ConfirmGroup>
            <ConfirmingForm action={removeWatchAction}>
              {compared.length === 0 ? (
                showsRegion && <Notice>No lists are being watched yet.</Notice>
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
                    const label =
                      catalogNames.get(c.accessListId) ?? c.name ?? `#${c.accessListId}`;
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
                        <Disclosure
                          summary={head}
                          className="acl-list__disc"
                          // A pre-built name, because the computed one would not
                          // hold still. The summary's accessible name is derived
                          // from its contents, and one of those contents is
                          // `RelativeTime` — a client component on a shared 30s
                          // ticker. So the control renamed itself twice a minute
                          // ("Alliance ACL 3 to add, 2 minutes ago" → "… 3
                          // minutes ago") without any state having changed. That
                          // is SC 4.1.2 in the announcement channel, where a
                          // screen reader re-reads a control whose name it
                          // notices has changed, and SC 3.2.4 for a voice user,
                          // whose "click Alliance ACL 3 to add 2 minutes ago"
                          // stops matching whatever the page now calls it.
                          //
                          // Starts with the visible name, so 2.5.3 label-in-name
                          // still matches on the word a voice user would say,
                          // and restates the row's status after it — an
                          // `aria-label` on a summary replaces the computed name
                          // outright, so anything stable that the contents were
                          // contributing has to be put back by hand or it leaves
                          // the assistive channel entirely (R4). Everything here
                          // is server-computed and holds still for the life of
                          // the render. The one thing deliberately not restated
                          // is the timestamp, which is the whole reason this
                          // prop is here.
                          ariaLabel={`${label} ${rowSummary(row)} — findings and controls`}
                        >
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
 * The one control every watched row carries, expandable or not. A plain
 * submit button, not a form of its own: it submits the single `ConfirmingForm`
 * that wraps the whole watched-lists region (`AdminAccessListsPage` above),
 * carrying its own `accessListId` by name/value the way any button in a
 * shared HTML form does. `<form>` cannot nest, and this row's own form would
 * unmount with it anyway — the button's job ends at the press.
 *
 * The region-wide form exists because a row-level (or even row-level-group)
 * `ConfirmingForm` unmounts in the same commit that would paint its own
 * confirmation: `revalidatePath` and this action's `useActionState` result
 * land together, so removing the last row collapses straight to the empty
 * `Notice`, taking whatever reported the text with it.
 * `src/app/admin/accounts/page.tsx:1075-1097` documents the same failure for
 * the Discord drawer group and states the fix this page follows: "hoisting
 * the host alone is not enough... both halves have to outlive the press" —
 * here that means the `ConfirmingForm`, not just the `ConfirmGroup`, has to
 * sit above every row rather than inside one.
 *
 * No `pendingLabel` here, unlike every other `Submit` on this page.
 * `useFormStatus` (inside `Submit`) reports the nearest parent `<form>`'s
 * pending state, and after this refactor that form is shared by every row —
 * pressing one row's button flips `pending` for all of them at once, so a
 * "Removing…" label would name the wrong row on every row but the one
 * actually in flight. `aria-busy` still fans out the same way, but that is
 * honest rather than a bug: the shared form genuinely is busy, region-wide,
 * until the one submission it can hold at a time resolves. Same reason
 * `useSubmitGuard` correctly refuses a second press anywhere in the region
 * while the first is in flight, not just on the pressed row's own button —
 * one form, one in-flight submission. Undoing any of this would mean giving
 * the row its own form again, which is the exact structure that breaks the
 * confirmation.
 */
function StopWatching({ accessListId, name }: { accessListId: number; name: string }) {
  return (
    <Submit
      name="accessListId"
      value={accessListId}
      className="btn btn--quiet"
      // Every watched row renders this button with the same visible words, so
      // the accessible name has to carry the row's identity — `Submit`'s own
      // rule for when an aria-label is required. The visible text stays
      // "Stop watching"; the label appends the list it acts on.
      aria-label={`Stop watching ${name}`}
    >
      Stop watching
    </Submit>
  );
}

/**
 * Names lead and ids are secondary throughout: the admin retypes these in-game,
 * where the id is not what the client accepts.
 *
 * Broad grants carry the "plus an unknown number of others" clause once, above
 * the list rather than on every line. We store a corporation per character and
 * hold no corp or alliance roster, so the covered-member count is OUR members
 * only — the page must never imply a corp-granted list is fully accounted for.
 * Stating it per line said the identical sentence up to N times to make one
 * point about how the count is computed, which is a property of the counting
 * and not of any particular grant.
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
  // See `sharedCorporation`. Null means the rows genuinely differ, and only
  // then is a Corporation column earning its width.
  const missingCorp = sharedCorporation(comparison.missingAccess);
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
          {missingCorp === null ? (
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
          ) : (
            <>
              <p className="acl-detail__norm">
                All of them are in {names.get(missingCorp) ?? `#${missingCorp}`}.
              </p>
              <ul className="acl-detail__names">
                {comparison.missingAccess.map((m) => (
                  <li key={m.characterId}>{m.name}</li>
                ))}
              </ul>
            </>
          )}
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
          <p className="table-note">
            Counts are our members only — each grant covers those, plus an unknown number
            of others.
          </p>
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
                {g.coveredMembers} of our members
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
