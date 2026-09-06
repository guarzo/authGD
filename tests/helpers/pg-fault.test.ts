import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withInjectedPgFault } from "./pg-fault";

/**
 * `withInjectedPgFault` against a fake pool whose `connect()` always hands
 * back the SAME client object -- standing in for node-postgres actually
 * reusing one physical connection across checkouts (its whole reason to
 * exist), which is exactly the scenario the fix below protects: restoring
 * ONLY `pool.connect` in the `finally` leaves every checked-out CLIENT's own
 * `query` method still wrapped once this helper returns.
 */
function makeFakePool() {
  const client = {
    query: vi.fn(async (..._args: unknown[]) => ({ rows: [] })),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, client };
}

describe("withInjectedPgFault", () => {
  it("restores the checked-out client's own query method, not only pool.connect, when the fault is never triggered", async () => {
    const { pool, client } = makeFakePool();

    await withInjectedPgFault(
      pool,
      { matchSql: /^\s*select/i, code: "40P01" },
      async () => {
        // Checked out and wrapped, but the code under test never happens to
        // issue a query matching `matchSql` on it this time -- `faulted`
        // stays false.
        await pool.connect();
      },
    );

    // A later, unrelated caller reusing the SAME pooled connection (this
    // repo's tests all share one pool) must see its ORIGINAL query method,
    // not a fault still armed for the next query that happens to match.
    await expect(client.query("select 1")).resolves.toEqual({ rows: [] });
  });

  it("faults exactly the first matching query during fn(), and lets every other query through, including on the same connection", async () => {
    const { pool } = makeFakePool();

    const result = await withInjectedPgFault(
      pool,
      { matchSql: /^\s*select/i, code: "40P01" },
      async () => {
        const client = await pool.connect();
        await expect(client.query("select 1")).rejects.toMatchObject({
          code: "40P01",
        });
        // A second matching query on the SAME connection, after the fault
        // already fired once, must go through untouched.
        await expect(client.query("select 2")).resolves.toEqual({ rows: [] });
        return "done";
      },
    );
    expect(result).toBe("done");
  });

  it("never faults a query that does not match matchSql", async () => {
    const { pool } = makeFakePool();

    await withInjectedPgFault(
      pool,
      { matchSql: /^\s*select/i, code: "40P01" },
      async () => {
        const client = await pool.connect();
        await expect(client.query("update foo set bar = 1")).resolves.toEqual({
          rows: [],
        });
      },
    );
  });
});
