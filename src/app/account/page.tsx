import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { ACCOUNT_ERRORS, loginErrorUrl, lookupErrorMessage } from "@/lib/error-redirects";
import { getAccountView, type PushStatus } from "@/services/account-view";
import { canReadPayouts } from "@/services/payouts";
import { listAccountPayouts } from "@/services/payout-view";
import { getSessionAccount } from "@/services/session";
import { computeAccountHealth } from "@/core/account-health";
import { Notice, RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import { utcHhmm } from "@/app/_components/utc-time";
import { Submit } from "@/app/_components/submit";
import {
  ConfirmArmScope,
  ConfirmCost,
  ConfirmSubmit,
} from "@/app/_components/confirm-submit";
import { ContactRemedy, ContactState, hasContactRemedy } from "./contact-state";
import { StandingTier } from "./standing";
import {
  setMainAction,
  unlinkAction,
  unlinkDiscordAction,
  wakeSelfAction,
} from "./actions";
import { AccountPayouts } from "./account-payouts";

/** Columns in the crew manifest table: portrait, name, token, contacts, map,
 *  actions. Kept alongside the empty-state row's `colSpan` so the two can't
 *  drift apart the way a bare `6` scattered at both sites could. */
const MANIFEST_COLUMN_COUNT = 6;

/** The id a contacts cell's `aria-describedby` points at when — and only
 *  when — `ContactRemedy` has something to say about that character. Unlike
 *  the CONTACTS column's caption below, which is always in the accessible
 *  tree regardless of whether its sighted copy is shown, this element is not
 *  rendered at all for a character with no remedy. The reference and the
 *  element are gated on the same `hasContactRemedy` predicate, so the id can
 *  never dangle. */
const contactRemedyId = (characterId: number) => `contact-remedy-${characterId}`;

// Reads the session cookie and hits the DB on every request; getConfig() also
// requires env vars that aren't present at build time, so this route must
// never be statically prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account",
};

// Every code this page renders lives in src/lib/error-redirects.ts, beside the
// builder its producers go through. Nearly all are emitted by a callback route
// redirect; the distinction the copy has to carry is "retry works"
// (expired/failed) versus "retrying will do the same thing" (already_linked).

/** A contacts state the note actually explains. "ok" needs no explanation, and
 *  "missing_label" and "label_mismatch" already carry more specific instructions
 *  than the generic note would add — so neither surfaces it. */
function contactsNoteApplies(result: string | null) {
  return result !== "ok" && result !== "missing_label" && result !== "label_mismatch";
}

/**
 * One line of the closing telemetry: when authGD last pushed this, and when it
 * will look again.
 *
 * A never-pushed row gets its own state rather than being handed a null:
 * `formatAgo(null)` would say "never", which is accurate but reads as a fault
 * in a member's telemetry rather than the ordinary "we haven't got to you yet"
 * this is. The next-check time still renders in that case: a member whose
 * first sync hasn't landed is exactly the one who wants to know when it will.
 */
function PushRow({ push, now }: { push: PushStatus; now: number }) {
  const iso = push.lastPushedAt?.toISOString() ?? null;
  return (
    <dd className="push">
      {iso === null ? (
        <Status tone="off">not yet run</Status>
      ) : (
        <RelativeTime iso={iso} initial={formatAgo(iso, now)} />
      )}
      {push.nextCheckAt && (
        <span className="push__next">next {utcHhmm(push.nextCheckAt)}</span>
      )}
    </dd>
  );
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  // A cookie that no longer resolves is a genuine expiry and gets said so. No
  // cookie at all is a first-time visitor, who must not be told a session they
  // never had has ended. `resolveAdmin` draws the same line for the admin
  // pages.
  if (!sess) redirect(sid ? loginErrorUrl("session_expired") : "/login");
  // Independent reads, each needing only `sess.accountId` (plus `cfg` for the
  // first): run in parallel so TTFB is the slowest of the three rather than
  // their sum. `searchParams` is a Next-supplied promise with no DB dependency
  // of its own, so it joins the same `Promise.all` instead of a separate await.
  //
  // Three concurrent queries against a pool of `max = 5` (src/db/index.ts).
  // Total connection-milliseconds are unchanged — the same three reads, just
  // overlapped — so average pool occupancy is what it was; only the per-request
  // burst grew from 1 slot to 3. That fits, but it is most of the headroom:
  // anything added to this array should be weighed against that 5, whose
  // `connectionTimeoutMillis` turns a long wait for a free client into a
  // thrown error rather than a slow page.
  const [view, { error }, showPayoutsLink, payouts] = await Promise.all([
    getAccountView(getDb(), cfg, sess.accountId),
    searchParams,
    // Same tier-only gate the payouts pages themselves re-check — this only
    // decides whether the link appears, never whether the route is reachable.
    canReadPayouts(getDb(), sess.accountId),
    // Finalized operations only, and only rows whose participant resolved to
    // this account — see listAccountPayouts for both, including what the second
    // one cannot show.
    listAccountPayouts(getDb(), sess.accountId),
  ]);
  const message = lookupErrorMessage(ACCOUNT_ERRORS, error);
  const now = Date.now();

  const nav = [
    // These two sit side by side for an admin, so they must not share a word.
    // The roster is "Members", not "Accounts", for exactly that reason — see
    // admin-nav.tsx. "Your account" keeps the possessive because this page is
    // genuinely the reader's own, and nothing else in either bar competes
    // with it now.
    { href: "/account", label: "Your account" },
    ...(showPayoutsLink ? [{ href: "/payouts", label: "Payouts" }] : []),
    ...(view.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];

  // Shown once above the manifest rather than repeated in every affected cell:
  // two identical four-line paragraphs in a table column is noise, and the note
  // is about the column as a whole, not about one character.
  //
  // Non-targets are excluded: their cell reads "— not managed", not a state the
  // note explains. Telling an associate member authGD manages a contact label on their
  // characters describes something that never happens to them.
  const showContactsNote = view.characters.some(
    (c) => c.contactsTarget && contactsNoteApplies(c.contactSyncResult),
  );

  // One derivation feeds three surfaces: the verdict line, the first-sync
  // notice below (previously computed inline here, separately), and the
  // colour grade on "Add character" further down. `now` is the same clock
  // read used by the "Sync schedule" rows below, so the page renders against
  // one instant rather than two.
  const health = computeAccountHealth(view.characters, {
    linked: view.discordLinked,
    lastPushedAt: view.pushes.discord.lastPushedAt,
    now: new Date(now),
  });

  const contactRemedies = view.characters.filter((c) =>
    hasContactRemedy(c.contactSyncResult, c.contactsTarget),
  );

  return (
    <>
      <SiteHeader items={nav} current="/account" {...brandProps()} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>Your account</h1>
          <p className="page__lede">
            Membership, characters, and the state authGD is pushing out to standings, the
            map, and Discord.
          </p>
          {/* One line, above everything else: whether there is anything to
              read past this point before the member can leave. Quiet states
              stay text-only at the token's own size; the loud ones reuse the
              same Status token the manifest below uses for its own warn
              states, at size="lead" so they outrank the gold tier badge a
              block down — otherwise the loudest thing on a degraded page is
              the one fact that needs no action. No new colour either way.
              Suppressed entirely at zero characters — "nominal" would be true
              and useless, and the manifest's empty state says the real thing. */}
          {view.characters.length > 0 &&
            (health.verdict === "degraded" ? (
              <p className="verdict">
                <Status tone="warn" size="lead">
                  {health.attention} character{health.attention === 1 ? "" : "s"} need
                  {health.attention === 1 ? "s" : ""} attention
                </Status>
              </p>
            ) : health.verdict === "stalled" ? (
              // Not "needs attention": nothing here is the member's to fix
              // themselves. For an unrecognized code the remedy does name an
              // action — ask an admin — which is why the wording is about who
              // owns the fix rather than claiming there is nothing to do.
              <p className="verdict">
                <Status tone="warn" size="lead">
                  {health.stalled} character{health.stalled === 1 ? "" : "s"} not syncing
                </Status>
              </p>
            ) : health.verdict === "discord-stale" ? (
              // getPushStatus (services/account-view.ts) reports the newest
              // completed discord-roles run ANYWHERE, not per account, and
              // counts a "partial" run as pushed — so this can only ever mean
              // the job itself stopped running corp-wide, never that this
              // member's own roles are wrong. Wording stays about the
              // schedule, never "your roles".
              <p className="verdict">
                <Status tone="warn" size="lead">
                  Discord roles behind schedule
                </Status>
              </p>
            ) : health.verdict === "first-sync-pending" ? (
              <p className="verdict">
                <Status tone="off">first sync pending</Status>
              </p>
            ) : (
              <p className="verdict">
                <Status>nominal</Status>
              </p>
            ))}
        </div>

        {/* Mounted unconditionally rather than `&&`-gated: unlink, set-main and
            unlink-Discord all revalidate this route in place, so the region has
            to already exist for AT to hear a change land in it. See `Notice`'s
            docblock. */}
        <Notice tone="bad">{message}</Notice>

        {/* Only the characters the contacts job actually targets can be waiting
            on a first run. Testing every character instead meant an associate
            member, who has no targets and never will, was told their first sync
            was pending for as long as they stayed associate. Reads
            `firstSyncPending` rather than the verdict: a just-linked character
            has no scopes yet, so it is simultaneously "needs attention" and
            "waiting on its first run", and this notice — the one that says the
            wait is minutes, not broken — must survive the verdict leading with
            the fault. */}
        {health.firstSyncPending && (
          <Notice>
            First sync has not run yet.{" "}
            {/* The Discord clause is conditional because this notice renders
                directly above a "Link Discord" button on an unlinked account.
                Promising Discord roles there is both false (nothing pushes to
                Discord until the link exists) and quietly costly: it tells a
                member the one thing they still have to do is already handled.
                The unlinked branch spends the same clause pointing at the
                control instead. */}
            {view.discordLinked
              ? "Standings, map access and Discord roles update within a few minutes of linking a character."
              : "Standings and map access update within a few minutes of linking a character. Discord roles start once you link Discord below."}
          </Notice>
        )}

        <RuleHead as="h2">Standing</RuleHead>
        <dl className="facts">
          <dt>Tier</dt>
          <dd data-field="tier" className="facts__lead">
            <StandingTier tier={view.tier} />
            {/* Cryo's copy and its "wake me" control fold into this same dd
                rather than a row of their own: `.facts` is a grid, and a
                `.visually-hidden` dt in that grid is taken out of flow by its
                own `position: absolute`, which shifts every dt/dd after it
                into the wrong track. `.facts__lead` already wraps, so the
                sentence and button land on a second line within the value
                column instead of inventing a row the grid can't place. */}
            {view.status === "cryo" && (
              <>
                {/* Neutral, not --signal-warn: cryo is a pause the member
                    asked for, not a fault. DESIGN.md's amber stays on the
                    admin table, where cryo is a scanning target rather than a
                    fact about the member's own state. */}
                <Status>cryo</Status>
                <span className="dim">
                  Paused at your request. Tier is retained while you&rsquo;re away.
                </span>
                <form action={wakeSelfAction} className="inline-form">
                  <Submit className="btn" pendingLabel="waking…">
                    wake me
                  </Submit>
                </form>
              </>
            )}
          </dd>

          <dt>Discord</dt>
          {/* Same `.facts__lead` the tier row uses, and for the same reason:
              the consequence line below has to be able to wrap onto a second
              line inside the value column, and a `.facts` grid can't be given a
              row of its own without a dt to pair it with. A layout-only class,
              despite the "lead" in its name. */}
          <dd className="facts__lead">
            {view.discordLinked ? (
              // Its own arm scope, not the manifest's: ConfirmSubmit throws outside
              // one (confirm-submit.tsx:115), and a scope of one is right here —
              // arming this must not disarm a character row three sections down.
              <ConfirmArmScope>
                {/* No `linked` token beside the button. The unlinked branch
                    below has never rendered one either — it is a bare "Link
                    Discord" — so the row already trusts a verb to answer "is
                    Discord linked?" in one state. Rendering a status token in
                    the other state made the two halves read as one object,
                    which is the clutter #108 tried to solve with spacing. The
                    verb carries the state: `unlink` present means linked.

                    The same call the sync-schedule section already made: it
                    drops its Discord row rather than render an inert "not
                    linked" token, on the grounds that a nearby element states
                    the fact with the action attached. */}
                {/* ...but a name is not a status token. `linked` restated what
                    the button already said; this says WHICH Discord account is
                    on the hook, which is the one thing the row could not
                    answer before and the only question a member with two
                    Discord accounts actually has when they see `unlink`.

                    Display name first and in full ink, handle second and
                    dimmed: the guild nickname is what they are called by the
                    people they play with, and the @handle is the identifier
                    that settles it when the nickname is ambiguous. Either may
                    be missing on its own — a member with no nickname and no
                    global name has only a handle, and a link made before the
                    first roles sync has only a handle too — so each is
                    rendered independently rather than as one string.

                    Both null renders exactly what shipped in #115: the button
                    alone. That is the reason no backfill has to run before
                    this is correct. */}
                {(view.discordDisplayName || view.discordUsername) && (
                  <span className="discord-id">
                    {view.discordDisplayName && <span>{view.discordDisplayName}</span>}
                    {view.discordUsername && (
                      <span className="dim mono">@{view.discordUsername}</span>
                    )}
                  </span>
                )}
                <form action={unlinkDiscordAction} className="inline-form">
                  {/* A grade heavier at rest than the character-row unlinks
                      below (`.btn--quiet .btn--danger-quiet`), and
                      deliberately so: those drop one character from an
                      account that keeps every other one, while this one
                      enqueues a deprovision that strips every managed role
                      in the guild. There is one of these and up to a dozen
                      of those, so the quiet grade that keeps a dense table
                      from reading as a wall of buttons buys nothing here.
                      Both still upgrade to full `.btn--danger` only once
                      armed.

                      Full 36px, not the 28px `.btn--micro` grade: this sits
                      in the facts grid, not in a table row, and DESIGN.md
                      gives the smaller size to "the in-row controls of the
                      admin tables… and nowhere else". `inline-edit.tsx:75-83`
                      already made this exact call for the same grid, and
                      `.inline-edit--standalone` (globals.css:1695) exists
                      only to buy the floor back where a class had to keep
                      its colouring. Here nothing had to be bought back —
                      dropping `--micro` is the whole fix, and the heavier
                      rest grade this comment argues for is a colour
                      decision that never depended on the size. */}
                  <ConfirmSubmit
                    className="btn"
                    armedClassName="btn btn--danger"
                    label="unlink"
                    restName="unlink Discord"
                    confirmName="confirm unlink Discord"
                    describedBy="discord-unlink-cost"
                  />
                </form>
                {/* The unlink is not just a disconnected account: the deprovision
                    it enqueues strips every managed role
                    (jobs/discord-roles.ts:79), so a member who reads only the
                    word "unlink" loses their tier role in the guild without
                    having been told. Carried by the button's aria-describedby
                    rather than folded into its accessible name — a name is
                    spoken ahead of every press and has to stay short and match
                    the visible label, and this sits AFTER the control in reading
                    order, so a member who tabs straight to it would otherwise
                    never hear it at all.

                    Shown to sighted users only once armed (see ConfirmCost):
                    at rest this row's job is to answer "is Discord linked?",
                    and a permanent sentence about undoing it answers a question
                    the member has not asked. It stays in the accessible tree at
                    rest either way — the aria-describedby above depends on it.

                    "Queues", not "removes": the action enqueues a deprovision
                    and a worker runs it (jobs/discord-roles.ts), so a member who
                    unlinks and still sees the role a minute later has been told
                    the truth rather than contradicted. The verb survived the
                    trim from 17 words to 11 because it is the one fact in the
                    sentence a member can catch this page being wrong about. */}
                <ConfirmCost id="discord-unlink-cost" className="dim">
                  Queues removal of the Discord roles authGD manages. Relink any time.
                </ConfirmCost>
              </ConfirmArmScope>
            ) : (
              // Raised to the default button grade: high-value but was the
              // weakest affordance on the page. Not gold — DESIGN.md rations
              // that to one primary action per view, "Add character" below.
              <a className="btn" href="/auth/discord/link">
                Link Discord
              </a>
            )}
          </dd>
        </dl>

        <RuleHead as="h2">Crew manifest</RuleHead>

        {/* Purely visual now: the accessible copy moved to the table's own
            `<caption>` below, which reaches a member landing on any cell in
            the CONTACTS column, not just the header a `<th>`'s
            aria-describedby could reach. Omitted entirely rather than
            visually-hidden when no row needs it — the caption alone carries
            the standing fact for a screen-reader user — and `aria-hidden`
            keeps a sighted user's screen reader from hearing it said twice. */}
        {showContactsNote && (
          <p className="table-note" aria-hidden="true">
            authGD owns the <code>{cfg.standings.label}</code> contact label on your
            characters: contacts under that label are managed automatically and may be
            added, changed, or removed.
          </p>
        )}

        <Scroller label="Your characters">
          <table className="log">
            {/* Always present, unlike the visual copy above: a `<caption>` is
                announced for the table as a whole, so this is the one place a
                standing fact about the CONTACTS column reaches a member no
                matter which cell they navigate to. Visually hidden — the
                sighted copy above (when shown) says the same thing where the
                eye already is. */}
            <caption className="visually-hidden">
              authGD owns the <code>{cfg.standings.label}</code> contact label on your
              characters: contacts under that label are managed automatically and may be
              added, changed, or removed.
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Portrait</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">Token</th>
                <th scope="col">Contacts</th>
                <th scope="col">Map</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <ConfirmArmScope>
                {view.characters.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {/* The EVE image server is a third party serving one
                          small thumbnail per row; running each through the
                          image optimizer would add a proxy hop and a
                          dependency on their uptime per row of an admin's
                          scan, for no visible gain on a 32x32 avatar — not
                          adding images.evetech.net to remotePatterns for
                          this. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        className="portrait"
                        src={`https://images.evetech.net/characters/${c.id}/portrait?size=64`}
                        alt=""
                        width={32}
                        height={32}
                        loading="lazy"
                      />
                    </td>
                    <td>
                      <span className="char">
                        {c.name}{" "}
                        {c.isMain && <strong className="char__main">(main)</strong>}
                      </span>
                    </td>
                    <td>
                      {c.tokenStatus === "valid" && !c.needsReauthForScopes ? (
                        <Status tone="ok">ok</Status>
                      ) : (
                        // A control, not a value: `.st` carries no underline of
                        // its own (it's display:inline-flex), so an anchor
                        // wrapping one rendered with no affordance at all —
                        // identical to an inert token one column over. This is
                        // the same "make main"/"unlink" grade the row's other
                        // controls use, per globals.css's value/control split.
                        <a className="btn btn--quiet btn--micro" href="/auth/eve/link">
                          re-authorize
                        </a>
                      )}
                    </td>
                    <td
                      aria-describedby={
                        hasContactRemedy(c.contactSyncResult, c.contactsTarget)
                          ? contactRemedyId(c.id)
                          : undefined
                      }
                    >
                      <div className="stack">
                        <ContactState
                          result={c.contactSyncResult}
                          target={c.contactsTarget}
                        />
                      </div>
                    </td>
                    <td>
                      {c.onMapAcl ? (
                        <Status tone="ok">on</Status>
                      ) : (
                        <Status tone="off">off</Status>
                      )}
                    </td>
                    <td>
                      <div className="btn-row btn-row--tight btn-row--end">
                        {!c.isMain && (
                          <form
                            action={setMainAction.bind(null, c.id)}
                            className="inline-form"
                          >
                            <Submit
                              className="btn btn--quiet btn--micro"
                              pendingLabel="setting…"
                            >
                              make main
                            </Submit>
                          </form>
                        )}
                        {view.characters.length > 1 && (
                          <form
                            action={unlinkAction.bind(null, c.id)}
                            className="inline-form"
                          >
                            <ConfirmSubmit
                              className="btn btn--quiet btn--micro btn--danger-quiet"
                              armedClassName="btn btn--micro btn--danger"
                              label="unlink"
                              // Named, like the Discord unlink above and every
                              // unlink on the admin table: three rows each
                              // offering a bare "unlink" gives a screen-reader
                              // or speech-input member the verb three times
                              // with no object, and the manifest is exactly
                              // where they cannot see which row they are on.
                              restName={`unlink ${c.name}`}
                              confirmName={`confirm unlink ${c.name}`}
                            />
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {view.characters.length === 0 && (
                  <tr>
                    <td className="log__empty" colSpan={MANIFEST_COLUMN_COUNT}>
                      <span className="log__empty-text">
                        No characters linked yet. Add one to start pushing standings, map
                        access, and Discord roles for it.
                      </span>
                    </td>
                  </tr>
                )}
              </ConfirmArmScope>
            </tbody>
          </table>
        </Scroller>

        {/* Remediation prose lives below the Scroller, never inside it: at
            320px the table region scrolls horizontally, and up to three
            sentences of fix instructions inside a cell drove that row to
            ~340px tall while staying off-screen and unreachable. Each block
            is capped at `--measure` like every other prose block on the
            page, and is named by character since more than one row can need
            explaining at once. */}
        {contactRemedies.length > 0 && (
          <div className="table-notes">
            {contactRemedies.map((c) => (
              <p key={c.id} id={contactRemedyId(c.id)} className="table-note">
                <strong>{c.name}:</strong>{" "}
                <ContactRemedy
                  result={c.contactSyncResult}
                  detail={c.contactSyncDetail}
                  label={cfg.standings.label}
                  // Only when the TOKEN cell isn't already showing a
                  // re-authorize control for this row: two links to one href
                  // in one row is noise. This covers the stale-snapshot case
                  // where the token has since refreshed to valid but the last
                  // contacts run still reports a token fault — there the cell
                  // reads "ok" and this is the only place the control can live.
                  showReauth={c.tokenStatus === "valid" && !c.needsReauthForScopes}
                />
              </p>
            ))}
          </div>
        )}

        <p className="btn-row pager">
          {/* Demoted to the default grade whenever the page is reporting
              anything: DESIGN.md rations gold to one primary action per view,
              and "state before action" means the loudest thing on a broken
              page must not be adding more to it. Gold only in the nominal
              state — which a zero-character account also computes to
              (`computeAccountHealth` has no target and no fault to find) —
              where adding a character genuinely is the primary action.

              Keyed off the verdict rather than `attention === 0`, which is
              the weaker test: `stalled`, `discord-stale` and
              `first-sync-pending` all satisfy it while a `.verdict` line is
              showing above (see the ladder at account-health.ts:163-177),
              so the gold fired on three of the four states this comment
              says it excludes. */}
          <a
            className={health.verdict === "nominal" ? "btn btn--primary" : "btn"}
            href="/auth/eve/link"
          >
            Add character
          </a>
        </p>

        {/* Omitted entirely when there are none, like the "Sync schedule" block
            below: an empty table under "Your payouts" on every alumni member's
            page is a section that never says anything. */}
        {payouts.length > 0 && (
          <AccountPayouts rows={payouts} linkToOperations={showPayoutsLink} />
        )}

        {/* Omitted entirely with no characters linked: there is nothing being
            pushed on their behalf yet, and three "not yet run" rows would read
            as a broken system rather than an empty one. */}
        {view.characters.length > 0 && (
          <>
            <RuleHead as="h2" aside={<span className="dim mono">UTC</span>}>
              Sync schedule
            </RuleHead>
            {/* getPushStatus (services/account-view.ts) reports the newest
                completed run of each job ACROSS THE WHOLE CORP, not this
                account's own. Renamed from "Last pushed", which read as a
                personal fact ("my standings were written at 14:02") when it
                is really "the job last completed, corp-wide, at 14:02". The
                per-character truth lives in the manifest above. */}
            <p className="table-note">
              When each job last completed corp-wide, and when it runs next. For your own
              characters, read the CONTACTS and MAP columns above.
            </p>
            <dl className="facts">
              <dt>Standings</dt>
              <PushRow push={view.pushes.standings} now={now} />

              <dt>Map</dt>
              <PushRow push={view.pushes.map} now={now} />

              {/* Dropped entirely rather than shown as an inert "not linked"
                  token: nothing is being pushed for it, and STANDING above
                  already states the same fact with the fix attached. Stating
                  it twice, ~800px apart, was the same information doing
                  nothing the second time. */}
              {view.discordLinked && (
                <>
                  <dt>Discord</dt>
                  <PushRow push={view.pushes.discord} now={now} />
                </>
              )}
            </dl>
          </>
        )}

        {/* The closing beat. Decorative, so alt is empty; drawn from a
            1120px asset cut for exactly this, never a scaled-down master.
            A single-character account has little content above it, and the
            full-size artwork dwarfed it; `.closing--compact` asks the same
            asset for a smaller frame rather than cropping or downscaling it,
            same technique the full size already uses, just a smaller target. */}
        <p className={`closing${view.characters.length <= 1 ? " closing--compact" : ""}`}>
          <Image src="/brand/hero-account.webp" alt="" width={1120} height={711} />
        </p>
      </main>
    </>
  );
}
