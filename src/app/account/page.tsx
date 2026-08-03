import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAccountView } from "@/services/account-view";
import { getSessionAccount } from "@/services/session";
import { RuleHead, Scroller, SiteHeader, Status, Tier } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { setMainAction, unlinkAction } from "./actions";

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
};

/**
 * The contact job records a small set of result codes. "ok" and "missing_label"
 * get bespoke treatment; anything else is a failure the member can act on by
 * re-authing, so it reads as bad rather than as noise.
 */
function ContactState({ result, label }: { result: string | null; label: string }) {
  if (result === null) return <Status tone="off">not yet run</Status>;
  if (result === "ok") return <Status tone="ok">ok</Status>;
  if (result === "missing_label") {
    return (
      <>
        <Status tone="warn">label missing</Status>
        <span className="dim">
          Create a contact label named <code>{label}</code> in game, then re-sync.
        </span>
      </>
    );
  }
  return <Status tone="bad">{result.replace(/_/g, " ")}</Status>;
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

  const nav = [
    { key: "account", href: "/account", label: "Account" },
    ...(view.isAdmin ? [{ key: "admin", href: "/admin/accounts", label: "Admin" }] : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="account" />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>Your account</h1>
          <p className="page__lede">
            Membership, characters, and the state authGD is pushing out to standings, the
            map, and Discord.
          </p>
        </div>

        {message && (
          <p className="notice notice--bad" data-glyph="!" role="alert">
            {message}
          </p>
        )}

        {view.characters.length > 0 &&
          view.characters.every((c) => c.contactSyncResult === null) && (
            <p className="notice" data-glyph="·">
              First sync has not run yet. Standings, map access and Discord roles update
              within a few minutes of linking a character.
            </p>
          )}

        <RuleHead as="h2">Standing</RuleHead>
        <dl className="facts">
          <dt>Tier</dt>
          <dd data-field="tier">
            <Tier tier={view.tier} />
            {view.status === "cryo" && (
              <>
                {" "}
                <Status tone="warn">cryo</Status>
              </>
            )}
          </dd>

          <dt>Discord</dt>
          <dd>
            {view.discordLinked ? (
              <Status tone="ok">linked</Status>
            ) : (
              <a href="/auth/discord/link">Link Discord</a>
            )}
          </dd>
        </dl>

        <RuleHead as="h2">Crew manifest</RuleHead>
        <Scroller label="Your characters">
          <table className="log">
            <thead>
              <tr>
                <th>
                  <span className="visually-hidden">Portrait</span>
                </th>
                <th>Name</th>
                <th>Token</th>
                <th>Contacts</th>
                <th>Map</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
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
                        label={cfg.standings.label}
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
                    <div className="btn-row btn-row--tight">
                      {!c.isMain && (
                        <form
                          action={setMainAction.bind(null, c.id)}
                          className="inline-form"
                        >
                          <Submit className="btn btn--quiet btn--micro">make main</Submit>
                        </form>
                      )}
                      {view.characters.length > 1 && (
                        <form
                          action={unlinkAction.bind(null, c.id)}
                          className="inline-form"
                        >
                          <Submit className="btn btn--quiet btn--micro btn--danger">
                            unlink
                          </Submit>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>

        <p className="btn-row pager">
          <a className="btn btn--primary" href="/auth/eve/link">
            Add character
          </a>
        </p>

        <p className="footnote">
          authGD owns the <code>{cfg.standings.label}</code> contact label on your
          characters: contacts under that label are managed automatically and may be
          added, changed, or removed.
        </p>
      </main>
    </>
  );
}
