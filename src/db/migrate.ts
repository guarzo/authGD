import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index";

// wrapped in main(): tsx compiles this entry as CJS, which forbids top-level await
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  // Single connection: migrations are strictly sequential, and this runs as the
  // Fly release command while web and worker still hold their own pools.
  const { db, pool } = createDb(url, 1);
  await migrate(db, { migrationsFolder: "drizzle" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
