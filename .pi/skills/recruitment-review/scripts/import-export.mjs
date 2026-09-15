import process from "node:process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  BundleError,
  INPUT_LIMIT,
  prepareBundle,
  readBounded,
  renderPacket,
} from "./bundle.mjs";

const USAGE =
  "Usage: node scripts/import-export.mjs <export-file> --interview <file> --prepared-by <name> --out <new-directory> [--note <text>]\n";
const FILES = ["manifest.json", "interview.txt", "records.json", "context.json"];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
class ImportError extends Error {
  constructor(code) {
    super(
      code === "OUTPUT_EXISTS"
        ? "The output directory already exists; choose a new directory."
        : "The bundle could not be written.",
    );
    this.code = code;
  }
}

async function readInput(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new BundleError("READ_FAILED");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BundleError("UNSAFE_FILE");
  const bytes = await readBounded(path, INPUT_LIMIT);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BundleError("INVALID_UTF8");
  }
}

function parseSnapshot(text) {
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new BundleError("INVALID_SCHEMA");
  }
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).sort().join(",") !==
      "accountId,format,manifest,records,version" ||
    snapshot.format !== "authgd-recruitment-evidence" ||
    snapshot.version !== 1 ||
    typeof snapshot.accountId !== "string" ||
    !UUID.test(snapshot.accountId)
  ) {
    throw new BundleError("INVALID_SCHEMA");
  }
  return snapshot;
}

/** Local operator input, never an assertion that the export's provenance is trusted. */
export async function importExport({
  exportPath,
  interviewPath,
  preparedBy,
  out,
  notes = [],
}) {
  if (
    ![exportPath, interviewPath, preparedBy, out].every(
      (s) => typeof s === "string" && s.trim(),
    ) ||
    !Array.isArray(notes) ||
    !notes.every((s) => typeof s === "string" && s.trim())
  ) {
    throw new BundleError("INVALID_SCHEMA");
  }
  const destination = resolve(out);
  try {
    await lstat(destination);
    throw new ImportError("OUTPUT_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT")
      throw error instanceof ImportError ? error : new ImportError("WRITE_FAILED");
  }
  const snapshot = parseSnapshot(await readInput(exportPath));
  const interview = await readInput(interviewPath);
  const context = {
    preparedBy,
    preparedAt: new Date().toISOString(),
    notes: notes.map((text, index) => ({
      id: `context-${index + 1}`,
      text,
      source: "Recruiter input",
      asOf: null,
    })),
  };
  let staging;
  let createdDestination = false;
  try {
    // Validate a private staging bundle with the existing preparation library.
    // An invalid or oversized export never publishes a half-prepared bundle.
    staging = await mkdtemp(join(dirname(destination), ".recruitment-import-"));
    const inputs = [
      JSON.stringify(snapshot.manifest),
      interview,
      JSON.stringify(snapshot.records),
      JSON.stringify(context),
    ];
    if (inputs.some((text) => typeof text !== "string"))
      throw new BundleError("INVALID_SCHEMA");
    for (const [index, name] of FILES.entries()) {
      await writeFile(join(staging, name), inputs[index], { flag: "wx", mode: 0o600 });
    }
    const prepared = await prepareBundle(staging, {
      evaluation: false,
      confirmedBy: null,
    });
    try {
      await mkdir(destination, { mode: 0o700 });
    } catch (error) {
      throw new ImportError(error?.code === "EEXIST" ? "OUTPUT_EXISTS" : "WRITE_FAILED");
    }
    createdDestination = true;
    for (const name of FILES) {
      await copyFile(
        join(staging, name),
        join(destination, name),
        constants.COPYFILE_EXCL,
      );
    }
    return prepared;
  } catch (error) {
    if (createdDestination) await rm(destination, { recursive: true, force: true });
    if (error instanceof BundleError || error instanceof ImportError) throw error;
    throw new ImportError("WRITE_FAILED");
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

function argumentsFor(argv) {
  if (!argv[0] || argv[0].startsWith("--")) return null;
  const options = { exportPath: argv[0], notes: [] };
  const keys = {
    "--interview": "interviewPath",
    "--prepared-by": "preparedBy",
    "--out": "out",
  };
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith("--") || !value.trim()) return null;
    if (flag === "--note") options.notes.push(value);
    else if (Object.hasOwn(keys, flag) && !Object.hasOwn(options, keys[flag]))
      options[keys[flag]] = value;
    else return null;
  }
  return options.interviewPath && options.preparedBy && options.out ? options : null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = argumentsFor(process.argv.slice(2));
  if (!options) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    try {
      const { packet } = await importExport(options);
      process.stdout.write(renderPacket(packet));
    } catch (error) {
      const safe =
        error instanceof BundleError || error instanceof ImportError
          ? error
          : new ImportError("WRITE_FAILED");
      process.stderr.write(`${safe.code}: ${safe.message}\n`);
      process.exitCode = 1;
    }
  }
}
