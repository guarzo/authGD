import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { loadConfig, type Config } from "@/config";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  wandererAclObservation,
} from "@/db/schema";
import { getAccountView } from "@/services/account-view";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    ...process.env,
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "http://localhost:3000",
    ALLIANCE_ID: "99000001",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_MAP_SLUG: "m",
    WANDERER_ACL_ID: "a",
  } as NodeJS.ProcessEnv);
});
beforeEach(() =>
  ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, contact_sync_state,
      wanderer_acl_observation RESTART IDENTITY CASCADE
  `),
);
afterAll(() => ctx.cleanup());

describe("getAccountView", () => {
  it("assembles characters with token, sync, and map state", async () => {
    // account.main_character_id has a deferred composite FK onto
    // character(id, account_id); it isn't checked until COMMIT, so both
    // inserts must share one explicit transaction (the account row can't
    // reference a character that doesn't exist yet outside of that).
    const acc = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(account)
        .values({ tier: "flygd", mainCharacterId: 1001 })
        .returning();
      await tx.insert(character).values([
        {
          id: 1001,
          accountId: row.id,
          name: "Main",
          ownerHash: "o1",
          scopes: [
            "esi-characters.read_contacts.v1",
            "esi-characters.write_contacts.v1",
          ],
          tokenStatus: "valid",
        },
        {
          id: 1002,
          accountId: row.id,
          name: "Alt",
          ownerHash: "o1",
          scopes: ["esi-characters.read_contacts.v1"], // missing write scope
          tokenStatus: "valid",
        },
      ]);
      return row;
    });
    await ctx.db.insert(discordLink).values({ accountId: acc.id, discordUserId: "d1" });
    await ctx.db.insert(contactSyncState).values({
      characterId: 1002,
      lastResult: "missing_label",
    });
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 1001,
      role: "member",
      observedAt: new Date(),
    });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.tier).toBe("flygd");
    expect(view.discordLinked).toBe(true);

    const main = view.characters.find((c) => c.id === 1001)!;
    expect(main.isMain).toBe(true);
    expect(main.needsReauthForScopes).toBe(false);
    expect(main.onMapAcl).toBe(true);

    const alt = view.characters.find((c) => c.id === 1002)!;
    expect(alt.needsReauthForScopes).toBe(true);
    expect(alt.contactSyncResult).toBe("missing_label");
    expect(alt.onMapAcl).toBe(false);
  });

  it("handles an account with no characters and no discord link", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.characters).toEqual([]);
    expect(view.discordLinked).toBe(false);
  });
});
