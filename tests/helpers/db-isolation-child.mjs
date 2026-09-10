// An actual pg owner in a separate process, with the same preload as Next.
import { once } from "node:events";
import process from "node:process";
import { createServer, get } from "node:http";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const send = (event) => process.send?.({ event });
const command = async () => (await once(process, "message"))[0];
let server;
try {
  const mode = process.argv[2];
  if (mode === "delayed") {
    let complete, fail;
    const work = new Promise((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    server = createServer((_request, response) => {
      response.once("close", () => send("response-closed"));
      response.end();
      void (async () => {
        await command();
        send("checkout-start");
        await pool.query("SELECT count(*) FROM account");
      })().then(complete, fail);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${server.address().port}`, { agent: false }, (response) => {
        response.resume();
        response.on("end", resolve);
      }).on("error", reject);
    });
    send("ready");
    await work;
  } else if (mode === "error") {
    await pool.query("SELECT 1 / 0").catch(() => send("query-failed"));
    await pool.query("SELECT count(*) FROM account");
  } else if (mode === "callback") {
    await new Promise((resolve, reject) => {
      pool.connect((error, client, release) => {
        if (error) return reject(error);
        client.query("SELECT count(*) FROM account", (error) => {
          release(error);
          if (error) reject(error);
          else resolve();
        });
      });
    });
  } else {
    const client = await pool.connect();
    if (mode === "transaction" || mode === "unsettled") await client.query("BEGIN");
    await client.query("SELECT count(*) FROM account");
    send("held");
    let queued;
    if (mode === "queued") {
      queued = pool.query("SELECT count(*) FROM session");
      send("queued");
    }
    await command();
    if (mode === "transaction") {
      // Reset is waiting now. This second query must still be admitted under
      // the SAME lease/transaction; a per-query gate deadlocks here.
      await client.query("SELECT count(*) FROM session");
      await client.query("COMMIT");
    }
    if (mode === "unsettled") {
      try {
        client.release();
        send("unsettled-accepted");
      } catch {
        send("unsettled-rejected");
      }
    } else client.release(mode === "destroy");
    await queued;
  }
  await pool.end();
  send("done");
} catch {
  // Do not forward driver errors, SQL, bind values or connection options.
  send("failed");
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  process.disconnect();
}
