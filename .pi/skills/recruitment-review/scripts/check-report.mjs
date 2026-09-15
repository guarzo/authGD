import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { TextDecoder } from "node:util";
import { BundleError, prepareBundle } from "./bundle.mjs";
import { parseCheckReportArguments, renderPreparationAbort } from "./cli.mjs";
import { SAFE_ID_PATTERN, isSafeId, isUtcTimestamp } from "./syntax.mjs";

const REPORT_LIMIT = 128 * 1024;
const INTERVIEW_CITATION = /^\[interview:L([1-9]\d*)-L([1-9]\d*)\]/;
const RECORD_CITATION = new RegExp(`^\\[record:(${SAFE_ID_PATTERN})\\]`);
const CONTEXT_CITATION = new RegExp(`^\\[context:(${SAFE_ID_PATTERN})\\]`);
const BUNDLE_MARKER = new RegExp(`^Bundle: (${SAFE_ID_PATTERN})@(${SAFE_ID_PATTERN})$`);
const ASSESSMENT_MARKER =
  "Assessment status: DRAFT — human recruiter review required; not an admission decision";
const COMPLETED_HEADINGS = [
  "## Coverage and limitations",
  "## Claim review",
  "## Material findings",
  "## Follow-up questions",
  "## Bottom line",
];
const COMPLETED_SECTION_ERRORS = [
  "EMPTY_COVERAGE_AND_LIMITATIONS",
  "EMPTY_CLAIM_REVIEW",
  "EMPTY_MATERIAL_FINDINGS",
  "EMPTY_FOLLOW_UP_QUESTIONS",
  "EMPTY_BOTTOM_LINE",
];
const COVERAGE_FIELDS = [
  [["Snapshot", "Snapshot and scope"], "MISSING_COVERAGE_SNAPSHOT"],
  [
    ["Character scope", "Characters", "Scope", "Omissions and review scope"],
    "MISSING_CHARACTER_SCOPE",
  ],
  [["Dataset coverage"], "MISSING_DATASET_COVERAGE"],
  [
    ["Provenance", "Provenance and verification", "Records and verification"],
    "MISSING_PROVENANCE",
  ],
  [
    [
      "Verification",
      "Provenance and verification",
      "Records and verification",
      "Handoff and verification",
      "Confirmation and verification",
      "External confirmation",
      "External assertion",
      "Handoff assertion",
    ],
    "MISSING_RECORD_VERIFICATION",
  ],
  [["Synthetic-only", "Evaluation"], "MISSING_SYNTHETIC_ONLY_STATE"],
  [
    [
      "Limitations and unexamined inputs",
      "Review scope",
      "Review extent",
      "Unexamined inputs",
      "Review completeness",
      "Evidence limitations",
      "Semantic omissions",
      "Evidence omissions",
      "Omissions and review scope",
      "Inputs reviewed",
    ],
    "MISSING_REVIEW_LIMITATIONS",
  ],
];
const CLAIM_FIELDS = [
  ["Applicant claim", "MISSING_APPLICANT_CLAIM"],
  ["Evidence", "MISSING_CLAIM_EVIDENCE"],
  ["Assessment", "MISSING_CLAIM_ASSESSMENT"],
  ["Limits", "MISSING_CLAIM_LIMITS"],
  ["Plausible alternatives", "MISSING_PLAUSIBLE_ALTERNATIVES"],
];
const ASSESSMENTS = new Set([
  "supported",
  "contradicted",
  "tension",
  "unknown / not assessable",
]);
const MATERIAL_SUBSECTIONS = [
  ["### Direct contradictions", "MISSING_DIRECT_CONTRADICTIONS"],
  ["### Tensions", "MISSING_TENSIONS"],
  ["### Unknowns and gaps", "MISSING_UNKNOWNS_AND_GAPS"],
];
const BOTTOM_LINES = [
  "No material inconsistencies found within stated coverage",
  "Clarification needed",
  "Insufficient evidence",
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

function markerLines(lines, prefix) {
  return lines.filter((line) => line.startsWith(prefix));
}

function hasOneNonEmptyMarker(lines, prefix) {
  const matches = markerLines(lines, prefix);
  return matches.length === 1 && matches[0].slice(prefix.length).trim().length > 0;
}

function sectionBodies(lines, headings) {
  return headings.map((heading, index) => {
    const start = lines.indexOf(heading) + 1;
    const end =
      index + 1 < headings.length ? lines.indexOf(headings[index + 1]) : lines.length;
    return lines.slice(start, end).join("\n").trim();
  });
}

function parseLabelLine(line) {
  const match =
    /^\s*(?:[-*]\s+)?(?:(?:\*\*([^:*\n]+):\*\*)|(?:\*\*([^:*\n]+)\*\*:)|([^:*\n]+):)\s*(.*)$/.exec(
      line,
    );
  if (match === null) return null;
  return { label: (match[1] ?? match[2] ?? match[3]).trim(), value: match[4] };
}

function fieldValue(lines, markerIndex, initialValue, fieldMarkers) {
  const nextMarker = fieldMarkers.find(({ index }) => index > markerIndex);
  return [
    initialValue,
    ...lines.slice(markerIndex + 1, nextMarker?.index ?? lines.length),
  ]
    .join("\n")
    .trim();
}

function markdownItems(content) {
  const items = [];
  let current = null;
  let afterBlank = false;

  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      afterBlank = true;
      continue;
    }

    const numbered = /^(\d+)\.\s+(\S.*)$/.exec(line);
    const bullet = /^[-*]\s+(\S.*)$/.exec(line);
    if (numbered !== null || bullet !== null) {
      current = {
        kind: numbered === null ? "bullet" : "numbered",
        text: numbered === null ? bullet[1] : numbered[2],
      };
      items.push(current);
    } else if (current === null || (afterBlank && !/^\s/.test(line))) {
      current = { kind: "paragraph", text: line.trim() };
      items.push(current);
    } else {
      current.text += `\n${line.trim()}`;
    }
    afterBlank = false;
  }

  return items;
}

function validateCoverage(body, errors) {
  const lines = body.split(/\r?\n/);
  const coverageLabels = new Set(COVERAGE_FIELDS.flatMap(([labels]) => labels));
  const fieldMarkers = lines.flatMap((line, index) => {
    const parsed = parseLabelLine(line);
    return parsed !== null && coverageLabels.has(parsed.label)
      ? [{ index, ...parsed }]
      : [];
  });

  for (const [labels, missingError] of COVERAGE_FIELDS) {
    const hasContent = fieldMarkers.some(
      ({ index, label, value }) =>
        labels.includes(label) &&
        fieldValue(lines, index, value, fieldMarkers).length > 0,
    );
    const hasDatasetTable =
      missingError === "MISSING_DATASET_COVERAGE" &&
      /^\s*\|\s*(?:(?:Dataset|Category)\s*\|\s*Status|Character\s*\|\s*(?:Category|Dataset)\s*\|\s*Status)\s*\|/im.test(
        body,
      );
    if (!hasContent && !hasDatasetTable) errors.add(missingError);
  }
}

function validateClaimReview(body, errors) {
  if (
    /^No material checkable applicant claims identified in the supplied interview\.$/i.test(
      body,
    )
  ) {
    return;
  }

  const lines = body.split(/\r?\n/);
  const claimStarts = lines.flatMap((line, index) =>
    /^### Claim(?:\s+\S.*)?$/.test(line) ? [index] : [],
  );
  if (claimStarts.length === 0) {
    errors.add("INVALID_CLAIM_REVIEW");
    return;
  }

  for (const [claimOffset, start] of claimStarts.entries()) {
    const end = claimStarts[claimOffset + 1] ?? lines.length;
    const claimLines = lines.slice(start + 1, end);
    const fieldMarkers = claimLines.flatMap((line, index) => {
      const parsed = parseLabelLine(line);
      return parsed !== null && CLAIM_FIELDS.some(([field]) => field === parsed.label)
        ? [{ index, ...parsed }]
        : [];
    });

    let previousIndex = -1;
    const values = new Map();
    for (const [field, missingError] of CLAIM_FIELDS) {
      const matches = fieldMarkers.filter(({ label }) => label === field);
      if (matches.length !== 1) {
        errors.add(matches.length === 0 ? missingError : "DUPLICATE_CLAIM_FIELD");
        continue;
      }
      const [{ index, value: initialValue }] = matches;
      if (index <= previousIndex) errors.add("INVALID_CLAIM_FIELD_ORDER");
      previousIndex = index;
      const value = fieldValue(claimLines, index, initialValue, fieldMarkers);
      if (value.length === 0) {
        errors.add(missingError);
      } else {
        values.set(field, value);
      }
    }

    const applicantClaim = values.get("Applicant claim");
    if (applicantClaim !== undefined) {
      const { citations, malformed } = scanCitations(applicantClaim);
      if (!malformed && !citations.some((citation) => citation.type === "interview")) {
        errors.add("MISSING_APPLICANT_CITATION");
      }
    }

    const assessment = values
      .get("Assessment")
      ?.replace(/^\*\*(.*?)\*\*$/, "$1")
      .trim();
    if (assessment !== undefined && !ASSESSMENTS.has(assessment)) {
      errors.add("INVALID_CLAIM_ASSESSMENT");
    }

    const evidence = values.get("Evidence");
    if (evidence !== undefined) {
      const { citations, malformed } = scanCitations(evidence);
      const noUsableRecord =
        evidence === "No usable record exists in the supplied packet.";
      const evidenceLines = evidence.split(/\r?\n/);
      const metadata = parseLabelLine(evidenceLines[0]);
      const packetMetadata = metadata?.label === "Packet metadata";
      if (packetMetadata) {
        const metadataValue = [metadata.value, ...evidenceLines.slice(1)]
          .join("\n")
          .trim();
        if (metadataValue.length === 0) errors.add("EMPTY_PACKET_METADATA_EVIDENCE");
      } else if (noUsableRecord) {
        if (assessment !== "unknown / not assessable") {
          errors.add("INVALID_NO_RECORD_ASSESSMENT");
        }
      } else if (
        !malformed &&
        !citations.some((citation) => citation.type === "record")
      ) {
        errors.add("MISSING_EVIDENCE_CITATION");
      }
    }
  }
}

function validateMaterialFindings(body, errors) {
  const lines = body.split(/\r?\n/);
  let previousIndex = -1;
  for (const [heading, missingError] of MATERIAL_SUBSECTIONS) {
    const indexes = lines.flatMap((line, index) => (line === heading ? [index] : []));
    if (indexes.length !== 1 || indexes[0] <= previousIndex) {
      errors.add(missingError);
      continue;
    }
    previousIndex = indexes[0];
    const nextHeading = MATERIAL_SUBSECTIONS.find(
      ([candidate]) => lines.indexOf(candidate) > indexes[0],
    );
    const end = nextHeading === undefined ? lines.length : lines.indexOf(nextHeading[0]);
    const content = lines
      .slice(indexes[0] + 1, end)
      .join("\n")
      .trim();
    if (content.length === 0) {
      errors.add(missingError);
      continue;
    }
    if (
      content === "None identified." ||
      content === "None identified within the supplied coverage."
    ) {
      continue;
    }

    for (const item of markdownItems(content)) {
      const itemLines = item.text.split(/\r?\n/);
      const metadata = parseLabelLine(itemLines[0]);
      const isMetadata =
        heading === "### Unknowns and gaps" &&
        (metadata?.label === "Coverage" || metadata?.label === "Provenance");
      if (isMetadata) {
        const value = [metadata.value, ...itemLines.slice(1)].join("\n").trim();
        if (value.length === 0) errors.add("EMPTY_MATERIAL_METADATA");
      } else if (scanCitations(item.text).citations.length === 0) {
        errors.add("MISSING_MATERIAL_FINDING_CITATION");
      }
    }
  }
}

function validateFollowUpQuestions(body, errors) {
  if (/^No follow-up questions needed based on the supplied packet\.$/i.test(body)) {
    return;
  }

  for (const item of markdownItems(body)) {
    if (item.kind !== "numbered") {
      errors.add("INVALID_FOLLOW_UP_QUESTIONS");
      continue;
    }
    const itemLines = item.text.split(/\r?\n/);
    const repair = parseLabelLine(itemLines[0]);
    if (repair?.label === "Coverage repair") {
      const value = [repair.value, ...itemLines.slice(1)].join("\n").trim();
      if (value.length === 0) errors.add("EMPTY_COVERAGE_REPAIR");
    } else if (scanCitations(item.text).citations.length === 0) {
      errors.add("MISSING_FOLLOW_UP_CITATION");
    }
  }
}

function validateBottomLine(body, errors) {
  const normalized = body.replaceAll("**", "").trim();
  const category = BOTTOM_LINES.find(
    (candidate) =>
      normalized.startsWith(candidate) &&
      /^[\s,.:;—-]/.test(normalized.slice(candidate.length, candidate.length + 1)),
  );
  if (category === undefined) {
    errors.add("INVALID_BOTTOM_LINE");
    return;
  }

  const explanation = normalized
    .slice(category.length)
    .replace(/^[,.:;—-]\s*/, "")
    .trim();
  if (explanation.length === 0) errors.add("INVALID_BOTTOM_LINE");
}

function scanCitations(text) {
  const citations = [];
  let malformed = false;
  const starts = /\[(?:interview|record|context)\b/gi;
  let candidate;
  while ((candidate = starts.exec(text)) !== null) {
    const remainder = text.slice(candidate.index);
    const interview = INTERVIEW_CITATION.exec(remainder);
    if (interview !== null) {
      citations.push({ type: "interview", start: interview[1], end: interview[2] });
      starts.lastIndex = candidate.index + interview[0].length;
      continue;
    }
    const record = RECORD_CITATION.exec(remainder);
    if (record !== null) {
      citations.push({ type: "record", id: record[1] });
      starts.lastIndex = candidate.index + record[0].length;
      continue;
    }
    const context = CONTEXT_CITATION.exec(remainder);
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
    !isSafeId(citationIndex.bundleId) ||
    !isSafeId(citationIndex.revision) ||
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
    bundleMarkers.length === 1 ? BUNDLE_MARKER.exec(bundleMarkers[0]) : null;
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
    let validStructure = true;
    for (const heading of COMPLETED_HEADINGS) {
      const indexes = lines.flatMap((line, index) => (line === heading ? [index] : []));
      if (indexes.length !== 1 || indexes[0] <= previousIndex) {
        errors.add("INVALID_COMPLETED_STRUCTURE");
        validStructure = false;
      } else {
        previousIndex = indexes[0];
      }
    }
    if (validStructure) {
      const bodies = sectionBodies(lines, COMPLETED_HEADINGS);
      for (const [index, body] of bodies.entries()) {
        if (body.length === 0) errors.add(COMPLETED_SECTION_ERRORS[index]);
      }
      if (bodies[0].length > 0) validateCoverage(bodies[0], errors);
      if (bodies[1].length > 0) validateClaimReview(bodies[1], errors);
      if (bodies[2].length > 0) validateMaterialFindings(bodies[2], errors);
      if (bodies[3].length > 0) validateFollowUpQuestions(bodies[3], errors);
      if (bodies[4].length > 0) validateBottomLine(bodies[4], errors);
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
