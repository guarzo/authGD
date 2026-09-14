import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BundleError, prepareBundle, renderPacket } from "../scripts/bundle.mjs";
import { fixtureCases, makeBundle, writeBundle } from "./fixtures.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageRoot, "scripts", "prepare.mjs");

async function temporaryRoot(t) {
  const sandbox = await mkdtemp(join(tmpdir(), "recruitment-review-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return join(sandbox, "bundle");
}

async function preparedRoot(t, overrides = {}) {
  const root = await temporaryRoot(t);
  await writeBundle(root, makeBundle(overrides));
  return root;
}

async function expectBundleError(action, code, forbidden = []) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof BundleError);
    assert.equal(error.code, code);
    for (const value of forbidden) {
      assert.equal(error.message.includes(value), false);
    }
    return true;
  });
}

function prepareOptions(overrides = {}) {
  return { evaluation: false, confirmedBy: null, ...overrides };
}

test("prepares a complete packet without changing opaque evidence", async (t) => {
  const opaqueData = { label: "opaque", nested: { illustrative: true } };
  const bundle = makeBundle();
  bundle["records.json"][1].data = opaqueData;
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);

  const { packet, citationIndex } = await prepareBundle(
    root,
    prepareOptions({ evaluation: true, confirmedBy: "recruiter-1" }),
  );

  assert.deepEqual(packet.bundle, {
    id: "synthetic-review",
    revision: "r1",
    collectedAt: "2026-09-14T12:00:00Z",
  });
  assert.deepEqual(packet.preparation, {
    evaluation: true,
    confirmedBy: "recruiter-1",
    syntheticOnly: true,
  });
  assert.deepEqual(packet.interview.lines, [
    { line: 1, text: "Recruiter: Describe your recent contacts." },
    { line: 2, text: "Applicant: None to disclose." },
  ]);
  assert.deepEqual(packet.records[1].data, opaqueData);
  assert.equal(packet.records[1].provenanceId, "source-1");
  assert.deepEqual(citationIndex, {
    bundleId: "synthetic-review",
    revision: "r1",
    transcriptLineCount: 2,
    recordIds: ["record-1", "record-2", "record-3", "record-4", "record-5", "record-6"],
    contextIds: ["context-1"],
  });
  assert.doesNotThrow(() => JSON.parse(renderPacket(packet)));
});

test("preserves exact high-precision amount strings through packet serialization", async (t) => {
  const exactAmount = "900719925474099312345.678900";
  const bundle = makeBundle();
  bundle["records.json"][1].data = { amount: exactAmount };
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);

  const { packet } = await prepareBundle(root, prepareOptions());
  const rendered = JSON.parse(renderPacket(packet));

  assert.equal(rendered.records[1].data.amount, exactAmount);
  assert.equal(typeof rendered.records[1].data.amount, "string");
});

test("does not promote applicant records after a handoff assertion", async (t) => {
  const root = await preparedRoot(t, { sourceKind: "applicant" });
  const { packet } = await prepareBundle(
    root,
    prepareOptions({ confirmedBy: "recruiter" }),
  );
  assert.equal(packet.preparation.confirmedBy, "recruiter");
  assert.ok(packet.records.every((record) => record.verification === "unverified"));
});

test("requires both ESI provenance and external confirmation for trusted handoff", async (t) => {
  for (const sourceKind of ["authenticated-esi", "public-esi"]) {
    const root = await preparedRoot(t, { sourceKind });
    const unconfirmed = await prepareBundle(root, prepareOptions());
    const confirmed = await prepareBundle(
      root,
      prepareOptions({ confirmedBy: "recruiter" }),
    );
    assert.ok(
      unconfirmed.packet.records.every((record) => record.verification === "unverified"),
    );
    assert.ok(
      confirmed.packet.records.every(
        (record) => record.verification === "trusted-handoff",
      ),
    );
  }
});

test("uses each record's provenance instead of inheriting dataset trust", async (t) => {
  const bundle = makeBundle({ sourceKind: "authenticated-esi" });
  bundle["manifest.json"].provenance.push({
    id: "applicant-source",
    collector: "Synthetic Fixture Generator",
    method: "illustrative applicant upload",
    toolVersion: "fixture-v1",
    sourceKind: "applicant",
    transformations: [],
  });
  bundle["records.json"][0].provenanceId = "applicant-source";
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);

  const { packet } = await prepareBundle(
    root,
    prepareOptions({ confirmedBy: "recruiter" }),
  );
  assert.equal(packet.coverage.datasets[0].provenanceId, "source-1");
  assert.equal(packet.records[0].verification, "unverified");
  assert.ok(
    packet.records.slice(1).every((record) => record.verification === "trusted-handoff"),
  );
});

test("keeps evaluation packets visibly synthetic-only", async (t) => {
  const root = await preparedRoot(t, { sourceKind: "authenticated-esi" });
  const { packet } = await prepareBundle(
    root,
    prepareOptions({ evaluation: true, confirmedBy: "fixture-recruiter" }),
  );
  assert.equal(packet.preparation.syntheticOnly, true);
  assert.equal(packet.preparation.evaluation, true);
  assert.ok(packet.records.every((record) => record.verification === "trusted-handoff"));
});

test("validates preparation options rather than inferring them", async (t) => {
  const root = await preparedRoot(t);
  for (const options of [
    {},
    { evaluation: "false", confirmedBy: null },
    { evaluation: false },
    { evaluation: false, confirmedBy: "" },
    { evaluation: false, confirmedBy: "recruiter", extra: true },
  ]) {
    await expectBundleError(() => prepareBundle(root, options), "INVALID_SCHEMA");
  }
});

test("rejects a symlink root without reading its files", async (t) => {
  const parent = await temporaryRoot(t);
  const target = join(parent, "target");
  const link = join(parent, "link");
  await writeBundle(target, makeBundle());
  await symlink(target, link);
  await expectBundleError(() => prepareBundle(link, prepareOptions()), "UNSAFE_FILE");
});

test("rejects an input symlink pointing at an outside sentinel", async (t) => {
  const root = await preparedRoot(t);
  const sentinel = "SENTINEL-OUTSIDE-CONTENT";
  const outside = join(dirname(root), "outside-interview.txt");
  await writeFile(outside, sentinel);
  await unlink(join(root, "interview.txt"));
  await symlink(outside, join(root, "interview.txt"));

  await expectBundleError(() => prepareBundle(root, prepareOptions()), "UNSAFE_FILE", [
    sentinel,
  ]);
});

test("rejects a directory in place of a fixed input file", async (t) => {
  const root = await preparedRoot(t);
  await unlink(join(root, "records.json"));
  await mkdir(join(root, "records.json"));
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "UNSAFE_FILE");
});

test("rejects a FIFO in place of a fixed input file", async (t) => {
  const root = await preparedRoot(t);
  const path = join(root, "context.json");
  await unlink(path);
  const made = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "UNSAFE_FILE");
});

test("maps missing or unreadable fixed inputs to a safe read failure", async (t) => {
  const root = await preparedRoot(t);
  await unlink(join(root, "context.json"));
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "READ_FAILED");
});

test("rejects aggregate input above four MiB before parsing", async (t) => {
  const root = await preparedRoot(t);
  await writeFile(join(root, "interview.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INPUT_TOO_LARGE");
});

test("rejects packets above 128 KiB without truncating or sampling", async (t) => {
  const sentinel = "PACKET-END-SENTINEL";
  const root = await preparedRoot(t, {
    interview: `Recruiter: Begin.\nApplicant: ${"x".repeat(140_000)}${sentinel}`,
  });
  await expectBundleError(
    () => prepareBundle(root, prepareOptions()),
    "PACKET_TOO_LARGE",
    [sentinel],
  );
  assert.throws(
    () => renderPacket({ value: `${"x".repeat(140_000)}${sentinel}` }),
    (error) =>
      error instanceof BundleError &&
      error.code === "PACKET_TOO_LARGE" &&
      !error.message.includes(sentinel),
  );
});

test("rejects invalid UTF-8", async (t) => {
  const root = await preparedRoot(t);
  await writeFile(join(root, "interview.txt"), Buffer.from([0xc3, 0x28]));
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_UTF8");
});

test("rejects malformed JSON without echoing source data", async (t) => {
  const root = await preparedRoot(t);
  const secret = "SOURCE-CONTENT-MUST-NOT-BE-ECHOED";
  await writeFile(join(root, "records.json"), `{${secret}`);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA", [
    secret,
  ]);
});

test("rejects unknown manifest versions", async (t) => {
  const root = await preparedRoot(t, { manifest: { version: 2 } });
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects missing category coverage without relying on a dangling record", async (t) => {
  const bundle = makeBundle();
  bundle["manifest.json"].datasets = bundle["manifest.json"].datasets.filter(
    (dataset) => dataset.category !== "skill-queue",
  );
  bundle["records.json"] = bundle["records.json"].filter(
    (record) => record.category !== "skill-queue",
  );
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects duplicate provenance IDs", async (t) => {
  const bundle = makeBundle();
  bundle["manifest.json"].provenance.push({
    ...bundle["manifest.json"].provenance[0],
  });
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects duplicate record IDs", async (t) => {
  const bundle = makeBundle();
  bundle["records.json"].push({
    ...bundle["records.json"][0],
    category: "wallet",
  });
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects duplicate context IDs", async (t) => {
  const bundle = makeBundle();
  bundle["context.json"].notes.push({
    ...bundle["context.json"].notes[0],
  });
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects a dangling dataset provenance reference", async (t) => {
  const bundle = makeBundle();
  bundle["manifest.json"].datasets[0].provenanceId = "missing-source";
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects a dangling record provenance reference", async (t) => {
  const bundle = makeBundle();
  bundle["records.json"][0].provenanceId = "missing-source";
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects a record whose character/category dataset does not exist", async (t) => {
  const bundle = makeBundle();
  bundle["records.json"][0].characterId = "missing-character";
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects an included character that is not declared", async (t) => {
  const bundle = makeBundle();
  bundle["manifest.json"].includedCharacterIds = ["undeclared-character"];
  bundle["manifest.json"].datasets = bundle["manifest.json"].datasets.map((dataset) => ({
    ...dataset,
    characterId: "undeclared-character",
  }));
  bundle["records.json"] = bundle["records.json"].map((record) => ({
    ...record,
    characterId: "undeclared-character",
  }));
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  await expectBundleError(() => prepareBundle(root, prepareOptions()), "INVALID_SCHEMA");
});

test("rejects contradictory dataset status and records", async (t) => {
  for (const status of ["empty", "unauthorised", "failed", "absent"]) {
    const bundle = makeBundle();
    bundle["manifest.json"].datasets[1].status = status;
    const root = await temporaryRoot(t);
    await writeBundle(root, bundle);
    await expectBundleError(
      () => prepareBundle(root, prepareOptions()),
      "INVALID_SCHEMA",
    );
  }
});

test("accepts partial datasets with records and empty datasets without them", async (t) => {
  const bundle = makeBundle();
  bundle["manifest.json"].datasets[1].status = "partial";
  bundle["manifest.json"].datasets[2].status = "empty";
  bundle["records.json"] = bundle["records.json"].filter(
    (record) => record.category !== "contracts",
  );
  const root = await temporaryRoot(t);
  await writeBundle(root, bundle);
  const { packet } = await prepareBundle(root, prepareOptions());
  assert.equal(packet.coverage.datasets[1].status, "partial");
  assert.equal(packet.coverage.datasets[2].status, "empty");
});

test("rejects recognized credential-bearing keys anywhere in JSON", async (t) => {
  for (const key of ["access_token", "REFRESH_TOKEN", "Authorization", "cOoKiE"]) {
    const bundle = makeBundle();
    const secret = `SECRET-FOR-${key}`;
    bundle["records.json"][0].data = { nested: [{ [key]: secret }] };
    const root = await temporaryRoot(t);
    await writeBundle(root, bundle);
    await expectBundleError(
      () => prepareBundle(root, prepareOptions()),
      "INVALID_CREDENTIAL_FIELD",
      [secret],
    );
  }
});

test("rejects invalid identities, timestamps, transcript lines, and record payloads", async (t) => {
  const cases = [
    (bundle) => {
      bundle["manifest.json"].bundleId = "unsafe id";
    },
    (bundle) => {
      bundle["manifest.json"].collectedAt = "2026-09-14";
    },
    (bundle) => {
      bundle["manifest.json"].collectedAt = "2026-02-30T12:00:00Z";
    },
    (bundle) => {
      bundle["interview.txt"] = "not speaker labelled";
    },
    (bundle) => {
      bundle["records.json"][0].data = [];
    },
  ];
  for (const mutate of cases) {
    const bundle = makeBundle();
    mutate(bundle);
    const root = await temporaryRoot(t);
    await writeBundle(root, bundle);
    await expectBundleError(
      () => prepareBundle(root, prepareOptions()),
      "INVALID_SCHEMA",
    );
  }
});

test("the fixture factory explicitly covers all six categories", () => {
  const requiredCategories = [
    "corporation-history",
    "wallet",
    "contracts",
    "assets",
    "skills",
    "skill-queue",
  ];
  const bundle = makeBundle();
  assert.deepEqual(
    bundle["manifest.json"].datasets.map((dataset) => dataset.category),
    requiredCategories,
  );
  assert.deepEqual(
    bundle["records.json"].map((record) => record.category),
    requiredCategories,
  );
  assert.equal(Object.keys(bundle).length, 4);
});

test("preserves every per-character dataset entry in multi-character packets", async (t) => {
  const fixture = fixtureCases.find(({ id }) => id === "empty-vs-failed");
  assert.ok(fixture);
  const root = await temporaryRoot(t);
  await writeBundle(root, fixture.bundle);

  const { packet } = await prepareBundle(root, fixture.options);

  assert.deepEqual(
    packet.coverage.datasets.map(({ characterId, category, status, history }) => ({
      characterId,
      category,
      status,
      history,
    })),
    [
      {
        characterId: "character-1001",
        category: "corporation-history",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-1001",
        category: "wallet",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-1001",
        category: "contracts",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-1001",
        category: "assets",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-1001",
        category: "skills",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-1001",
        category: "skill-queue",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-2002",
        category: "corporation-history",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-2002",
        category: "wallet",
        status: "failed",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-2002",
        category: "contracts",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-2002",
        category: "assets",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-2002",
        category: "skills",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
      {
        characterId: "character-2002",
        category: "skill-queue",
        status: "empty",
        history: { knownLimit: null, earliestReturnedAt: null },
      },
    ],
  );
});

test("current-affiliation fixture history includes its older exchange", () => {
  const fixture = fixtureCases.find(({ id }) => id === "current-affiliation");
  assert.ok(fixture);
  const walletDataset = fixture.bundle["manifest.json"].datasets.find(
    ({ characterId, category }) =>
      characterId === "character-1001" && category === "wallet",
  );
  const olderExchange = fixture.bundle["records.json"].find(
    ({ id }) => id === "older-exchange-record",
  );

  assert.equal(walletDataset?.history.earliestReturnedAt, "2025-03-01T00:00:00Z");
  assert.equal(olderExchange?.data.occurredAt, "2025-03-01T00:00:00Z");
});

test("the fixture catalogue defines all required cases and expectation fields", () => {
  assert.deepEqual(
    fixtureCases.map(({ id }) => id),
    [
      "direct-transfer",
      "transfer-removed",
      "transfer-disclosed",
      "newcomer-guided",
      "public-business",
      "current-affiliation",
      "partial-with-finding",
      "empty-vs-failed",
      "duplicate-event",
      "planted-instructions",
      "applicant-curated",
      "claimed-esi-unconfirmed",
      "transcript-revision",
      "uninterpretable",
      "unsafe-path",
      "oversized",
    ],
  );
  for (const fixture of fixtureCases) {
    assert.deepEqual(Object.keys(fixture).sort(), [
      "bundle",
      "expected",
      "id",
      "options",
    ]);
    assert.equal(fixture.options.evaluation, true, `${fixture.id} is not synthetic-only`);
    assert.deepEqual(Object.keys(fixture.expected).sort(), [
      "citations",
      "coverage",
      "permittedFindings",
      "prohibitedInferences",
      "provenance",
      "requiredFindings",
      "status",
    ]);
    assert.ok(
      fixture.expected.permittedFindings.length > 0,
      `${fixture.id} has no useful permitted findings`,
    );
  }
});

test("fixture expectations never enter prepared packets", async (t) => {
  for (const fixture of fixtureCases.filter(
    ({ expected }) => expected.status === "completed",
  )) {
    const root = await temporaryRoot(t);
    await writeBundle(root, fixture.bundle);
    const { packet } = await prepareBundle(root, fixture.options);
    const serialized = renderPacket(packet);
    assert.equal(packet.preparation.syntheticOnly, true, fixture.id);
    assert.equal(Object.hasOwn(packet, "expected"), false);
    for (const phrase of [
      ...fixture.expected.requiredFindings,
      ...fixture.expected.permittedFindings,
    ]) {
      assert.equal(
        serialized.includes(phrase),
        false,
        `${fixture.id} leaked an expected finding`,
      );
    }
  }
});

test("aborted catalogue fixtures fail with their declared preparation code", async (t) => {
  for (const fixture of fixtureCases.filter(
    ({ expected }) => expected.status === "aborted",
  )) {
    const root = await temporaryRoot(t);
    await writeBundle(root, fixture.bundle);
    await expectBundleError(
      () => prepareBundle(root, fixture.options),
      fixture.expected.requiredFindings[0],
    );
  }
});

test("preparation CLI accepts both shared option orders", async (t) => {
  const root = await preparedRoot(t);
  for (const suffix of [
    ["--evaluation", "--confirmed-by", "recruiter-1"],
    ["--confirmed-by", "recruiter-1", "--evaluation"],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, root, ...suffix], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${JSON.stringify(suffix)}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).preparation, {
      evaluation: true,
      confirmedBy: "recruiter-1",
      syntheticOnly: true,
    });
  }
});

test("CLI writes only packet JSON to stdout on success", async (t) => {
  const root = await preparedRoot(t, { sourceKind: "public-esi" });
  const result = spawnSync(
    process.execPath,
    [cliPath, root, "--evaluation", "--confirmed-by", "recruiter-1"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const packet = JSON.parse(result.stdout);
  assert.deepEqual(packet.preparation, {
    evaluation: true,
    confirmedBy: "recruiter-1",
    syntheticOnly: true,
  });
});

test("CLI does not expose an outside symlink sentinel", async (t) => {
  const root = await preparedRoot(t);
  const sentinel = "CLI-OUTSIDE-SYMLINK-SENTINEL";
  const outside = join(dirname(root), "cli-outside-interview.txt");
  await writeFile(outside, sentinel);
  await unlink(join(root, "interview.txt"));
  await symlink(outside, join(root, "interview.txt"));
  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Blocking reason: UNSAFE_FILE/);
  assert.equal(result.stderr.includes(sentinel), false);
});

test("CLI preserves validated identity on a prohibited context credential", async (t) => {
  const root = await preparedRoot(t);
  const secret = "CLI-SECRET-MUST-NOT-LEAK";
  const bundle = makeBundle();
  bundle["context.json"].notes[0].cookie = secret;
  await writeBundle(root, bundle);
  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Bundle: synthetic-review@r1\nReview status: aborted\n/);
  assert.match(result.stderr, /Blocking reason: INVALID_CREDENTIAL_FIELD/);
  assert.match(result.stderr, /Attempted review timestamp: \d{4}-\d{2}-\d{2}T/);
  assert.match(
    result.stderr,
    /Unreviewed inputs: manifest\.json, interview\.txt, records\.json, context\.json/,
  );
  assert.equal(result.stderr.includes(secret), false);
});

test("CLI preserves validated identity when records JSON is malformed", async (t) => {
  const root = await preparedRoot(t);
  const sentinel = "MALFORMED-RECORDS-MUST-NOT-LEAK";
  await writeFile(join(root, "records.json"), `{${sentinel}`);

  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Bundle: synthetic-review@r1\nReview status: aborted\n/);
  assert.match(result.stderr, /Blocking reason: INVALID_SCHEMA/);
  assert.equal(result.stderr.includes(sentinel), false);
});

test("CLI preserves validated identity when context validation fails", async (t) => {
  const root = await preparedRoot(t);
  const bundle = makeBundle();
  const sentinel = "INVALID-CONTEXT-MUST-NOT-LEAK";
  bundle["context.json"].preparedBy = sentinel;
  bundle["context.json"].preparedAt = "not-a-timestamp";
  await writeBundle(root, bundle);

  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Bundle: synthetic-review@r1\nReview status: aborted\n/);
  assert.match(result.stderr, /Blocking reason: INVALID_SCHEMA/);
  assert.equal(result.stderr.includes(sentinel), false);
});

test("CLI preserves validated identity when interview validation fails", async (t) => {
  const sentinel = "INVALID-INTERVIEW-MUST-NOT-LEAK";
  const root = await preparedRoot(t, { interview: sentinel });

  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Bundle: synthetic-review@r1\nReview status: aborted\n/);
  assert.match(result.stderr, /Blocking reason: INVALID_SCHEMA/);
  assert.equal(result.stderr.includes(sentinel), false);
});

test("CLI does not derive identity from an invalid manifest", async (t) => {
  const invalidIdentity = "unsafe bundle identity";
  const root = await preparedRoot(t, { manifest: { bundleId: invalidIdentity } });

  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Bundle: unavailable\nReview status: aborted\n/);
  assert.match(result.stderr, /Blocking reason: INVALID_SCHEMA/);
  assert.equal(result.stderr.includes(invalidIdentity), false);
});

test("CLI includes validated bundle identity in a late aborted result", async (t) => {
  const sentinel = "LATE-PACKET-SENTINEL";
  const root = await preparedRoot(t, {
    interview: `Recruiter: Begin.\nApplicant: ${"x".repeat(140_000)}${sentinel}`,
  });
  const result = spawnSync(process.execPath, [cliPath, root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Bundle: synthetic-review@r1\nReview status: aborted\n/);
  assert.match(result.stderr, /Blocking reason: PACKET_TOO_LARGE/);
  assert.equal(result.stderr.includes(sentinel), false);
});

test("CLI rejects unknown, duplicate, missing-value, and misplaced arguments with exit 2", async (t) => {
  const root = await preparedRoot(t);
  const argumentCases = [
    [],
    [root, "--unknown"],
    [root, "--evaluation", "--evaluation"],
    [root, "--confirmed-by", "one", "--confirmed-by", "two"],
    [root, "--confirmed-by"],
    [root, "--confirmed-by", "--evaluation"],
    [root, "--confirmed-by", " "],
    [root, "--confirmed-by", "x".repeat(129)],
    ["--evaluation", root],
    [root, "extra-root"],
  ];
  for (const args of argumentCases) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: node scripts\/prepare\.mjs/);
  }
});
