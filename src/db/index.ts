import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * `max` is capped deliberately. node-postgres defaults to 10 per pool, and this
 * app opens one per web machine plus worker and pg-boss against one small
 * Postgres — four at web=2 — so the default allows ~30 backends at 10-25MB RSS
 * each. That exhausted a 256MB database machine on the first production
 * deploy and crashlooped the worker. Members number in the tens, not
 * thousands; 5 is ample.
 *
 * `connectionTimeoutMillis` covers both the TCP connect and the wait for a free
 * pooled client. Without it, a database that is up but slow — max_connections
 * reached, or a long lock — leaves callers queued forever. The health endpoints
 * would then hang instead of returning their documented 503 with `db: "error"`,
 * losing that signal in exactly the incident that is hardest to diagnose by
 * hand. 5s sits below the Fly check's 10s timeout so the app's own structured
 * answer arrives before the proxy gives up on it.
 *
 * No global `statement_timeout` on purpose: src/db/migrate.ts builds its pool
 * through this same function, and a migration or a Wanderer reconcile can
 * legitimately run long. Bounding those belongs at the call site, not here.
 */
export function createDb(url: string, max = 5) {
  const pool = new Pool({ connectionString: url, max, connectionTimeoutMillis: 5000 });

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
