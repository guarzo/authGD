import type { Metadata } from "next";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { compareRosterRows, formatStructureAlert } from "@/core/structure-event";
import { requireAdminPage } from "@/lib/admin-guard";
import { resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import {
  findGrantableCharacter,
  getReadStates,
  getRecentEvents,
  getRoster,
  getStructureHolder,
  toHolderView,
  type RosterRow,
} from "@/services/structures";
import { lookupCachedNames } from "@/services/universe-names";
import { RuleHead, Scroller, Status } from "@/app/_components/ui";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { Submit } from "@/app/_components/submit";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import { checkNowAction, designateStructureHolderAction } from "./actions";
import {
  doneNotice,
  forbiddenReads,
  monitorRemedy,
  monitorSentence,
  monitorState,
  rowTone,
  showsRoster,
  type MonitorInput,
} from "./view";

/**
 * This page reads Postgres and enqueues; the worker performs every read. A
 * live ESI fetch on render would burn a refresh-token rotation per page load.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Structures" };

const RECENT_EVENT_LIMIT = 20;

export default async function StructuresPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; at?: string }>;
}) {
  // Its own guard, not the layout's: a layout does not re-run on soft
  // navigation and never sees a server action.
  await requireAdminPage();
  const { done, at } = await searchParams;
  const db = getDb();
  const cfg = getConfig();

  const holder = await getStructureHolder(db);
  // The pinned corp, read off the raw holder row rather than off `holderView`
  // below — the roster and event reads must not go dark just because the
  // holder's character row happens to be missing.
  const corporationId = holder?.corporationId ?? null;
  const grantable = await findGrantableCharacter(db);

  // `toHolderView` THROWS when the holder's character row is missing:
  // `unlinkCharacter` deletes a character row and `structure_holder`'s FK
  // cascades, so the row `getStructureHolder` just read can be gone by the
  // time this join runs. Caught here and treated as "no holder" — the page
  // renders whatever `monitorState` gives a null holder (`grant-needed` or
  // `designate-needed`) rather than surfacing the throw as a 500.
  const holderView = holder ? await toHolderView(db, holder).catch(() => null) : null;

  const [roster, readStates, events] = await Promise.all([
    corporationId ? getRoster(db, corporationId) : Promise.resolve([]),
    corporationId ? getReadStates(db, corporationId) : Promise.resolve({}),
    corporationId
      ? getRecentEvents(db, corporationId, RECENT_EVENT_LIMIT)
      : Promise.resolve([]),
  ]);

  // ONE batched, cache-only name read for every system the two tables print.
  const systemNames = await lookupCachedNames(db, [
    ...new Set(roster.map((r) => r.systemId)),
  ]);

  const input: MonitorInput = {
    grantable,
    holder: holderView,
    readStates,
    rosterCount: roster.length,
    webhookConfigured: resolveStructureWebhookUrl(cfg) !== undefined,
  };
  const state = monitorState(input);
  const remedy = monitorRemedy(state);
  const rows = [...roster].sort(compareRosterRows);
  const notice = doneNotice(done, at);
  const now = Date.now();

  // One lookup from structureId to its roster row, for the recent-events list
  // below: `structure` rows are never deleted (a vanished structure gets
  // `missingSince` stamped instead), so every event's structure is still in
  // `roster` even once it is gone.
  const structureIndex = new Map(roster.map((r) => [r.structureId, r]));

  return (
    <main
      id="main"
      tabIndex={-1}
      className={`page ${showsRoster(state) ? "page--wide" : "page--narrow"}`}
    >
      <div className="page__head">
        <h1>Structures</h1>
        <p className="page__lede">
          {monitorSentence(state, {
            name: input.holder?.name,
            count: roster.length,
            forbidden: forbiddenReads(input),
          })}
        </p>
      </div>

      <ConfirmNotice text={notice} at={at} />

      <div className="btn-row btn-row--controls">
        {/* Gold is rationed to one primary action per view. A link remedy
            (grant/re-grant/re-authenticate) is that action when one exists;
            "Designate as holder" takes its place when a holder is needed and
            an admin-owned character can already fill it; "Check now" takes it
            the rest of the time, once there is a holder and nothing else to
            fix first. */}
        {remedy && (
          <a className="btn btn--primary" href={remedy.href}>
            {remedy.label}
          </a>
        )}
        {!remedy &&
          (state === "designate-needed" || state === "corp-changed") &&
          grantable !== null &&
          grantable.corporationId !== null && (
            <form action={designateStructureHolderAction}>
              <input type="hidden" name="characterId" value={grantable.characterId} />
              <Submit className="btn btn--primary" pendingLabel="Designating…">
                Designate as holder
              </Submit>
            </form>
          )}
        {!remedy && state !== "designate-needed" && (
          <form action={checkNowAction}>
            <Submit className="btn btn--primary" pendingLabel="Queueing…">
              Check now
            </Submit>
          </form>
        )}
      </div>

      {showsRoster(state) && (
        <>
          <RuleHead as="h2">Structures ({rows.length})</RuleHead>
          <Scroller label="Structure roster">
            <table className="log">
              <thead>
                <tr>
                  <th scope="col">Structure</th>
                  <th scope="col">System</th>
                  <th scope="col">State</th>
                  <th scope="col">Timer ends</th>
                  <th scope="col">Fuel expires</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <StructureRow
                    key={row.structureId}
                    row={row}
                    systemName={systemNames.get(row.systemId)}
                    now={now}
                  />
                ))}
              </tbody>
            </table>
          </Scroller>
        </>
      )}

      {events.length > 0 && (
        <>
          <RuleHead as="h2">Recent notifications</RuleHead>
          <Scroller label="Recent structure notifications">
            <table className="log">
              <thead>
                <tr>
                  <th scope="col">Notification</th>
                  <th scope="col">Sent</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const s =
                    e.structureId !== null
                      ? structureIndex.get(e.structureId)
                      : undefined;
                  const line = formatStructureAlert({
                    type: e.type,
                    structureName: s?.name ?? null,
                    typeName: s?.typeName ?? null,
                    systemName: s ? (systemNames.get(s.systemId) ?? null) : null,
                    details: e.details ?? {},
                  });
                  const sentIso = e.sentAt.toISOString();
                  return (
                    <tr key={e.notificationId}>
                      <td>{line}</td>
                      <td>
                        <RelativeTime iso={sentIso} initial={formatAgo(sentIso, now)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Scroller>
        </>
      )}
    </main>
  );
}

/**
 * One roster row. `rowTone` is the only place that decides a row's alarm
 * colour (view.ts, per PRODUCT.md principle 4): reinforced timers get `bad`,
 * a vulnerability window gets `warn`, anything else is `neutral` — this
 * component only renders whatever it returns, never a colour of its own.
 */
function StructureRow({
  row,
  systemName,
  now,
}: {
  row: RosterRow;
  systemName: string | undefined;
  now: number;
}) {
  const timerIso = row.stateTimerEnd?.toISOString();
  const fuelIso = row.fuelExpires?.toISOString();
  return (
    <tr>
      <td>{row.name ?? row.typeName ?? `#${row.structureId}`}</td>
      <td>{systemName ?? `#${row.systemId}`}</td>
      <td>
        <Status tone={rowTone(row.state)}>{row.state.replaceAll("_", " ")}</Status>
      </td>
      <td>
        {timerIso ? (
          <RelativeTime iso={timerIso} initial={formatAgo(timerIso, now)} />
        ) : (
          "—"
        )}
      </td>
      <td>
        {fuelIso ? <RelativeTime iso={fuelIso} initial={formatAgo(fuelIso, now)} /> : "—"}
      </td>
    </tr>
  );
}
