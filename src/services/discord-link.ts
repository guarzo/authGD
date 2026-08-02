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
): Promise<{ ok: true } | { ok: false; error: "already_linked" }> {
  // Lock the account row first: concurrent replacements for one account
  // serialize here, so every intermediate discord user gets its deprovision
  // event (the second replacement reads the first one's committed row).
  await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
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
      .values({ accountId, discordUserId })
      .onConflictDoUpdate({
        target: discordLink.accountId,
        set: { discordUserId, linkedAt: new Date() },
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
