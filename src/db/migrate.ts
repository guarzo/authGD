import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index";

// wrapped in main(): tsx compiles this entry as CJS, which forbids top-level await
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: "drizzle" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
