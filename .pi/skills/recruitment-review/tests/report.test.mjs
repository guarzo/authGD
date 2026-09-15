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
import { BundleError, prepareBundle } from "../scripts/bundle.mjs";
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
- Snapshot: 2026-09-14T12:00:00Z.
- Character scope: Declared and included character-1001.
- Dataset coverage: All six categories are present with stated status and history limits.
- Provenance: Synthetic Fixture Generator; illustrative local fixture; synthetic; no transformations.
- Verification: confirmedBy is fixture-recruiter; records are unverified.
- Synthetic-only: This report cannot support a real applicant decision.
- Limitations and unexamined inputs: External sources and original files were not examined.

## Claim review
### Claim 1
- Applicant claim: “The exchange happened.” [interview:L1-L2]
- Evidence: A supplied record exists. [record:W001] [context:C001]
- Assessment: supported
- Limits: Citation existence does not establish semantic support.
- Plausible alternatives: None apparent from the supplied packet.

## Material findings
### Direct contradictions
None identified within the supplied coverage.
### Tensions
None identified within the supplied coverage.
### Unknowns and gaps
None identified within the supplied coverage.

## Follow-up questions
1. Please clarify the exchange. [interview:L1-L2]

## Bottom line
No material inconsistencies found within stated coverage. The supplied comparison contains no identified inconsistency.
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

test("producer and checker accept the same safe-ID boundary", async (t) => {
  const bundleId = `A_z-9${"b".repeat(123)}`;
  const revision = `R_7-${"x".repeat(124)}`;
  const recordId = `W_${"r".repeat(126)}`;
  const contextId = `C-${"n".repeat(126)}`;
  for (const id of [bundleId, revision, recordId, contextId]) {
    assert.equal(id.length, 128);
  }
  const { root } = await bundleDirectory(t, {
    manifest: { bundleId, revision },
    records: [
      {
        id: recordId,
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
          id: contextId,
          text: "Illustrative context.",
          source: "Synthetic policy",
          asOf: null,
        },
      ],
    },
  });

  const preparedBoundary = await prepareBundle(root, {
    evaluation: false,
    confirmedBy: null,
  });
  const report = validReport
    .replace("sample@v1", `${bundleId}@${revision}`)
    .replace("[record:W001]", `[record:${recordId}]`)
    .replace("[context:C001]", `[context:${contextId}]`);

  assert.deepEqual(checkReport(report, preparedBoundary), { ok: true, errors: [] });
});

test("producer and checker apply the same UTC timestamp boundaries", async (t) => {
  const validTimestamp = "2024-02-29T23:59:59.123Z";
  const invalidTimestamp = "2026-02-30T12:00:00Z";
  const { root } = await bundleDirectory(t, {
    manifest: { collectedAt: validTimestamp },
  });
  const validPrepared = await prepareBundle(root, {
    evaluation: false,
    confirmedBy: null,
  });
  const validAbort = validAbortedReport
    .replace("sample@v1", "synthetic-review@r1")
    .replace("2026-09-14T12:00:00Z", validTimestamp);
  assert.deepEqual(checkReport(validAbort, validPrepared), { ok: true, errors: [] });

  const invalidBundle = makeBundle({ manifest: { collectedAt: invalidTimestamp } });
  const invalidRoot = join(await temporaryDirectory(t), "invalid-bundle");
  await writeBundle(invalidRoot, invalidBundle);
  await assert.rejects(
    () =>
      prepareBundle(invalidRoot, {
        evaluation: false,
        confirmedBy: null,
      }),
    (error) => error instanceof BundleError && error.code === "INVALID_SCHEMA",
  );
  const invalidAbort = validAbortedReport.replace(
    "2026-09-14T12:00:00Z",
    invalidTimestamp,
  );
  assert.deepEqual(checkReport(invalidAbort, prepared).errors, [
    "INVALID_ABORT_TIMESTAMP",
  ]);
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

test("rejects empty completed sections instead of accepting headings alone", () => {
  const empty = `Bundle: sample@v1
Review status: completed
Skill version: unavailable
Model: unavailable
Assessment status: DRAFT — human recruiter review required; not an admission decision

## Coverage and limitations

## Claim review

## Material findings

## Follow-up questions

## Bottom line
`;

  assert.deepEqual(checkReport(empty, prepared).errors, [
    "EMPTY_COVERAGE_AND_LIMITATIONS",
    "EMPTY_CLAIM_REVIEW",
    "EMPTY_MATERIAL_FINDINGS",
    "EMPTY_FOLLOW_UP_QUESTIONS",
    "EMPTY_BOTTOM_LINE",
  ]);
});

test("requires every coverage field to have a nonempty value", () => {
  const cases = [
    ["- Snapshot: 2026-09-14T12:00:00Z.", "- Snapshot:", "MISSING_COVERAGE_SNAPSHOT"],
    [
      "- Character scope: Declared and included character-1001.",
      "- Character scope:",
      "MISSING_CHARACTER_SCOPE",
    ],
    [
      "- Dataset coverage: All six categories are present with stated status and history limits.",
      "- Dataset coverage:",
      "MISSING_DATASET_COVERAGE",
    ],
    [
      "- Provenance: Synthetic Fixture Generator; illustrative local fixture; synthetic; no transformations.",
      "- Provenance:",
      "MISSING_PROVENANCE",
    ],
    [
      "- Verification: confirmedBy is fixture-recruiter; records are unverified.",
      "- Verification:",
      "MISSING_RECORD_VERIFICATION",
    ],
    [
      "- Synthetic-only: This report cannot support a real applicant decision.",
      "- Synthetic-only:",
      "MISSING_SYNTHETIC_ONLY_STATE",
    ],
    [
      "- Limitations and unexamined inputs: External sources and original files were not examined.",
      "- Limitations and unexamined inputs:",
      "MISSING_REVIEW_LIMITATIONS",
    ],
  ];

  for (const [field, emptyField, expectedError] of cases) {
    for (const replacement of [emptyField, ""]) {
      const result = checkReport(validReport.replace(field, replacement), prepared);
      assert.equal(result.ok, false, field);
      assert.ok(result.errors.includes(expectedError), field);
    }
  }
});

test("dataset tables require a delimiter and a nonempty data row", async (t) => {
  const variants = [
    ["| Dataset | Status |", "| wallet | complete |"],
    ["| Category | Status |", "| wallet | complete |"],
    ["| Character | Category | Status |", "| character-1001 | wallet | complete |"],
    ["| Character | Dataset | Status |", "| character-1001 | wallet | complete |"],
  ];
  const field =
    "- Dataset coverage: All six categories are present with stated status and history limits.";
  for (const [header, row] of variants) {
    const columns = header.split("|").length - 2;
    const delimiter = `| ${Array(columns).fill("---").join(" | ")} |`;
    const emptyRow = `| ${Array(columns).fill(" ").join(" | ")} |`;
    const cases = [
      ["header only", header],
      ["delimiter only", `${header}\n${delimiter}`],
      ["empty row", `${header}\n${delimiter}\n${emptyRow}`],
      ["missing delimiter", `${header}\n${row}`],
      ["non-row prose", `${header}\n${delimiter}\nThis is not a table row.`],
    ];
    for (const [name, table] of cases) {
      for (const labelled of [false, true]) {
        await t.test(`${header} ${name}, labelled=${labelled}`, () => {
          const replacement = labelled
            ? `- Dataset coverage:\n${table.replace(/^/gm, "  ")}`
            : table;
          assert.deepEqual(
            checkReport(validReport.replace(field, replacement), prepared).errors,
            ["MISSING_DATASET_COVERAGE"],
          );
        });
      }
    }
    for (const separator of [delimiter, delimiter.replaceAll("---", ":-")]) {
      await t.test(`${header} accepts complete table ${separator}`, () => {
        assert.deepEqual(
          checkReport(
            validReport.replace(field, `${header}\n${separator}\n${row}`),
            prepared,
          ),
          { ok: true, errors: [] },
        );
      });
    }
  }
});

test("accepts both bold coverage-label styles", () => {
  const colonInside = validReport
    .replace("Snapshot:", "**Snapshot:**")
    .replace("Character scope:", "**Character scope:**")
    .replace("Dataset coverage:", "**Dataset coverage:**")
    .replace("Provenance:", "**Provenance:**")
    .replace("Verification:", "**Verification:**")
    .replace("Synthetic-only:", "**Synthetic-only:**")
    .replace(
      "Limitations and unexamined inputs:",
      "**Limitations and unexamined inputs:**",
    );
  const colonOutside = validReport
    .replace("Snapshot:", "**Snapshot**:")
    .replace("Character scope:", "**Character scope**:")
    .replace("Dataset coverage:", "**Dataset coverage**:")
    .replace("Provenance:", "**Provenance**:")
    .replace("Verification:", "**Verification**:")
    .replace("Synthetic-only:", "**Synthetic-only**:")
    .replace(
      "Limitations and unexamined inputs:",
      "**Limitations and unexamined inputs**:",
    );

  assert.deepEqual(checkReport(colonInside, prepared), { ok: true, errors: [] });
  assert.deepEqual(checkReport(colonOutside, prepared), { ok: true, errors: [] });
});

test("accepts coverage values on attached continuation and nested Markdown lines", () => {
  const continued = validReport
    .replace(
      "- Snapshot: 2026-09-14T12:00:00Z.",
      "- Snapshot:\n  - 2026-09-14T12:00:00Z.",
    )
    .replace(
      "- Character scope: Declared and included character-1001.",
      "- Character scope:\n  Declared and included character-1001.",
    )
    .replace(
      "- Dataset coverage: All six categories are present with stated status and history limits.",
      "- Dataset coverage:\n  - All six categories are present with stated status and history limits.",
    );
  assert.deepEqual(checkReport(continued, prepared), { ok: true, errors: [] });

  const empty = validReport.replace(
    "- Snapshot: 2026-09-14T12:00:00Z.",
    "- Snapshot:\n  \n",
  );
  assert.ok(checkReport(empty, prepared).errors.includes("MISSING_COVERAGE_SNAPSHOT"));
});

test("does not let a same-level coverage sibling satisfy an empty Snapshot", () => {
  const report = validReport.replace(
    "- Snapshot: 2026-09-14T12:00:00Z.",
    "- Snapshot:\n- Note: Unrelated coverage detail.",
  );

  assert.deepEqual(checkReport(report, prepared).errors, ["MISSING_COVERAGE_SNAPSHOT"]);
});

test("does not infer missing coverage fields from bare keywords", () => {
  const report = validReport
    .replace(
      "- Provenance: Synthetic Fixture Generator; illustrative local fixture; synthetic; no transformations.",
      "- Provenance: q unverified q synthetic-only q\nblah unexamined blah",
    )
    .replace(
      "- Verification: confirmedBy is fixture-recruiter; records are unverified.\n",
      "",
    )
    .replace(
      "- Synthetic-only: This report cannot support a real applicant decision.\n",
      "",
    )
    .replace(
      "- Limitations and unexamined inputs: External sources and original files were not examined.\n",
      "",
    );

  const result = checkReport(report, prepared);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("MISSING_RECORD_VERIFICATION"));
  assert.ok(result.errors.includes("MISSING_SYNTHETIC_ONLY_STATE"));
  assert.ok(result.errors.includes("MISSING_REVIEW_LIMITATIONS"));
});

test("requires every labelled claim field to have a nonempty value", () => {
  const cases = [
    [
      "- Applicant claim: “The exchange happened.” [interview:L1-L2]",
      "- Applicant claim:",
      "MISSING_APPLICANT_CLAIM",
    ],
    [
      "- Evidence: A supplied record exists. [record:W001] [context:C001]",
      "- Evidence:",
      "MISSING_CLAIM_EVIDENCE",
    ],
    ["- Assessment: supported", "- Assessment:", "MISSING_CLAIM_ASSESSMENT"],
    [
      "- Limits: Citation existence does not establish semantic support.",
      "- Limits:",
      "MISSING_CLAIM_LIMITS",
    ],
    [
      "- Plausible alternatives: None apparent from the supplied packet.",
      "- Plausible alternatives:",
      "MISSING_PLAUSIBLE_ALTERNATIVES",
    ],
  ];

  for (const [field, emptyField, expectedError] of cases) {
    const result = checkReport(validReport.replace(field, emptyField), prepared);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.includes(expectedError), field);
  }
});

test("does not let a cited same-level Note satisfy an empty Applicant claim", () => {
  const report = validReport.replace(
    "- Applicant claim: “The exchange happened.” [interview:L1-L2]",
    "- Applicant claim:\n- Note: Unrelated transcript remark. [interview:L1-L2]",
  );

  assert.deepEqual(checkReport(report, prepared).errors, ["MISSING_APPLICANT_CLAIM"]);
});

test("does not let a cited shallower Note satisfy empty Evidence", () => {
  const report = validReport.replace(
    "- Evidence: A supplied record exists. [record:W001] [context:C001]",
    "  - Evidence:\n- Note: Unrelated record remark. [record:W001]",
  );

  assert.deepEqual(checkReport(report, prepared).errors, ["MISSING_CLAIM_EVIDENCE"]);
});

test("does not let a trailing sibling paragraph satisfy empty alternatives", () => {
  const report = validReport.replace(
    "- Plausible alternatives: None apparent from the supplied packet.",
    "- Plausible alternatives:\nUnrelated closing paragraph.",
  );

  assert.deepEqual(checkReport(report, prepared).errors, [
    "MISSING_PLAUSIBLE_ALTERNATIVES",
  ]);
});

test("requires every labelled claim field to be present", () => {
  const cases = [
    [
      "- Applicant claim: “The exchange happened.” [interview:L1-L2]\n",
      "MISSING_APPLICANT_CLAIM",
    ],
    [
      "- Evidence: A supplied record exists. [record:W001] [context:C001]\n",
      "MISSING_CLAIM_EVIDENCE",
    ],
    ["- Assessment: supported\n", "MISSING_CLAIM_ASSESSMENT"],
    [
      "- Limits: Citation existence does not establish semantic support.\n",
      "MISSING_CLAIM_LIMITS",
    ],
    [
      "- Plausible alternatives: None apparent from the supplied packet.\n",
      "MISSING_PLAUSIBLE_ALTERNATIVES",
    ],
  ];

  for (const [field, expectedError] of cases) {
    const result = checkReport(validReport.replace(field, ""), prepared);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.includes(expectedError), field);
  }
});

test("accepts both bold claim-label styles", () => {
  const colonInside = validReport
    .replace("Applicant claim:", "**Applicant claim:**")
    .replace("Evidence:", "**Evidence:**")
    .replace("Assessment:", "**Assessment:**")
    .replace("Limits:", "**Limits:**")
    .replace("Plausible alternatives:", "**Plausible alternatives:**");
  const colonOutside = validReport
    .replace("Applicant claim:", "**Applicant claim**:")
    .replace("Evidence:", "**Evidence**:")
    .replace("Assessment:", "**Assessment**:")
    .replace("Limits:", "**Limits**:")
    .replace("Plausible alternatives:", "**Plausible alternatives**:");

  assert.deepEqual(checkReport(colonInside, prepared), { ok: true, errors: [] });
  assert.deepEqual(checkReport(colonOutside, prepared), { ok: true, errors: [] });
});

test("accepts claim values on attached continuation and nested Markdown lines", () => {
  const report = validReport
    .replace(
      "- Applicant claim: “The exchange happened.” [interview:L1-L2]",
      "- **Applicant claim**:\n  - “The exchange happened.” [interview:L1-L2]",
    )
    .replace(
      "- Evidence: A supplied record exists. [record:W001] [context:C001]",
      "- **Evidence**:\n  A supplied record exists. [record:W001] [context:C001]",
    )
    .replace("- Assessment: supported", "- **Assessment**:\n  supported")
    .replace(
      "- Limits: Citation existence does not establish semantic support.",
      "- **Limits**:\n  - Citation existence does not establish semantic support.",
    );

  assert.deepEqual(checkReport(report, prepared), { ok: true, errors: [] });

  const empty = validReport.replace(
    "- Limits: Citation existence does not establish semantic support.",
    "- **Limits**:\n  \n",
  );
  assert.ok(checkReport(empty, prepared).errors.includes("MISSING_CLAIM_LIMITS"));
});

test("rejects duplicate and out-of-order claim fields with exact codes", () => {
  const duplicate = validReport.replace(
    "- Evidence: A supplied record exists. [record:W001] [context:C001]",
    "- Evidence: A supplied record exists. [record:W001] [context:C001]\n- Evidence: Duplicate. [record:W001]",
  );
  assert.deepEqual(checkReport(duplicate, prepared).errors, ["DUPLICATE_CLAIM_FIELD"]);

  const outOfOrder = validReport.replace(
    "- Applicant claim: “The exchange happened.” [interview:L1-L2]\n- Evidence: A supplied record exists. [record:W001] [context:C001]",
    "- Evidence: A supplied record exists. [record:W001] [context:C001]\n- Applicant claim: “The exchange happened.” [interview:L1-L2]",
  );
  assert.deepEqual(checkReport(outOfOrder, prepared).errors, [
    "INVALID_CLAIM_FIELD_ORDER",
  ]);
});

test("rejects invalid claim assessments", () => {
  const result = checkReport(
    validReport.replace("- Assessment: supported", "- Assessment: likely supported"),
    prepared,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_CLAIM_ASSESSMENT"));
});

test("requires an interview citation on every quoted applicant claim", () => {
  const result = checkReport(
    validReport.replace(
      " “The exchange happened.” [interview:L1-L2]",
      " “The exchange happened.”",
    ),
    prepared,
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("MISSING_APPLICANT_CITATION"));
});

test("requires cited Evidence unless an explicit safe structural branch applies", () => {
  for (const evidence of [
    "A supplied record supports the claim.",
    "No supplied evidence contradicts the applicant; the transfer clearly happened.",
  ]) {
    const result = checkReport(
      validReport.replace(
        "A supplied record exists. [record:W001] [context:C001]",
        evidence,
      ),
      prepared,
    );
    assert.equal(result.ok, false, evidence);
    assert.ok(result.errors.includes("MISSING_EVIDENCE_CITATION"), evidence);
  }

  const noUsableRecord = validReport
    .replace(
      "A supplied record exists. [record:W001] [context:C001]",
      "No usable record exists in the supplied packet.",
    )
    .replace("- Assessment: supported", "- Assessment: unknown / not assessable");
  assert.deepEqual(checkReport(noUsableRecord, prepared), { ok: true, errors: [] });

  const unsupportedNoRecord = validReport.replace(
    "A supplied record exists. [record:W001] [context:C001]",
    "No usable record exists in the supplied packet.",
  );
  assert.deepEqual(checkReport(unsupportedNoRecord, prepared).errors, [
    "INVALID_NO_RECORD_ASSESSMENT",
  ]);

  const packetMetadata = validReport.replace(
    "A supplied record exists. [record:W001] [context:C001]",
    "Packet metadata: The included-character list establishes this packet's scope.",
  );
  assert.deepEqual(checkReport(packetMetadata, prepared), { ok: true, errors: [] });

  const emptyPacketMetadata = validReport.replace(
    "A supplied record exists. [record:W001] [context:C001]",
    "Packet metadata:",
  );
  assert.ok(
    checkReport(emptyPacketMetadata, prepared).errors.includes(
      "EMPTY_PACKET_METADATA_EVIDENCE",
    ),
  );
});

test("accepts only a standalone no-material-claims statement instead of a fake claim block", () => {
  const report = validReport.replace(
    /### Claim 1[\s\S]*?(?=\n## Material findings)/,
    "No material checkable applicant claims identified in the supplied interview.",
  );
  assert.deepEqual(checkReport(report, prepared), { ok: true, errors: [] });

  const mixed = report.replace(
    "No material checkable applicant claims identified in the supplied interview.",
    "No material checkable applicant claims identified in the supplied interview.\nUnlabelled claim content.",
  );
  const result = checkReport(mixed, prepared);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("INVALID_CLAIM_REVIEW"));
});

test("requires all material-finding subsections with content", () => {
  const cases = [
    [
      "### Direct contradictions\nNone identified within the supplied coverage.\n",
      "MISSING_DIRECT_CONTRADICTIONS",
    ],
    ["### Tensions\nNone identified within the supplied coverage.\n", "MISSING_TENSIONS"],
    [
      "### Unknowns and gaps\nNone identified within the supplied coverage.\n",
      "MISSING_UNKNOWNS_AND_GAPS",
    ],
  ];

  for (const [subsection, expectedError] of cases) {
    for (const replacement of ["", subsection.split("\n")[0] + "\n"]) {
      const result = checkReport(validReport.replace(subsection, replacement), prepared);
      assert.equal(result.ok, false, `${expectedError}: ${JSON.stringify(replacement)}`);
      assert.ok(result.errors.includes(expectedError));
    }
  }
});

test("requires a citation for each factual material-finding item", () => {
  for (const findings of [
    "1. A cited contradiction. [record:W001]\n2. An uncited accusation.",
    "- An uncited accusation.\n\nA standalone scope note. [record:W001]",
    "None identified.\n- An uncited accusation.",
  ]) {
    const result = checkReport(
      validReport.replace(
        "### Direct contradictions\nNone identified within the supplied coverage.",
        `### Direct contradictions\n${findings}`,
      ),
      prepared,
    );
    assert.equal(result.ok, false, findings);
    assert.ok(result.errors.includes("MISSING_MATERIAL_FINDING_CITATION"));
  }

  const continued = validReport.replace(
    "### Direct contradictions\nNone identified within the supplied coverage.",
    "### Direct contradictions\n- A factual finding.\n  - Supporting detail. [record:W001]",
  );
  assert.deepEqual(checkReport(continued, prepared), { ok: true, errors: [] });
});

test("rejects unsupported tables in material findings", () => {
  const tables = [
    "| Finding | Evidence |\n| --- | --- |\n| Cited row | [record:W001] |\n| Uncited row | None |",
    "Finding | Evidence\n:--- | ---:\nCited row | [record:W001]",
    "| --- |\n| Cited row [record:W001] |",
    "| Finding | Evidence |\n| - | - |\n| Cited row | [record:W001] |\n| Uncited row | None |",
    "| Finding | Evidence |\n|-|-|\n| Cited row | [record:W001] |\n| Uncited row | None |",
    "| Finding | Evidence |\n| -- | -- |\n| Cited row | [record:W001] |\n| Uncited row | None |",
    "Finding | Evidence\n:- | -:\nCited row | [record:W001]\nUncited row | None",
    "| Finding | Evidence |\n| :-: | --: |\n| Cited row | [record:W001] |\n| Uncited row | None |",
    "| - |\n| Cited row [record:W001] |\n| Uncited row |",
  ];

  for (const table of tables) {
    const report = validReport.replace(
      "### Direct contradictions\nNone identified within the supplied coverage.",
      `### Direct contradictions\n${table}`,
    );
    assert.deepEqual(checkReport(report, prepared).errors, [
      "UNSUPPORTED_MATERIAL_FINDINGS_TABLE",
    ]);
  }
});

test("splits blank-separated non-list findings regardless of indentation", () => {
  const report = validReport.replace(
    "### Direct contradictions\nNone identified within the supplied coverage.",
    "### Direct contradictions\nA cited paragraph. [record:W001]\n\n  An uncited separate paragraph.",
  );

  assert.deepEqual(checkReport(report, prepared).errors, [
    "MISSING_MATERIAL_FINDING_CITATION",
  ]);
});

test("preserves deeper list continuations after blank lines", () => {
  const report = validReport.replace(
    "### Direct contradictions\nNone identified within the supplied coverage.",
    "### Direct contradictions\n- A factual finding.\n\n  Supporting detail. [record:W001]",
  );

  assert.deepEqual(checkReport(report, prepared), { ok: true, errors: [] });
});

test("allows only nonempty labelled metadata items without material citations", () => {
  const labelled = validReport.replace(
    "### Unknowns and gaps\nNone identified within the supplied coverage.",
    "### Unknowns and gaps\n- Coverage: Wallet collection is partial.\n- Provenance: Records are applicant supplied.",
  );
  assert.deepEqual(checkReport(labelled, prepared), { ok: true, errors: [] });

  for (const label of ["Coverage", "Provenance"]) {
    const empty = validReport.replace(
      "### Unknowns and gaps\nNone identified within the supplied coverage.",
      `### Unknowns and gaps\n- ${label}:`,
    );
    const result = checkReport(empty, prepared);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.includes("EMPTY_MATERIAL_METADATA"));
  }
});

test("requires a citation for each factual follow-up item", () => {
  for (const questions of [
    "1. A cited question? [record:W001]\n2. An uncited accusation?",
    "1. An uncited accusation?\n\nA standalone scope note. [record:W001]",
  ]) {
    const result = checkReport(
      validReport.replace("1. Please clarify the exchange. [interview:L1-L2]", questions),
      prepared,
    );
    assert.equal(result.ok, false, questions);
    assert.ok(result.errors.includes("MISSING_FOLLOW_UP_CITATION"));
  }

  const continued = validReport.replace(
    "1. Please clarify the exchange. [interview:L1-L2]",
    "1. Please clarify the exchange?\n   - Relevant scope. [interview:L1-L2]",
  );
  assert.deepEqual(checkReport(continued, prepared), { ok: true, errors: [] });
});

test("allows only nonempty labelled coverage-repair questions without citations", () => {
  const repair = validReport.replace(
    "1. Please clarify the exchange. [interview:L1-L2]",
    "1. Please clarify the exchange. [interview:L1-L2]\n2. Coverage repair: Re-collect the partial wallet dataset.",
  );
  assert.deepEqual(checkReport(repair, prepared), { ok: true, errors: [] });

  const emptyRepair = validReport.replace(
    "1. Please clarify the exchange. [interview:L1-L2]",
    "1. Please clarify the exchange. [interview:L1-L2]\n2. Coverage repair:",
  );
  assert.ok(checkReport(emptyRepair, prepared).errors.includes("EMPTY_COVERAGE_REPAIR"));

  const noneNeeded = validReport.replace(
    "1. Please clarify the exchange. [interview:L1-L2]",
    "No follow-up questions needed based on the supplied packet.",
  );
  assert.deepEqual(checkReport(noneNeeded, prepared), { ok: true, errors: [] });
});

test("requires a leading permitted bottom-line category and an explanation", () => {
  for (const bottomLine of [
    "Likely acceptable. The evidence seems adequate.",
    "Clarification needed.",
    "Clarification neededness. This is not the category.",
  ]) {
    const result = checkReport(
      validReport.replace(
        "No material inconsistencies found within stated coverage. The supplied comparison contains no identified inconsistency.",
        bottomLine,
      ),
      prepared,
    );
    assert.equal(result.ok, false, bottomLine);
    assert.ok(result.errors.includes("INVALID_BOTTOM_LINE"), bottomLine);
  }

  for (const bottomLine of [
    "Clarification needed, because the date is unresolved.",
    "Clarification needed\nThe date is unresolved.",
    "Clarification needed. The phrase Insufficient evidence describes a narrower issue.",
  ]) {
    const report = validReport.replace(
      "No material inconsistencies found within stated coverage. The supplied comparison contains no identified inconsistency.",
      bottomLine,
    );
    assert.deepEqual(checkReport(report, prepared), { ok: true, errors: [] });
  }
});

test("rejects reversed and out-of-range transcript ranges with the range code", () => {
  for (const citation of ["[interview:L2-L1]", "[interview:L1-L3]"]) {
    const report = validReport.replace("[interview:L1-L2]", citation);
    assert.deepEqual(checkReport(report, prepared).errors, ["INVALID_INTERVIEW_RANGE"]);
  }
});

test("rejects zero and fractional transcript ranges as malformed citations", () => {
  for (const citation of ["[interview:L0-L1]", "[interview:L1.5-L2]"]) {
    const report = validReport.replace("[interview:L1-L2]", citation);
    assert.deepEqual(checkReport(report, prepared).errors, ["MALFORMED_CITATION"]);
  }
});

test("rejects malformed citation tokens with the malformed-citation code", () => {
  for (const citation of [
    "[interview:L1]",
    "[interview:L1-L2-L3]",
    "[record:]",
    "[record:W001 extra]",
    "[context:C001",
    "[Record:W001]",
  ]) {
    const report = validReport.replace("[record:W001]", citation);
    assert.deepEqual(checkReport(report, prepared).errors, ["MALFORMED_CITATION"]);
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
    "The supplied comparison contains no identified inconsistency.",
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
    /Every subsequent preparation failure emits a pipeline diagnostic with that validated bundle identity; a failure before successful manifest validation uses `Bundle: unavailable`\./,
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
    .replace(
      "<supported | contradicted | tension | unknown / not assessable>",
      "supported",
    )
    .replace(
      "<Ranked findings with citations, or “None identified within the supplied coverage.”>",
      "None identified within the supplied coverage.",
    )
    .replace(
      "<Ranked tensions with citations, or “None identified.”>",
      "None identified.",
    )
    .replace(
      "<Individually cited unknowns; non-empty `Coverage:` or `Provenance:` metadata items; or “None identified.”>",
      "None identified.",
    )
    .replace(
      "<Highest-priority neutral question with its own citation; use a non-empty `Coverage repair:` item only for packet-metadata collection repair.>",
      "Please clarify the exchange. [interview:L1-L2]",
    )
    .replace(
      "<Exactly one: No material inconsistencies found within stated coverage | Clarification needed | Insufficient evidence. Start with that category and then explain why, preserve material gaps, and make no admission recommendation.>",
      "No material inconsistencies found within stated coverage. Supplied detail.",
    )
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
