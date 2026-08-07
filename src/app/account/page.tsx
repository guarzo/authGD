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
import { getMainChangeContext } from "@/services/accounts";
import { getSessionAccount } from "@/services/session";
import { classifyCharacter, computeAccountHealth } from "@/core/account-health";
import { previewMainChange } from "@/core/tier";
import { tierLabel } from "@/app/_components/labels";
import { navFor } from "@/app/_components/nav-items";
import { Notice, RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import { utcHhmm } from "@/app/_components/utc-time";
import { CharacterLocation } from "@/app/_components/character-location";
import { Submit } from "@/app/_components/submit";
import {
  ConfirmArmScope,
  ConfirmCost,
  ConfirmSubmit,
} from "@/app/_components/confirm-submit";
import {
  ContactRemedy,
  ContactState,
  contactStateToken,
  hasContactRemedy,
} from "./contact-state";
import { StandingTier } from "./standing";
import {
  setMainAction,
  unlinkAction,
  unlinkDiscordAction,
  wakeSelfAction,
} from "./actions";
import { AccountPayouts } from "./account-payouts";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { accountConfirmation } from "./view";

/** Columns in the crew manifest table: portrait, name, [status], actions.
 *  Derived rather than constant because STATUS is an exception column — see
 *  `showStatusColumn` in the page body — and the empty-state row's `colSpan`
 *  has to follow it or a no-character account renders a short row. */
const manifestColumns = (showStatus: boolean) => (showStatus ? 4 : 3);

/** The id a contacts cell's `aria-describedby` points at when — and only
 *  when — `ContactRemedy` has something to say about that character. Unlike
 *  the manifest table's `<caption>` below, which is always in the accessible
 *  tree regardless of whether its sighted copy is shown, this element is not
 *  rendered at all for a character with no remedy. The reference and the
 *  element are gated on the same `hasContactRemedy` predicate, so the id can
 *  never dangle. */
const contactRemedyId = (characterId: number) => `contact-remedy-${characterId}`;

/** Same dangling-id guarantee as `contactRemedyId` above, for the "make main"
 *  consequence sentence — the id is only ever referenced from the button for a
 *  character `mainChangeNotes` actually produced a note for. */
const mainChangeNoteId = (characterId: number) => `main-change-note-${characterId}`;

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
 * The words the collapsed STATUS chip's `aria-label` uses for the standings
 * fact — the same words `ContactState` would render visibly, so the
 * accessible name never says something different from what an expanded row
 * would have shown.
 */
function standingsSummary(c: {
  contactsTarget: boolean;
  contactSyncResult: string | null;
}) {
  if (!c.contactsTarget) return "— not managed";
  if (c.contactSyncResult === null) return "not yet run";
  return contactStateToken(c.contactSyncResult).text;
}

/** The `token ok, standings …, map on|off` sentence, in one place because it
 *  now has two surfaces: the STATUS cell's accessible name when the column
 *  renders, and a visually-hidden span in the NAME cell when it does not. Two
 *  copies would drift, and the one that drifts is the one nobody can see.
 *
 *  Only correct for a character that is not `attention`: the literal "token
 *  ok" holds because `classifyCharacter` returns "attention" for any token
 *  that is not valid (account-health.ts:112-118), so this string and the `ok`
 *  chip can only ever agree. A change loosening that classification has to
 *  update this too — nothing else guards it. */
function statusSummary(c: {
  contactsTarget: boolean;
  contactSyncResult: string | null;
  onMapAcl: boolean;
}) {
  return `token ok, standings ${standingsSummary(c)}, map ${c.onMapAcl ? "on" : "off"}`;
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
  searchParams: Promise<{ error?: string; done?: string; name?: string; at?: string }>;
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
  // Four concurrent queries against a pool of `max = 5` (src/db/index.ts).
  // Total connection-milliseconds are unchanged — the same four reads, just
  // overlapped — so average pool occupancy is what it was; only the per-request
  // burst grew from 1 slot to 4. That fits, but it is nearly all the headroom:
  // anything added to this array should be weighed against that 5, whose
  // `connectionTimeoutMillis` turns a long wait for a free client into a
  // thrown error rather than a slow page.
  const [view, { error, done, name, at }, showPayoutsLink, payouts, mainChangeContext] =
    await Promise.all([
      getAccountView(getDb(), cfg, sess.accountId),
      searchParams,
      // Same tier-only gate the payouts pages themselves re-check — this only
      // decides whether the link appears, never whether the route is reachable.
      canReadPayouts(getDb(), sess.accountId),
      // Finalized operations only, and only rows whose participant resolved to
      // this account — see listAccountPayouts for both, including what the second
      // one cannot show.
      listAccountPayouts(getDb(), sess.accountId),
      // Backs the honest "make main" consequence below — see
      // `previewMainChange`'s own doc for why this is a separate query rather
      // than a field on `AccountView`.
      getMainChangeContext(getDb(), sess.accountId),
    ]);
  const message = lookupErrorMessage(ACCOUNT_ERRORS, error);
  const confirmation = accountConfirmation(done, name);
  const now = Date.now();

  const nav = navFor({ canReadPayouts: showPayoutsLink, isAdmin: view.isAdmin });

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

  // The STATUS column renders only when it has something to say. On the common
  // account every row reads "ok", which costs a header, a column and 82px of a
  // 320px viewport to report the absence of news; the column appearing is a
  // better signal than the column being permanently present. A pure function of
  // `classifyCharacter` over the crew, so the manifest stays a server component.
  const showStatusColumn = view.characters.some((c) => classifyCharacter(c) !== "ok");

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

  // The honest "make main" consequence per non-main character — sweep item
  // #6. Computed once here, not per-row where the button lives, because the
  // sentence is prose too long for that cell (same reasoning as
  // `contactRemedies` below) and because "none" of the three outcomes is the
  // common case: a member's alts are usually in the same corp as their main,
  // and a blanket warning on every row would be noise on exactly the rows
  // where pressing the button changes nothing (PRODUCT.md principle 4).
  //
  // `text` never repeats `c.name` — same convention as `contactRemedies`
  // below, which prefixes the rendered `<strong>{name}:</strong>` itself — and
  // never guesses a pronoun for the character's owner; each sentence reads as
  // a standalone clause after that prefix instead.
  const mainChangeNotes = view.characters
    .filter((c) => !c.isMain)
    .flatMap((c) => {
      const preview = previewMainChange({
        tier: mainChangeContext.tier,
        tierLocked: mainChangeContext.tierLocked,
        allianceId: mainChangeContext.allianceIdByCharacter.get(c.id) ?? null,
        configuredAllianceId: cfg.allianceId,
      });
      if (preview.kind === "none") return [];
      const text =
        preview.kind === "unknown"
          ? "Alliance standing not checked yet — setting as main means your tier follows whatever the next check finds."
          : preview.nextTier === "alumni"
            ? `Not in the alliance right now — setting as main moves your tier to ${tierLabel(
                "alumni",
              )} once the next check runs, and standings and map access follow it.`
            : `In the alliance — setting as main moves your tier to ${tierLabel(
                "member",
              )} once the next check runs.`;
      return [{ id: c.id, name: c.name, text }];
    });

  return (
    <>
      <SiteHeader items={nav} current="/account" {...brandProps()} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <div className="page__head-row">
            <h1>Your account</h1>
            {/* The verdict shares the h1's line: at 24px against the h1's 40px
                it costs zero vertical pixels, where its own row cost 36. Same
                five branches, same tones, same size="lead" — see the comment
                below for why the loud ones outrank the tier badge. */}
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
                    {health.stalled} character{health.stalled === 1 ? "" : "s"} not
                    syncing
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
          <p className="page__lede">
            Membership, characters, and the state authGD is pushing out to standings, the
            map, and Discord.
          </p>
          {/* STANDING's two facts, flattened out of a rule-head + definition
              list (171px of chrome including the collapsed margin) onto one
              line inside the head. The h2 that grouped them is not replaced:
              two facts are not a section, and the labels below carry the
              naming the heading was doing by proximity. */}
          <div className="page__meta">
            <div className="page__meta-item" data-field="tier">
              {/* Visually hidden because the approved layout puts the token on
                  its own — but `StandingTier` renders "Testers", a word that
                  answers nothing without "Tier" in front of it. The `.facts`
                  grid's `<dt>` was doing this job; nothing else was. */}
              <span className="visually-hidden">Tier</span>
              <StandingTier tier={view.tier} />
              {/* Cryo's copy and its "wake me" control, unchanged from the dd
                  they used to share. The old comment here argued they could not
                  have a row of their own because a `.visually-hidden` dt is
                  `position: absolute` and breaks a grid's tracks; that argument
                  died with the grid and is not carried over. This is a wrapping
                  flex line — the sentence and the button take a second line on
                  their own. */}
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
            </div>

            <div className="page__meta-item">
              <span className="visually-hidden">Discord</span>
              {view.discordLinked ? (
                // Its own arm scope, not the manifest's: an arming ConfirmSubmit
                // throws outside one (confirm-submit.tsx:281), and a scope of one
                // is right here —
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
                        in the page head, not in a table row, and DESIGN.md
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
                  <ConfirmCost id="discord-unlink-cost">
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
            </div>
          </div>
        </div>

        {/* Mounted unconditionally rather than `&&`-gated: unlink, set-main and
            unlink-Discord all revalidate this route in place, so the region has
            to already exist for AT to hear a change land in it. See `Notice`'s
            docblock. */}
        <Notice tone="bad">{message}</Notice>

        {/* Success confirmation for the four self-serve actions below
            (make main, unlink, wake me, unlink Discord) — a separate slot
            from `message` above rather than a shared one, because `message`
            is hard-coded `tone="bad"` and a success confirmation must not
            render in the alarm colour. See `@/app/_components/confirm-notice`
            for how this also answers the focus half of the same defect: the
            control that was pressed unmounts the instant one of those four
            actions succeeds, and this is what focus lands on instead of
            `<body>`. Shared with `/admin/sync`, which has the identical
            problem for its own three enqueue actions. It is already mounted
            unconditionally, and carries `live={false}` on purpose — focus,
            not the live region, does the announcing there. */}
        <ConfirmNotice text={confirmation} at={at} />

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

        <RuleHead
          as="h2"
          aside={
            view.locationAsOf && (
              <span className="dim mono">
                locations{" "}
                <RelativeTime
                  iso={view.locationAsOf.toISOString()}
                  initial={formatAgo(view.locationAsOf.toISOString(), now)}
                />
              </span>
            )
          }
        >
          Crew manifest
        </RuleHead>

        {/* Purely visual now: the accessible copy moved to the table's own
            `<caption>` below, which reaches a member landing on any cell,
            not just the header a `<th>`'s aria-describedby could reach.
            Omitted entirely rather than visually-hidden when no row needs it —
            the caption alone carries the standing fact for a screen-reader
            user — and `aria-hidden` keeps a sighted user's screen reader from
            hearing it said twice. */}
        {showContactsNote && (
          <p className="table-note" aria-hidden="true">
            authGD owns the <code>{cfg.standings.label}</code> contact label on your
            characters: contacts under that label are managed automatically and may be
            added, changed, or removed.
          </p>
        )}

        <Scroller label="Your characters">
          <table className="log log--manifest">
            {/* Always present, unlike the visual copy above: a `<caption>` is
                announced for the table as a whole, so this is the one place a
                standing fact about the managed contact label reaches a member
                no matter which cell they navigate to. It also says where that
                state now lives, since the CONTACTS and MAP columns it used to
                name were merged into STATUS. Visually hidden — the sighted copy
                above (when shown) says the same thing where the eye already
                is. */}
            <caption className="visually-hidden">
              authGD owns the <code>{cfg.standings.label}</code> contact label on your
              characters: contacts under that label are managed automatically and may be
              added, changed, or removed.
              {showStatusColumn
                ? " Each character’s STATUS cell summarizes its token, standings and map state, and shows the detail when something needs your attention."
                : view.characters.length > 0
                  ? " Every character is healthy, so each row states its own token, standings and map state in place of a STATUS column."
                  : " No characters are linked yet, so there is no STATUS column to show."}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Portrait</span>
                </th>
                <th scope="col">Name</th>
                {showStatusColumn && <th scope="col">Status</th>}
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <ConfirmArmScope>
                {view.characters.map((c) => {
                  const state = classifyCharacter(c);
                  // `classifyCharacter` only returns "stalled" when
                  // `contactSyncResult` is a non-null, non-"ok" code
                  // (account-health.ts:127), so this narrowing check never
                  // actually fails for that state — an explicit `!== null`
                  // rather than a non-null assertion, so `tsc` can follow it.
                  // Gated on `state === "stalled"` so the value has no meaning
                  // outside the one arm that reads it.
                  const stalledToken =
                    state === "stalled" && c.contactSyncResult !== null
                      ? contactStateToken(c.contactSyncResult)
                      : null;
                  return (
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
                        <div className="char-line">
                          <span className="char">
                            {c.name}{" "}
                            {c.isMain && <strong className="char__main">(main)</strong>}
                          </span>
                          <CharacterLocation
                            location={c.location}
                            stale={c.locationStale}
                          />
                          {/* Only when the STATUS column is gone. `map on|off`
                              varies per character while the chip reads `ok`
                              either way — deliberately, since map membership
                              cannot substantiate a fault
                              (account-health.ts:27-35) — so the cell's
                              accessible name was the only place a
                              screen-reader user could learn it. Visually
                              hidden costs no vertical space, which is the
                              whole point of dropping the column. Never
                              rendered alongside the column: that would say the
                              same sentence twice in one row. */}
                          {!showStatusColumn && (
                            <span className="visually-hidden" data-status-summary>
                              {statusSummary(c)}
                            </span>
                          )}
                        </div>
                      </td>
                      {showStatusColumn && (
                        <td
                          data-state={state}
                          aria-label={
                            state === "attention" ? undefined : statusSummary(c)
                          }
                          aria-describedby={
                            hasContactRemedy(c.contactSyncResult, c.contactsTarget)
                              ? contactRemedyId(c.id)
                              : undefined
                          }
                        >
                          {state === "attention" ? (
                            <div className="status-lines">
                              <span className="status-line">
                                <span className="status-line__label">token</span>
                                {c.tokenStatus === "valid" && !c.needsReauthForScopes ? (
                                  <Status tone="ok">ok</Status>
                                ) : (
                                  // A control, not a value: `.st` carries no underline
                                  // of its own (it's display:inline-flex), so an anchor
                                  // wrapping one rendered with no affordance at all —
                                  // identical to an inert token beside it. This is the
                                  // same "make main"/"unlink" grade the row's other
                                  // controls use, per globals.css's value/control
                                  // split. Merging TOKEN into STATUS does not demote it
                                  // to a chip.
                                  <a
                                    className="btn btn--quiet btn--micro"
                                    href="/auth/eve/link"
                                  >
                                    re-authorize
                                  </a>
                                )}
                              </span>
                              <span className="status-line">
                                <span className="status-line__label">standings</span>
                                <ContactState
                                  result={c.contactSyncResult}
                                  target={c.contactsTarget}
                                />
                              </span>
                              <span className="status-line">
                                <span className="status-line__label">map</span>
                                {c.onMapAcl ? (
                                  <Status tone="ok">on</Status>
                                ) : (
                                  <Status tone="off">off</Status>
                                )}
                              </span>
                            </div>
                          ) : state === "stalled" ? (
                            // One chip, and it never overstates health: a stalled
                            // character shows its own state, not `ok`. `map: off`
                            // rides in the cell's accessible name rather than the
                            // visible chip because it is unsubstantiable as a fault
                            // (account-health.ts:27-35) and nothing a member can
                            // act on.
                            //
                            // The null-token branch is unreachable today —
                            // `classifyCharacter` only returns "stalled" for a
                            // non-null `contactSyncResult` — but its fallback is
                            // still a non-"ok" tone. This arm must never be able
                            // to reach the `ok` chip through any path, so a
                            // future change to `isStalled` that breaks that
                            // guarantee fails loud (a wrong chip) rather than
                            // quiet (a false green).
                            <Status tone={stalledToken?.tone ?? "warn"}>
                              {stalledToken?.text ?? "stalled"}
                            </Status>
                          ) : (
                            <Status tone="ok">ok</Status>
                          )}
                        </td>
                      )}
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
                                // Nine of these stack up in a ten-character
                                // manifest, and "make main" is 89px against
                                // `main`'s 50px — 39px of a 320px viewport's
                                // forced horizontal scroll, per character
                                // column. The verb moves into the accessible
                                // name rather than being dropped: `unlink`
                                // beside it already made this exact trade
                                // (`restName` below), and a column of bare
                                // "main"s would otherwise announce a noun with
                                // no object nine times.
                                aria-label={`make ${c.name} main`}
                                // Points at the prose below the Scroller only when
                                // `mainChangeNotes` produced one for this character
                                // — most rows change nothing (an alt in the same
                                // corp as the main), and this button carries no
                                // `aria-describedby` at all on those, matching the
                                // STATUS cell's `contactRemedyId` wiring above.
                                //
                                // Complements the label above rather than competing
                                // with it: `aria-label` replaces the name a screen
                                // reader announces, `aria-describedby` is read after
                                // it, so the row says what the press does and then
                                // what it will change.
                                aria-describedby={
                                  mainChangeNotes.some((n) => n.id === c.id)
                                    ? mainChangeNoteId(c.id)
                                    : undefined
                                }
                              >
                                main
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
                  );
                })}
                {view.characters.length === 0 && (
                  <tr>
                    <td
                      className="log__empty"
                      colSpan={manifestColumns(showStatusColumn)}
                    >
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
                  // Only when the STATUS cell isn't already showing a
                  // re-authorize control for this row: two links to one href in
                  // one row is noise. This covers the stale-snapshot case where
                  // the token has since refreshed to valid but the last contacts
                  // run still reports a token fault — there the cell reads "ok"
                  // and this is the only place the control can live.
                  showReauth={c.tokenStatus === "valid" && !c.needsReauthForScopes}
                />
              </p>
            ))}
          </div>
        )}

        {/* Same placement rule as the remediation prose above: state before
            action (PRODUCT.md principle 2), read by anyone before they press
            "make main", not surfaced as a tooltip or screen-reader-only aside.
            Only the characters where pressing it actually moves the tier get a
            sentence — an alt already in the same corp as the main gets none,
            so this never reads as a warning on a press that changes nothing. */}
        {mainChangeNotes.length > 0 && (
          <div className="table-notes">
            {mainChangeNotes.map((n) => (
              <p key={n.id} id={mainChangeNoteId(n.id)} className="table-note">
                <strong>{n.name}:</strong> {n.text}
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
              characters,{" "}
              {showStatusColumn
                ? "read the STATUS column in the crew manifest above."
                : "read the crew manifest above."}
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
