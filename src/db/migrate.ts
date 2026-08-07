import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index";

// wrapped in main(): tsx compiles this entry as CJS, which forbids top-level await
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  // Single connection: migrations are strictly sequential, and this runs as the
  // Fly release command while web and worker still hold their own pools.
  const { db, pool } = createDb(url, 1);
  // drizzle's migrate() wraps the whole pending batch in ONE transaction and
  // writes each bookkeeping row inside it, so a failed deploy rolls back schema
  // and bookkeeping together and the retry is always safe. That coupling is the
  // reason this stays the stock helper: it also means CREATE INDEX CONCURRENTLY
  // cannot run here. Decided against a custom runner — see docs/ops.md,
  // "Migrations run in one transaction — deliberately", for the revisit
  // triggers and the out-of-band procedure if you need a concurrent build.
  await migrate(db, { migrationsFolder: "drizzle" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
