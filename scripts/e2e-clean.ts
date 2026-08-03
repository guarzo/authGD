import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CONTAINER_NAME, WORKTREE_ROOT } from "../e2e/env";

/**
 * Removes the Postgres container `npm run test:e2e` provisions for this
 * worktree, plus the stamp that records which migrations it has had applied.
 *
 * The suite deliberately keeps its container warm between runs, so nothing
 * reclaims it automatically. Run this when you are finished with a worktree —
 * or whenever you want the next run to rebuild the database from scratch.
 */
const removed = spawnSync("docker", ["rm", "-f", CONTAINER_NAME], {
  encoding: "utf8",
  timeout: 30_000,
});

const stdout = (removed.stdout ?? "").trim();
const stderr = (removed.stderr ?? "").trim();

// `docker rm -f` reports a missing container two different ways depending on
// version: exit 0 with an empty stdout and a warning, or a non-zero exit with
// "No such container". Both are the goal state. Everything else has to be loud —
// reporting a removal when the daemon was simply unreachable would leave a live
// container behind under a message saying it was gone.
const absent =
  (removed.status === 0 && stdout === "") || /no such container/i.test(stderr);

if (removed.status === 0 && stdout !== "") {
  console.log(`removed container ${CONTAINER_NAME}`);
} else if (absent) {
  console.log(`no container named ${CONTAINER_NAME}`);
} else {
  throw new Error(
    `[e2e] could not remove ${CONTAINER_NAME}: ` +
      `${stderr || removed.error?.message || `docker exited ${removed.status}`}\n` +
      `The container may still be running. Leaving the migration stamp in place.`,
  );
}

rmSync(join(WORKTREE_ROOT, "tmp", "e2e", `${CONTAINER_NAME}.stamp`), {
  force: true,
});
