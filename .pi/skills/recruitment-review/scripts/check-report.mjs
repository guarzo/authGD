import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { TextDecoder } from "node:util";
import { BundleError, prepareBundle } from "./bundle.mjs";
import { parseCheckReportArguments, renderPreparationAbort } from "./cli.mjs";

const REPORT_LIMIT = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const ASSESSMENT_MARKER =
  "Assessment status: DRAFT — human recruiter review required; not an admission decision";
const COMPLETED_HEADINGS = [
  "## Coverage and limitations",
  "## Claim review",
  "## Material findings",
  "## Follow-up questions",
  "## Bottom line",
];
const ABORTED_FIELDS = [
  "Blocking reason: ",
  "Unreviewed inputs: ",
  "Corrective action: ",
];
const USAGE =
  "Usage: node scripts/check-report.mjs <bundle-directory> <report-file> [--evaluation] [--confirmed-by <recruiter>]\n";

class ReportInputError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReportInputError";
    this.code = code;
  }
}

function isUtcTimestamp(value) {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function markerLines(lines, prefix) {
  return lines.filter((line) => line.startsWith(prefix));
}

function hasOneNonEmptyMarker(lines, prefix) {
  const matches = markerLines(lines, prefix);
  return matches.length === 1 && matches[0].slice(prefix.length).trim().length > 0;
}

function scanCitations(text) {
  const citations = [];
  let malformed = false;
  const starts = /\[(?:interview|record|context)\b/gi;
  let candidate;
  while ((candidate = starts.exec(text)) !== null) {
    const remainder = text.slice(candidate.index);
    const interview = /^\[interview:L([1-9]\d*)-L([1-9]\d*)\]/.exec(remainder);
    if (interview !== null) {
      citations.push({ type: "interview", start: interview[1], end: interview[2] });
      starts.lastIndex = candidate.index + interview[0].length;
      continue;
    }
    const record = /^\[record:([A-Za-z0-9_-]{1,128})\]/.exec(remainder);
    if (record !== null) {
      citations.push({ type: "record", id: record[1] });
      starts.lastIndex = candidate.index + record[0].length;
      continue;
    }
    const context = /^\[context:([A-Za-z0-9_-]{1,128})\]/.exec(remainder);
    if (context !== null) {
      citations.push({ type: "context", id: context[1] });
      starts.lastIndex = candidate.index + context[0].length;
      continue;
    }
    malformed = true;
  }
  return { citations, malformed };
}

export function checkReport(text, prepared) {
  const errors = new Set();
  if (typeof text !== "string") {
    return { ok: false, errors: ["INVALID_REPORT"] };
  }
  if (Buffer.byteLength(text, "utf8") > REPORT_LIMIT) {
    return { ok: false, errors: ["REPORT_TOO_LARGE"] };
  }

  const citationIndex = prepared?.citationIndex;
  if (
    citationIndex === null ||
    typeof citationIndex !== "object" ||
    !SAFE_ID.test(citationIndex.bundleId ?? "") ||
    !SAFE_ID.test(citationIndex.revision ?? "") ||
    !Number.isSafeInteger(citationIndex.transcriptLineCount) ||
    citationIndex.transcriptLineCount < 1 ||
    !Array.isArray(citationIndex.recordIds) ||
    !Array.isArray(citationIndex.contextIds)
  ) {
    return { ok: false, errors: ["INVALID_PREPARED_BUNDLE"] };
  }

  const lines = text.split(/\r?\n/);
  const bundleMarkers = markerLines(lines, "Bundle:");
  const statusMarkers = markerLines(lines, "Review status:");
  const bundleMatch =
    bundleMarkers.length === 1
      ? /^Bundle: ([A-Za-z0-9_-]{1,128})@([A-Za-z0-9_-]{1,128})$/.exec(bundleMarkers[0])
      : null;
  const statusMatch =
    statusMarkers.length === 1
      ? /^Review status: (completed|aborted)$/.exec(statusMarkers[0])
      : null;

  if (bundleMatch === null || lines[0] !== bundleMarkers[0]) {
    errors.add("INVALID_BUNDLE_MARKER");
  } else if (
    bundleMatch[1] !== citationIndex.bundleId ||
    bundleMatch[2] !== citationIndex.revision
  ) {
    errors.add("BUNDLE_IDENTITY_MISMATCH");
  }
  if (statusMatch === null || lines[1] !== statusMarkers[0]) {
    errors.add("INVALID_STATUS_MARKER");
  }

  if (!hasOneNonEmptyMarker(lines, "Skill version: ")) {
    errors.add("INVALID_SKILL_VERSION_MARKER");
  }
  if (!hasOneNonEmptyMarker(lines, "Model: ")) {
    errors.add("INVALID_MODEL_MARKER");
  }
  if (lines.filter((line) => line === ASSESSMENT_MARKER).length !== 1) {
    errors.add("INVALID_ASSESSMENT_MARKER");
  }

  const { citations, malformed } = scanCitations(text);
  if (malformed) errors.add("MALFORMED_CITATION");

  for (const citation of citations) {
    if (citation.type === "interview") {
      const start = Number(citation.start);
      const end = Number(citation.end);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end > citationIndex.transcriptLineCount
      ) {
        errors.add("INVALID_INTERVIEW_RANGE");
      }
    } else if (
      citation.type === "record" &&
      !citationIndex.recordIds.includes(citation.id)
    ) {
      errors.add("UNKNOWN_RECORD_CITATION");
    } else if (
      citation.type === "context" &&
      !citationIndex.contextIds.includes(citation.id)
    ) {
      errors.add("UNKNOWN_CONTEXT_CITATION");
    }
  }

  if (statusMatch?.[1] === "completed") {
    let previousIndex = -1;
    for (const heading of COMPLETED_HEADINGS) {
      const indexes = lines.flatMap((line, index) => (line === heading ? [index] : []));
      if (indexes.length !== 1 || indexes[0] <= previousIndex) {
        errors.add("INVALID_COMPLETED_STRUCTURE");
      } else {
        previousIndex = indexes[0];
      }
    }
    if (
      markerLines(lines, "Attempted review timestamp:").length > 0 ||
      ABORTED_FIELDS.some((prefix) => markerLines(lines, prefix).length > 0)
    ) {
      errors.add("CONFLICTING_REPORT_STRUCTURE");
    }
  } else if (statusMatch?.[1] === "aborted") {
    const attempted = markerLines(lines, "Attempted review timestamp:");
    if (
      attempted.length !== 1 ||
      !(
        attempted[0] === "Attempted review timestamp: unavailable" ||
        isUtcTimestamp(attempted[0].slice("Attempted review timestamp: ".length))
      )
    ) {
      errors.add("INVALID_ABORT_TIMESTAMP");
    }
    for (const prefix of ABORTED_FIELDS) {
      if (!hasOneNonEmptyMarker(lines, prefix)) errors.add("MISSING_ABORT_FIELD");
    }
    if (
      COMPLETED_HEADINGS.some((heading) => lines.includes(heading)) ||
      citations.length > 0
    ) {
      errors.add("CONFLICTING_REPORT_STRUCTURE");
    }
  }

  return { ok: errors.size === 0, errors: [...errors] };
}

async function readReport(path) {
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch {
    throw new ReportInputError("REPORT_READ_FAILED");
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new ReportInputError("UNSAFE_REPORT_FILE");
  }
  if (pathStat.size > REPORT_LIMIT) {
    throw new ReportInputError("REPORT_TOO_LARGE");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) throw new ReportInputError("UNSAFE_REPORT_FILE");
    if (descriptorStat.size > REPORT_LIMIT) {
      throw new ReportInputError("REPORT_TOO_LARGE");
    }

    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, REPORT_LIMIT - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > REPORT_LIMIT) throw new ReportInputError("REPORT_TOO_LARGE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, total),
      );
    } catch {
      throw new ReportInputError("INVALID_REPORT_UTF8");
    }
  } catch (error) {
    if (error instanceof ReportInputError) throw error;
    if (error && typeof error === "object" && error.code === "ELOOP") {
      throw new ReportInputError("UNSAFE_REPORT_FILE");
    }
    throw new ReportInputError("REPORT_READ_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function main() {
  const parsed = parseCheckReportArguments(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  let prepared;
  try {
    prepared = await prepareBundle(parsed.root, parsed.options);
  } catch (error) {
    const safeError =
      error instanceof BundleError ? error : new BundleError("READ_FAILED");
    process.stderr.write(renderPreparationAbort(safeError));
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = await readReport(parsed.reportPath);
  } catch (error) {
    const code = error instanceof ReportInputError ? error.code : "REPORT_READ_FAILED";
    process.stderr.write(`Report error: ${code}\n`);
    process.exitCode = 1;
    return;
  }

  const result = checkReport(report, prepared);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`Report error: ${error}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
