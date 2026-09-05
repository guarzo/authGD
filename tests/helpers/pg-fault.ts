import type { Pool, PoolClient } from "pg";

/**
 * Monkeypatches `pool.connect` for exactly ONE checkout so the first query
 * matching `matchSql` on that connection rejects with a synthetic error
 * carrying Postgres's own SQLSTATE shape (`err.code`) -- reproducing what a
 * genuine deadlock/serialization failure looks like to node-postgres,
 * without needing to actually force one (impossible to force organically
 * through the fleet-relay public API once every path locks characters in
 * the same ascending order -- exactly the property that fix establishes).
 * Restores `pool.connect` immediately after the one faulted checkout, so
 * later queries in the same test (assertions against the shared test db
 * connection) are unaffected.
 */
export async function withInjectedPgFault<T>(
  pool: Pool,
  opts: { matchSql: RegExp; code: string },
  fn: () => Promise<T>,
): Promise<T> {
  const origConnect = pool.connect.bind(pool);
  let faulted = false;
  (pool as unknown as { connect: typeof pool.connect }).connect = (async (
    ...args: unknown[]
  ) => {
    const client = await (origConnect as (...a: unknown[]) => Promise<PoolClient>)(
      ...args,
    );
    const origQuery = client.query.bind(client);
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
  }
}
