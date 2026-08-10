"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { character } from "@/db/schema";
import { accountErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { setMainCharacter, unlinkCharacter, wakeSelf } from "@/services/accounts";
import { unlinkDiscord } from "@/services/discord-link";
import { getSessionAccount } from "@/services/session";

/** `setMainAction`/`unlinkAction`'s one bound argument. Neither action reads
 *  any FormData at all — `account/page.tsx` renders zero named controls — but
 *  a bound server-action argument is still caller input on the wire, not
 *  trusted state, so it is parsed rather than cast. Unreachable from the
 *  rendered page with anything but a real character id, so a bad value throws
 *  rather than earning notice copy — the same posture the admin actions take
 *  on their own unreachable inputs (`access-lists/actions.ts`'s `parseId`,
 *  `sync/actions.ts`'s `jobTypeSchema`). Both callers parse AFTER
 *  `requireAccount()`, not before — same order those two siblings use — so a
 *  caller who is not signed in gets `requireAccount`'s own redirect regardless
 *  of what they sent, rather than a thrown validation error telling an
 *  unauthenticated request whether its argument even had the right shape. */
const characterIdSchema = z.number().int().positive({ error: "invalid_character_id" });

function parseCharacterId(value: number): number {
  const parsed = characterIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid_character_id");
  return parsed.data;
}

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
  characterId = parseCharacterId(characterId);
  const result = await getDb().transaction((dbtx) =>
    setMainCharacter(dbtx, accountId, accountId, characterId),
  );
  if (!result.ok) {
    // The character list can go stale between render and click: a transfer
    // reclaim (background token-health job) can pull this character off the
    // account first. That is a race the member just needs a fresh render for,
    // not a bug worth an error boundary.
    redirect(accountErrorUrl("stale_character"));
  }
  revalidatePath("/account");
  // `redirect` rather than a bare return: the button that was pressed
  // unmounts the instant this succeeds (the row that was "make main" becomes
  // the main row), so the press otherwise lands with no confirmation and
  // focus stranded on `<body>` — see `@/app/_components/confirm-notice`. `at`
  // is what makes the *second* press of a different character's "make main"
  // land, same reasoning as `admin/sync`'s `queuedNotice`: `ConfirmNotice`
  // moves focus to the notice on every `at` change rather than relying on a
  // live region (it renders `live={false}` deliberately — see its docblock),
  // and without `at` in its dependency list only the FIRST press would move
  // focus.
  redirect(`/account?done=main&name=${encodeURIComponent(result.name)}&at=${Date.now()}`);
}

export async function unlinkAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  characterId = parseCharacterId(characterId);
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
  const result = await db.transaction((dbtx) =>
    // A last_character / not_owned rejection is a silent no-op here: the page
    // hides the unlink control for the final character, and a reclaim race
    // resolves itself on the revalidated render.
    unlinkCharacter(dbtx, cfg, accountId, characterId, {
      expectedAccountId: accountId,
    }),
  );
  revalidatePath("/account");
  // Confirmation only on a genuine unlink: a lost race (`result.ok === false`)
  // did nothing this press, and claiming "Character unlinked" over a no-op
  // would tell the member something that isn't true. The plain redirect below
  // still lands them on the revalidated page, silently, matching the no-op
  // reasoning above.
  redirect(result.ok ? `/account?done=unlink&at=${Date.now()}` : "/account");
}

/** Member self-serve: leave cryo. Only ever moves the caller's own account,
 * and only in this direction — see `wakeSelf`'s own doc comment for why a
 * member freezing themselves would be a policy bypass rather than a feature. */
export async function wakeSelfAction(): Promise<void> {
  const accountId = await requireAccount();
  const result = await getDb().transaction((dbtx) => wakeSelf(dbtx, accountId));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/account");
  redirect(`/account?done=wake&at=${Date.now()}`);
}

/** Member self-serve: disconnect Discord. Only ever the caller's own account,
 *  so `actor` and the target are the same id.
 *
 *  Both failures are a silent no-op. The control renders only when the account
 *  IS linked, so `not_linked` means a second submit or another tab got there
 *  first, and `not_found` cannot be reached by a member holding a live session
 *  for that very account. Same reasoning as `unlinkAction`'s rejections. */
export async function unlinkDiscordAction(): Promise<void> {
  const accountId = await requireAccount();
  const result = await getDb().transaction((dbtx) =>
    unlinkDiscord(dbtx, accountId, accountId, "self"),
  );
  revalidatePath("/account");
  // Same "don't confirm a no-op" rule as unlinkAction: a lost race reports
  // nothing rather than claiming a press that didn't do anything.
  redirect(result.ok ? `/account?done=discord&at=${Date.now()}` : "/account");
}
