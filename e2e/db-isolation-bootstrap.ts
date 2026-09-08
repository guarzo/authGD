import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { IS_RUNNER, WORKTREE_ROOT } from "./env";

const preload = join(WORKTREE_ROOT, "tmp/e2e/db-preload.mjs");
let built = false;

export function databaseIsolationEnvironment() {
  if (IS_RUNNER && !built) {
    // Compile before spawning Next, never from an inherited Node preload.
    mkdirSync(join(WORKTREE_ROOT, "tmp/e2e"), { recursive: true });
    buildSync({
      entryPoints: [join(WORKTREE_ROOT, "e2e/db-preload.mjs")],
      outfile: preload,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      define: { __dirname: JSON.stringify(join(WORKTREE_ROOT, "e2e")) },
    });
    built = true;
  }
  return { E2E_DB_ISOLATION: "1", NODE_OPTIONS: `--import=${preload}` };
}
