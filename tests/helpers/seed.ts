import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, character, discordLink } from "@/db/schema";
import { encryptToken } from "@/lib/crypto";

export async function seedAccount(
  db: Db,
  opts: {
    tier?: "flygd" | "blue" | "green";
    tierLocked?: boolean;
    discordUserId?: string;
  } = {},
) {
  const [acc] = await db
    .insert(account)
    .values({ tier: opts.tier ?? "green", tierLocked: opts.tierLocked ?? false })
    .returning();
  if (opts.discordUserId) {
    await db
      .insert(discordLink)
      .values({ accountId: acc.id, discordUserId: opts.discordUserId });
  }
  return acc;
}

export async function seedCharacter(
  db: Db,
  cfg: Config,
  opts: {
    id: number;
    accountId: string;
    name?: string;
    ownerHash?: string;
    /** null → no stored token; otherwise encrypted with the test key. */
    refreshToken?: string | null;
    scopes?: string[];
    tokenStatus?: "valid" | "invalid" | "needs_reauth" | "missing";
    /** Also set as the account's main character. */
    main?: boolean;
    allianceId?: number | null;
    affiliationInvalid?: boolean;
  },
) {
  const [ch] = await db
    .insert(character)
    .values({
      id: opts.id,
      accountId: opts.accountId,
      name: opts.name ?? `Char ${opts.id}`,
      ownerHash: opts.ownerHash ?? `oh-${opts.id}`,
      refreshTokenEnc:
        opts.refreshToken === null
          ? null
          : encryptToken(opts.refreshToken ?? "refresh", cfg.tokenEncryptionKey),
      scopes: opts.scopes ?? [...cfg.eveSso.scopes],
      tokenStatus: opts.tokenStatus ?? "valid",
      allianceId: opts.allianceId ?? null,
      affiliationInvalid: opts.affiliationInvalid ?? false,
    })
    .returning();
  if (opts.main) {
    await db
      .update(account)
      .set({ mainCharacterId: opts.id })
      .where(eq(account.id, opts.accountId));
  }
  return ch;
}
