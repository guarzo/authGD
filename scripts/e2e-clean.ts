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
});

if (removed.status === 0 && removed.stdout.trim()) {
  console.log(`removed container ${CONTAINER_NAME}`);
} else {
  console.log(`no container named ${CONTAINER_NAME}`);
}

rmSync(join(WORKTREE_ROOT, "tmp", "e2e", `${CONTAINER_NAME}.stamp`), {
  force: true,
});
