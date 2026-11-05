import { beforeEach, describe, expect, it, vi } from "vitest";
import { runJob } from "@/services/sync-run";
import { buildJobHandlers, type JobDeps } from "@/worker/handlers";
import { testConfig } from "./helpers/config";

// Keep real routing and job entry points: only skip the database/network body
// after it has reached the shared persistence/notification boundary.
vi.mock("@/services/sync-run", async (original) => ({
  ...(await original<typeof import("@/services/sync-run")>()),
  runJob: vi.fn(async () => ({ status: "ok" })),
}));

const queues = [
  "membership",
  "membership-recheck",
  "contacts",
  "wanderer",
  "discord-roles",
  "token-health",
  "purge",
  "location",
  "access-lists",
  "structures",
  "structure-events",
] as const;

function deps(onRunFinished?: () => void): JobDeps {
  // Every job's real work is inside runJob; an accidental pre-boundary access
  // to these unavailable systems must fail rather than contacting anything.
  return {
    cfg: testConfig(),
    db: {} as JobDeps["db"],
    esi: {} as JobDeps["esi"],
    discord: {} as JobDeps["discord"],
    wanderer: {} as JobDeps["wanderer"],
    onRunFinished,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("ordinary worker progress forwarding", () => {
  it.each(queues)("forwards completion notification for %s", async (queue) => {
    const notify = vi.fn();
    await buildJobHandlers(deps(notify))[queue]({ jobType: queue });
    expect(runJob).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      queue,
      expect.any(Function),
      notify,
    );
  });

  it.each(queues)("leaves %s unmonitored without a worker notifier", async (queue) => {
    await buildJobHandlers(deps())[queue]({ jobType: queue });
    expect(vi.mocked(runJob).mock.calls[0][3]).toBeUndefined();
    expect(runJob).toHaveBeenCalledOnce();
  });

  it.each(queues)(
    "rejects malformed %s payload before running any job",
    async (queue) => {
      await expect(
        buildJobHandlers(deps())[queue]({ jobType: queue, injected: true }),
      ).rejects.toThrow();
      expect(runJob).not.toHaveBeenCalled();
    },
  );
});
