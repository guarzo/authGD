// Real socket failure at a held private-query boundary. No emitted fake errors,
// driver-error logging or client error listener that could mask the regression.
import assert from "node:assert/strict";
import process from "node:process";
import { setImmediate } from "node:timers/promises";
import { Client, Pool } from "pg";

const mode = process.argv[2];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const send = (event, fields = {}) => process.send?.({ event, ...fields });
const transportError = new Error("owned test socket disconnected");
let failedClient, ended, active;
let releases = 0,
  removals = 0,
  errors = 0,
  acquisitionFailures = 0;
let notify;
const notification = new Promise((resolve) => {
  notify = resolve;
});
pool.on("error", (error, client) => {
  errors++;
  assert.equal(error, transportError);
  assert.equal(client, failedClient);
  send("pool-error");
  notify();
});
pool.on("release", (_error, client) => {
  if (client === failedClient) releases++;
});
pool.on("remove", (client) => {
  if (client === failedClient) removals++;
});
process.on("uncaughtExceptionMonitor", (_error, origin) => {
  send(origin === "unhandledRejection" ? "unhandled-rejection" : "uncaught-client-event");
});
process.on("message", (message) => {
  if (message === "break-transport") {
    // This reference came from THIS pool's real query. Never select a backend
    // by database-wide discovery or terminate somebody else's connection.
    failedClient.connection.stream.destroy(transportError);
    send("transport-destroyed");
  }
});
const originalQuery = Client.prototype.query;
Client.prototype.query = function (...args) {
  const target =
    mode === "unlock"
      ? "SELECT pg_advisory_unlock_shared($1)"
      : "SELECT pg_advisory_lock_shared($1)";
  if (args[0] !== target || failedClient) return Reflect.apply(originalQuery, this, args);
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- Retain the exact owned driver receiver for the later IPC-triggered socket failure.
  failedClient = this;
  // Unlike events.once(client, 'end'), this does NOT add an error listener.
  ended = new Promise((resolve) => this.once("end", resolve));
  if (mode === "unlock") {
    // Send the actual unlock, but hold its incoming reply at the TCP socket.
    // The driver promise remains pending inside release's private interval.
    this.connection.stream.pause();
  }
  const result = Reflect.apply(originalQuery, this, args);
  send("private-query", { pid: this.processID });
  return result;
};

try {
  if (mode === "unlock") {
    active = await pool.connect();
    assert.equal(
      active.listenerCount("error"),
      0,
      "admission listener removed at handoff",
    );
    await active.query("SELECT count(*) FROM account");
    const client = active;
    active = undefined;
    assert.equal(client.release(), undefined, "release stays void");
    send("release-void");
    await notification;
  } else {
    const admission =
      mode === "admission-callback"
        ? new Promise((resolve, reject) => {
            pool.connect((error, client) => {
              if (error) reject(error);
              else resolve(client);
            });
          })
        : pool.connect();
    await admission.then(
      (client) => {
        client.release();
        throw new Error("broken transport was admitted");
      },
      (error) => {
        assert.equal(error, transportError);
        acquisitionFailures++;
        send("acquisition-failed");
      },
    );
  }
  await ended;
  await setImmediate(); // Flush deferred pg rejections before counting notification/release.
  assert.equal(releases, 1, "failed client returned/destroyed exactly once");
  assert.equal(removals, 1, "failed client removed exactly once");
  assert.equal(errors, mode === "unlock" ? 1 : 0);
  assert.equal(acquisitionFailures, mode === "unlock" ? 0 : 1);
  assert.equal(
    failedClient.listenerCount("error"),
    1,
    "only pg-pool's return listener remains",
  );
  active = await pool.connect();
  assert.notEqual(active, failedClient);
  assert.equal(active.listenerCount("error"), 0, "no temporary admission listener leaks");
  await active.query("SELECT count(*) FROM account");
  const fresh = active;
  active = undefined;
  fresh.release();
  await pool.end();
  assert.equal(fresh.listenerCount("error"), 1, "only pg-pool's return listener remains");
  assert.equal(pool.totalCount, 0);
  assert.equal(errors, mode === "unlock" ? 1 : 0);
  send("done");
} catch {
  send("probe-failed");
  process.exitCode = 1;
} finally {
  if (active) active.release(true);
  if (!pool.ending) await pool.end();
  process.disconnect();
}
