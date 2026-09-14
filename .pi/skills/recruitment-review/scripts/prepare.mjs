import process from "node:process";
import { BundleError, prepareBundle, renderPacket } from "./bundle.mjs";

const USAGE =
  "Usage: node scripts/prepare.mjs <bundle-directory> [--evaluation] [--confirmed-by <recruiter>]\n";

function usageFailure() {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

function parseArguments(args) {
  if (args.length === 0 || args[0].startsWith("--")) return null;
  const root = args[0];
  let evaluation = false;
  let confirmedBy = null;
  let sawEvaluation = false;
  let sawConfirmedBy = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--evaluation") {
      if (sawEvaluation) return null;
      sawEvaluation = true;
      evaluation = true;
      continue;
    }
    if (argument === "--confirmed-by") {
      if (sawConfirmedBy) return null;
      const value = args[index + 1];
      if (
        value === undefined ||
        value.startsWith("--") ||
        value.trim().length === 0 ||
        value.length > 128
      ) {
        return null;
      }
      sawConfirmedBy = true;
      confirmedBy = value;
      index += 1;
      continue;
    }
    return null;
  }

  return { root, options: { evaluation, confirmedBy } };
}

function abortedArtifact(error) {
  const bundle = error.identity
    ? `${error.identity.bundleId}@${error.identity.revision}`
    : "unavailable";
  return [
    `Bundle: ${bundle}`,
    "Review status: aborted",
    `Blocking reason: ${error.code}`,
    `Attempted review timestamp: ${new Date().toISOString()}`,
    "Unreviewed inputs: manifest.json, interview.txt, records.json, context.json",
    "Corrective action: Correct the local bundle and run preparation again.",
    "",
  ].join("\n");
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed === null) {
  usageFailure();
} else {
  try {
    const { packet } = await prepareBundle(parsed.root, parsed.options);
    process.stdout.write(renderPacket(packet));
  } catch (error) {
    const safeError =
      error instanceof BundleError ? error : new BundleError("READ_FAILED");
    process.stderr.write(abortedArtifact(safeError));
    process.exitCode = 1;
  }
}
