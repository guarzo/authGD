import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { isSafeId, isUtcTimestamp } from "./syntax.mjs";

export const INPUT_LIMIT = 4 * 1024 * 1024;
const PACKET_LIMIT = 128 * 1024;
const FILES = ["manifest.json", "interview.txt", "records.json", "context.json"];
const CATEGORIES = [
  "corporation-history",
  "wallet",
  "contracts",
  "assets",
  "skills",
  "skill-queue",
];
const DATASET_STATUSES = [
  "complete",
  "empty",
  "unauthorised",
  "failed",
  "partial",
  "absent",
];
const SOURCE_KINDS = [
  "authenticated-esi",
  "public-esi",
  "applicant",
  "synthetic",
  "unknown",
];
const NO_RECORD_STATUSES = new Set(["empty", "unauthorised", "failed", "absent"]);
const CREDENTIAL_KEYS = new Set([
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
]);
const SAFE_MESSAGES = {
  INVALID_SCHEMA: "The evidence bundle does not match the version 1 schema.",
  INVALID_UTF8: "A bundle input is not valid UTF-8.",
  UNSAFE_FILE: "A bundle path is not a regular, non-symbolic-link file.",
  INPUT_TOO_LARGE: "The evidence bundle exceeds the 4 MiB input limit.",
  PACKET_TOO_LARGE: "The prepared packet exceeds the 128 KiB packet limit.",
  INVALID_CREDENTIAL_FIELD: "A JSON input contains a prohibited credential-bearing key.",
  READ_FAILED: "A required bundle input could not be read.",
};

export class BundleError extends Error {
  constructor(code, identity = null) {
    const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : "INVALID_SCHEMA";
    super(SAFE_MESSAGES[safeCode]);
    this.name = "BundleError";
    this.code = safeCode;
    this.identity = identity;
  }
}

function fail(code) {
  throw new BundleError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasUniqueValues(values) {
  return new Set(values).size === values.length;
}

function assertNoCredentialKeys(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    if (!isPlainObject(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
        fail("INVALID_CREDENTIAL_FIELD");
      }
      pending.push(child);
    }
  }
}

function assertStringArray(value, { nonEmpty = false, safeIds = false } = {}) {
  if (
    !Array.isArray(value) ||
    (nonEmpty && value.length === 0) ||
    !value.every((entry) => (safeIds ? isSafeId(entry) : isNonEmptyString(entry)))
  ) {
    fail("INVALID_SCHEMA");
  }
}

function validateProvenance(provenance) {
  if (!Array.isArray(provenance) || provenance.length === 0) fail("INVALID_SCHEMA");
  const ids = [];
  for (const entry of provenance) {
    if (
      !hasExactKeys(entry, [
        "id",
        "collector",
        "method",
        "toolVersion",
        "sourceKind",
        "transformations",
      ]) ||
      !isSafeId(entry.id) ||
      !isNonEmptyString(entry.collector) ||
      !isNonEmptyString(entry.method) ||
      !isNonEmptyString(entry.toolVersion) ||
      !SOURCE_KINDS.includes(entry.sourceKind)
    ) {
      fail("INVALID_SCHEMA");
    }
    assertStringArray(entry.transformations);
    ids.push(entry.id);
  }
  if (!hasUniqueValues(ids)) fail("INVALID_SCHEMA");
  return new Set(ids);
}

function validateDatasets(datasets, includedCharacterIds, provenanceIds) {
  if (!Array.isArray(datasets)) fail("INVALID_SCHEMA");
  const expectedKeys = new Set(
    includedCharacterIds.flatMap((characterId) =>
      CATEGORIES.map((category) => `${characterId}\u0000${category}`),
    ),
  );
  const actualKeys = new Set();

  for (const dataset of datasets) {
    if (
      !hasExactKeys(dataset, [
        "characterId",
        "category",
        "status",
        "provenanceId",
        "history",
        "note",
      ]) ||
      !isSafeId(dataset.characterId) ||
      !includedCharacterIds.includes(dataset.characterId) ||
      !CATEGORIES.includes(dataset.category) ||
      !DATASET_STATUSES.includes(dataset.status) ||
      !provenanceIds.has(dataset.provenanceId) ||
      typeof dataset.note !== "string" ||
      !hasExactKeys(dataset.history, ["knownLimit", "earliestReturnedAt"]) ||
      !(
        dataset.history.knownLimit === null ||
        isNonEmptyString(dataset.history.knownLimit)
      ) ||
      !(
        dataset.history.earliestReturnedAt === null ||
        isUtcTimestamp(dataset.history.earliestReturnedAt)
      )
    ) {
      fail("INVALID_SCHEMA");
    }
    const key = `${dataset.characterId}\u0000${dataset.category}`;
    if (actualKeys.has(key)) fail("INVALID_SCHEMA");
    actualKeys.add(key);
  }

  if (
    actualKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    fail("INVALID_SCHEMA");
  }

  return new Map(
    datasets.map((dataset) => [
      `${dataset.characterId}\u0000${dataset.category}`,
      dataset,
    ]),
  );
}

function validateManifest(manifest) {
  if (
    !hasExactKeys(manifest, [
      "version",
      "bundleId",
      "revision",
      "collectedAt",
      "declaredCharacterIds",
      "includedCharacterIds",
      "provenance",
      "datasets",
    ]) ||
    manifest.version !== 1 ||
    !isSafeId(manifest.bundleId) ||
    !isSafeId(manifest.revision) ||
    !isUtcTimestamp(manifest.collectedAt)
  ) {
    fail("INVALID_SCHEMA");
  }
  assertStringArray(manifest.declaredCharacterIds, { nonEmpty: true, safeIds: true });
  assertStringArray(manifest.includedCharacterIds, { nonEmpty: true, safeIds: true });
  if (
    !hasUniqueValues(manifest.declaredCharacterIds) ||
    !hasUniqueValues(manifest.includedCharacterIds) ||
    manifest.includedCharacterIds.some(
      (characterId) => !manifest.declaredCharacterIds.includes(characterId),
    )
  ) {
    fail("INVALID_SCHEMA");
  }
  const provenanceIds = validateProvenance(manifest.provenance);
  const datasets = validateDatasets(
    manifest.datasets,
    manifest.includedCharacterIds,
    provenanceIds,
  );
  return { provenanceIds, datasets };
}

function validateRecords(records, manifestState) {
  if (!Array.isArray(records)) fail("INVALID_SCHEMA");
  const ids = [];
  for (const record of records) {
    if (
      !hasExactKeys(record, [
        "id",
        "characterId",
        "category",
        "provenanceId",
        "sourceRecordId",
        "data",
      ]) ||
      !isSafeId(record.id) ||
      !isSafeId(record.characterId) ||
      !CATEGORIES.includes(record.category) ||
      !manifestState.provenanceIds.has(record.provenanceId) ||
      !(record.sourceRecordId === null || isNonEmptyString(record.sourceRecordId)) ||
      !isPlainObject(record.data)
    ) {
      fail("INVALID_SCHEMA");
    }
    const dataset = manifestState.datasets.get(
      `${record.characterId}\u0000${record.category}`,
    );
    if (!dataset || NO_RECORD_STATUSES.has(dataset.status)) fail("INVALID_SCHEMA");
    ids.push(record.id);
  }
  if (!hasUniqueValues(ids)) fail("INVALID_SCHEMA");
}

function validateContext(context) {
  if (
    !hasExactKeys(context, ["preparedBy", "preparedAt", "notes"]) ||
    !isNonEmptyString(context.preparedBy) ||
    !isUtcTimestamp(context.preparedAt) ||
    !Array.isArray(context.notes)
  ) {
    fail("INVALID_SCHEMA");
  }
  const ids = [];
  for (const note of context.notes) {
    if (
      !hasExactKeys(note, ["id", "text", "source", "asOf"]) ||
      !isSafeId(note.id) ||
      !isNonEmptyString(note.text) ||
      !isNonEmptyString(note.source) ||
      !(note.asOf === null || isUtcTimestamp(note.asOf))
    ) {
      fail("INVALID_SCHEMA");
    }
    ids.push(note.id);
  }
  if (!hasUniqueValues(ids)) fail("INVALID_SCHEMA");
}

function validateInterview(interview) {
  const lines = interview.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const normalized = lines.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  );
  if (
    normalized.length === 0 ||
    normalized.some((line) => !/^[^:\r\n]+:\s*\S/.test(line))
  ) {
    fail("INVALID_SCHEMA");
  }
  return normalized.map((text, index) => ({ line: index + 1, text }));
}

function validateOptions(options) {
  if (
    !hasExactKeys(options, ["evaluation", "confirmedBy"]) ||
    typeof options.evaluation !== "boolean" ||
    !(
      options.confirmedBy === null ||
      (isNonEmptyString(options.confirmedBy) && options.confirmedBy.length <= 128)
    )
  ) {
    fail("INVALID_SCHEMA");
  }
}

async function inspectInputs(root) {
  if (!isNonEmptyString(root)) fail("INVALID_SCHEMA");
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    fail("READ_FAILED");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("UNSAFE_FILE");

  const inspected = [];
  let aggregate = 0;
  for (const name of FILES) {
    const path = join(root, name);
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      fail("READ_FAILED");
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail("UNSAFE_FILE");
    aggregate += stat.size;
    if (aggregate > INPUT_LIMIT) fail("INPUT_TOO_LARGE");
    inspected.push({ name, path });
  }
  return inspected;
}

export async function readBounded(path, remaining) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) fail("UNSAFE_FILE");
    if (stat.size > remaining) fail("INPUT_TOO_LARGE");

    const chunks = [];
    let total = 0;
    while (true) {
      const capacity = Math.min(64 * 1024, remaining - total + 1);
      const buffer = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > remaining) fail("INPUT_TOO_LARGE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof BundleError) throw error;
    if (error && typeof error === "object" && error.code === "ELOOP") {
      fail("UNSAFE_FILE");
    }
    fail("READ_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readInput(input, remaining) {
  const bytes = await readBounded(input.path, remaining);
  try {
    return {
      name: input.name,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      byteLength: bytes.length,
    };
  } catch {
    fail("INVALID_UTF8");
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    fail("INVALID_SCHEMA");
  }
}

export function renderPacket(packet) {
  let text;
  try {
    text = `${JSON.stringify(packet, null, 2)}\n`;
  } catch {
    fail("INVALID_SCHEMA");
  }
  if (Buffer.byteLength(text, "utf8") > PACKET_LIMIT) fail("PACKET_TOO_LARGE");
  return text;
}

export async function prepareBundle(root, options) {
  validateOptions(options);
  const inspected = await inspectInputs(root);
  const manifestInput = await readInput(inspected[0], INPUT_LIMIT);
  const manifest = parseJson(manifestInput.text);
  assertNoCredentialKeys(manifest);
  const manifestState = validateManifest(manifest);
  const identity = {
    bundleId: manifest.bundleId,
    revision: manifest.revision,
  };

  try {
    const inputs = new Map([[manifestInput.name, manifestInput.text]]);
    let total = manifestInput.byteLength;
    for (const input of inspected.slice(1)) {
      const result = await readInput(input, INPUT_LIMIT - total);
      total += result.byteLength;
      inputs.set(result.name, result.text);
    }

    const records = parseJson(inputs.get("records.json"));
    const context = parseJson(inputs.get("context.json"));
    for (const value of [records, context]) assertNoCredentialKeys(value);

    validateRecords(records, manifestState);
    validateContext(context);
    const interviewLines = validateInterview(inputs.get("interview.txt"));
    const sourceKinds = new Map(
      manifest.provenance.map((entry) => [entry.id, entry.sourceKind]),
    );
    const isConfirmed = options.confirmedBy !== null;
    const preparedRecords = records.map((record) => ({
      ...record,
      verification:
        isConfirmed &&
        ["authenticated-esi", "public-esi"].includes(sourceKinds.get(record.provenanceId))
          ? "trusted-handoff"
          : "unverified",
    }));

    const packet = {
      bundle: {
        id: manifest.bundleId,
        revision: manifest.revision,
        collectedAt: manifest.collectedAt,
      },
      preparation: {
        evaluation: options.evaluation,
        confirmedBy: options.confirmedBy,
        syntheticOnly: options.evaluation,
      },
      interview: { lines: interviewLines },
      coverage: {
        declaredCharacterIds: manifest.declaredCharacterIds,
        includedCharacterIds: manifest.includedCharacterIds,
        datasets: manifest.datasets,
      },
      provenance: manifest.provenance,
      context,
      records: preparedRecords,
    };

    renderPacket(packet);
    return {
      packet,
      citationIndex: {
        bundleId: manifest.bundleId,
        revision: manifest.revision,
        transcriptLineCount: interviewLines.length,
        recordIds: records.map((record) => record.id),
        contextIds: context.notes.map((note) => note.id),
      },
    };
  } catch (error) {
    if (error instanceof BundleError) {
      throw new BundleError(error.code, identity);
    }
    throw error;
  }
}
