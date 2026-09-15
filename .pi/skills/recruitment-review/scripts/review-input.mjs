import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import {
  assertNoCredentialKeys,
  BundleError,
  prepareInputs,
  readBounded,
} from "./bundle.mjs";
import { parseSnapshot } from "./import-export.mjs";

// Source ingestion is not model-context capacity. Collector-shaped fixtures in
// review-input.test.mjs measure 474,656 source bytes for 1,000 assets and 5,684,349
// for three characters/12,000 assets (pretty-printed envelopes included). 64 MiB
// allows >11x the larger measured case while bounding file reads and leaving
// room for collector wrappers and unknown payload fields. The collector's 32 MiB
// upstream budget does NOT guarantee a <=64 MiB export; larger
// exports are rejected, never sampled. The adapter must preflight the full packet.
const SOURCE_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

function textBytes(text) {
  if (typeof text !== "string" || !text.trim()) throw new BundleError("INVALID_SCHEMA");
  if (!text.isWellFormed()) throw new BundleError("INVALID_UTF8");
  return Buffer.byteLength(text, "utf8");
}

function validateTextInputs(interview, notes) {
  if (textBytes(interview) > TEXT_LIMIT) throw new BundleError("REVIEW_INPUT_TOO_LARGE");
  validateNotes(notes);
}

function validateNotes(notes) {
  if (!Array.isArray(notes)) throw new BundleError("INVALID_SCHEMA");
  let total = 0;
  for (const note of notes) {
    total += textBytes(note);
    if (total > TEXT_LIMIT) throw new BundleError("REVIEW_INPUT_TOO_LARGE");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function freezeReview(review) {
  const pending = [review];
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) pending.push(child);
  }
  return review;
}

function buildReview({ exportText, exportSha256, interview, context, confirmedBy }) {
  // The decoded source retains its BOM, if any; JSON's grammar excludes it.
  const snapshot = parseSnapshot(exportText.replace(/^\uFEFF/, ""));
  const { packet, citationIndex } = prepareInputs(
    { manifest: snapshot.manifest, interview, records: snapshot.records, context },
    { evaluation: false, confirmedBy },
  );
  const source = {
    accountId: snapshot.accountId,
    bundleId: snapshot.manifest.bundleId,
    revision: snapshot.manifest.revision,
    sha256: exportSha256,
  };
  // A structured encoding prevents ambiguous concatenation. Both original bytes
  // (including BOM/whitespace) and decoded text are bound, without path or clock
  // reads during updates. Preparation metadata belongs to the frozen case.
  const fingerprint = sha256(
    JSON.stringify({ exportSha256, exportText, interview, context, confirmedBy }),
  );
  packet.bundle.revision = `r-${fingerprint}`;
  citationIndex.revision = packet.bundle.revision;
  let packetText;
  try {
    packetText = JSON.stringify(packet);
  } catch {
    throw new BundleError("INVALID_SCHEMA");
  }
  return freezeReview({
    packet,
    citationIndex,
    packetText,
    fingerprint,
    source,
    interview,
    exportText,
  });
}

async function readSource(path) {
  if (typeof path !== "string" || !path.trim()) throw new BundleError("INVALID_SCHEMA");
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new BundleError("READ_FAILED");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BundleError("UNSAFE_FILE");
  let bytes;
  try {
    bytes = await readBounded(path, SOURCE_LIMIT);
  } catch (error) {
    if (error instanceof BundleError && error.code === "INPUT_TOO_LARGE") {
      throw new BundleError("REVIEW_INPUT_TOO_LARGE");
    }
    throw error;
  }
  let exportText;
  try {
    exportText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BundleError("INVALID_UTF8");
  }
  return { exportText, exportSha256: sha256(bytes) };
}

/** Read only the explicitly selected export; never publish or modify source files. */
export async function prepareReview({
  exportPath,
  interview,
  notes = [],
  confirmedBy = null,
  now = new Date().toISOString(),
}) {
  validateTextInputs(interview, notes);
  return buildReview({
    ...(await readSource(exportPath)),
    interview,
    confirmedBy,
    context: {
      preparedBy: "recruitment-review",
      preparedAt: now,
      notes: notes.map((text, index) => ({
        id: `context-${index + 1}`,
        text,
        source: "Recruiter input",
        asOf: null,
      })),
    },
  });
}

function buildExistingReview({ exportText, exportSha256, context = null }) {
  try {
    const original = JSON.parse(exportText.replace(/^\uFEFF/, ""));
    assertNoCredentialKeys(original);
    // Only the numbered text survives in old packets. Reconstruct a canonical
    // LF view, not purported original transcript bytes; the extra terminator
    // preserves a final blank physical line when prepareInputs numbers it again.
    const interview = `${original.interview.lines.map((line) => line.text).join("\n")}\n`;
    const inputs = {
      manifest: {
        version: 1,
        bundleId: original.bundle.id,
        revision: original.bundle.revision,
        collectedAt: original.bundle.collectedAt,
        declaredCharacterIds: original.coverage.declaredCharacterIds,
        includedCharacterIds: original.coverage.includedCharacterIds,
        provenance: original.provenance,
        datasets: original.coverage.datasets,
      },
      interview,
      records: original.records.map((record) => {
        const input = { ...record };
        delete input.verification;
        return input;
      }),
      context: original.context,
    };
    const options = {
      evaluation: original.preparation.evaluation,
      confirmedBy: original.preparation.confirmedBy,
    };
    let prepared = prepareInputs(inputs, options);
    // Exact round-trip equality also checks all wrapper keys, sequential line
    // numbers and supplied verification flags. Never silently repair/promote a
    // claimed historical handoff; it remains a claim in the selected source.
    if (!isDeepStrictEqual(prepared.packet, original))
      throw new BundleError("INVALID_SCHEMA");
    if (context !== null) {
      // Historical text is bounded by the selected packet's source limit, not
      // today's raw-paste policy. Bound only the newly added human context.
      validateNotes(
        context.notes.slice(original.context.notes.length).map((note) => note.text),
      );
      prepared = prepareInputs({ ...inputs, context }, options);
    }
    const { packet, citationIndex } = prepared;
    const fingerprint = sha256(
      JSON.stringify({
        exportSha256,
        exportText,
        interview,
        context: packet.context,
        confirmedBy: options.confirmedBy,
      }),
    );
    if (context !== null) {
      packet.bundle.revision = `r-${fingerprint}`;
      citationIndex.revision = packet.bundle.revision;
    }
    return freezeReview({
      ...prepared,
      packetText: JSON.stringify(packet),
      fingerprint,
      source: {
        accountId: null,
        bundleId: original.bundle.id,
        revision: original.bundle.revision,
        sha256: exportSha256,
      },
      interview,
      exportText,
      kind: "prepared",
    });
  } catch (error) {
    if (error instanceof BundleError) throw error;
    throw new BundleError("INVALID_SCHEMA");
  }
}

/** Explicit advanced intake only; raw exports are never detected or promoted here. */
export async function prepareExistingReview({ packetPath }) {
  return buildExistingReview(await readSource(packetPath));
}

/** Append user context to the same frozen source; the external path is not retained. */
export function addReviewNote(review, text) {
  const ids = new Set(review.packet.context.notes.map((note) => note.id));
  let number = ids.size + 1;
  while (ids.has(`context-${number}`)) number++;
  const notes = [
    ...review.packet.context.notes,
    {
      id: `context-${number}`,
      text,
      source: "Recruiter input",
      asOf: null,
    },
  ];
  if (review.kind === "prepared") {
    return buildExistingReview({
      exportText: review.exportText,
      exportSha256: review.source.sha256,
      context: { ...review.packet.context, notes },
    });
  }
  validateTextInputs(
    review.interview,
    notes.map((note) => note.text),
  );
  return buildReview({
    exportText: review.exportText,
    exportSha256: review.source.sha256,
    interview: review.interview,
    context: { ...review.packet.context, notes },
    confirmedBy: review.packet.preparation.confirmedBy,
  });
}
