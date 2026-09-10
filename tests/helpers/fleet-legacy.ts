import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WORKTREE_ROOT } from "../../e2e/env";

export const LEGACY_REVISION = "62b2c6cd8d5ad7cc346ad4f96205e96e19f3e07d";
/** Bundle actual old transitive logic, not current legacy-mode services. No
 * checkout/ref writes and no checked-in vendor copy that can drift from its pin. */
export async function loadLegacyFleet() {
  const root = join(WORKTREE_ROOT, "tmp/task-10");
  mkdirSync(root, { recursive: true });
  const hashes: Record<string, string> = {};
  const output = join(root, "legacy-fleet.mjs");
  await build({
    stdin: {
      contents:
        'export { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay"; export { dispatchOutbox } from "@/worker/dispatcher"; export { authenticateFleetRequest } from "@/lib/fleet-route-auth";',
      resolveDir: WORKTREE_ROOT,
      loader: "ts",
    },
    outfile: output,
    platform: "node",
    format: "esm",
    packages: "external",
    bundle: true,
    plugins: [
      {
        name: "pinned-legacy-source",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, (args) => ({
            path: `src/${args.path.slice(2)}.ts`,
            namespace: "legacy",
          }));
          builder.onResolve({ filter: /^\./, namespace: "legacy" }, (args) => ({
            path:
              posix.normalize(posix.join(posix.dirname(args.importer), args.path)) +
              ".ts",
            namespace: "legacy",
          }));
          builder.onLoad({ filter: /.*/, namespace: "legacy" }, (args) => {
            if (!/^src\/[\w/.-]+\.ts$/.test(args.path))
              throw new Error("invalid old source path");
            const contents = execFileSync(
              "git",
              ["-C", WORKTREE_ROOT, "show", `${LEGACY_REVISION}:${args.path}`],
              { encoding: "utf8" },
            );
            hashes[args.path] = createHash("sha256").update(contents).digest("hex");
            return {
              contents,
              loader: "ts",
              resolveDir: dirname(join(WORKTREE_ROOT, args.path)),
            };
          });
        },
      },
    ],
  });
  writeFileSync(
    join(root, "legacy-provenance.json"),
    JSON.stringify({ revision: LEGACY_REVISION, files: hashes }, null, 2),
  );
  const loaded = (await import(pathToFileURL(output).href)) as {
    readFleetProjection: (
      db: import("../../src/db").Dbx,
      args: { sessionId: string; revision: number; now: Date },
    ) => ReturnType<typeof import("../../src/services/fleet-relay").readFleetProjection>;
    replaceDeviceProjection: typeof import("../../src/services/fleet-relay").replaceDeviceProjection;
    dispatchOutbox: typeof import("../../src/worker/dispatcher").dispatchOutbox;
    authenticateFleetRequest: typeof import("../../src/lib/fleet-route-auth").authenticateFleetRequest;
  };
  return { ...loaded, hashes };
}
