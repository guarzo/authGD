"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { character } from "@/db/schema";
import { setMainCharacter, unlinkCharacter, wakeSelf } from "@/services/accounts";
import { getSessionAccount } from "@/services/session";

async function requireAccount(): Promise<string> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) throw new Error("not signed in");
  const sess = await getSessionAccount(getDb(), sid);
  if (!sess) throw new Error("not signed in");
  return sess.accountId;
}

export async function setMainAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  const result = await getDb().transaction((dbtx) =>
    setMainCharacter(dbtx, accountId, characterId),
  );
  if (!result.ok) throw new Error("character not on account");
  revalidatePath("/account");
}

export async function unlinkAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  const db = getDb();
  const cfg = getConfig();
  await db.transaction(async (dbtx) => {
    // members may only unlink their own characters
    const owned = await dbtx
      .select()
      .from(character)
      .where(and(eq(character.id, characterId), eq(character.accountId, accountId)));
    if (owned.length === 0) throw new Error("not your character");
    // In-lock check in unlinkCharacter is the authority against a
    // transfer-reclaim racing between this pre-check and the row lock.
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
