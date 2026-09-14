import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkReport } from "../scripts/check-report.mjs";
import { makeBundle, writeBundle } from "./fixtures.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageRoot, "scripts", "check-report.mjs");
const prepareCliPath = join(packageRoot, "scripts", "prepare.mjs");
const skillPath = join(packageRoot, "SKILL.md");
const inputFormatPath = join(packageRoot, "references", "input-format.md");
const rubricPath = join(packageRoot, "references", "review-rubric.md");

const prepared = {
  packet: {},
  citationIndex: {
    bundleId: "sample",
    revision: "v1",
    transcriptLineCount: 2,
    recordIds: ["W001"],
    contextIds: ["C001"],
  },
};

const validReport = `Bundle: sample@v1
Review status: completed
Skill version: unavailable
Model: unavailable
Assessment status: DRAFT — human recruiter review required; not an admission decision

## Coverage and limitations
The supplied packet covers the stated scope.

## Claim review
### Claim 1
- Applicant claim: “The exchange happened.” [interview:L1-L2]
- Evidence: A supplied record exists. [record:W001] [context:C001]
- Assessment: supported
- Limits: Citation existence does not establish semantic support.
- Plausible alternatives: None apparent from the supplied packet.

## Material findings
None identified within the supplied coverage.

## Follow-up questions
1. Please clarify the exchange.

## Bottom line
No material inconsistencies found within stated coverage.
`;

const validAbortedReport = `Bundle: sample@v1
Review status: aborted
Skill version: unavailable
Model: unavailable
Assessment status: DRAFT — human recruiter review required; not an admission decision
Attempted review timestamp: 2026-09-14T12:00:00Z
Blocking reason: The complete packet was not available to the reviewer.
Unreviewed inputs: Complete prepared packet.
Corrective action: Re-prepare safely and provide the complete packet.
`;

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "recruitment-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bundleDirectory(t, overrides = {}) {
  const sandbox = await temporaryDirectory(t);
  const root = join(sandbox, "bundle");
  await writeBundle(root, makeBundle(overrides));
  return { root, sandbox };
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

function fencedTemplate(source, heading) {
  const marker = `## ${heading}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${heading} heading is missing`);
  const match = /```markdown\n([\s\S]*?)\n```/.exec(source.slice(start + marker.length));
  assert.ok(match, `${heading} fenced template is missing`);
  return match[1];
}

test("accepts a completed report with exact identity, shape, and known citations", () => {
  assert.deepEqual(checkReport(validReport, prepared), { ok: true, errors: [] });
});

test("rejects an unknown record citation", () => {
  const result = checkReport(
    validReport.replace("[record:W001]", "[record:UNKNOWN]"),
    prepared,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("UNKNOWN_RECORD_CITATION"));
});

test("rejects a report from another bundle revision", () => {
  assert.equal(
    checkReport(validReport.replace("sample@v1", "sample@v0"), prepared).ok,
    false,
  );
});

test("rejects missing and conflicting identity or status markers", () => {
  const cases = [
    validReport.replace("Bundle: sample@v1\n", ""),
    validReport.replace("Bundle: sample@v1\n", "Bundle: sample@v1\nBundle: sample@v0\n"),
    validReport.replace("Review status: completed\n", ""),
    validReport.replace(
      "Review status: completed\n",
      "Review status: completed\nReview status: aborted\n",
    ),
    validReport.replace("Review status: completed", "Review status: pending"),
  ];

  for (const report of cases) assert.equal(checkReport(report, prepared).ok, false);
});

test("requires all five completed headings exactly once and in order", () => {
  const headings = [
    "## Coverage and limitations",
    "## Claim review",
    "## Material findings",
    "## Follow-up questions",
    "## Bottom line",
  ];
  for (const heading of headings) {
    assert.equal(
      checkReport(validReport.replace(`${heading}\n`, ""), prepared).ok,
      false,
    );
  }
  assert.equal(
    checkReport(
      validReport.replace(
        "## Claim review",
        "## Bottom line\nMoved too early.\n\n## Claim review",
      ),
      prepared,
    ).ok,
    false,
  );
});

test("rejects reversed, out-of-range, zero, and non-integer transcript ranges", () => {
  for (const citation of [
    "[interview:L2-L1]",
    "[interview:L1-L3]",
    "[interview:L0-L1]",
    "[interview:L1.5-L2]",
  ]) {
    const report = validReport.replace("[interview:L1-L2]", citation);
    assert.equal(checkReport(report, prepared).ok, false, citation);
  }
});

test("rejects malformed citation tokens", () => {
  for (const citation of [
    "[interview:L1]",
    "[interview:L1-L2-L3]",
    "[record:]",
    "[record:W001 extra]",
    "[context:C001",
    "[Record:W001]",
  ]) {
    const report = validReport.replace("[record:W001]", citation);
    assert.equal(checkReport(report, prepared).ok, false, citation);
  }
});

test("rejects an unknown context citation", () => {
  const report = validReport.replace("[context:C001]", "[context:UNKNOWN]");
  assert.equal(checkReport(report, prepared).ok, false);
});

test("accepts an aborted report with known identity and all required fields", () => {
  assert.equal(checkReport(validAbortedReport, prepared).ok, true);
});

test("requires exact spacing for metadata and aborted-field markers", () => {
  assert.equal(
    checkReport(
      validReport.replace("Skill version: unavailable", "Skill version:unavailable"),
      prepared,
    ).ok,
    false,
  );
  assert.equal(
    checkReport(
      validAbortedReport.replace(
        "Blocking reason: The complete packet",
        "Blocking reason:The complete packet",
      ),
      prepared,
    ).ok,
    false,
  );
});

test("rejects an aborted report missing any required field", () => {
  for (const marker of [
    "Skill version: unavailable\n",
    "Model: unavailable\n",
    "Assessment status: DRAFT — human recruiter review required; not an admission decision\n",
    "Attempted review timestamp: 2026-09-14T12:00:00Z\n",
    "Blocking reason: The complete packet was not available to the reviewer.\n",
    "Unreviewed inputs: Complete prepared packet.\n",
    "Corrective action: Re-prepare safely and provide the complete packet.\n",
  ]) {
    assert.equal(
      checkReport(validAbortedReport.replace(marker, ""), prepared).ok,
      false,
      marker,
    );
  }
});

test("rejects completed-report sections and citations in an aborted artifact", () => {
  assert.equal(
    checkReport(`${validAbortedReport}\n## Bottom line\nA finding.\n`, prepared).ok,
    false,
  );
  assert.equal(
    checkReport(
      validAbortedReport.replace("Blocking reason: ", "Blocking reason: [record:W001] "),
      prepared,
    ).ok,
    false,
  );
});

test("does not claim to judge whether cited conclusions are semantically true", () => {
  const semanticallyWrong = validReport.replace(
    "No material inconsistencies found within stated coverage.",
    "The applicant is cleared because this record proves every claim is true.",
  );
  assert.equal(checkReport(semanticallyWrong, prepared).ok, true);
});

test("rejects reports above the 128 KiB UTF-8 limit without echoing content", () => {
  const result = checkReport(`${validReport}${"SENSITIVE".repeat(20_000)}`, prepared);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("REPORT_TOO_LARGE"));
  assert.equal(
    result.errors.some((error) => error.includes("SENSITIVE")),
    false,
  );
});

test("references define citation-free model aborts separately from preparation diagnostics", async () => {
  const [inputFormat, rubric] = await Promise.all([
    readFile(inputFormatPath, "utf8"),
    readFile(rubricPath, "utf8"),
  ]);

  assert.match(rubric, /A model-aborted report contains no citations at all\./);
  assert.match(inputFormat, /A model-aborted report contains no citations at all\./);
  assert.match(
    inputFormat,
    /A CLI preparation failure emits a pipeline diagnostic with the validated bundle identity when available, otherwise `Bundle: unavailable`, and includes a real attempted-review timestamp\./,
  );
  assert.match(
    inputFormat,
    /A manual model invocation without a validated identity instead emits the five-line no-identity diagnostic/,
  );
  assert.match(
    inputFormat,
    /After successful preparation, a model report uses the actual validated identity and is submitted to `checkReport`/,
  );
  assert.match(
    rubric,
    /This five-line manual diagnostic is not the CLI preparation-failure diagnostic/,
  );
});

test("no-identity abort diagnostic is explicit and outside the report checker contract", async () => {
  const [skill, inputFormat, rubric] = await Promise.all([
    readFile(skillPath, "utf8"),
    readFile(inputFormatPath, "utf8"),
    readFile(rubricPath, "utf8"),
  ]);
  for (const source of [skill, inputFormat, rubric]) {
    assert.match(
      source,
      /not submitted to `checkReport` and cannot count as a completed check/,
    );
  }
  assert.match(skill, /a reported preparation failure supplied no validated identity/);

  const diagnostic = fencedTemplate(rubric, "No-identity abort diagnostic")
    .replace("<specific safe error or missing mandatory input>", "INVALID_SCHEMA")
    .replace("<files or packet not reviewed>", "Complete prepared packet")
    .replace("<provide or safely re-prepare the packet>", "Re-prepare the packet");

  assert.equal(
    diagnostic,
    [
      "Bundle: unavailable",
      "Review status: aborted",
      "Blocking reason: INVALID_SCHEMA",
      "Unreviewed inputs: Complete prepared packet",
      "Corrective action: Re-prepare the packet",
    ].join("\n"),
  );
  assert.doesNotMatch(diagnostic, /\[(?:interview|record|context):/);
  assert.doesNotMatch(diagnostic, /^(?:Skill version|Model|Assessment status):/m);
  const checked = checkReport(`${diagnostic}\n`, prepared);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("INVALID_BUNDLE_MARKER"));
});

test("rubric templates materialize to checker-compatible completed and aborted reports", async () => {
  const rubric = await readFile(rubricPath, "utf8");
  const normal = fencedTemplate(rubric, "Normal report template")
    .replace("<bundleId>@<revision>", "sample@v1")
    .replace(
      /<trustworthy invocation-reported skill version, or unavailable>/g,
      "unavailable",
    )
    .replace(/<actual host-reported model, or unavailable>/g, "unavailable")
    .replace(/<[^>]+>/g, "Supplied detail")
    .replace("[interview:Lx-Ly]", "[interview:L1-L2]")
    .replace("[record:ID]", "[record:W001]")
    .replace("[context:ID]", "[context:C001]");
  const aborted = fencedTemplate(rubric, "Aborted report template")
    .replace("<bundleId>@<revision>", "sample@v1")
    .replace(
      /<trustworthy invocation-reported skill version, or unavailable>/g,
      "unavailable",
    )
    .replace(/<actual host-reported model, or unavailable>/g, "unavailable")
    .replace(
      /<current UTC timestamp supplied by the host, or unavailable>/g,
      "unavailable",
    )
    .replace(/<[^>]+>/g, "Supplied detail");

  assert.equal(checkReport(`${normal}\n`, prepared).ok, true);
  assert.equal(checkReport(`${aborted}\n`, prepared).ok, true);
});

test("report CLI option parsing stays in parity with preparation", async (t) => {
  const { root, sandbox } = await bundleDirectory(t, {
    manifest: { bundleId: "sample", revision: "v1" },
    records: [
      {
        id: "W001",
        characterId: "character-1001",
        category: "wallet",
        provenanceId: "source-1",
        sourceRecordId: null,
        data: {},
      },
    ],
    context: {
      notes: [
        {
          id: "C001",
          text: "Illustrative context.",
          source: "Synthetic policy",
          asOf: null,
        },
      ],
    },
  });
  const reportPath = join(sandbox, "report.md");
  await writeFile(reportPath, validReport);

  const cases = [
    { suffix: [], status: 0 },
    { suffix: ["--evaluation"], status: 0 },
    { suffix: ["--confirmed-by", "recruiter-1"], status: 0 },
    {
      suffix: ["--evaluation", "--confirmed-by", "recruiter-1"],
      status: 0,
    },
    {
      suffix: ["--confirmed-by", "recruiter-1", "--evaluation"],
      status: 0,
    },
    { suffix: ["--unknown"], status: 2 },
    { suffix: ["--evaluation", "--evaluation"], status: 2 },
    {
      suffix: ["--confirmed-by", "one", "--confirmed-by", "two"],
      status: 2,
    },
    { suffix: ["--confirmed-by"], status: 2 },
    { suffix: ["--confirmed-by", "--evaluation"], status: 2 },
    { suffix: ["--confirmed-by", " "], status: 2 },
    { suffix: ["--confirmed-by", "x".repeat(129)], status: 2 },
    { suffix: ["extra-root"], status: 2 },
  ];

  for (const { suffix, status } of cases) {
    const preparation = spawnSync(process.execPath, [prepareCliPath, root, ...suffix], {
      encoding: "utf8",
    });
    const report = runCli([root, reportPath, ...suffix]);
    assert.deepEqual(
      [preparation.status, report.status],
      [status, status],
      JSON.stringify(suffix),
    );
  }
});

test("CLI validates completed and aborted reports and returns 1 for an invalid report", async (t) => {
  const { root, sandbox } = await bundleDirectory(t, {
    manifest: { bundleId: "sample", revision: "v1" },
    records: [
      {
        id: "W001",
        characterId: "character-1001",
        category: "wallet",
        provenanceId: "source-1",
        sourceRecordId: null,
        data: {},
      },
    ],
    context: {
      notes: [
        {
          id: "C001",
          text: "Illustrative context.",
          source: "Synthetic policy",
          asOf: null,
        },
      ],
    },
  });
  const reportPath = join(sandbox, "report.md");

  for (const report of [validReport, validAbortedReport]) {
    await writeFile(reportPath, report);
    const result = runCli([
      root,
      reportPath,
      "--evaluation",
      "--confirmed-by",
      "fixture-recruiter",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }

  await writeFile(reportPath, validReport.replace("[record:W001]", "[record:UNLISTED]"));
  const invalid = runCli([root, reportPath]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /UNKNOWN_RECORD_CITATION/);
  assert.equal(invalid.stderr.includes("UNLISTED"), false);
});

test("CLI aborts unsafe or uninterpretable preparation before opening the report", async (t) => {
  const cases = [
    {
      expected: "INVALID_SCHEMA",
      bundle: { ...makeBundle(), "manifest.json": "{not-json" },
    },
    {
      expected: "UNSAFE_FILE",
      bundle: {
        ...makeBundle(),
        "interview.txt": {
          fixtureFile: "outside-symlink",
          contents: "PREPARATION-SENTINEL",
        },
      },
    },
  ];

  for (const { bundle, expected } of cases) {
    const sandbox = await temporaryDirectory(t);
    const root = join(sandbox, `bundle-${expected}`);
    await writeBundle(root, bundle);
    const result = runCli([root, join(sandbox, "missing-report.md")]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Bundle: unavailable\nReview status: aborted\n/);
    assert.match(result.stderr, new RegExp(`Blocking reason: ${expected}`));
    assert.doesNotMatch(result.stderr, /REPORT_READ_FAILED/);
    assert.equal(result.stderr.includes("PREPARATION-SENTINEL"), false);
  }
});

test("CLI rejects symlink and non-regular report inputs without reading them", async (t) => {
  const { root, sandbox } = await bundleDirectory(t);
  const outside = join(sandbox, "outside.md");
  const link = join(sandbox, "report-link.md");
  const directory = join(sandbox, "report-directory");
  await writeFile(outside, "REPORT-SENTINEL");
  await symlink(outside, link);
  await mkdir(directory);

  for (const path of [link, directory]) {
    const result = runCli([root, path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /UNSAFE_REPORT_FILE/);
    assert.equal(result.stderr.includes("REPORT-SENTINEL"), false);
  }
});

test("CLI rejects invalid UTF-8 and oversized report files with fixed diagnostics", async (t) => {
  const { root, sandbox } = await bundleDirectory(t);
  const reportPath = join(sandbox, "report.md");
  const cases = [
    { contents: Buffer.from([0xc3, 0x28]), code: "INVALID_REPORT_UTF8" },
    { contents: Buffer.alloc(128 * 1024 + 1, 65), code: "REPORT_TOO_LARGE" },
  ];

  for (const { contents, code } of cases) {
    await writeFile(reportPath, contents);
    const result = runCli([root, reportPath]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(code));
  }
});

test("CLI uses exit 2 for invalid invocation syntax", async (t) => {
  const { root, sandbox } = await bundleDirectory(t);
  const reportPath = join(sandbox, "report.md");
  await writeFile(reportPath, validReport);
  for (const args of [
    [],
    [root],
    [root, reportPath, "--unknown"],
    [root, reportPath, "--evaluation", "--evaluation"],
    [root, reportPath, "--confirmed-by"],
    ["--evaluation", root, reportPath],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: node scripts\/check-report\.mjs/);
  }
});
