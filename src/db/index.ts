import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * `max` is capped deliberately. node-postgres defaults to 10 per pool, and this
 * app opens three of them against one small Postgres — web, worker, and pg-boss
 * — so the default allows ~30 backends at 10-25MB RSS each. That exhausted a
 * 256MB database machine on the first production deploy and crashlooped the
 * worker. Members number in the tens, not thousands; 5 is ample.
 */
export function createDb(url: string, max = 5) {
  const pool = new Pool({ connectionString: url, max });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
/** A live transaction handle. Identity mutations REQUIRE this (locks + deferred FK). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either a pool client or a transaction — fine for reads and independent writes. */
export type Dbx = Db | DbTx;

let cached: ReturnType<typeof createDb> | undefined;
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    cached = createDb(url);
  }
  return cached.db;
}
