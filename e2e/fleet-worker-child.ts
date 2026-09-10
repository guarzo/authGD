import PgBoss from "pg-boss";
import { createDb } from "../src/db";
import { loadConfig } from "../src/config";
import { buildJobHandlers } from "../src/worker/handlers";
import { startDispatcher } from "../src/worker/dispatcher";
import { QUEUES } from "../src/worker/queues";
import {
  createFleetSourceOwner,
  startFleetSourceScheduler,
} from "../src/worker/fleet-source-scheduler";
import {
  cleanupFleetSources,
  reserveDueFleetSources,
} from "../src/services/fleet-source-maintenance";
import { createEsiClient } from "../src/lib/esi/client";
import { createDiscordClient } from "../src/lib/discord/rest";
import { createWandererClient } from "../src/lib/wanderer/client";

// The launcher supplies a precompiled --import guard BEFORE any of these imports.
// Construct other handler dependencies, but register/dispatch ONLY fleet-source.
const cfg = loadConfig(process.env);
const { db, pool } = createDb(cfg.databaseUrl);
const boss = new PgBoss({ connectionString: cfg.databaseUrl });
const owner = createFleetSourceOwner();
let stopDispatch: (() => Promise<void>) | undefined;
let stopScheduler: (() => Promise<void>) | undefined;
let closing: Promise<void> | undefined;
let failed = false;
let starting: Promise<void> = Promise.resolve();
boss.on("error", () => {
  failed = true;
});
async function close() {
  if (closing) return closing;
  closing = (async () => {
    owner.stopAdmission();
    await starting;
    const failures: unknown[] = [];
    for (const dispose of [
      async () => {
        await stopScheduler?.();
      },
      async () => {
        await stopDispatch?.();
      },
      async () => {
        await boss.offWork(QUEUES.fleetSource);
      },
      async () => {
        await owner.drain();
      },
      async () => {
        await boss.stop({ graceful: true, wait: true });
      },
      async () => {
        await pool.end();
      },
    ]) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    process.exitCode = failed || failures.length ? 1 : 0;
    process.disconnect?.();
  })();
  return closing;
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
process.on("disconnect", () => {
  void close();
});
async function main() {
  const esi = createEsiClient();
  const handlers = buildJobHandlers({
    db,
    cfg,
    esi,
    discord: createDiscordClient(cfg),
    wanderer: createWandererClient(cfg),
    fleetSource: { signal: owner.signal, esi },
  });
  await boss.start();
  if (closing) return;
  const options = {
    name: QUEUES.fleetSource,
    policy: "short" as const,
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 30,
    retentionMinutes: 1,
  };
  await boss.createQueue(QUEUES.fleetSource, options);
  await boss.updateQueue(QUEUES.fleetSource, options);
  if ((await boss.getQueue(QUEUES.fleetSource))?.deadLetter)
    throw new Error("unexpected dead letter");
  if (closing) return;
  const handler = owner.wrap(handlers[QUEUES.fleetSource]);
  await boss.work(QUEUES.fleetSource, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) await handler(job.data);
  });
  if (closing) return;
  stopDispatch = startDispatcher(
    db,
    (queue, data, options) => boss.send(queue, data, options),
    500,
    "fleet-source",
  );
  stopScheduler = startFleetSourceScheduler(async () => {
    await cleanupFleetSources(db);
    await reserveDueFleetSources(db);
  });
  process.send?.({ ready: true });
}
starting = main().catch(() => {
  failed = true;
});
void starting.then(async () => {
  if (failed) await close();
});
