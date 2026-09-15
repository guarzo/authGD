import process from "node:process";
import { BundleError, prepareBundle, renderPacket } from "./bundle.mjs";
import { parsePrepareArguments, renderPreparationAbort } from "./cli.mjs";

const USAGE =
  "Usage: node scripts/prepare.mjs <bundle-directory> [--evaluation] [--confirmed-by <recruiter>]\n";

function usageFailure() {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}

const parsed = parsePrepareArguments(process.argv.slice(2));
if (parsed === null) {
  usageFailure();
} else {
  try {
    const { packet } = await prepareBundle(parsed.root, parsed.options);
    process.stdout.write(renderPacket(packet));
  } catch (error) {
    const safeError =
      error instanceof BundleError ? error : new BundleError("READ_FAILED");
    process.stderr.write(renderPreparationAbort(safeError));
    process.exitCode = 1;
  }
}
