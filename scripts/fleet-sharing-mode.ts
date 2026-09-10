/** Explicit operator-only empty first-use bootstrap and safe disable. General
 * nonempty enable/reconciliation remains blocked. Existing operator shell access
 * is the authorization boundary; audit uses system, not caller-supplied identity.
 * No dotenv loading, deploy hook, public route, or implicit mode transition. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { count, sql } from "drizzle-orm";
import { createDb, type Dbx } from "@/db";
import { fleetDeviceSession, fleetEligibility, fleetTelemetryRow } from "@/db/schema";
import {
  bootstrapFleetSharingMode,
  boundFleetModeOperatorWaits,
  FleetModeOperatorError as ModeOperatorError,
  readFleetSharingMode,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";

export { ModeOperatorError };
export type ModeOptions = {
  apply: boolean;
  enabled: boolean;
  firstUse: boolean;
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
    "--first-use",
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
  if (flags.has("--first-use") && !flags.has("--enable"))
    throw new ModeOperatorError("first_use_requires_enable");
  return {
    apply: flags.has("--apply"),
    enabled: flags.has("--enable"),
    firstUse: flags.has("--first-use"),
    expectedRevision,
    compatibleWeb: flags.has("--compatible-web"),
    compatibleWorker: flags.has("--compatible-worker"),
    oldReplicasDrained: flags.has("--old-replicas-drained"),
  };
}

function deploymentRefusal(options: ModeOptions): string | null {
  if (options.firstUse && !options.enabled) return "first_use_requires_enable";
  if (!options.compatibleWeb || !options.compatibleWorker || !options.oldReplicasDrained)
    return "compatible_web_worker_and_drained_old_replicas_required";
  if (options.enabled && !options.firstUse) return "full_source_model_not_release_ready";
  return null;
}

export function checkDeploymentPreconditions(options: ModeOptions): void {
  const refusal = deploymentRefusal(options);
  if (refusal) throw new ModeOperatorError(refusal);
}

export async function runFleetSharingMode(db: Dbx, options: ModeOptions) {
  if (options.apply) checkDeploymentPreconditions(options);
  if (options.firstUse) {
    const result = await bootstrapFleetSharingMode(db, {
      expectedRevision: options.expectedRevision,
      dryRun: !options.apply,
    });
    if ("dryRun" in result) {
      const refusal = deploymentRefusal(options) ?? result.refusal;
      return { ...result, refusal, releaseReady: refusal === null };
    }
    return result;
  }
  if (options.apply) {
    return transitionFleetSharingMode(db, {
      enabled: options.enabled,
      expectedRevision: options.expectedRevision,
    });
  }
  // One coherent preview even if disable commits between the gate and counts.
  // This snapshot never authorizes apply: the write path rechecks under its lock.
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    await boundFleetModeOperatorWaits(tx);
    const current = await readFleetSharingMode(tx);
    const [sessions] = await tx.select({ count: count() }).from(fleetDeviceSession);
    const [eligibility] = await tx.select({ count: count() }).from(fleetEligibility);
    const [telemetry] = await tx.select({ count: count() }).from(fleetTelemetryRow);
    return {
      dryRun: true,
      releaseReady:
        deploymentRefusal(options) === null &&
        current.revision === options.expectedRevision,
      refusal:
        deploymentRefusal(options) ??
        (current.revision !== options.expectedRevision ? "conflict" : null),
      current,
      targetEnabled: options.enabled,
      expectedRevision: options.expectedRevision,
      revisionMatches: current.revision === options.expectedRevision,
      sessionsToRetire: sessions.count,
      legacyEligibilityToDelete: eligibility.count,
      telemetryToDelete: telemetry.count,
    };
  });
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
