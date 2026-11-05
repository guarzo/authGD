import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WORKTREE_ROOT } from "../../e2e/env";

export const LEGACY_REVISION = "62b2c6cd8d5ad7cc346ad4f96205e96e19f3e07d";
// Published and explicitly fetched in unit CI; unlike a coordinator's local
// foundation commit, this remains available after cherry-picking the change.
export const PRE_COMBAT_REVISION = "123a4d2547e2a93fefd1044645fedff1ad581b8b";
export function pinnedSource(
  revision: typeof LEGACY_REVISION | typeof PRE_COMBAT_REVISION,
  path: string,
) {
  return execFileSync("git", ["-C", WORKTREE_ROOT, "show", `${revision}:${path}`], {
    encoding: "utf8",
  });
}
// Historical types are intentionally separate. Importing the evolving current
// relay signature silently made this pinned old writer require v2 input.
type LegacyRow = { characterId: number; dps: number; ewar: readonly string[] };
type LegacyCall = { sessionId: string; revision: number; now: Date };
type LegacyRefusal = { ok: false; code: string };
type LegacyRelay = {
  readFleetProjection: (
    db: import("../../src/db").Dbx,
    args: LegacyCall,
  ) => Promise<
    | LegacyRefusal
    | {
        ok: true;
        rows: (LegacyRow & {
          characterName: string;
          state: "live" | "stale";
          ageMs: number;
        })[];
      }
  >;
  replaceDeviceProjection: (
    db: import("../../src/db").Db,
    args: LegacyCall & { rows: readonly LegacyRow[] },
  ) => Promise<LegacyRefusal | { ok: true }>;
};
/** Bundle actual pinned transitive logic. No checkout/ref writes and no
 * checked-in historical production copy that can drift from its pin. */
async function bundlePinned(
  revision: typeof LEGACY_REVISION | typeof PRE_COMBAT_REVISION,
  name: string,
  exports: string,
) {
  const root = join(WORKTREE_ROOT, "tmp/task-10");
  mkdirSync(root, { recursive: true });
  const hashes: Record<string, string> = {};
  const output = join(root, `${name}-fleet.mjs`);
  await build({
    stdin: { contents: exports, resolveDir: WORKTREE_ROOT, loader: "ts" },
    outfile: output,
    platform: "node",
    format: "esm",
    packages: "external",
    bundle: true,
    plugins: [
      {
        name: "pinned-legacy-source",
        setup(builder) {
          // Entry fixture helpers must be pinned too: resolving only their @/
          // imports mixes evolving current assertions with historical services.
          builder.onResolve({ filter: /^\.\/tests\/helpers\// }, (args) => ({
            path: `${args.path.slice(2)}.ts`,
            namespace: "legacy",
          }));
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
            if (!/^(?:src|tests\/helpers)\/[\w/.-]+\.ts$/.test(args.path))
              throw new Error("invalid old source path");
            const contents = pinnedSource(revision, args.path);
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
    join(root, `${name}-provenance.json`),
    JSON.stringify({ revision, files: hashes }, null, 2),
  );
  return { loaded: (await import(pathToFileURL(output).href)) as unknown, hashes };
}
export async function loadLegacyFleet() {
  const { loaded, hashes } = await bundlePinned(
    LEGACY_REVISION,
    "legacy",
    'export { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay"; export { dispatchOutbox } from "@/worker/dispatcher"; export { authenticateFleetRequest } from "@/lib/fleet-route-auth";',
  );
  return {
    ...(loaded as LegacyRelay & {
      dispatchOutbox: typeof import("../../src/worker/dispatcher").dispatchOutbox;
      authenticateFleetRequest: typeof import("../../src/lib/fleet-route-auth").authenticateFleetRequest;
    }),
    hashes,
  };
}
/** Only the existing historical regression uses this pre-0025 backend. The
 * current relay suites still execute current production code on the main DB.
 * Fixture helpers and their transitive imports resolve through the same pin. */
export async function loadPreCombatFleet() {
  const { loaded, hashes } = await bundlePinned(
    PRE_COMBAT_REVISION,
    "pre-combat",
    `
    export { replaceDeviceProjection } from "@/services/fleet-relay";
    export { readFleetSharingMode, transitionFleetSharingMode, readFleetKeyIdentityState } from "@/services/fleet-sharing-mode";
    export { createDb } from "@/db/index";
    export { fleetTelemetryRow } from "@/db/schema";
    export { TRUNCATE_ALL_SQL } from "@/db/tables";
    export { pairDevice, reconcileFleetKeys } from "./tests/helpers/fleet-sharing";
    export { participatingDevice, realSource } from "./tests/helpers/fleet-shared-admission";
  `,
  );
  return {
    ...(loaded as Pick<LegacyRelay, "replaceDeviceProjection"> & {
      readFleetSharingMode: typeof import("../../src/services/fleet-sharing-mode").readFleetSharingMode;
      transitionFleetSharingMode: typeof import("../../src/services/fleet-sharing-mode").transitionFleetSharingMode;
      readFleetKeyIdentityState: typeof import("../../src/services/fleet-sharing-mode").readFleetKeyIdentityState;
      // Selected only for retained-row counts/emptiness. Do not pretend that the
      // historical columns have the current combat schema's TypeScript shape.
      fleetTelemetryRow: import("drizzle-orm/pg-core").PgTable;
      createDb: typeof import("../../src/db").createDb;
      TRUNCATE_ALL_SQL: string;
      pairDevice: typeof import("./fleet-sharing").pairDevice;
      reconcileFleetKeys: typeof import("./fleet-sharing").reconcileFleetKeys;
      participatingDevice: typeof import("./fleet-shared-admission").participatingDevice;
      realSource: typeof import("./fleet-shared-admission").realSource;
    }),
    hashes,
  };
}
