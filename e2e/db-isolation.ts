import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { SYNTHETIC_APP_ENV, WORKTREE_ROOT } from "./env";

// "AUTHGDE2": separate from Vitest's whole-run AUTHGDLK and the application's
// two-int advisory keys. These locks exist only in the disposable test database.
export const RESET_LOCK_KEY = 0x4155544847444532n.toString();

export function assertDatabaseIsolationEnvironment(env: NodeJS.ProcessEnv) {
  const url = new URL(env.DATABASE_URL ?? "");
  if (
    env.E2E_DB_ISOLATION !== "1" ||
    env.E2E_MANAGED_WORKTREE !== WORKTREE_ROOT ||
    resolve(process.cwd()) !== WORKTREE_ROOT ||
    env.TEST_DATABASE_URL !== env.DATABASE_URL ||
    url.protocol !== "postgres:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.port ||
    url.username !== "authgd" ||
    url.password !== "authgd" ||
    !/^\/authgd_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    (env.SYNC_MODE !== "dry-run" &&
      !(env.SYNC_MODE === "live" && env.E2E_FLEET_INTEGRATIONS === "1"))
  )
    throw new Error("[e2e] database isolation requires an owned disposable test server");
  for (const [key, value] of Object.entries(SYNTHETIC_APP_ENV)) {
    if (env[key] !== value)
      throw new Error(`[e2e] database isolation requires synthetic ${key}`);
  }
  for (const suffix of [
    "",
    ".local",
    ".development",
    ".development.local",
    ".production",
    ".production.local",
    ".test",
    ".test.local",
  ]) {
    if (existsSync(join(WORKTREE_ROOT, `.env${suffix}`)))
      throw new Error("[e2e] database isolation refuses dotenv files");
  }
  return env.DATABASE_URL;
}

type ConnectCallback = (
  error: Error | undefined,
  client?: PoolClient,
  release?: (error?: Error | boolean) => void,
) => void;

/** Install only in the owned Next process, never in the test/reset process. */
export function installDatabaseIsolation(databaseUrl: string) {
  // pg Pool.query (callbacks) and Drizzle.transaction (promises) both acquire
  // through this public seam. Do not gate Client.query: doing so drops ownership
  // between BEGIN and COMMIT and can deadlock a reset against that transaction.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the original pool receiver.
  const connect = Pool.prototype.connect;
  const ownedPools = new WeakMap<Pool, { failure?: Error }>();
  async function acquire(pool: Pool): Promise<PoolClient> {
    if (pool.options.connectionString !== databaseUrl)
      throw new Error("[e2e] server pool does not use the owned test database");
    // createDb has no pool error listener. Own that harness-only channel before
    // checkout, without replacing an existing owner's reporting/recovery policy.
    if (!ownedPools.has(pool) && pool.listenerCount("error") === 0) {
      const state: { failure?: Error } = {};
      ownedPools.set(pool, state);
      pool.on("error", () => {
        if (state.failure) return;
        state.failure = new Error("[e2e] database isolation pool failed");
        // Closed diagnostics only: driver errors can include SQL or credentials.
        // Keep cleanup possible, but never admit another query or exit green.
        console.error(state.failure.message);
        process.exitCode = 1;
      });
    }
    const failure = ownedPools.get(pool)?.failure;
    if (failure) throw failure;
    return new Promise<PoolClient>((resolve, reject) => {
      // Attach admission ownership in pg's callback, not an await continuation
      // that would leave a new listener-free checkout interval.
      connect.call(pool, (error, client) => {
        if (error) reject(error);
        else void admit(pool, client!).then(resolve, reject);
      });
    });
  }
  async function admit(pool: Pool, client: PoolClient): Promise<PoolClient> {
    const release = client.release.bind(client);
    let returned = false;
    const returnToPool = (error?: Error | boolean) => {
      if (returned) return;
      returned = true;
      release(error);
    };
    // pg-pool has removed its idle listener, but the application has not yet
    // received this client. A transport error emits synchronously, before pg's
    // deferred query rejection; a promise catch alone cannot own that event.
    let admissionError: Error | undefined;
    const onAdmissionError = (error: Error) => {
      admissionError ??= error;
      returnToPool(true);
    };
    client.on("error", onAdmissionError);
    try {
      await client.query("SELECT pg_advisory_lock_shared($1)", [RESET_LOCK_KEY]);
      if (admissionError) throw admissionError;
    } catch (error) {
      returnToPool(true);
      throw admissionError ?? error;
    } finally {
      client.removeListener("error", onAdmissionError);
    }
    let released = false;
    client.release = (error?: Error | boolean) => {
      if (released) throw new Error("[e2e] pooled client released twice");
      released = true;
      if (error) return returnToPool(error);
      if (client.getTransactionStatus() !== "I") {
        // Never unlock a lease while its transaction still owns relation locks.
        // Closing the connection rolls it back and releases both atomically.
        returnToPool(true);
        throw new Error("[e2e] pooled client returned with an unsettled transaction");
      }
      // Pool.query removes its application error listener before release(). Own
      // this second gap until return, including the event + deferred rejection
      // pair from one socket failure. release stays void; report failure through
      // pg's normal pool error channel rather than silently losing it.
      let unlockSettled = false;
      const finishUnlock = (error?: Error) => {
        if (unlockSettled) return;
        unlockSettled = true;
        client.removeListener("error", onUnlockError);
        returnToPool(error ? true : undefined);
        if (error) pool.emit("error", error, client);
      };
      const onUnlockError = (error: Error) => finishUnlock(error);
      client.on("error", onUnlockError);
      try {
        void client.query("SELECT pg_advisory_unlock_shared($1)", [RESET_LOCK_KEY]).then(
          () => finishUnlock(),
          (error: Error) => finishUnlock(error),
        );
      } catch (error) {
        finishUnlock(error as Error);
      }
    };
    return client;
  }
  Pool.prototype.connect = function (this: Pool, callback?: ConnectCallback) {
    const pending = acquire(this);
    if (!callback) return pending;
    void pending.then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error: Error) => callback(error),
    );
  } as typeof Pool.prototype.connect;
}
