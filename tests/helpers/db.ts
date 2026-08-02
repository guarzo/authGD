import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@/db";

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://authgd:authgd@localhost:5433/authgd_test";

export async function setupTestDb() {
  const { db, pool } = createDb(TEST_URL);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
  return { db, pool, cleanup: () => pool.end() };
}
