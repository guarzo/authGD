import type { Metadata } from "next";
import { Fragment } from "react";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { requireAdminPage } from "@/lib/admin-guard";
import { isDryRun } from "@/lib/sync-mode";
import { getSyncStatus } from "@/services/sync-status";
import { workerHeartbeat } from "@/services/health";
import { evaluateFreshness, HEARTBEAT_STALE_AFTER_MS } from "@/core/health";
import { rowHealth, type RowHealth } from "@/core/run-health";
import { cadenceFor, cronFor, groupFor, type JobGroup } from "@/core/schedules";
import {
  collapseRuns,
  countColumns,
  formatDuration,
  formatDurationMs,
  humanizeKey,
  isFailureKey,
  isNoChange,
} from "@/core/run-summary";
import type { SyncStatusGroup } from "@/services/sync-status";
import { Json, Notice, RuleHead, Scroller, Status } from "@/app/_components/ui";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { ConfirmGroup, ConfirmingForm } from "@/app/_components/confirm-group";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { elapsedShort, formatAgo } from "@/app/_components/format-ago";
import { RelativeTime } from "@/app/_components/relative-time";
import { recheckInvalidAction, syncAllAction, syncJobAction } from "./actions";
import {
  evidenceSince,
  groupHealthSummary,
  groupNeedsAttention,
  groupTone,
  healthLabel,
  HEALTH_TONE,
  needsAttention,
  nextRunFor,
  queuedMarkerStuck,
  queuedMarkerText,
  queuedNotice,
  splitCadenceUtc,
  tone,
  windowRestatesGroup,
} from "./view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sync",
};

/**
 * The order the strip's four groups render in, and the label above each —
 * so the primary button's scope ("sweep") is answerable by looking at the
 * strip rather than by parsing 50 characters of uppercase mono on the button
 * itself. `"other"` is not a `JobGroup`: it catches a job type present in
 * `sync_run` but absent from `JOB_CRON` (retired or hand-queued), which
 * `groupFor` reports as `null` rather than assigning to any of the four real
 * groups — the row still has to render somewhere rather than silently drop.
 *
 * `member-facing` sits right after `sweep`: `location` is control-reachable
 * from nowhere on this page (same as housekeeping), but its output is the
 * character location column every member's `/account` reads, so it earns a
 * full strip of its own rather than being folded behind housekeeping's
 * collapsed line — see `JobGroup`'s own doc in `@/core/schedules`.
 */
const GROUP_ORDER = ["sweep", "member-facing", "on-demand", "housekeeping"] as const;

/**
 * Every `JobGroup` must appear in `GROUP_ORDER`, and this line is what enforces
 * it. A group missing from that array does not fall through to the `other`
 * bucket below — `other` takes only the jobs `groupFor` rejects outright, and
 * `groupFor` returns the new group happily — so its rows would vanish from this
 * page entirely, with the `jobs.length > 0` filter guaranteeing not even an
 * empty section appears as a hint. `GROUP_LABEL` failing to compile two lines
 * down is proximity, not a guarantee; this is the guarantee.
 */
const _everyGroupIsOrdered: (typeof GROUP_ORDER)[number] = null as unknown as JobGroup;
void _everyGroupIsOrdered;

const GROUP_LABEL: Record<JobGroup | "other", string> = {
  sweep: "Sweep",
  "member-facing": "Member-facing",
  "on-demand": "On-demand",
  housekeeping: "Housekeeping",
  other: "Other",
};

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

/**
 * An absence glyph and the words it stands for. The runs table distinguishes
 * several kinds of absence by eye — `—` for a finished run that recorded
 * nothing, `…` for one still in flight, `—` again for a counter this run did
 * not report — but at the default punctuation verbosity of NVDA, JAWS and
 * VoiceOver an em dash and an ellipsis are both dropped, so every one of those
 * cells announced as empty: indistinguishable from each other and from a
 * missing cell. Each call site supplies the words its own glyph means, which
 * is why this takes the string rather than deriving it.
 *
 * `fmt()` above still returns a bare `…` for a null start instant. It is left
 * alone deliberately: it returns a string into several call sites, only one of
 * which is a table cell, and no run in the schema reaches it with a null
 * `startedAt`.
 *
 * The hidden span is `position: absolute` and takes its containing block from
 * `.scroller`'s `position: relative`, so it costs no layout and cannot stretch
 * the table it sits in — or inflate the `scrollWidth` the Scroller measures.
 */
function Absent({ glyph, children }: { glyph: string; children: string }) {
  return (
    <>
      <span aria-hidden="true">{glyph}</span>
      <span className="visually-hidden">{children}</span>
    </>
  );
}

function utcHhmm(d: Date): string {
  return d.toISOString().slice(11, 16);
}

function utcHhmmss(d: Date): string {
  return d.toISOString().slice(11, 19);
}

export default async function AdminSyncPage({
  searchParams,
}: {
  searchParams: Promise<{ queued?: string; at?: string }>;
}) {
  await requireAdminPage();
  const { queued, at } = await searchParams;
  const db = getDb();
  // The same predicate the three integration clients apply at the write
  // boundary (`@/lib/sync-mode`), read here rather than re-tested against the
  // string, so this page cannot drift from the guard it reports. This is the
  // one page where distribution's own health is stated, so an admin arriving
  // because a role never showed up must be told the deployment isn't live
  // before they read seven "OK" rows and conclude it should have been.
  const dryRun = isDryRun(getConfig());
  const [groups, heartbeat] = await Promise.all([getSyncStatus(db), workerHeartbeat(db)]);
  // One instant for the whole render: the worker line, every row's health and
  // the "checked at" stamp all have to agree, and reading the clock per row
  // would let them disagree by however long the page takes to build.
  const renderedAt = new Date();
  const now = renderedAt.getTime();
  // pg-boss's own maintenance heartbeat, not `sync_run`: a job only writes a
  // row when it fires, so that table can't tell "the worker is dead" from
  // "the worker is alive and none of its jobs happened to be due" — this can,
  // because pg-boss ticks `maintained_on` on a fixed ~120s cadence with no job
  // involved at all. See `HEARTBEAT_STALE_AFTER_MS` (@/core/health) for the
  // threshold this replaces, and `workerHeartbeat` (@/services/health) for
  // where the timestamp comes from.
  //
  // `heartbeat.status === "error"` (the read itself failed) is evaluated with
  // no timestamp, same as "never" — `evaluateFreshness` only distinguishes
  // fresh/stale, not why the evidence is missing. `workerLine` below is what
  // tells those two states apart for the admin reading the page.
  const worker = evaluateFreshness(
    heartbeat.status === "ok" ? heartbeat.at : null,
    renderedAt,
    HEARTBEAT_STALE_AFTER_MS,
  );
  const workerAge = worker.ageSec === null ? null : elapsedShort(worker.ageSec * 1000);
  // A switch on the tag with a `never` default rather than a ternary chain,
  // matching `admin/accounts/actions.ts` and `worker/dispatcher.ts`. The
  // ternary this replaces keyed off `workerAge === null`, which both "never"
  // and a future fourth variant satisfy — so adding one would have compiled
  // silently and fallen through to "worker · no heartbeat recorded", the exact
  // sentence the "error" branch exists to stop showing about a live worker.
  // The regression would have come back word for word. Here it is a build
  // failure instead.
  const workerLine = ((): string => {
    switch (heartbeat.status) {
      case "error":
        return "worker · heartbeat check failed — unknown whether the worker is running";
      case "never":
        return "worker · no heartbeat recorded";
      case "ok":
        // `workerAge` is non-null on this branch by construction —
        // `evaluateFreshness` only returns a null `ageSec` for a null instant,
        // and "ok" carries a real one — but it is typed `string | null`, so
        // the fallback keeps a `null` from ever reaching the template.
        return workerAge === null
          ? "worker · no heartbeat recorded"
          : worker.fresh
            ? `worker · alive, checked in ${workerAge} ago`
            : `worker · no heartbeat in ${workerAge}`;
      default: {
        const unhandled: never = heartbeat;
        return unhandled;
      }
    }
  })();
  const notice = queuedNotice(queued, at, workerAge, heartbeat.status === "error");
  // How far back this page can see the worker doing anything at all. Only this
  // lets a never-run row escalate: see `evidenceSince` and `rowHealth`.
  const seenSince = evidenceSince(worker.fresh, groups);
  // Pulled out of the per-row render below so the housekeeping group's own
  // collapsed line (5.3) can read every member's health before the `<ul>` that
  // holds them is built, and so it reads the exact same value the row itself
  // renders rather than a second call that could silently drift from it.
  const healthFor = (g: SyncStatusGroup): RowHealth =>
    rowHealth({
      status: g.runs[0]?.status ?? null,
      startedAt: g.runs[0]?.startedAt ?? null,
      finishedAt: g.runs[0]?.finishedAt ?? null,
      cron: cronFor(g.jobType),
      now: renderedAt,
      seenSince,
    });
  // Partitioned for display only — `groups` itself is untouched, and each
  // bucket keeps the relative order `KNOWN_ORDER` (in the service) already
  // gave its members, so grouping never becomes a second sort. A job absent
  // from `JOB_CRON` reports `null` from `groupFor` and falls into "other"
  // rather than being dropped: every row from `getSyncStatus` still renders.
  const buckets = [
    ...GROUP_ORDER.map((key) => ({
      key,
      jobs: groups.filter((g) => groupFor(g.jobType) === key),
    })),
    { key: "other" as const, jobs: groups.filter((g) => groupFor(g.jobType) === null) },
  ].filter((b) => b.jobs.length > 0);

  return (
    <main id="main" tabIndex={-1} className="page">
      <div className="page__head">
        <h1>Sync</h1>
        <p className="page__lede">
          The jobs that keep tiers, roles and standings in step with the game. The buttons
          enqueue work;{" "}
          {/* Three not-fresh cases, and only one of them supports the claim
              that the worker is stopped. A STALE heartbeat is positive
              evidence: pg-boss wrote one and then stopped writing. "never" is
              not — pg-boss's maintenance loop writes on its own cadence, so a
              worker that started moments ago is processing work while this
              table is still empty, and telling an admin it is "not running"
              would be a claim the page cannot support. "error" says even less.
              Each says what is actually known. */}
          {worker.fresh
            ? "the worker picks it up within a few seconds."
            : heartbeat.status === "error"
              ? "whether the worker picks it up is unknown right now — its heartbeat could not be checked — see the line below."
              : heartbeat.status === "never"
                ? "no worker heartbeat has been recorded yet, so whether queued work is picked up promptly is unknown — see the line below."
                : "the worker is not running right now, so queued work waits until it is — see the line below."}
        </p>
      </div>

      {/* `ConfirmNotice`, not a bare `Notice`: two of this page's three enqueue
          actions (`syncAllAction`, `recheckInvalidAction`, both below the
          strip in `btn-row--controls`) redirect back to this same page
          carrying `notice` in `?queued=` and `?at=`, and both buttons sit
          below seven job rows and however many drawers are open — well out of
          view of this slot at the top. A bare `<Notice>` relied on the text
          mutating a permanently-mounted live region to be heard, which covers
          a screen reader but leaves a sighted admin, who pressed a button
          they can no longer see the top of the page from, looking at exactly
          nothing: the same "nothing happened, press again" trap `/account`'s
          four self-serve actions had before `ConfirmNotice` started moving
          focus there too. Moving focus here scrolls it into view for
          everyone, not only assistive tech, which is the whole of what this
          page was missing — the sentence itself was already answering "what
          did the press cause" via `queuedNotice`. See
          `@/app/_components/confirm-notice` for the focus/live-region
          reasoning; `admin/sync`'s own `queued`/`at` redirect shape is what
          that component's `text`/`at` props were generalized from.

          The third action, `syncJobAction`, does NOT redirect here: its
          `<form>` sits inside that job's own `Disclosure` (line ~740 below),
          and a redirect back to this route — even carrying only a query
          string — resets that `Disclosure`'s `useState` and closes the
          drawer the admin opened to press it. That one instead returns its
          confirmation through `useActionState`, landing in the drawer itself
          via `ConfirmGroup`/`ConfirmingForm` (`@/app/_components/confirm-group`)
          rather than here. See `actions.ts`'s own docblock on `syncJobAction`
          and `confirm-group.tsx` for the full account. */}
      <ConfirmNotice text={notice} at={at} />

      {/* Every row below reports on one job. This line reports on the process
          that runs all of them: without it a worker that died at 02:00 leaves
          seven rows still showing whatever they last succeeded at, and the
          page looks perfect through the outage that brought the admin here. */}
      {worker.fresh ? (
        <p className="worker">{workerLine}</p>
      ) : (
        <Notice tone="bad">
          <span className="worker">{workerLine}</span>
        </Notice>
      )}

      {/* An operator setting, not a fault — `tone="warn"`, never `tone="bad"`.
          Without this, the only trace of a non-live deployment is the
          `wouldAdd`/`wouldRemove`/`wouldChangeRoles` counter columns below,
          which exist only when the counter is non-zero in the window
          (`countColumns`, @/core/run-summary): a converged deployment shows
          "no change" on every row and no tell at all. Placed above the strip,
          not folded into the worker line — this is a fact about the
          deployment's configuration, not about whether the worker is running,
          and the worker can be perfectly alive while every write it makes is
          suppressed at the client boundary (`@/lib/sync-mode`). Same "sync
          disabled" vocabulary as `/account`'s own dry-run copy
          (`contact-state.tsx:72`), so a member reading their own account and
          an admin reading this page describe the same guard the same way.

          `live={false}`: this is a standing property of the deployment, not an
          arrival. It is in the document from first paint on every load, and
          `Notice`'s own doc explains why a region born holding its text is the
          shape AT announces least reliably anyway — so the live region buys
          nothing here and would re-fire on every soft navigation back from
          `syncAllAction`'s redirect. Read in document order, above the strip,
          it lands before the rows it qualifies. */}
      {dryRun && (
        <Notice tone="warn" live={false}>
          SYNC_MODE=dry-run — jobs run and record counts, but no contact, ACL or Discord
          write leaves this deployment.
        </Notice>
      )}

      {/* The strip's own section header, the signature component every other
          admin table (accounts, audit) heads its data region with — sync had
          none. The stamp lives here now, not at the bottom of the page: it is
          a fact about this render, and an admin scanning down should not have
          to reach past seven rows and however many open drawers to find out
          how current the table above them is.

          `as="h2"`, not the job names' own level: this is the strip's parent
          in the outline, not an eighth sibling next to the seven job names —
          see `.strip__name`, which moved to `h3` for exactly this reason. */}
      <RuleHead
        as="h2"
        aside={
          <span className="btn-row__stamp">checked {utcHhmmss(renderedAt)} UTC</span>
        }
      >
        {groups.length} job{groups.length === 1 ? "" : "s"}
      </RuleHead>

      {/* No empty state above this: `getSyncStatus` seeds a row for every key
          in JOB_CRON whether or not it has ever run, so the list is never
          empty and a "nothing has come due" message could only ever be a lie
          about a state the page cannot reach. */}
      {/* The one thing hiding the group labels from the accessibility tree
          would have deleted: which jobs the primary button's own scope
          covers — the fact the button's label used to spell out in 50
          characters of uppercase mono ("Sync membership, contacts, wanderer,
          discord-roles") before it shrank to "Sync now" on the strength of
          the strip now carrying that answer visually. A screen reader user
          who lost the four nouns and gained an aria-hidden label would be
          strictly worse off than before this task. So `.strip` is no longer
          one flat `role="list"` with the grouping painted over it — it is
          `.strip__head`'s aria-hidden column labels, then one `role="list"`
          PER group, each one's accessible name the group's own visible
          heading via `aria-labelledby`. VoiceOver reports "list, 4 items"
          (sweep) / "list, 1 item" (member-facing) / "list, 1 item"
          (on-demand) / "list, 2 items" (housekeeping) instead of one flat
          list of every job — a real loss for anyone who relied on the flat
          count — but the alternative was a grouping only sighted users could
          act on, which is the one thing this whole task exists to fix.
          Housekeeping's own list is additionally folded behind a collapsed
          summary line (5.3, below); VoiceOver reports "list, 2 items" for it
          only once that line is open — Chromium excludes a closed
          `<details>`'s content from the accessibility tree, same as every
          job's own run-history drawer already does on this page — so the
          collapsed sentence itself (`groupHealthSummary`, below) is what has
          to carry the group's health until then. */}
      <div className="strip">
        {/* aria-hidden: these label the summary rows visually, but each row
            is a single disclosure control whose accessible name already
            carries job, health, age and cadence in that order — including
            the cadence's own "UTC" clause, which the accessible name still
            states even though the visible cadence cell below no longer spells
            it out. "Cadence (UTC)" is what tells a sighted reader every
            cadence shares one timezone without repeating the word on all
            eight rows; see the comment beside `splitCadenceUtc` (./view.ts)
            for why the row itself had to stop doing that instead (5.2). */}
        <div className="strip__head" aria-hidden="true">
          <span />
          <span>Job</span>
          <span className="strip__h-health">Health</span>
          <span className="strip__h-last">Last run</span>
          <span className="strip__h-cadence">Cadence (UTC)</span>
        </div>
        {buckets.map((bucket) => {
          const headingId = `strip-group-${bucket.key}`;
          // Computed once per bucket, not per row: the housekeeping group's
          // own collapsed line (5.3, below) has to read every member's health
          // before deciding whether to render open, and it has to be the
          // identical value the row itself renders — a second `rowHealth`
          // call here risked silently drifting from the row's own.
          const members = bucket.jobs.map((g) => ({
            jobType: g.jobType,
            health: healthFor(g),
          }));
          const list = (
            <ul className="strip__sub" role="list" aria-labelledby={headingId}>
              {bucket.jobs.map((g, i) => {
                const latest = g.runs[0];
                const startedAt = latest?.startedAt ?? null;
                const finishedAt = latest?.finishedAt ?? null;
                // finish-time for a completed run, start-time for one in flight:
                // in both cases the last moment this job is known to have been
                // doing something.
                const latestAt = finishedAt ?? startedAt;
                const latestIso = latestAt ? latestAt.toISOString() : null;
                const health = members[i].health;
                // Null for a job type found in `sync_run` but absent from
                // JOB_CRON — a retired or hand-queued job. Every *seeded* row
                // has a cadence by construction, so the column always earns its
                // width, but that one still has to say something.
                const cadence = cadenceFor(g.jobType);
                // Visible text with a trailing " UTC" clause removed (5.2 —
                // the header now states the timezone once, as "Cadence
                // (UTC)", rather than every row repeating it), and whether
                // that clause has to be re-added as a visually-hidden word
                // so the accessible name doesn't lose it: `.strip__head` is
                // `aria-hidden`, so the header alone cannot carry the fact
                // for a screen reader. See `splitCadenceUtc` (./view.ts).
                const { visible: cadenceVisible, hiddenUtc } = splitCadenceUtc(
                  cadence ?? "on demand",
                );
                const nextRun = nextRunFor(g.jobType, renderedAt);
                // A pre-built accessible name for the toggle, because the
                // computed one would not hold still. `<summary>`'s name comes
                // from its contents, and one of those contents is
                // `RelativeTime` — a client component on a shared 30s ticker —
                // so this control renamed itself twice a minute with no state
                // having changed. A screen reader re-announces a control whose
                // name it sees change (SC 4.1.2), and a voice user's "click
                // discord.sweep healthy 2 minutes ago" stops matching the page
                // a minute later (SC 3.2.4).
                //
                // Every other piece is restated here rather than left to the
                // contents, because `aria-label` replaces the computed name
                // outright: anything not repeated leaves the assistive channel
                // entirely, which is the R4 parity failure inverted. All of it
                // is safe to freeze — `renderedAt` is one server-side instant
                // for the whole render, so the queued age and the next-run time
                // are as fixed as the cadence is. Only the "ago" is dropped,
                // which is the entire reason this exists; the drawer under it
                // carries every run's own timestamp.
                //
                // Assembled to match what the contents computed to, separator
                // for separator: `queuedMarkerText` supplies its own leading
                // comma, ` UTC` is the span `splitCadenceUtc` strips off the
                // visible text, and the space before "next" is the one the
                // `<br>` was contributing. The three `toHaveAccessibleName`
                // cases in `e2e/sync.spec.ts` pin those joins.
                const summaryName =
                  `${g.jobType} ${healthLabel(health)}` +
                  `${g.queued ? queuedMarkerText(g.queuedSince, renderedAt) : ""}` +
                  ` ${cadenceVisible}${hiddenUtc ? " UTC" : ""}` +
                  `${nextRun ? ` next ${utcHhmm(nextRun)}` : ""}`;
                const cols = countColumns(g.jobType, g.runs);
                const span = cols.length || 1;
                // Shared between the runs table below and the window
                // caption under it (5.7), so the two can never disagree
                // about whether the whole window folded into one row.
                const collapsed = collapseRuns(g.runs);
                return (
                  <li key={g.jobType} className="strip__job">
                    <Disclosure
                      className="strip__disc"
                      ariaLabel={summaryName}
                      defaultOpen={needsAttention(health)}
                      summary={
                        <>
                          <h3 className="strip__name">{g.jobType}</h3>
                          {/* One grid item, not two: `.strip__disc > summary > .st`
                        used to be the health track's own grid item, and a
                        second sibling here would spill the queued marker into
                        the *next* track — the last-run column — on rows that
                        have one and leave every other row's last-run cell
                        exactly where it was, breaking the single scannable
                        column this grid exists for. Wrapping both in one span
                        keeps the health track one item wide whether or not
                        `queued` is set. */}
                          <span className="strip__health">
                            <Status tone={HEALTH_TONE[health]}>
                              {healthLabel(health)}
                            </Status>
                            {g.queued && (
                              // A ring, not a second `.st` word: the health
                              // track is a fixed 7.5rem, and "cadence unknown"
                              // — the longest label — already spends most of
                              // that on its own. `queued`'s own word would
                              // overflow the track next to it on exactly the
                              // rows most likely to carry it (an on-demand job
                              // fanned out to). The ring is aria-hidden and the
                              // full word is the accessible one, same pattern
                              // as `Absent` below — this isn't `Absent` itself
                              // because that component's own doc reserves it
                              // for a run recording nothing, not a job that has
                              // something coming.
                              //
                              // Not "your request queued": a member-triggered
                              // account merge or Discord link fans out to the
                              // same jobs and reads identically here — this
                              // says work targets the job, not who asked for
                              // it.
                              //
                              // Below `QUEUED_AGE_NOTABLE_MS` this is only up
                              // for the couple of seconds before an in-flight
                              // `sync_run` row — and the `inflight` health
                              // above, a `RowHealth` member this deliberately
                              // is not — takes over the signal, so the visible
                              // shape stays a bare ring and the accessible
                              // word stays a bare ", queued". Past it the
                              // dispatcher (`startDispatcher`, ~2s poll) is
                              // running behind, and past `QUEUED_AGE_STUCK_MS`
                              // it is wedged — `queuedMarkerText` states the
                              // age rather than a verdict, and
                              // `queuedMarkerStuck` is the one place that
                              // escalation is allowed to change the ring's own
                              // shape, since the fixed-width track has no room
                              // for a second visible word.
                              //
                              // Gated on `queued` alone, never on
                              // `queuedSince`: the age is a detail the two
                              // helpers below each degrade on their own, and
                              // hiding the whole marker over a missing one
                              // would make a job with work waiting read as
                              // idle — the one thing this ring exists to
                              // prevent.
                              <>
                                <span
                                  className={
                                    queuedMarkerStuck(g.queuedSince, renderedAt)
                                      ? "strip__queued strip__queued--stuck"
                                      : "strip__queued"
                                  }
                                  aria-hidden="true"
                                />
                                <span className="visually-hidden">
                                  {queuedMarkerText(g.queuedSince, renderedAt)}
                                </span>
                              </>
                            )}
                          </span>
                          <RelativeTime
                            iso={latestIso}
                            initial={formatAgo(latestIso, now)}
                          />
                          <span className="strip__cadence mono">
                            {cadenceVisible}
                            {/* The visible text just dropped this clause
                                  (5.2) — the header says it once for every row
                                  now, as "Cadence (UTC)" — but the row's own
                                  accessible name must not, or a screen reader
                                  would hear "daily 03:00" with no timezone at
                                  all, which is the defect this fix exists to
                                  close, inverted.

                                  The leading space is belt-and-braces, not a
                                  requirement: measured in Chromium, removing
                                  it still yields "Sun 04:00 UTC" — the
                                  accessible-name computation inserts its own
                                  separator at this inline boundary, so the
                                  space is one of two and is normalised away.
                                  It stays because that separator is an engine
                                  behaviour rather than something this page
                                  controls, and the failure it would cause
                                  elsewhere ("daily 03:00UTC", announced as one
                                  word) is both silent to every test we run —
                                  `toHaveAccessibleName` normalises whitespace,
                                  so it cannot tell one space from two — and
                                  only observable in the channel we have the
                                  least ability to check. `splitCadenceUtc`
                                  cut " UTC" with its space; keeping them
                                  together costs nothing. */}
                            {hiddenUtc && <span className="visually-hidden"> UTC</span>}
                            {nextRun && (
                              <>
                                {/* The leading space is belt-and-braces, not a
                              requirement — the same posture as the " UTC"
                              span above, and measured the same way. The row's
                              whole accessible name is this four-value
                              concatenation, because the column header above is
                              aria-hidden, so what separates the values here is
                              the only thing a screen reader has to go on.

                              Chromium's accessible-name computation does
                              insert its own separator at the <br> below: with
                              this space deleted the row still computes as
                              "every 30m next 17:30". Delete the <br> as well
                              and it collapses to "every 30mnext 17:30" — the
                              line break, not the space, is what holds the two
                              values apart today.

                              It stays because that separator is an engine
                              behaviour rather than something this page
                              controls, and because the <br> is a layout
                              choice: a future rewrite that sets this cell to
                              wrap on its own, dropping the break, would make
                              this space the only thing left doing the job.
                              The e2e case "an interval row's cadence and its
                              next-run time stay separate words" catches that
                              collapse — it distinguishes one space from none,
                              which is the part that matters. What no test we
                              run can see is one space versus two, since
                              `toHaveAccessibleName` normalises whitespace; a
                              doubled separator is harmless, so that blind spot
                              is the acceptable side of keeping this. */}{" "}
                                <br />
                                next {utcHhmm(nextRun)}
                              </>
                            )}
                          </span>
                        </>
                      }
                    >
                      {g.runs.length === 0 ? (
                        <p className="dim strip__empty">
                          No runs recorded for this job yet.
                        </p>
                      ) : (
                        <Scroller label={`${g.jobType} runs`}>
                          {/* No colgroup: each job now shows only the counters it
                        actually moves, so the tables deliberately no longer
                        share a column set and cannot be aligned to each
                        other. Widths come from content. The trailing spacer
                        that brings the drawer flush with the panel edge is a
                        sibling of this table, not a column of it — see the
                        `log--runs-fill` div below and the comment on
                        `.scroller:has(.log--runs)` in globals.css for why. */}
                          <table className="log log--runs">
                            <thead>
                              <tr>
                                <th scope="col">Started</th>
                                <th scope="col">Took</th>
                                <th scope="col">Status</th>
                                {cols.length > 0 ? (
                                  cols.map((k) => (
                                    <th key={k} scope="col" className="num">
                                      {humanizeKey(k)}
                                    </th>
                                  ))
                                ) : (
                                  <th scope="col">Counts</th>
                                )}
                                <th scope="col">Raw</th>
                              </tr>
                            </thead>
                            <tbody>
                              {collapsed.map((entry) => {
                                if (entry.kind === "group") {
                                  const first = entry.runs[0];
                                  const last = entry.runs[entry.runs.length - 1];
                                  // `to` is never null for a group — every
                                  // member has finished, see `sameOutcome` —
                                  // so only `from` needs the null guard here.
                                  const sameStamp =
                                    entry.from !== null &&
                                    entry.from.getTime() === entry.to.getTime();
                                  return (
                                    <tr
                                      key={`group-${first.id}-${last.id}`}
                                      className="log--group"
                                    >
                                      {/* "N runs" moved here from Took, below:
                                    the header above this cell says "Started",
                                    not "Took", and a screen reader in
                                    table-navigation mode used to announce the
                                    count under the wrong column's promise. It
                                    is still plain cell text, read the same way
                                    any other cell is — not a badge whose count
                                    needs an aria-label to be more than a shape
                                    — and the range beside it is the other half
                                    of "how many runs are behind it": a count
                                    alone says five identical outcomes
                                    happened, not over what span.

                                    That range is a SPAN, not a claim of
                                    continuity: `collapseRuns` only folds
                                    CONSECUTIVE runs it was given, so a
                                    multi-hour gap between two of them (a
                                    missed schedule tick, say) reads
                                    identically to five runs an hour apart.
                                    Accepted — the alternative is restating
                                    every run's own instant, which is the row
                                    this collapse exists to avoid re-adding. */}
                                      <td className="mono nowrap">
                                        <span className="only-wide">
                                          {fmt(entry.from)}
                                          {!sameStamp ? ` – ${fmt(entry.to)}` : ""}
                                        </span>
                                        <span className="strip__group-count">
                                          {entry.count} runs
                                        </span>
                                        <span className="only-narrow">
                                          <RelativeTime
                                            iso={
                                              entry.from ? entry.from.toISOString() : null
                                            }
                                            initial={formatAgo(
                                              entry.from
                                                ? entry.from.toISOString()
                                                : null,
                                              now,
                                            )}
                                          />
                                          {/* Both ends: this used to say only
                                        `started {from} UTC`, so below 40rem —
                                        where `.only-wide` beside it is
                                        `display: none` and out of the
                                        accessibility tree — the group's END
                                        was unreachable to a screen reader
                                        entirely. Same "started X UTC" phrasing
                                        convention as the single-run branch
                                        below, said twice.

                                        The count is deliberately NOT restated
                                        here: `.strip__group-count` above is
                                        unconditional, so at this width it is
                                        the one thing in the cell still in the
                                        tree beside this, and naming the count
                                        again would announce it twice. */}
                                          <span className="visually-hidden">
                                            {`started ${fmt(entry.from)} UTC, ended ${fmt(entry.to)} UTC`}
                                          </span>
                                        </span>
                                      </td>
                                      <td className="mono nowrap num">
                                        {/* The group's DURATION SPAN, not its
                                      count: `sameOutcome` deliberately never
                                      compares duration (durations are
                                      near-never equal, so nothing would ever
                                      collapse if it did), so a group can hide
                                      an outlier this wide — five hourly runs
                                      all OK with identical counts, one of
                                      which took 47 minutes because ESI was
                                      degraded, used to collapse to a row that
                                      said nothing about the 47 minutes. This
                                      is the one column whose header already
                                      promises it. `durationMs` is null only
                                      when no run in the group has a
                                      `startedAt` — every member has a
                                      `finishedAt` (see above), so that is a
                                      missing start, not a run still in flight,
                                      and gets the "not recorded" treatment
                                      rather than the single-run branch's
                                      "still running" below. */}
                                        {entry.durationMs === null ? (
                                          <span className="dim">
                                            <Absent glyph="—">not recorded</Absent>
                                          </span>
                                        ) : entry.durationMs.min ===
                                          entry.durationMs.max ? (
                                          formatDurationMs(entry.durationMs.min)
                                        ) : (
                                          `${formatDurationMs(entry.durationMs.min)} – ${formatDurationMs(entry.durationMs.max)}`
                                        )}
                                      </td>
                                      <td>
                                        <Status tone={tone(entry.status)}>
                                          {/* No `?? "running"` here: unlike the
                                        single-run branch below, where null
                                        really is a run in flight,
                                        `sameOutcome` requires
                                        `finishedAt !== null` on every run in
                                        the group, and `finishSyncRun`
                                        (src/services/sync-run.ts) sets
                                        `finishedAt` and `status` in the same
                                        UPDATE — so a group's `status` can
                                        never be null. Keeping the fallback
                                        here would claim a finished group is
                                        running. */}
                                          {entry.status}
                                        </Status>
                                        {/* `sameOutcome` requires every run in
                                      the group to agree on `errorSummary` too,
                                      so this is the one message the whole
                                      group shares — not a representative
                                      picked from the first run. Read off the
                                      group's own field, which `collapseRuns`
                                      has already normalized, rather than
                                      re-deriving the same fact from `runs[0]`. */}
                                        {entry.errorSummary && (
                                          <span className="detail strip__err">
                                            {entry.errorSummary}
                                          </span>
                                        )}
                                      </td>
                                      {!entry.counts || cols.length === 0 ? (
                                        <td colSpan={span} className="dim">
                                          {!entry.counts ? (
                                            <Absent glyph="—">not recorded</Absent>
                                          ) : isNoChange(entry.counts) ? (
                                            "no change"
                                          ) : (
                                            <Absent glyph="—">nothing counted</Absent>
                                          )}
                                        </td>
                                      ) : isNoChange(entry.counts) ? (
                                        <td colSpan={span} className="dim">
                                          no change
                                        </td>
                                      ) : (
                                        cols.map((k) => {
                                          const v = entry.counts?.[k];
                                          return (
                                            <td
                                              key={k}
                                              className={
                                                v
                                                  ? isFailureKey(k)
                                                    ? "mono num warn"
                                                    : "mono num"
                                                  : "mono num dim-ink"
                                              }
                                            >
                                              {v ?? (
                                                <Absent glyph="—">not reported</Absent>
                                              )}
                                            </td>
                                          );
                                        })
                                      )}
                                      <td>
                                        {entry.counts ? (
                                          /* `pretty={false}`: `counts` is flat —
                                     every value is a bare number
                                     (`Record<string, number>`, see
                                     `@/core/run-summary`) — so the indented
                                     form's one-key-per-line buys nothing a
                                     compact string doesn't already say, and
                                     here it costs real height. Measured on a
                                     6-counter run (`e2e/sync.spec.ts`'s own
                                     `membership` seed): 8 lines at this
                                     table's 12px mono / 18.6px line-height
                                     plus padding came to 174.75px, in a row
                                     whose every other cell is one line at
                                     ~52.5px — so opening Raw stretched the
                                     whole row to 227.25px, 77% of it blank in
                                     every cell but this one. Compact, wrapped
                                     by `.json__full`'s existing 40ch, the same
                                     payload is 2 lines and the row is ~116px.
                                     The peek is unaffected: it was already the
                                     literal word "json", never the payload. */
                                          <Json
                                            value={entry.counts}
                                            summary="json"
                                            pretty={false}
                                          />
                                        ) : (
                                          <span className="dim">
                                            <Absent glyph="—">no payload</Absent>
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                }
                                const r = entry.run;
                                const startedIso = r.startedAt
                                  ? r.startedAt.toISOString()
                                  : null;
                                return (
                                  <tr key={r.id}>
                                    {/* At 320px the 19ch ISO stamp is the widest
                                  cell in the row and the least of its
                                  meaning, and it is most of what the table's
                                  44rem floor was buying. Below 40rem it reads
                                  as elapsed time instead — but the exact
                                  value may not leave the accessibility tree
                                  for that, so it is restated in text a screen
                                  reader reads out. `title` would not do:
                                  VoiceOver and TalkBack do not announce it
                                  and touch cannot reach it. */}
                                    <td className="mono nowrap">
                                      <span className="only-wide">
                                        {fmt(r.startedAt)}
                                      </span>
                                      <span className="only-narrow">
                                        <RelativeTime
                                          iso={startedIso}
                                          initial={formatAgo(startedIso, now)}
                                        />
                                        <span className="visually-hidden">
                                          {`started ${fmt(r.startedAt)} UTC`}
                                        </span>
                                      </span>
                                    </td>
                                    <td className="mono nowrap num">
                                      {formatDuration(r.startedAt, r.finishedAt) ?? (
                                        <span className="dim">
                                          <Absent glyph="…">still running</Absent>
                                        </span>
                                      )}
                                    </td>
                                    {/* The error lives here rather than in a column
                                  of its own: it is populated on a small
                                  minority of runs, and a column that is an
                                  em-dash on every row is width spent on
                                  nothing. */}
                                    <td>
                                      <Status tone={tone(r.status)}>
                                        {r.status ?? "running"}
                                      </Status>
                                      {r.errorSummary && (
                                        <span className="detail strip__err">
                                          {r.errorSummary}
                                        </span>
                                      )}
                                    </td>
                                    {!r.counts || cols.length === 0 ? (
                                      // Three absences that read differently: a run
                                      // still in flight has not reported yet, a
                                      // finished one that recorded nothing never
                                      // will, and a recorded all-zero result is a
                                      // real answer. cols is empty only when no run
                                      // in the window moved a counter, so there is
                                      // one header cell to span.
                                      <td colSpan={span} className="dim">
                                        {!r.counts ? (
                                          r.finishedAt ? (
                                            <Absent glyph="—">not recorded</Absent>
                                          ) : (
                                            <Absent glyph="…">not reported yet</Absent>
                                          )
                                        ) : isNoChange(r.counts) ? (
                                          "no change"
                                        ) : (
                                          // Not "not recorded": counts *were*
                                          // recorded, the Raw column beside this
                                          // renders them, and they are simply not
                                          // all zero and not countable either — a
                                          // payload like `{ removed: 0, lastError:
                                          // null }` clears isNoChange and yields no
                                          // columns. The glyph was ambiguous about
                                          // that; hidden words would state it as a
                                          // fact, so they have to state the right
                                          // one.
                                          <Absent glyph="—">nothing counted</Absent>
                                        )}
                                      </td>
                                    ) : isNoChange(r.counts) ? (
                                      <td colSpan={span} className="dim">
                                        no change
                                      </td>
                                    ) : (
                                      cols.map((k) => {
                                        const v = r.counts?.[k];
                                        return (
                                          <td
                                            key={k}
                                            className={
                                              v
                                                ? isFailureKey(k)
                                                  ? "mono num warn"
                                                  : "mono num"
                                                : "mono num dim-ink"
                                            }
                                          >
                                            {/* The column exists because some other
                                          run in the window moved this counter;
                                          this run did not report it. Same
                                          absence as the cells above, in the
                                          same table, so it gets the same
                                          treatment rather than announcing as
                                          an empty cell. */}
                                            {v ?? <Absent glyph="—">not reported</Absent>}
                                          </td>
                                        );
                                      })
                                    )}
                                    <td>
                                      {r.counts ? (
                                        <Json
                                          value={r.counts}
                                          summary="json"
                                          pretty={false}
                                        />
                                      ) : (
                                        <span className="dim">
                                          <Absent glyph="—">no payload</Absent>
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          {/* Fills whatever the table itself doesn't ask for,
                          so the drawer's visible edge always reaches the
                          panel's own width — see the comment on
                          `.scroller:has(.log--runs)` in globals.css. A
                          sibling of the table, not a column of it: giving a
                          table's own last column `width: 100%` looked like
                          the CSS Grid trailing-`1fr`-track idiom
                          `.strip__head` uses (above), but measured, it isn't
                          the same trick — auto table layout resolves a
                          percentage column width against the table's own
                          width, so a bare last-child at 100% claims almost
                          all of it and every other column, including this
                          one's Raw disclosure, gets squeezed to its
                          minimum-content width on every reflow, not just the
                          first one. That reproduced as a real regression:
                          opening a run's Raw payload (which was previously
                          capped at `.json__full`'s own 40ch) instead wrapped
                          down to a handful of characters per line and grew
                          the row to 785px, where the row height above the
                          disclosure is 52.5px and the "still under half the
                          old height" e2e assertion caps it at 140px. A plain
                          flex sibling avoids that: it lives outside the
                          table, so the table keeps sizing itself exactly as
                          it always has (shrink-to-fit, min-width 44rem
                          floor), Raw's disclosure keeps growing freely on its
                          own reflow, and only the leftover flex-line space —
                          the actual analogue of Grid's `1fr` — goes here. */}
                          <div className="log--runs-fill" aria-hidden="true" />
                        </Scroller>
                      )}
                      {/* The window, stated — except when the table above already
                    said it. This table shows a fixed handful of the most
                    recent runs, so a job that has failed forty times looks
                    identical to one that has failed five — on the row most
                    likely to be open. Counted from the rendered rows rather
                    than restating the service's `runsPerJob`, so it cannot
                    claim a depth the table does not have.

                    Suppressed exactly when `windowRestatesGroup` (5.7) finds
                    the whole window collapsed into one row: that row's own
                    `.strip__group-count` cell already states this table's
                    full depth as "N runs", and printing "last N runs"
                    underneath it would be the identical number said twice in
                    the same small area. The moment the table shows more than
                    one row — an in-flight run above a group, two groups with
                    different outcomes, or no collapsing at all — no single
                    cell states the total any more, and this caption goes back
                    to being the only thing that does. */}
                      {g.runs.length > 0 && !windowRestatesGroup(collapsed) && (
                        <p className="dim strip__window">
                          last {g.runs.length === 1 ? "run" : `${g.runs.length} runs`}
                        </p>
                      )}
                      {/* Below the history, not above it: the admin opened this row
                    to read why it failed, and the error string is the top
                    row of that table. Only for jobs the worker actually has
                    a queue for — the action rejects anything else, and a
                    control that can only fail is worse than none.

                    `ConfirmGroup`/`ConfirmingForm`
                    (`@/app/_components/confirm-group`), not a bare `<form>`:
                    this control sits inside the job's own `Disclosure` above,
                    and `syncJobAction` returns its confirmation through
                    `useActionState` rather than a redirect for exactly the
                    reason `ConfirmNotice`'s docblock above and
                    `syncJobAction`'s own explain — a redirect back to this
                    route would reset this `Disclosure`'s `useState` and close
                    the drawer the admin opened to press the button. One group
                    per job is enough: each drawer holds exactly one enqueue
                    control, not several mutually-exclusive ones the way
                    `/admin/accounts`'s tier group does. */}
                      {cronFor(g.jobType) !== null && (
                        <ConfirmGroup>
                          <ConfirmingForm
                            action={syncJobAction}
                            className="btn-row strip__act"
                          >
                            <input type="hidden" name="jobType" value={g.jobType} />
                            {/* Full 36px, not the 28px `.btn--micro` grade: this sits in
                                  a drawer strip below the runs table (`.strip__act`), not in
                                  a table row, and DESIGN.md gives the smaller size to "the
                                  in-row controls of the admin tables… and nowhere else".
                                  Same call `account/page.tsx:372-381` and
                                  `inline-edit.tsx:75-83` already made for the facts grid.
                                  Nothing had to be bought back here — this control carries
                                  no `.btn--quiet`, so dropping `--micro` is the whole fix. */}
                            <Submit className="btn" pendingLabel="Queueing…">
                              Re-run {g.jobType}
                            </Submit>
                          </ConfirmingForm>
                        </ConfirmGroup>
                      )}
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          );
          return (
            <Fragment key={bucket.key}>
              <p id={headingId} className="strip__group">
                {GROUP_LABEL[bucket.key]}
              </p>
              {/* Housekeeping alone folds behind a collapsed summary line
                  (5.3): its two jobs are reachable from no control on this
                  page, so nothing else stops a failing one from vanishing at
                  equal rank with groups that have real controls. The
                  `Disclosure` still renders `list` as its own child either
                  way — `role="list"` + `aria-labelledby` (above) is never
                  swapped out for a flattened summary, so opening the line
                  (by hand, or on its own the moment a member needs
                  attention) reaches the exact same per-row markup every
                  other group renders unconditionally. Closed, that markup
                  is out of the accessibility tree — Chromium's
                  `content-visibility: hidden` on a shut `<details>` hides
                  its content from assistive tech the same way it already
                  does for every job's own run-history drawer elsewhere on
                  this page — so the group heading and the collapsed line's
                  own sentence (`groupHealthSummary`, below) are what a
                  screen reader has to go on until it is opened; that
                  sentence is written to say enough on its own rather than
                  leaning on rows it cannot reach yet. `groupTone`/
                  `groupHealthSummary`/`groupNeedsAttention` (./view.ts) are
                  the pure decisions behind the line's colour, its text and
                  whether it opens on its own — the last of those has to stay
                  in step with each member's own `needsAttention`, or a
                  faulted `token-health`/`purge` would stop auto-opening the
                  moment it moved behind this line. */}
              {bucket.key === "housekeeping" ? (
                <Disclosure
                  className="strip__group-disc"
                  defaultOpen={groupNeedsAttention(members)}
                  summary={
                    <Status tone={groupTone(members)}>
                      {groupHealthSummary(members)}
                    </Status>
                  }
                >
                  {list}
                </Disclosure>
              ) : (
                list
              )}
            </Fragment>
          );
        })}
      </div>

      {/* State before action (PRODUCT.md principle 2): the strip answers "what
          is true right now" before the gold button, which is the most
          saturated thing on the page, gets to pull the eye. */}
      <div className="btn-row btn-row--controls">
        <form action={syncAllAction}>
          <Submit className="btn btn--primary" pendingLabel="Queueing…">
            {/* Short verb, not the four nouns it used to spell out: the
                "Sweep" group header above the strip is now what answers
                "which jobs" — repeating that list on the button just made it
                the widest label on the page for no reading anything else on
                the page didn't already say. */}
            Sync now
          </Submit>
        </form>
        <form action={recheckInvalidAction}>
          <Submit className="btn" pendingLabel="Queueing…">
            Recheck invalid affiliations
          </Submit>
        </form>
        {/* A plain anchor, not a router link: this page is the only thing on
            screen that can answer "did the run land", and a soft navigation to
            the URL you are already on is exactly the case a client router is
            entitled to serve from its own cache. It drops `?queued=` and
            `?at=` on the way, which is still worth having even now that the
            notice stamps itself: the canonical URL is the one an admin leaves
            open, and it should not carry a press from an hour ago at all.

            No polling behind it: an admin reading an expanded failed row must
            not have the page move under them. The notice copy names the
            browser reload rather than this control, because the notice renders
            at the top of the page and this sits below seven rows and however
            many open drawers. */}
        <a className="btn" href="/admin/sync">
          Refresh
        </a>
      </div>
    </main>
  );
}
