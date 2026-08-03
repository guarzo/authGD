import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAccountView } from "@/services/account-view";
import { getSessionAccount } from "@/services/session";
import { setMainAction, unlinkAction } from "./actions";

// Reads the session cookie and hits the DB on every request; getConfig() also
// requires env vars that aren't present at build time, so this route must
// never be statically prerendered.
export const dynamic = "force-dynamic";

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

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Your account</h1>
      {view.isAdmin && (
        <p>
          <a href="/admin/accounts">Admin →</a>
        </p>
      )}
      {error === "already_linked" && (
        <p role="alert">That character is already linked to another account.</p>
      )}
      {error === "discord_already_linked" && (
        <p role="alert">That Discord account is already linked to another account.</p>
      )}
      {error === "discord_denied" && (
        <p role="alert">Discord authorization was cancelled.</p>
      )}
      <p>
        Tier: <strong>{view.tier}</strong>
        {view.status === "cryo" && " · cryo"}
      </p>
      <p>
        Discord:{" "}
        {view.discordLinked ? "linked" : <a href="/auth/discord/link">Link Discord</a>}
      </p>
      <h2>Characters</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Token</th>
            <th>Contacts</th>
            <th>Map</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {view.characters.map((c) => (
            <tr key={c.id}>
              <td>
                <img
                  src={`https://images.evetech.net/characters/${c.id}/portrait?size=64`}
                  alt=""
                  width={32}
                  height={32}
                />
              </td>
              <td>
                {c.name} {c.isMain && <strong>(main)</strong>}
              </td>
              <td>
                {c.tokenStatus === "valid" && !c.needsReauthForScopes && "ok"}
                {(c.tokenStatus !== "valid" || c.needsReauthForScopes) && (
                  <a href="/auth/eve/link">re-auth needed</a>
                )}
              </td>
              <td>
                {c.contactSyncResult === "missing_label"
                  ? `Create a contact label named "${cfg.standings.label}" in-game, then re-sync.`
                  : (c.contactSyncResult ?? "—")}
              </td>
              <td>{c.onMapAcl ? "✓" : "✗"}</td>
              <td>
                {!c.isMain && (
                  <form
                    action={setMainAction.bind(null, c.id)}
                    style={{ display: "inline" }}
                  >
                    <button type="submit">make main</button>
                  </form>
                )}
                {view.characters.length > 1 && (
                  <form
                    action={unlinkAction.bind(null, c.id)}
                    style={{ display: "inline" }}
                  >
                    <button type="submit">unlink</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <a href="/auth/eve/link">Add character</a>
      </p>
      <p style={{ fontSize: "0.85em", opacity: 0.8 }}>
        authGD owns the <code>{cfg.standings.label}</code> contact label on your
        characters: contacts under that label are managed automatically and may be added,
        changed, or removed.
      </p>
    </main>
  );
}
