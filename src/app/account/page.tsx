import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAccountView, type PushStatus } from "@/services/account-view";
import { getSessionAccount } from "@/services/session";
import { computeAccountHealth } from "@/core/account-health";
import { RuleHead, Scroller, SiteHeader, Status, Tier } from "@/app/_components/ui";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import { utcHhmm } from "@/app/_components/utc-time";
import { Submit } from "@/app/_components/submit";
import { ConfirmArmScope, ConfirmSubmit } from "@/app/_components/confirm-submit";
import { ContactRemedy, ContactState, hasContactRemedy } from "./contact-state";
import { setMainAction, unlinkAction, wakeSelfAction } from "./actions";

/** Columns in the crew manifest table: portrait, name, token, contacts, map,
 *  actions. Kept alongside the empty-state row's `colSpan` so the two can't
 *  drift apart the way a bare `6` scattered at both sites could. */
const MANIFEST_COLUMN_COUNT = 6;

/** The id a contacts cell's `aria-describedby` points at when — and only
 *  when — `ContactRemedy` has something to say about that character. Unlike
 *  `CONTACTS_NOTE_ID` below, which is always in the DOM and merely toggles
 *  between visible and visually-hidden, this element is not rendered at all
 *  for a character with no remedy. The reference and the element are gated on
 *  the same `hasContactRemedy` predicate, so the id can never dangle. */
const contactRemedyId = (characterId: number) => `contact-remedy-${characterId}`;

// Reads the session cookie and hits the DB on every request; getConfig() also
// requires env vars that aren't present at build time, so this route must
// never be statically prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your account",
};

const ERRORS: Record<string, string> = {
  already_linked: "That character is already linked to another account.",
  discord_already_linked: "That Discord account is already linked to another account.",
  discord_denied: "Discord authorization was cancelled.",
  stale_character:
    "That character isn't on this account anymore. The page below is current.",
};

/**
 * The id the CONTACTS column header points `aria-describedby` at. The note is
 * a standing property of that column, not news, so it lives there once instead
 * of as a disclaimer every member reads on every visit.
 */
const CONTACTS_NOTE_ID = "contacts-note";

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
 * `formatAgo(null)` means "running", which is true on the sync page and false
 * here, so a never-pushed row gets its own state rather than being handed a
 * null. The next-check time still renders in that case: a member whose first
 * sync hasn't landed is exactly the one who wants to know when it will.
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
  if (!sess) redirect("/login");
  const view = await getAccountView(getDb(), cfg, sess.accountId);
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  const now = Date.now();

  const nav = [
    // "Your account", not "Account", everywhere it appears: the admin nav
    // already carries "Accounts" for the roster, and the two read as the same
    // destination at a glance. The possessive is what distinguishes them, so
    // it has to be the name on both navs rather than only the admin one.
    { key: "account", href: "/account", label: "Your account" },
    ...(view.isAdmin ? [{ key: "admin", href: "/admin/accounts", label: "Admin" }] : []),
  ];

  // Shown once above the manifest rather than repeated in every affected cell:
  // two identical four-line paragraphs in a table column is noise, and the note
  // is about the column as a whole, not about one character.
  //
  // Non-targets are excluded: their cell reads "— not managed", not a state the
  // note explains. Telling a blue member authGD manages a contact label on their
  // characters describes something that never happens to them.
  const showContactsNote = view.characters.some(
    (c) => c.contactsTarget && contactsNoteApplies(c.contactSyncResult),
  );

  // One derivation feeds three surfaces: the verdict line, the first-sync
  // notice below (previously computed inline here, separately), and the
  // colour grade on "Add character" further down.
  const health = computeAccountHealth(view.characters);

  const contactRemedies = view.characters.filter((c) =>
    hasContactRemedy(c.contactSyncResult, c.contactsTarget),
  );

  return (
    <>
      <SiteHeader items={nav} current="account" measure="narrow" />
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

        {message && (
          <p className="notice notice--bad" data-glyph="!" role="alert">
            {message}
          </p>
        )}

        {/* Only the characters the contacts job actually targets can be waiting
            on a first run. Testing every character instead meant a blue member,
            who has no targets and never will, was told their first sync was
            pending for as long as they stayed blue. Reads `firstSyncPending`
            rather than the verdict: a just-linked character has no scopes yet,
            so it is simultaneously "needs attention" and "waiting on its first
            run", and this notice — the one that says the wait is minutes, not
            broken — must survive the verdict leading with the fault. */}
        {health.firstSyncPending && (
          <p className="notice" data-glyph="·">
            First sync has not run yet. Standings, map access and Discord roles update
            within a few minutes of linking a character.
          </p>
        )}

        <RuleHead as="h2">Standing</RuleHead>
        <dl className="facts">
          <dt>Tier</dt>
          <dd data-field="tier" className="facts__lead">
            <Tier tier={view.tier} size="lead" />
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
          <dd>
            {view.discordLinked ? (
              // Secondary to the tier, and per DESIGN.md a settled state is not
              // actionable: a neutral token says "linked" without competing
              // with the tier badge for the eye.
              <Status>linked</Status>
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

        {/* One element, always in the accessible tree as the CONTACTS column's
            description, so a keyboard user reaches it by navigating the header
            and never needs a hover-only title attribute. It becomes visible
            copy only when some row's contacts state is one the note explains —
            a caption on the manifest, not a disclaimer on the account. */}
        <p
          id={CONTACTS_NOTE_ID}
          className={showContactsNote ? "table-note" : "visually-hidden"}
        >
          authGD owns the <code>{cfg.standings.label}</code> contact label on your
          characters: contacts under that label are managed automatically and may be
          added, changed, or removed.
        </p>

        <Scroller label="Your characters">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Portrait</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">Token</th>
                <th scope="col" aria-describedby={CONTACTS_NOTE_ID}>
                  Contacts
                </th>
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
                      No characters linked yet. Add one to start pushing standings, map
                      access, and Discord roles for it.
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
          {/* Demoted to the default grade whenever any character needs
              attention: DESIGN.md rations gold to one primary action per
              view, and "state before action" means the loudest thing on a
              broken page must not be adding more to it. Gold only in the
              nominal state — which a zero-character account also computes to
              (`computeAccountHealth` has no target and no fault to find) —
              where adding a character genuinely is the primary action. */}
          <a
            className={health.attention === 0 ? "btn btn--primary" : "btn"}
            href="/auth/eve/link"
          >
            Add character
          </a>
        </p>

        {/* Omitted entirely with no characters linked: there is nothing being
            pushed on their behalf yet, and three "not yet run" rows would read
            as a broken system rather than an empty one. */}
        {view.characters.length > 0 && (
          <>
            <RuleHead as="h2" aside={<span className="dim mono">UTC</span>}>
              Last pushed
            </RuleHead>
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
          <Image src="/brand/lander-moon.webp" alt="" width={1120} height={711} />
        </p>
      </main>
    </>
  );
}
