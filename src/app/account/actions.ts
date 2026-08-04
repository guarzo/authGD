"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { character } from "@/db/schema";
import { accountErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { setMainCharacter, unlinkCharacter, wakeSelf } from "@/services/accounts";
import { getSessionAccount } from "@/services/session";

async function requireAccount(): Promise<string> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  // The session cookie can expire, or be cleared by a sign-out in another tab,
  // while this page is still open — the exact "alt-tabbed at 1am" session
  // PRODUCT.md describes. That is an expected end state, not a bug: send the
  // member back to sign in instead of throwing to the error boundary for it.
  if (!sess) redirect(loginErrorUrl("session_expired"));
  return sess.accountId;
}

export async function setMainAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  const result = await getDb().transaction((dbtx) =>
    setMainCharacter(dbtx, accountId, characterId),
  );
  if (!result.ok) {
    // The character list can go stale between render and click: a transfer
    // reclaim (background token-health job) can pull this character off the
    // account first. That is a race the member just needs a fresh render for,
    // not a bug worth an error boundary.
    redirect(accountErrorUrl("stale_character"));
  }
  revalidatePath("/account");
}

export async function unlinkAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  const db = getDb();
  const cfg = getConfig();
  // members may only unlink their own characters. This is a fast, non-locking
  // pre-check for a friendly error; the authoritative check against a
  // transfer-reclaim race is unlinkCharacter's `expectedAccountId` gate below.
  // Kept outside the transaction so the redirect() below (same race as
  // setMainAction's stale_character) doesn't fire from inside a live tx.
  const owned = await db
    .select()
    .from(character)
    .where(and(eq(character.id, characterId), eq(character.accountId, accountId)));
  if (owned.length === 0) redirect(accountErrorUrl("stale_character"));
  await db.transaction(async (dbtx) => {
    // A last_character / not_owned rejection is a silent no-op here: the page
    // hides the unlink control for the final character, and a reclaim race
    // resolves itself on the revalidated render.
    await unlinkCharacter(dbtx, cfg, accountId, characterId, {
      expectedAccountId: accountId,
    });
  });
  revalidatePath("/account");
}

/** Member self-serve: leave cryo. Only ever moves the caller's own account,
 * and only in this direction — see `wakeSelf`'s own doc comment for why a
 * member freezing themselves would be a policy bypass rather than a feature. */
export async function wakeSelfAction(): Promise<void> {
  const accountId = await requireAccount();
  const result = await getDb().transaction((dbtx) => wakeSelf(dbtx, accountId));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/account");
}
