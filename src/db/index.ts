import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url });
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
