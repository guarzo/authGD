import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "@/db";
import { TRUNCATE_ALL_SQL } from "@/db/tables";

export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://authgd:authgd@localhost:5433/authgd_test";

/** Shared TRUNCATE used between tests. Table list lives in src/db/tables.ts. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql.raw(TRUNCATE_ALL_SQL));
}

export async function setupTestDb() {
  const { db, pool } = createDb(TEST_URL);
  await migrate(db, { migrationsFolder: "drizzle" });
  await truncateAll(db);
  return { db, pool, cleanup: () => pool.end() };
}
