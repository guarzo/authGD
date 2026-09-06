import type { Pool, PoolClient } from "pg";

/**
 * Monkeypatches `pool.connect` for exactly ONE checkout so the first query
 * matching `matchSql` on that connection rejects with a synthetic error
 * carrying Postgres's own SQLSTATE shape (`err.code`) -- reproducing what a
 * genuine deadlock/serialization failure looks like to node-postgres,
 * without needing to actually force one (impossible to force organically
 * through the fleet-relay public API once every path locks characters in
 * the same ascending order -- exactly the property that fix establishes).
 *
 * Restores `pool.connect` AND every checked-out client's own `query` method
 * once `fn()` settles -- not only the former. Every checkout during `fn()`
 * receives a wrapped `query`, and only the FIRST matching query across all
 * of them ever faults (the shared `faulted` flag); a checkout whose query
 * never happens to match keeps its wrapper armed for as long as the client
 * object survives, and node-postgres pools (reuses) that same physical
 * connection afterward. Left unrestored, a later, unrelated caller reusing
 * that pooled connection can trip the exact same regex (both call sites
 * today use the broad `/^\s*select/i`) and fail with a spurious SQLSTATE
 * that has nothing to do with whatever it was actually running.
 */
export async function withInjectedPgFault<T>(
  pool: Pool,
  opts: { matchSql: RegExp; code: string },
  fn: () => Promise<T>,
): Promise<T> {
  const origConnect = pool.connect.bind(pool);
  let faulted = false;
  const restoreClientQueries: Array<() => void> = [];
  (pool as unknown as { connect: typeof pool.connect }).connect = (async (
    ...args: unknown[]
  ) => {
    const client = await (origConnect as (...a: unknown[]) => Promise<PoolClient>)(
      ...args,
    );
    const origQuery = client.query.bind(client);
    restoreClientQueries.push(() => {
      (client as unknown as { query: typeof client.query }).query = origQuery;
    });
    (client as unknown as { query: typeof client.query }).query = ((
      ...qargs: unknown[]
    ) => {
      const first = qargs[0];
      const text = typeof first === "string" ? first : (first as { text?: string })?.text;
      if (!faulted && text && opts.matchSql.test(text)) {
        faulted = true;
        const err = new Error("synthetic injected pg fault") as Error & { code: string };
        err.code = opts.code;
        return Promise.reject(err);
      }
      return (origQuery as (...a: unknown[]) => unknown)(...qargs);
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  try {
    return await fn();
  } finally {
    (pool as unknown as { connect: typeof pool.connect }).connect = origConnect;
    for (const restore of restoreClientQueries) restore();
  }
}
