import PgBoss from "pg-boss";
import { z } from "zod";
import { getConfig } from "@/config";
import { createDb } from "@/db";
import { createDiscordClient } from "@/lib/discord/rest";
import { createEsiClient } from "@/lib/esi/client";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { createWandererClient } from "@/lib/wanderer/client";
import { startDispatcher } from "@/worker/dispatcher";
import { buildJobHandlers } from "@/worker/handlers";
import { QUEUES, createQueues, scheduleJobs } from "@/worker/queues";

const deadLetterSchema = z.object({ jobType: z.string().optional() }).nullish();

async function main(): Promise<void> {
  const cfg = getConfig();
  const { db, pool } = createDb(cfg.databaseUrl);

  const boss = new PgBoss({ connectionString: cfg.databaseUrl });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await createQueues(boss);

  const handlers = buildJobHandlers({
    db,
    cfg,
    esi: createEsiClient(),
    wanderer: createWandererClient(cfg),
    discord: createDiscordClient(cfg),
  });
  // pg-boss v10 handlers receive an ARRAY of jobs.
  for (const [queue, handler] of Object.entries(handlers)) {
    await boss.work(queue, async ([job]) => handler(job.data));
  }

  // Ops alerting (spec: Error handling): a job landing here exhausted its
  // retries — post to the optional Discord ops webhook.
  await boss.work(QUEUES.deadLetter, async ([job]) => {
    const data = deadLetterSchema.parse(job.data);
    await postOpsWebhook(
      cfg,
      `authGD: job \`${data?.jobType ?? "unknown"}\` failed after final retry.`,
    );
  });

  await scheduleJobs(boss);
  const stopDispatcher = startDispatcher(db, (queue, data, options) =>
    boss.send(queue, data, options),
  );

  const shutdown = async (): Promise<void> => {
    stopDispatcher();
    await boss.stop({ graceful: true, wait: true });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log("authGD worker started");
}

main().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
