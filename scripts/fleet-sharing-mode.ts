/** Intermediate Task 1 operator interface, NOT a release-ready cutover tool.
 * Dry-run is read-only. Apply remains blocked until source invalidation and the
 * compatible source worker/outbox deployment exist and pass final acceptance.
 * No dotenv loading, deploy hook, public route, or implicit mode transition. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { count } from "drizzle-orm";
import { createDb, type Dbx } from "@/db";
import { fleetDeviceSession, fleetEligibility, fleetTelemetryRow } from "@/db/schema";
import {
  readFleetSharingMode,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";

export class ModeOperatorError extends Error {}
export type ModeOptions = {
  apply: boolean;
  enabled: boolean;
  expectedRevision: number;
  compatibleWeb: boolean;
  compatibleWorker: boolean;
  oldReplicasDrained: boolean;
};

export function parseModeOptions(args: string[]): ModeOptions {
  const allowed = new Set([
    "--apply",
    "--dry-run",
    "--enable",
    "--disable",
    "--expected-revision",
    "--compatible-web",
    "--compatible-worker",
    "--old-replicas-drained",
  ]);
  const flags = new Set<string>();
  let expectedRevision: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!allowed.has(arg) || flags.has(arg))
      throw new ModeOperatorError("invalid_arguments");
    flags.add(arg);
    if (arg === "--expected-revision") {
      const raw = args[++i];
      if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) >= 2147483647)
        throw new ModeOperatorError("invalid_revision");
      expectedRevision = Number(raw);
    }
  }
  if (
    flags.has("--apply") === flags.has("--dry-run") ||
    flags.has("--enable") === flags.has("--disable") ||
    expectedRevision === undefined
  )
    throw new ModeOperatorError("explicit_mode_target_and_revision_required");
  return {
    apply: flags.has("--apply"),
    enabled: flags.has("--enable"),
    expectedRevision,
    compatibleWeb: flags.has("--compatible-web"),
    compatibleWorker: flags.has("--compatible-worker"),
    oldReplicasDrained: flags.has("--old-replicas-drained"),
  };
}

export function checkDeploymentPreconditions(options: ModeOptions): void {
  if (!options.compatibleWeb || !options.compatibleWorker || !options.oldReplicasDrained)
    throw new ModeOperatorError(
      "compatible_web_worker_and_drained_old_replicas_required",
    );
  // No CLI flag can bypass this incomplete integration. Remove only when the
  // real source lifecycle/worker/outbox and rollback rehearsal are accepted.
  throw new ModeOperatorError("full_source_model_not_release_ready");
}

export async function runFleetSharingMode(db: Dbx, options: ModeOptions) {
  if (options.apply) {
    checkDeploymentPreconditions(options);
    return transitionFleetSharingMode(db, {
      enabled: options.enabled,
      expectedRevision: options.expectedRevision,
    });
  }
  const current = await readFleetSharingMode(db);
  const [sessions] = await db.select({ count: count() }).from(fleetDeviceSession);
  const [eligibility] = await db.select({ count: count() }).from(fleetEligibility);
  const [telemetry] = await db.select({ count: count() }).from(fleetTelemetryRow);
  return {
    dryRun: true,
    releaseReady: false,
    current,
    targetEnabled: options.enabled,
    expectedRevision: options.expectedRevision,
    revisionMatches: current.revision === options.expectedRevision,
    sessionsToRetire: sessions.count,
    legacyEligibilityToDelete: eligibility.count,
    telemetryToDelete: telemetry.count,
  };
}

async function main() {
  const options = parseModeOptions(process.argv.slice(2));
  if (options.apply) checkDeploymentPreconditions(options);
  const url = process.env.DATABASE_URL;
  if (!url) throw new ModeOperatorError("explicit_database_url_required");
  const { db, pool } = createDb(url);
  try {
    console.log(JSON.stringify(await runFleetSharingMode(db, options)));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(
      err instanceof ModeOperatorError ? err.message : "fleet_mode_operation_failed",
    );
    process.exitCode = 1;
  });
}
