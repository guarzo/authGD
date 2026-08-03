import PgBoss from "pg-boss";
import { z } from "zod";
import { getConfig } from "@/config";
import { createDb } from "@/db";
import { createDiscordClient } from "@/lib/discord/rest";
import { createEsiClient } from "@/lib/esi/client";
import { postOpsWebhookOrThrow, postOpsWebhookUrl } from "@/lib/ops-webhook";
import { createWandererClient } from "@/lib/wanderer/client";
import { startDispatcher } from "@/worker/dispatcher";
import { buildJobHandlers } from "@/worker/handlers";
import { QUEUES, createQueues, scheduleJobs } from "@/worker/queues";

const deadLetterSchema = z.object({ jobType: z.string().optional() }).nullish();

/**
 * Names the mode and the three systems this process would mutate, BEFORE any
 * queue starts. "Which credentials is this terminal holding?" has to be
 * answerable at a glance — the production incident this guards against was a
 * worker pointed at real credentials that nobody realized was live.
 */
function logStartupBanner(cfg: ReturnType<typeof getConfig>): void {
  const targets = [
    `wanderer=${cfg.wanderer.baseUrl} acl=${cfg.wanderer.aclId}`,
    `discord guild=${cfg.discord.guildId}`,
    `standings label=${cfg.standings.label} value=${cfg.standings.value}`,
  ];
  if (cfg.syncMode === "dry-run") {
    console.log("authGD worker: SYNC_MODE=dry-run — outbound writes are SUPPRESSED");
  } else {
    console.log("authGD worker: SYNC_MODE=live — outbound writes are REAL");
  }
  for (const t of targets) console.log(`  target: ${t}`);
}

async function main(): Promise<void> {
  const cfg = getConfig();
  logStartupBanner(cfg);
  const { db, pool } = createDb(cfg.databaseUrl);

  // pg-boss keeps its own pool, separate from createDb's — cap it too.
  const boss = new PgBoss({ connectionString: cfg.databaseUrl, max: 5 });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await createQueues(boss);

  const handlers = buildJobHandlers({
    db,
    cfg,
    esi: createEsiClient({
      userAgent: `authgd/0.1.0 (${cfg.esiContact})`,
      // The ESI factory takes no Config, so the guard's mode arrives here.
      syncMode: cfg.syncMode,
    }),
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

/**
 * A worker that has not finished booting in this long is not going to.
 *
 * pg-boss's `start()` retries its connection indefinitely: with valid config
 * but an unreachable database it neither resolves nor rejects, so the process
 * sits past the startup banner forever. That is worse than crashing — Fly sees
 * a live process, never restarts it, and `main().catch()` below never fires, so
 * no alert is sent either. The worker is silently doing nothing, which is the
 * exact failure mode this file is meant to eliminate.
 *
 * 60s is deliberately generous. Migrations run in the Fly release command, not
 * here, so a healthy boot is a connection and a handful of CREATE-IF-NOT-EXISTS
 * statements — seconds, not minutes.
 */
const BOOT_TIMEOUT_MS = 60_000;

/**
 * Last-resort alert for a worker that dies before it can start working.
 *
 * The incident this exists for: the worker crashlooped on first deploy,
 * exhausted its restarts, and stayed down silently. The dead-letter handler is
 * the only thing in this process that posts to the ops webhook, and it is
 * registered *inside* main() after boss.start() — so a worker that dies at boot
 * could never reach it. That is the silence being fixed here.
 *
 * It reads process.env directly instead of getConfig() on purpose: the most
 * likely boot failure is getConfig() itself throwing on invalid config, so
 * there is no validated Config available. That means doing by hand the two
 * things getConfig() would have done — find the webhook URL, and honour
 * dry-run so a developer's laptop never pages the real ops channel.
 *
 * `safeSummary` is for callers that constructed the error themselves and know
 * its text is safe to publish. Arbitrary error text is NEVER forwarded: a
 * driver-level failure can carry a connection string, a hostname, or a
 * credential in its message, and this channel is a chat room with a wider
 * audience than `fly logs`. Zod is the one exception — it reports variable
 * names, which are exactly what an operator needs and contain no values.
 */
async function alertBootFailure(err: unknown, safeSummary?: string): Promise<void> {
  const url = process.env.DISCORD_OPS_WEBHOOK_URL;
  if (!url) return;
  if (process.env.SYNC_MODE === "dry-run") return;
  // A ZodError serializes to ~200 characters PER failing variable, so on the
  // common "nothing is set" failure the raw message blows past the webhook's
  // length cap and gets cut mid-JSON — losing most of the names, which are the
  // only part worth reading. Collapse it to the list of variables instead.
  const detail =
    err instanceof z.ZodError
      ? `invalid or missing config: ${[
          ...new Set(err.issues.map((i) => i.path.join(".")).filter(Boolean)),
        ]
          .sort()
          .join(", ")}`
      : (safeSummary ??
        "startup failed before the worker could take jobs — full error in `fly logs`");
  try {
    await postOpsWebhookUrl(
      url,
      `authGD: **worker FAILED TO START** — it will not process any jobs until this is fixed.\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\``,
    );
  } catch (alertErr) {
    // Nothing left to escalate to. Log and let the exit code speak.
    console.error("boot-failure alert could not be delivered", alertErr);
  }
}

/** Alert (best-effort) and exit non-zero so Fly's restart policy engages. */
function failBoot(err: unknown, safeSummary?: string): void {
  // The COMPLETE error goes here regardless of what the webhook is allowed to
  // say — stderr is the authoritative record, `fly logs` the place to read it.
  console.error("worker failed to start", err);
  // Await the alert before exiting — process.exit() would abort the in-flight
  // POST. Failure to alert must not mask the original failure, so the exit code
  // is 1 either way (alertBootFailure never rejects).
  void alertBootFailure(err, safeSummary).finally(() => process.exit(1));
}

const bootTimer = setTimeout(() => {
  // Self-authored message, so it is safe to publish — and it is the most
  // actionable alert this file can send, naming the likeliest cause.
  const summary = `worker boot did not complete within ${BOOT_TIMEOUT_MS / 1000}s — most likely the database is unreachable (pg-boss retries forever without failing)`;
  failBoot(new Error(summary), summary);
}, BOOT_TIMEOUT_MS);

main()
  // Boot finished; stop the watchdog so it can't fire at a running worker.
  .then(() => clearTimeout(bootTimer))
  .catch((err) => {
    clearTimeout(bootTimer);
    failBoot(err);
  });
