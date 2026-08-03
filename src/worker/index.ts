import PgBoss from "pg-boss";
import { z } from "zod";
import { getConfig } from "@/config";
import { createDb } from "@/db";
import { createDiscordClient } from "@/lib/discord/rest";
import { createEsiClient } from "@/lib/esi/client";
import { postOpsWebhookOrThrow } from "@/lib/ops-webhook";
import { createWandererClient } from "@/lib/wanderer/client";
import { startDispatcher } from "@/worker/dispatcher";
import { buildJobHandlers } from "@/worker/handlers";
import { QUEUES, createQueues, scheduleJobs } from "@/worker/queues";

const deadLetterSchema = z.object({ jobType: z.string().optional() }).nullish();

async function main(): Promise<void> {
  const cfg = getConfig();
  const { db, pool } = createDb(cfg.databaseUrl);

  // pg-boss keeps its own pool, separate from createDb's — cap it too.
  const boss = new PgBoss({ connectionString: cfg.databaseUrl, max: 5 });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await createQueues(boss);

  const handlers = buildJobHandlers({
    db,
    cfg,
    esi: createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` }),
    wanderer: createWandererClient(cfg),
    discord: createDiscordClient(cfg),
  });
  // pg-boss v10 handlers receive an ARRAY of jobs.
  for (const [queue, handler] of Object.entries(handlers)) {
    await boss.work(queue, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  // Ops alerting (spec: Error handling): a job landing here exhausted its
  // retries — post to the optional Discord ops webhook. Only the payload
  // parse is caught (a malformed payload is permanent); webhook failures
  // throw so pg-boss retries the alert instead of silently losing it.
  await boss.work(QUEUES.deadLetter, async ([job]) => {
    let data: z.infer<typeof deadLetterSchema>;
    try {
      data = deadLetterSchema.parse(job.data);
    } catch (err) {
      // Malformed payload is permanent — log locally and complete the job.
      console.error("dead-letter payload malformed", err);
      return;
    }
    // Throws on failure → pg-boss retries the alert (queue has RETRY options).
    await postOpsWebhookOrThrow(
      cfg,
      `authGD: job \`${data?.jobType ?? "unknown"}\` failed after final retry.`,
    );
  });

  await scheduleJobs(boss);
  const stopDispatcher = startDispatcher(db, (queue, data, options) =>
    boss.send(queue, data, options),
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // re-entrant SIGTERM/SIGINT is a no-op
    shuttingDown = true;
    try {
      await stopDispatcher();
      await boss.stop({ graceful: true, wait: true });
      await pool.end();
    } catch (err) {
      console.error("worker shutdown failed", err);
      process.exit(1);
    }
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
