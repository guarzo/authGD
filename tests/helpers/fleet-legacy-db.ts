import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { LOCK_KEY } from "./global-setup";
import type { PoolClient } from "pg";
import { WORKTREE_ROOT } from "../../e2e/env";
import { loadPreCombatFleet, pinnedSource, PRE_COMBAT_REVISION } from "./fleet-legacy";

/** No defaults, fallback database, provisioning, URL options or non-loopback
 * connection. A suffix distinguishes this disposable resource even if two URL
 * spellings (localhost/127.0.0.1 or encoded paths) address the same server. */
export function legacyFixtureUrls(env: Record<string, string | undefined>) {
  function parse(name: string) {
    const value = env[name];
    if (!value) throw new Error(`${name}_required`);
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.search ||
      url.hash ||
      url.username !== "authgd" ||
      !/^\/authgd_test_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error(`${name}_unsafe`);
    return url;
  }
  const main = parse("TEST_DATABASE_URL");
  const legacy = parse("FLEET_LEGACY_TEST_DATABASE_URL");
  if (main.pathname === legacy.pathname)
    throw new Error("legacy_fixture_must_be_distinct");
  const host = (url: URL) => (url.hostname === "localhost" ? "127.0.0.1" : url.hostname);
  if (
    host(main) !== host(legacy) ||
    main.port !== legacy.port ||
    legacy.pathname !== `${main.pathname}_legacy_migration`
  )
    throw new Error("legacy_fixture_not_owned_sibling");
  return { main: main.href, legacy: legacy.href };
}

/** Pure plan for the unit job's fresh owned service. Never reuse/drop an
 * existing database: CREATE's duplicate error must stop CI. */
export function legacyFixtureProvisionPlan(env: Record<string, string | undefined>) {
  if (env.CI !== "true" || env.GITHUB_ACTIONS !== "true")
    throw new Error("legacy_fixture_provision_ci_only");
  const urls = legacyFixtureUrls(env);
  const name = new URL(urls.legacy).pathname.slice(1);
  // The URL guard permits only ASCII identifier characters. PostgreSQL would
  // silently truncate an overlong quoted identifier to a different DB name.
  if (name.length > 63) throw new Error("legacy_fixture_identifier_too_long");
  return {
    connectionString: urls.main,
    sql: `CREATE DATABASE "${name}" OWNER authgd`,
  };
}

/** The existing old-reader test is the only caller. It gets pre-0025 schema,
 * metadata and backend code on the explicit separate DB, never a compatibility
 * path on current production. The same AUTHGDLK lock as global-setup owns this
 * fixture lane through migration, reset, concurrent assertions and cleanup. */
export async function withLegacyFleetFixture<T>(
  work: (
    ctx: ReturnType<Awaited<ReturnType<typeof loadPreCombatFleet>>["createDb"]>,
    historical: Awaited<ReturnType<typeof loadPreCombatFleet>>,
  ) => Promise<T>,
): Promise<T> {
  const urls = legacyFixtureUrls(process.env);
  const historical = await loadPreCombatFleet();
  const ctx = historical.createDb(urls.legacy);
  let lock: PoolClient | undefined;
  try {
    lock = await ctx.pool.connect();
    const acquired = await lock.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [LOCK_KEY.toString()],
    );
    if (!acquired.rows[0].locked) throw new Error("legacy_fixture_in_use");
    const root = join(WORKTREE_ROOT, "tmp/task-10");
    mkdirSync(root, { recursive: true });
    const folder = mkdtempSync(join(root, "legacy-migrations-"));
    mkdirSync(join(folder, "meta"));
    const rawJournal = pinnedSource(PRE_COMBAT_REVISION, "drizzle/meta/_journal.json");
    const journal = JSON.parse(rawJournal) as { entries: { tag: string }[] };
    writeFileSync(join(folder, "meta/_journal.json"), rawJournal);
    for (const entry of journal.entries)
      writeFileSync(
        join(folder, `${entry.tag}.sql`),
        pinnedSource(PRE_COMBAT_REVISION, `drizzle/${entry.tag}.sql`),
      );
    const expected = readMigrationFiles({ migrationsFolder: folder }).map((m) => m.hash);
    const present = await lock.query<{ table: string | null }>(
      "select to_regclass('drizzle.__drizzle_migrations') as table",
    );
    if (present.rows[0].table) {
      const applied = await lock.query<{ hash: string }>(
        "select hash from drizzle.__drizzle_migrations",
      );
      if (applied.rows.some((m) => !expected.includes(m.hash)))
        throw new Error("legacy_fixture_schema_ahead_or_foreign");
    }
    await migrate(ctx.db, { migrationsFolder: folder });
    const applied = await lock.query<{ hash: string }>(
      "select hash from drizzle.__drizzle_migrations order by created_at",
    );
    if (JSON.stringify(applied.rows.map((m) => m.hash)) !== JSON.stringify(expected))
      throw new Error("legacy_fixture_migration_mismatch");
    await lock.query(historical.TRUNCATE_ALL_SQL);
    return await work(ctx, historical);
  } finally {
    // Releasing the dedicated session releases its lock even on test failure.
    lock?.release(true);
    await ctx.pool.end();
  }
}
