import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, TEST_URL } from "./helpers/db";
import { assertNoSchemaDrift } from "./helpers/global-setup";

vi.mock("drizzle-orm/migrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm/migrator")>();
  return { ...actual, readMigrationFiles: vi.fn(actual.readMigrationFiles) };
});
const { readMigrationFiles } = await import("drizzle-orm/migrator");

/**
 * `tests/global-setup.test.ts` covers `findForeignMigrations` and
 * `buildSchemaDriftMessage` as pure functions, but everything gluing them
 * together — the literal SQL against `drizzle.__drizzle_migrations`, the
 * argument order passed to `findForeignMigrations` (swap it and this becomes
 * "detect a database merely behind", and every pure-function test above still
 * passes), and the two fail-open catches — has none of its own coverage. This
 * file drives `assertNoSchemaDrift` against a real connection to close that.
 */
describe("assertNoSchemaDrift", () => {
  const FOREIGN_HASH = "bogus-foreign-hash-test";
  let client: Client;

  // Every case here reads or writes `drizzle.__drizzle_migrations`, which only
  // exists once something has migrated. In a full run an alphabetically earlier
  // file happens to do that first; alone against a freshly created per-worktree
  // database, nothing has. Migrate explicitly rather than inherit the order.
  beforeAll(async () => {
    const { cleanup } = await setupTestDb();
    await cleanup();
  });

  afterEach(async () => {
    await client
      ?.query("DELETE FROM drizzle.__drizzle_migrations WHERE hash = $1", [FOREIGN_HASH])
      .catch(() => {});
    await client?.end().catch(() => {});
    vi.mocked(readMigrationFiles).mockRestore();
  });

  it("throws exactly one error naming the database when a foreign hash is present", async () => {
    client = new Client({ connectionString: TEST_URL });
    await client.connect();
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [FOREIGN_HASH, 9999999999999],
    );

    const url = new URL(TEST_URL);
    await expect(assertNoSchemaDrift(client, url)).rejects.toThrow(
      /migration\(s\) this checkout does not have/,
    );
  });

  it("stays quiet when the database matches the checkout's journal", async () => {
    client = new Client({ connectionString: TEST_URL });
    await client.connect();

    await expect(assertNoSchemaDrift(client, new URL(TEST_URL))).resolves.toBeUndefined();
  });

  it("falls open when the migration-history query fails", async () => {
    // A fake rather than a real disconnected client: the check must not
    // become the thing that decides Postgres is unreachable — whatever the
    // test itself does with the database reports that failure on its own.
    const brokenClient = {
      query: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    } as unknown as Client;

    await expect(
      assertNoSchemaDrift(brokenClient, new URL(TEST_URL)),
    ).resolves.toBeUndefined();
  });

  it("falls open when the migration journal can't be read", async () => {
    vi.mocked(readMigrationFiles).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory, scandir 'drizzle'");
    });
    client = new Client({ connectionString: TEST_URL });
    await client.connect();

    await expect(assertNoSchemaDrift(client, new URL(TEST_URL))).resolves.toBeUndefined();
  });
});
