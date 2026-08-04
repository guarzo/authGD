import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db";
import { account, character, session } from "../src/db/schema";
import { BASE_URL, TEST_DATABASE_URL } from "./env";

export function testDb() {
  return createDb(TEST_DATABASE_URL);
}

export async function resetDb(db: ReturnType<typeof testDb>["db"]) {
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log, payout_operation, loot_pool,
      loot_item, payout_participant, payout_payment RESTART IDENTITY CASCADE
  `);
}

let nextCharId = 90_000_001;

export async function seedMember(
  db: ReturnType<typeof testDb>["db"],
  opts: {
    name: string;
    tier?: "flygd" | "blue" | "green";
    tierLocked?: boolean;
    status?: "active" | "cryo";
    isAdmin?: boolean;
    alts?: string[];
  },
) {
  const mainId = nextCharId++;
  // account.main_character_id's composite FK is DEFERRED — checked at COMMIT —
  // so the account and its main character MUST insert in one transaction
  // (see tests/account-view.test.ts for the same pattern).
  return db.transaction(async (tx) => {
    const [acc] = await tx
      .insert(account)
      .values({
        tier: opts.tier ?? "green",
        tierLocked: opts.tierLocked ?? false,
        status: opts.status ?? "active",
        isAdmin: opts.isAdmin ?? false,
        mainCharacterId: mainId,
      })
      .returning();
    await tx.insert(character).values({
      id: mainId,
      accountId: acc.id,
      name: opts.name,
      ownerHash: `oh-${mainId}`,
      scopes: [],
    });
    for (const altName of opts.alts ?? []) {
      const altId = nextCharId++;
      await tx.insert(character).values({
        id: altId,
        accountId: acc.id,
        name: altName,
        ownerHash: `oh-${altId}`,
        scopes: [],
      });
    }
    return acc;
  });
}

/** Mirrors src/services/session.ts: cookie carries the raw id, DB its sha256. */
export async function sessionCookieFor(
  db: ReturnType<typeof testDb>["db"],
  accountId: string,
) {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(session).values({
    id: createHash("sha256").update(raw).digest("base64url"),
    accountId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { name: "authgd_session", value: raw, url: BASE_URL };
}
