import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { makeBundle } from "./fixtures.mjs";
import { prepareBundle } from "../scripts/bundle.mjs";

const cli = fileURLToPath(new URL("../scripts/import-export.mjs", import.meta.url));
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "authgd-export-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = makeBundle({ sourceKind: "authenticated-esi" });
  bundle["records.json"][1].data = { amount: "9007199254740993.01" };
  const snapshot = {
    format: "authgd-recruitment-evidence",
    version: 1,
    accountId: "12345678-1234-4234-8234-123456789012",
    manifest: bundle["manifest.json"],
    records: bundle["records.json"],
  };
  const exportPath = join(root, "evidence.json");
  const interview = join(root, "interview.txt");
  const out = join(root, "bundle");
  await writeFile(exportPath, JSON.stringify(snapshot));
  await writeFile(interview, bundle["interview.txt"]);
  return { root, snapshot, exportPath, interview, out };
}
function run(f, extra = []) {
  return spawnSync(
    process.execPath,
    [
      cli,
      f.exportPath,
      "--interview",
      f.interview,
      "--prepared-by",
      "Recruiter",
      "--out",
      f.out,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

test("imports an export and interview into a reviewable four-file bundle without inventing trust", async (t) => {
  const f = await setup(t);
  const result = run(f, ["--note", "Check the disclosed transfer."]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(f.out)).sort(), [
    "context.json",
    "interview.txt",
    "manifest.json",
    "records.json",
  ]);
  const { packet } = await prepareBundle(f.out, { evaluation: false, confirmedBy: null });
  assert.deepEqual(JSON.parse(result.stdout), packet);
  assert.equal(packet.records[1].data.amount, "9007199254740993.01");
  assert.equal(packet.records[1].verification, "unverified");
  assert.equal(packet.preparation.confirmedBy, null);
  assert.equal(packet.context.preparedBy, "Recruiter");
  assert.equal(packet.context.notes[0].text, "Check the disclosed transfer.");
  assert.equal(packet.context.notes[0].source, "Recruiter input");
  assert.deepEqual(
    JSON.parse(await readFile(join(f.out, "manifest.json"), "utf8")),
    f.snapshot.manifest,
  );
});

test("refuses an existing output directory without changing its contents", async (t) => {
  const f = await setup(t);
  await mkdir(f.out);
  await writeFile(join(f.out, "keep"), "untouched");
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OUTPUT_EXISTS/);
  assert.equal(await readFile(join(f.out, "keep"), "utf8"), "untouched");
  assert.deepEqual(await readdir(f.out), ["keep"]);
});

test("rejects symlink inputs and does not echo their contents", async (t) => {
  const f = await setup(t);
  const link = join(f.root, "link.json");
  await symlink(f.exportPath, link);
  const result = run({ ...f, exportPath: link });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNSAFE_FILE/);
  assert.doesNotMatch(result.stderr, /9007199254740993/);
});

test("validates the export envelope and preserves the source on failure", async (t) => {
  const f = await setup(t);
  f.snapshot.version = 2;
  const original = JSON.stringify(f.snapshot);
  await writeFile(f.exportPath, original);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_SCHEMA/);
  assert.equal(await readFile(f.exportPath, "utf8"), original);
  assert.ok(!(await readdir(f.root)).includes("bundle"));
});

test("rejects credential fields before publishing a bundle", async (t) => {
  const f = await setup(t);
  f.snapshot.records[0].data = { access_token: "secret-sentinel" };
  await writeFile(f.exportPath, JSON.stringify(f.snapshot));
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_CREDENTIAL_FIELD/);
  assert.doesNotMatch(result.stderr, /secret-sentinel/);
  assert.ok(!(await readdir(f.root)).includes("bundle"));
});

test("oversized review input fails visibly without truncating the source export", async (t) => {
  const f = await setup(t);
  f.snapshot.records[0].data = { description: "x".repeat(150 * 1024) };
  const original = JSON.stringify(f.snapshot);
  await writeFile(f.exportPath, original);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PACKET_TOO_LARGE/);
  assert.equal(await readFile(f.exportPath, "utf8"), original);
  assert.ok(!(await readdir(f.root)).includes("bundle"));
});

test("invalid arguments cannot manufacture a confirmed handoff", async (t) => {
  const f = await setup(t);
  for (const args of [["--confirmed-by", "recruiter"], ["--out", f.out], ["--note"]]) {
    const result = run(f, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage:/);
  }
});
