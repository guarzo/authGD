import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAccountView, type PushStatus } from "@/services/account-view";
import { getSessionAccount } from "@/services/session";
import {
  Notice,
  RuleHead,
  Scroller,
  SiteHeader,
  Status,
  Tier,
} from "@/app/_components/ui";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import { utcHhmm } from "@/app/_components/utc-time";
import { Submit } from "@/app/_components/submit";
import { ConfirmArmScope, ConfirmSubmit } from "@/app/_components/confirm-submit";
import { ContactState } from "./contact-state";
import { setMainAction, unlinkAction, wakeSelfAction } from "./actions";

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
  not_admin: "Your admin access was removed. This is your account page.",
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
  if (!sess) redirect("/login");
  const view = await getAccountView(getDb(), cfg, sess.accountId);
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  const now = Date.now();

  const nav = [
    // These two sit side by side for an admin, so they must not share a word.
    // The roster is "Members", not "Accounts", for exactly that reason — see
    // admin-nav.tsx. "Your account" keeps the possessive because this page is
    // genuinely the reader's own, and nothing else in either bar competes
    // with it now.
    { href: "/account", label: "Your account" },
    ...(view.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
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

  return (
    <>
      <SiteHeader items={nav} current="/account" measure="narrow" />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>Your account</h1>
          <p className="page__lede">
            Membership, characters, and the state authGD is pushing out to standings, the
            map, and Discord.
          </p>
        </div>

        {message && <Notice tone="bad">{message}</Notice>}

        {/* Only the characters the contacts job actually targets can be waiting
            on a first run. Testing every character instead meant a blue member,
            who has no targets and never will, was told their first sync was
            pending for as long as they stayed blue. */}
        {view.characters.some((c) => c.contactsTarget) &&
          view.characters.every(
            (c) => !c.contactsTarget || c.contactSyncResult === null,
          ) && (
            <Notice>
              First sync has not run yet. Standings, map access and Discord roles update
              within a few minutes of linking a character.
            </Notice>
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
                        <a href="/auth/eve/link">
                          <Status tone="warn">re-auth needed</Status>
                        </a>
                      )}
                    </td>
                    <td>
                      <div className="stack">
                        <ContactState
                          result={c.contactSyncResult}
                          detail={c.contactSyncDetail}
                          label={cfg.standings.label}
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
              </ConfirmArmScope>
            </tbody>
          </table>
        </Scroller>

        <p className="btn-row pager">
          <a className="btn btn--primary" href="/auth/eve/link">
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

              <dt>Discord</dt>
              {view.discordLinked ? (
                <PushRow push={view.pushes.discord} now={now} />
              ) : (
                <dd className="push">
                  <Status tone="off">not linked</Status>
                </dd>
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
          <img
            src="/brand/lander-moon.webp"
            alt=""
            width={1120}
            height={711}
            loading="lazy"
            decoding="async"
          />
        </p>
      </main>
    </>
  );
}
