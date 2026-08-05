import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { account, discordLink } from "@/db/schema";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

/** Drizzle may wrap the pg error; walk the cause chain for code 23505. */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === "object" && (cur as { code?: string }).code === "23505") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Thrown THROUGH the transaction so a concurrent uniqueness race rolls back
 * everything (including any old-link deletion + deprovision event). Callers
 * catch it OUTSIDE db.transaction() and map it to `already_linked`.
 */
export class DiscordLinkConflictError extends Error {
  constructor() {
    super("discord user already linked to another account");
  }
}

export async function linkDiscord(
  dbx: DbTx,
  accountId: string,
  discordUserId: string,
  /**
   * The @handle, from the same `/users/@me` response the caller already has.
   * Optional because it is decoration: the link is the snowflake, and every
   * reader tolerates a null name. `/users/@me` is not guild-scoped, so it
   * carries no `nick` — `displayName` stays null here and the roles job fills
   * it on the next cycle.
   */
  username?: string,
): Promise<{ ok: true } | { ok: false; error: "already_linked" }> {
  // Lock the account row first: concurrent replacements for one account
  // serialize here, so every intermediate discord user gets its deprovision
  // event (the second replacement reads the first one's committed row).
  await dbx.select().from(account).where(eq(account.id, accountId)).for("update");
  const existing = await dbx
    .select()
    .from(discordLink)
    .where(eq(discordLink.discordUserId, discordUserId));
  if (existing.length > 0 && existing[0].accountId !== accountId) {
    return { ok: false, error: "already_linked" };
  }
  // Upsert on our own account row; the unique(discord_user_id) index is the
  // cross-account race arbiter. Only after it succeeds do we emit side effects.
  const previous = await dbx
    .select()
    .from(discordLink)
    .where(eq(discordLink.accountId, accountId));
  const previousUserId =
    previous.length > 0 && previous[0].discordUserId !== discordUserId
      ? previous[0].discordUserId
      : null;
  try {
    await dbx
      .insert(discordLink)
      .values({ accountId, discordUserId, username: username ?? null })
      .onConflictDoUpdate({
        target: discordLink.accountId,
        // `displayName` is cleared rather than carried over. On a REPLACEMENT
        // it belonged to the Discord user being replaced, so keeping it would
        // label the new link with the old person's guild nickname — and this
        // path cannot tell the two cases apart without an extra read. Clearing
        // costs nothing: `/users/@me` has no `nick` to write here anyway, and
        // the `{kind:"account"}` enqueue below runs discord-roles for this
        // account, which refills it from the guild member payload.
        set: {
          discordUserId,
          username: username ?? null,
          displayName: null,
          linkedAt: new Date(),
        },
      });
  } catch (err) {
    // concurrent claim of the same discord user: abort the whole transaction
    if (isUniqueViolation(err)) throw new DiscordLinkConflictError();
    throw err;
  }
  if (previousUserId) {
    await logAudit(dbx, {
      actor: accountId,
      action: "discord.unlinked",
      target: previousUserId,
      details: { reason: "replaced" },
    });
    await enqueueSync(dbx, { kind: "discord-user", discordUserId: previousUserId });
  }
  await logAudit(dbx, {
    actor: accountId,
    action: "discord.linked",
    target: discordUserId,
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

/**
 * Remove an account's Discord link and leave it with none.
 *
 * The counterpart `linkDiscord` never had: its only `discord.unlinked` row is
 * the implicit one for a REPLACEMENT, so until now no path could end at zero
 * links. That gap is also why `merge_discord` had no remedy to name.
 *
 * Locks the account row first for the same reason `linkDiscord` does — a
 * concurrent link and unlink must serialize rather than interleave, or the
 * loser's deprovision can be written against a link the winner still owns.
 *
 * `enqueueSync` is not optional: the row deletion alone leaves the member
 * holding every managed Discord role. The deprovision handler
 * (src/jobs/discord-roles.ts) is written for exactly this payload and
 * re-checks for a link before stripping, so a re-link that lands mid-flight is
 * handled there rather than here.
 *
 * Deliberately does NOT enqueue `{kind:"account"}`. The replacement path does,
 * because it has a new Discord user to provision; an unlink has none, and
 * contacts and wanderer sync do not depend on Discord state.
 */
export async function unlinkDiscord(
  dbx: DbTx,
  actor: string,
  accountId: string,
  reason: "self" | "admin",
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_linked" }> {
  const locked = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  // The merge deletes accounts outright, so an admin's control can outlive the
  // row it targets. Same race ADMIN_ACCOUNTS_ERRORS.not_found already explains.
  if (locked.length === 0) return { ok: false, error: "not_found" };

  const [removed] = await dbx
    .delete(discordLink)
    .where(eq(discordLink.accountId, accountId))
    .returning();
  if (!removed) return { ok: false, error: "not_linked" };

  await logAudit(dbx, {
    actor,
    action: "discord.unlinked",
    target: removed.discordUserId,
    details: { reason },
  });
  await enqueueSync(dbx, {
    kind: "discord-user",
    discordUserId: removed.discordUserId,
  });
  return { ok: true };
}
