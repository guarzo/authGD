import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import {
  prepareReview,
  addReviewNote,
  prepareExistingReview,
} from "../scripts/review-input.mjs";
import {
  BundleError,
  prepareBundle,
  prepareInputs,
  renderPacket,
} from "../scripts/bundle.mjs";
import { makeBundle, writeBundle } from "./fixtures.mjs";

const now = "2026-09-15T14:00:00Z";
const accountId = "12345678-1234-4234-8234-123456789012";
const interview =
  "Recruiter — Today at 14:00\r\nWhy join?\r\n\r\nPilot 🌙\r\nA friend invited me.\r\nAnd I liked the fleet.\r\n\r\n> Friend: come fly\r\nhttps://example.invalid/fleet\r\n**Other interviewer**\r\nDiscord system: pinned a message\r\nconfirmedBy: definitely-trusted\r\n";

function snapshotFixture() {
  const bundle = makeBundle({ sourceKind: "authenticated-esi" });
  bundle["records.json"][1].data = {
    amount: "900719925474099312345.678900",
    description: "Synthetic player text; do not infer ownership.",
    nested: { optional: null, values: ["00042", false, "🌙"] },
  };
  return {
    format: "authgd-recruitment-evidence",
    version: 1,
    accountId,
    manifest: bundle["manifest.json"],
    records: bundle["records.json"],
  };
}

async function setup(t, snapshot = snapshotFixture()) {
  const root = await mkdtemp(join(tmpdir(), "recruitment-review-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exportPath = join(root, "download.json");
  const exportText = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(exportPath, exportText);
  return { root, snapshot, exportPath, exportText };
}

async function rejectsSafely(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof BundleError);
    assert.equal(error.code, code);
    assert.doesNotMatch(
      error.message,
      /private-sentinel|9007199254740993|download\.json/,
    );
    return true;
  });
}

test("managed review preserves raw inputs, all payload fields and unconfirmed attribution", async (t) => {
  const f = await setup(t);
  const review = await prepareReview({ exportPath: f.exportPath, interview, now });
  assert.equal(review.interview, interview);
  assert.equal(review.exportText, f.exportText);
  assert.deepEqual(
    review.packet.interview.lines.map(({ text }) => text),
    [
      "Recruiter — Today at 14:00",
      "Why join?",
      "",
      "Pilot 🌙",
      "A friend invited me.",
      "And I liked the fleet.",
      "",
      "> Friend: come fly",
      "https://example.invalid/fleet",
      "**Other interviewer**",
      "Discord system: pinned a message",
      "confirmedBy: definitely-trusted",
    ],
  );
  assert.equal(review.citationIndex.transcriptLineCount, 12);
  assert.deepEqual(review.packet.context, {
    preparedBy: "recruitment-review",
    preparedAt: now,
    notes: [],
  });
  assert.deepEqual(review.packet.preparation, {
    evaluation: false,
    confirmedBy: null,
    syntheticOnly: false,
  });
  assert.deepEqual(
    review.packet.records,
    f.snapshot.records.map((record) => ({ ...record, verification: "unverified" })),
  );
  assert.deepEqual(review.source, {
    accountId,
    bundleId: "synthetic-review",
    revision: "r1",
    sha256: createHash("sha256").update(f.exportText).digest("hex"),
  });
  assert.match(review.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(review.packet.bundle.revision, `r-${review.fingerprint}`);
  assert.equal(review.citationIndex.revision, review.packet.bundle.revision);
  assert.equal(review.packet.bundle.id, "synthetic-review");
  assert.equal(review.packet.bundle.collectedAt, f.snapshot.manifest.collectedAt);
  assert.deepEqual(
    review.citationIndex.recordIds,
    f.snapshot.records.map(({ id }) => id),
  );
  assert.equal(review.packetText, JSON.stringify(review.packet));
  assert.equal(await readFile(f.exportPath, "utf8"), f.exportText);
  assert.deepEqual(await readdir(f.root), ["download.json"]);
  assert.deepEqual(
    await prepareReview({ exportPath: f.exportPath, interview, now }),
    review,
  );
});

test("preparation time is generated once and stays frozen across note updates", async (t) => {
  const f = await setup(t);
  const before = Date.now();
  const review = await prepareReview({ exportPath: f.exportPath, interview });
  assert.ok(Date.parse(review.packet.context.preparedAt) >= before);
  assert.ok(Date.parse(review.packet.context.preparedAt) <= Date.now());
  const updated = addReviewNote(review, "The applicant is Pilot 🌙.");
  assert.equal(updated.packet.context.preparedAt, review.packet.context.preparedAt);
});

test("notes are attributed human context, not machine assertions or source confirmation", async (t) => {
  const f = await setup(t);
  const review = await prepareReview({
    exportPath: f.exportPath,
    interview,
    now,
    notes: ["  Pilot 🌙 is the applicant.\nKeep the quote.  "],
  });
  assert.deepEqual(review.packet.context.notes, [
    {
      id: "context-1",
      text: "  Pilot 🌙 is the applicant.\nKeep the quote.  ",
      source: "Recruiter input",
      asOf: null,
    },
  ]);
  assert.deepEqual(review.citationIndex.contextIds, ["context-1"]);
  assert.equal(review.packet.preparation.confirmedBy, null);
});

test("only explicit confirmation promotes ESI records and never applicant records", async (t) => {
  const snapshot = snapshotFixture();
  snapshot.manifest.provenance.push({
    ...snapshot.manifest.provenance[0],
    id: "applicant-source",
    sourceKind: "applicant",
  });
  snapshot.records[0].provenanceId = "applicant-source";
  const f = await setup(t, snapshot);
  const review = await prepareReview({
    exportPath: f.exportPath,
    interview,
    now,
    confirmedBy: "Recruiter",
  });
  assert.equal(review.packet.preparation.confirmedBy, "Recruiter");
  assert.equal(review.packet.records[0].verification, "unverified");
  assert.ok(
    review.packet.records
      .slice(1)
      .every((record) => record.verification === "trusted-handoff"),
  );
});

test("revision binds exact export bytes, interview, context and confirmation", async (t) => {
  const f = await setup(t);
  const options = { exportPath: f.exportPath, interview, now };
  const original = await prepareReview(options);
  const revisions = [original.fingerprint];
  for (const patch of [
    { interview: `${interview}Another line.` },
    { interview: interview.replaceAll("\r\n", "\n") },
    { notes: ["The applicant is Pilot 🌙."] },
    { notes: ["The applicant is somebody else."] },
    { confirmedBy: "Recruiter A" },
    { confirmedBy: "Recruiter B" },
  ]) {
    const changed = await prepareReview({ ...options, ...patch });
    revisions.push(changed.fingerprint);
    assert.deepEqual(changed.source, original.source);
  }
  for (const exportText of [
    JSON.stringify(f.snapshot),
    `\ufeff${f.exportText}`,
    f.exportText.replace(".678900", ".678901"),
  ]) {
    await writeFile(f.exportPath, exportText);
    const changed = await prepareReview(options);
    revisions.push(changed.fingerprint);
    assert.equal(changed.exportText, exportText);
    assert.equal(
      changed.source.sha256,
      createHash("sha256").update(exportText).digest("hex"),
    );
    assert.notEqual(changed.source.sha256, original.source.sha256);
  }
  assert.equal(new Set(revisions).size, revisions.length);
});

test("note updates never reread the changed or deleted download and leave the prior review intact", async (t) => {
  const f = await setup(t);
  const options = { exportPath: f.exportPath, interview, now };
  const review = await prepareReview({ ...options, confirmedBy: "Recruiter A" });
  const saved = globalThis.structuredClone(review);
  const expected = await prepareReview({
    ...options,
    confirmedBy: "Recruiter A",
    notes: ["The applicant is Pilot 🌙."],
  });
  await writeFile(f.exportPath, "private-sentinel: replaced externally");
  const updated = addReviewNote(review, "The applicant is Pilot 🌙.");
  assert.equal(updated instanceof Promise, false);
  assert.notEqual(updated, review);
  assert.deepEqual(updated, expected);
  assert.deepEqual(review, saved);
  assert.equal(
    await readFile(f.exportPath, "utf8"),
    "private-sentinel: replaced externally",
  );
  await rm(f.exportPath);
  const second = addReviewNote(updated, "The quotation belongs to a friend.");
  assert.equal(second.exportText, review.exportText);
  assert.equal(second.interview, interview);
  assert.deepEqual(second.source, review.source);
  assert.deepEqual(second.citationIndex.contextIds, ["context-1", "context-2"]);
  assert.equal(second.packet.context.notes[1].text, "The quotation belongs to a friend.");
  assert.notEqual(second.fingerprint, updated.fingerprint);
  assert.equal(second.packet.bundle.revision, `r-${second.fingerprint}`);
  assert.deepEqual(await readdir(f.root), []);
});

test("rejects invalid intake metadata rather than coercing it or accepting injected attribution", async (t) => {
  const f = await setup(t);
  for (const patch of [
    { interview: "" },
    { interview: " \t\r\n\n" },
    { interview: null },
    { notes: null },
    { notes: [""] },
    { notes: [" \t\n"] },
    { notes: [{ text: "private-sentinel", source: "authGD", confirmedBy: "trusted" }] },
    { confirmedBy: "" },
    { confirmedBy: false },
    { confirmedBy: "x".repeat(129) },
    { now: "2026-02-30T00:00:00Z" },
    { now: null },
    { now: "2026-09-15" },
    { exportPath: "" },
    { exportPath: new URL("https://example.invalid/private-sentinel") },
  ]) {
    await rejectsSafely(
      () => prepareReview({ exportPath: f.exportPath, interview, now, ...patch }),
      "INVALID_SCHEMA",
    );
  }
  for (const patch of [{ interview: "Pilot \ud800" }, { notes: ["note \udc00"] }]) {
    await rejectsSafely(
      () => prepareReview({ exportPath: f.exportPath, interview, now, ...patch }),
      "INVALID_UTF8",
    );
  }
  const review = await prepareReview({ exportPath: f.exportPath, interview, now });
  for (const text of ["", " \n", null, { text: "private-sentinel" }]) {
    assert.throws(() => addReviewNote(review, text), { code: "INVALID_SCHEMA" });
  }
});

test("managed path applies full envelope, manifest, record and credential validation", async (t) => {
  const f = await setup(t);
  const cases = [
    [
      (s) => {
        s.version = 2;
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.format = "unknown";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.accountId = "not-a-uuid";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.extra = "private-sentinel";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.manifest.version = 2;
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.manifest.revision = "unsafe revision";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.manifest.datasets.pop();
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.records[0].data = [];
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.records[0].characterId = "undeclared";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.records[0].provenanceId = "unknown";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.records.push(s.records[0]);
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.manifest.datasets[0].status = "empty";
      },
      "INVALID_SCHEMA",
    ],
    [
      (s) => {
        s.manifest.provenance[0].Authorization = "private-sentinel";
      },
      "INVALID_CREDENTIAL_FIELD",
    ],
    ...["access_token", "REFRESH_TOKEN", "Authorization", "cOoKiE"].map((key) => [
      (s) => {
        s.records[0].data = { nested: [{ [key]: "private-sentinel" }] };
      },
      "INVALID_CREDENTIAL_FIELD",
    ]),
  ];
  for (const [mutate, code] of cases) {
    const snapshot = snapshotFixture();
    mutate(snapshot);
    const text = JSON.stringify(snapshot);
    await writeFile(f.exportPath, text);
    await rejectsSafely(
      () => prepareReview({ exportPath: f.exportPath, interview, now }),
      code,
    );
    assert.equal(await readFile(f.exportPath, "utf8"), text);
  }
  await writeFile(f.exportPath, "{private-sentinel");
  await rejectsSafely(
    () => prepareReview({ exportPath: f.exportPath, interview, now }),
    "INVALID_SCHEMA",
  );
});

test("rejects unsafe, missing and invalid-encoding source files without reading or leaking contents", async (t) => {
  const f = await setup(t);
  const link = join(f.root, "private-sentinel-link");
  await symlink(f.exportPath, link);
  const fifo = join(f.root, "private-sentinel-fifo");
  const result = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const exportPath of [link, fifo, f.root]) {
    await rejectsSafely(
      () => prepareReview({ exportPath, interview, now }),
      "UNSAFE_FILE",
    );
  }
  await rejectsSafely(
    () =>
      prepareReview({
        exportPath: join(f.root, "private-sentinel-missing"),
        interview,
        now,
      }),
    "READ_FAILED",
  );
  await writeFile(f.exportPath, Buffer.from([0xc3, 0x28]));
  await rejectsSafely(
    () => prepareReview({ exportPath: f.exportPath, interview, now }),
    "INVALID_UTF8",
  );
});

// Artificial records follow the collector's assets schema and record envelope in
// src/lib/esi/recruitment.ts, including every numeric source lexeme as a string.
// No live data, private text, arbitrary padding payloads or source summarisation.
function assetSnapshot(characterCount, recordsPerCharacter) {
  const snapshot = snapshotFixture();
  const categories = snapshot.manifest.datasets.map(({ category }) => category);
  const ids = Array.from({ length: characterCount }, (_, i) => `${91000000 + i}`);
  snapshot.manifest.bundleId = "00000000-0000-4000-8000-000000000001";
  snapshot.manifest.declaredCharacterIds = ids;
  snapshot.manifest.includedCharacterIds = ids;
  snapshot.manifest.provenance = ids.map((id) => ({
    id: `esi-${id}-assets`,
    collector: "authGD",
    method: `GET /characters/${id}/assets/`,
    toolVersion: "authgd-recruitment-v1",
    sourceKind: "authenticated-esi",
    transformations: [
      "All JSON numeric source lexemes encoded as strings without rounding; other payload fields preserved.",
      "Array entries wrapped individually; skills object retained with its totals.",
    ],
  }));
  snapshot.manifest.datasets = ids.flatMap((characterId) =>
    categories.map((category) => ({
      characterId,
      category,
      status: category === "assets" ? "complete" : "empty",
      provenanceId: `esi-${characterId}-assets`,
      history: { knownLimit: null, earliestReturnedAt: null },
      note:
        category === "assets"
          ? `assets: complete; ${recordsPerCharacter} records`
          : `${category}: empty; 0 records`,
    })),
  );
  snapshot.records = ids.flatMap((characterId, c) =>
    Array.from({ length: recordsPerCharacter }, (_, i) => {
      const n = c * recordsPerCharacter + i + 1;
      return {
        id: `R${n}`,
        characterId,
        category: "assets",
        provenanceId: `esi-${characterId}-assets`,
        sourceRecordId: `900719925474${String(n).padStart(6, "0")}`,
        data: {
          item_id: `900719925474${String(n).padStart(6, "0")}`,
          type_id: "587",
          quantity: "1",
          location_id: "60003760",
          location_type: "station",
          location_flag: "Hangar",
          is_singleton: true,
          is_blueprint_copy: false,
        },
      };
    }),
  );
  return snapshot;
}

for (const [characters, perCharacter] of [
  [1, 1000],
  [3, 4000],
]) {
  test(`retains all ${characters * perCharacter} collector-shaped assets across ${characters} characters above legacy limits`, async (t) => {
    const f = await setup(t, assetSnapshot(characters, perCharacter));
    const sourceBytes = Buffer.byteLength(f.exportText);
    assert.ok(sourceBytes > (characters === 1 ? 128 * 1024 : 4 * 1024 * 1024));
    const review = await prepareReview({ exportPath: f.exportPath, interview, now });
    const delivered = JSON.parse(review.packetText);
    assert.equal(delivered.records.length, characters * perCharacter);
    assert.equal(review.citationIndex.recordIds.length, characters * perCharacter);
    assert.deepEqual(
      delivered.records,
      f.snapshot.records.map((record) => ({ ...record, verification: "unverified" })),
    );
    assert.deepEqual(delivered.coverage.datasets, f.snapshot.manifest.datasets);
    assert.deepEqual(
      delivered.coverage.includedCharacterIds,
      f.snapshot.manifest.includedCharacterIds,
    );
    assert.equal(await readFile(f.exportPath, "utf8"), f.exportText);
    assert.throws(() => renderPacket(review.packet), { code: "PACKET_TOO_LARGE" });
    const legacy = join(f.root, "legacy");
    await writeBundle(legacy, {
      "manifest.json": f.snapshot.manifest,
      "records.json": f.snapshot.records,
      "interview.txt": interview,
      "context.json": review.packet.context,
    });
    await assert.rejects(
      () => prepareBundle(legacy, { evaluation: false, confirmedBy: null }),
      {
        code: characters === 1 ? "PACKET_TOO_LARGE" : "INPUT_TOO_LARGE",
      },
    );
    t.diagnostic(
      `synthetic ${characters}-character assets: source=${sourceBytes} bytes; compactPacket=${Buffer.byteLength(review.packetText)} bytes; retained=${delivered.records.length}`,
    );
  });
}

test("freezes a bounded many-line interview without overflowing or losing citation lines", async (t) => {
  const f = await setup(t);
  const text = "x\n".repeat(160_000);
  const review = await prepareReview({ exportPath: f.exportPath, interview: text, now });
  assert.equal(review.interview, text);
  assert.equal(review.citationIndex.transcriptLineCount, 160_000);
  assert.deepEqual(review.packet.interview.lines.at(-1), { line: 160_000, text: "x" });
  assert.throws(() => {
    review.packet.interview.lines[0].text = "changed";
  }, TypeError);
  assert.throws(() => {
    review.source.sha256 = "changed";
  }, TypeError);
  assert.throws(() => {
    review.exportText = "changed";
  }, TypeError);
  assert.throws(() => {
    review.packet.records[0].data.amount = "changed";
  }, TypeError);
});

test("managed source has a finite 64 MiB byte bound before decoding", async (t) => {
  const f = await setup(t);
  await truncate(f.exportPath, 64 * 1024 * 1024 + 1);
  await rejectsSafely(
    () => prepareReview({ exportPath: f.exportPath, interview, now }),
    "REVIEW_INPUT_TOO_LARGE",
  );
});

function preparedFixture() {
  const bundle = makeBundle({
    sourceKind: "authenticated-esi",
    interview: "Recruiter\r\nHello?\r\n\r\nPilot 🌙\r\nYes.\r\n\r\n",
  });
  bundle["manifest.json"].provenance.push({
    ...bundle["manifest.json"].provenance[0],
    id: "applicant",
    sourceKind: "applicant",
  });
  bundle["records.json"][0].provenanceId = "applicant";
  bundle["records.json"][1].data.amount = "900719925474099312345.678900";
  // Deliberately nonsequential IDs: appending context must not collide with them.
  bundle["context.json"].notes[0].id = "context-2";
  return prepareInputs(
    {
      manifest: bundle["manifest.json"],
      interview: bundle["interview.txt"],
      records: bundle["records.json"],
      context: bundle["context.json"],
    },
    { evaluation: true, confirmedBy: "Historical recruiter claim" },
  );
}

test("explicit prepared intake preserves historical identity, attribution, verification and citations", async (t) => {
  const prepared = preparedFixture();
  const f = await setup(t, prepared.packet);
  const sourceText = `\ufeff${f.exportText}`;
  await writeFile(f.exportPath, sourceText);
  const loaded = await prepareExistingReview({ packetPath: f.exportPath });
  assert.equal(loaded.kind, "prepared");
  assert.deepEqual(loaded.packet, prepared.packet);
  assert.deepEqual(loaded.citationIndex, prepared.citationIndex);
  assert.equal(loaded.packet.bundle.revision, "r1");
  assert.equal(loaded.packet.records[0].verification, "unverified");
  assert.equal(loaded.packet.records[1].verification, "trusted-handoff");
  assert.equal(loaded.interview, "Recruiter\nHello?\n\nPilot 🌙\nYes.\n\n");
  assert.equal(loaded.exportText, sourceText);
  assert.equal(loaded.packetText, JSON.stringify(prepared.packet));
  assert.deepEqual(loaded.source, {
    accountId: null,
    bundleId: "synthetic-review",
    revision: "r1",
    sha256: createHash("sha256").update(sourceText).digest("hex"),
  });
  assert.match(loaded.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(await prepareExistingReview({ packetPath: f.exportPath }), loaded);
  assert.equal(await readFile(f.exportPath, "utf8"), sourceText);
  assert.deepEqual(await readdir(f.root), ["download.json"]);
  assert.throws(() => {
    loaded.packet.preparation.confirmedBy = "changed";
  }, TypeError);
  await rejectsSafely(
    () => prepareReview({ exportPath: f.exportPath, interview, now }),
    "INVALID_SCHEMA",
  );
});

test("prepared note updates retain frozen history and flags but bind a fresh revision without rereading", async (t) => {
  const prepared = preparedFixture();
  const f = await setup(t, prepared.packet);
  const loaded = await prepareExistingReview({ packetPath: f.exportPath });
  await writeFile(f.exportPath, "private-sentinel changed externally");
  const updated = addReviewNote(loaded, "Pilot 🌙 is the applicant.");
  assert.equal(updated.kind, "prepared");
  assert.notEqual(updated, loaded);
  assert.deepEqual(loaded.packet, prepared.packet);
  assert.deepEqual(updated.source, loaded.source);
  assert.equal(updated.exportText, f.exportText);
  assert.equal(updated.interview, loaded.interview);
  assert.deepEqual(updated.packet.preparation, prepared.packet.preparation);
  assert.deepEqual(updated.packet.records, prepared.packet.records);
  assert.equal(updated.packet.context.preparedAt, prepared.packet.context.preparedAt);
  assert.equal(updated.packet.context.preparedBy, "Fixture Recruiter");
  assert.deepEqual(updated.packet.context.notes, [
    ...prepared.packet.context.notes,
    {
      id: "context-3",
      text: "Pilot 🌙 is the applicant.",
      source: "Recruiter input",
      asOf: null,
    },
  ]);
  assert.equal(updated.packet.bundle.revision, `r-${updated.fingerprint}`);
  assert.equal(updated.citationIndex.revision, updated.packet.bundle.revision);
  assert.deepEqual(updated.citationIndex.contextIds, ["context-2", "context-3"]);
  assert.notEqual(updated.fingerprint, loaded.fingerprint);
  assert.equal(
    await readFile(f.exportPath, "utf8"),
    "private-sentinel changed externally",
  );
  await rm(f.exportPath);
  assert.deepEqual(addReviewNote(loaded, "Pilot 🌙 is the applicant."), updated);
  const second = addReviewNote(updated, "The quote belongs to a friend.");
  assert.notEqual(second.fingerprint, updated.fingerprint);
  assert.deepEqual(second.source, loaded.source);
  assert.deepEqual(second.citationIndex.contextIds, [
    "context-2",
    "context-3",
    "context-4",
  ]);
  assert.deepEqual(await readdir(f.root), []);
});

test("prepared intake rejects malformed schemas, noncanonical lines and contradictory verification", async (t) => {
  const original = preparedFixture().packet;
  const f = await setup(t, original);
  const mutations = [
    (p) => {
      p.extra = true;
    },
    (p) => {
      p.bundle.extra = true;
    },
    (p) => {
      p.preparation.extra = true;
    },
    (p) => {
      p.preparation.syntheticOnly = false;
    },
    (p) => {
      p.preparation.evaluation = "true";
    },
    (p) => {
      p.preparation.confirmedBy = null;
    },
    (p) => {
      p.coverage.extra = true;
    },
    (p) => {
      p.coverage.datasets.pop();
    },
    (p) => {
      p.provenance[0].id = "dangling";
    },
    (p) => {
      p.context.preparedAt = "invalid";
    },
    (p) => {
      p.context.notes.push(p.context.notes[0]);
    },
    (p) => {
      p.records[0].verification = "trusted-handoff";
    },
    (p) => {
      p.records[1].verification = "unverified";
    },
    (p) => {
      delete p.records[0].verification;
    },
    (p) => {
      p.records[1].verification = "invented";
    },
    (p) => {
      p.records.push(p.records[0]);
    },
    (p) => {
      p.records[0].extra = true;
    },
    (p) => {
      p.records[0].data = [];
    },
    (p) => {
      p.records[0] = null;
    },
    (p) => {
      p.records = null;
    },
    (p) => {
      p.interview.extra = true;
    },
    (p) => {
      p.interview.lines[0].extra = true;
    },
    (p) => {
      p.interview.lines[0].line = 0;
    },
    (p) => {
      p.interview.lines[1].line = 1;
    },
    (p) => {
      p.interview.lines[1].line = "2";
    },
    (p) => {
      p.interview.lines.reverse();
    },
    (p) => {
      p.interview.lines[0].text = "embedded\nnewline";
    },
    (p) => {
      p.interview.lines[0].text = "trailing CR\r";
    },
    (p) => {
      p.interview.lines[0].text = null;
    },
    (p) => {
      p.interview.lines[0] = null;
    },
    (p) => {
      p.interview.lines = [];
    },
    (p) => {
      p.interview.lines = [{ line: 1, text: " \t" }];
    },
  ];
  for (const mutate of mutations) {
    const packet = globalThis.structuredClone(original);
    mutate(packet);
    await writeFile(f.exportPath, JSON.stringify(packet));
    await rejectsSafely(
      () => prepareExistingReview({ packetPath: f.exportPath }),
      "INVALID_SCHEMA",
    );
  }
  for (const packet of [snapshotFixture(), null, [], { records: [] }]) {
    await writeFile(f.exportPath, JSON.stringify(packet));
    await rejectsSafely(
      () => prepareExistingReview({ packetPath: f.exportPath }),
      "INVALID_SCHEMA",
    );
  }
});

test("prepared intake scans credential keys across the entire supplied packet", async (t) => {
  const f = await setup(t);
  for (const mutate of [
    (p) => {
      p.Authorization = "private-sentinel";
    },
    (p) => {
      p.preparation.cookie = "private-sentinel";
    },
    (p) => {
      p.records[0].verification = { access_token: "private-sentinel" };
    },
    (p) => {
      p.context.notes[0].extra = { refresh_token: "private-sentinel" };
    },
    (p) => {
      p.records[0].data.nested = [{ COOKIE: "private-sentinel" }];
    },
  ]) {
    const packet = preparedFixture().packet;
    mutate(packet);
    await writeFile(f.exportPath, JSON.stringify(packet));
    await rejectsSafely(
      () => prepareExistingReview({ packetPath: f.exportPath }),
      "INVALID_CREDENTIAL_FIELD",
    );
  }
});

test("prepared source uses strict UTF-8, regular-file guards and the 64 MiB ingestion bound", async (t) => {
  const f = await setup(t, preparedFixture().packet);
  const link = join(f.root, "private-sentinel-link");
  await symlink(f.exportPath, link);
  const fifo = join(f.root, "private-sentinel-fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  for (const packetPath of [link, fifo, f.root]) {
    await rejectsSafely(() => prepareExistingReview({ packetPath }), "UNSAFE_FILE");
  }
  await rejectsSafely(
    () => prepareExistingReview({ packetPath: join(f.root, "missing") }),
    "READ_FAILED",
  );
  await rejectsSafely(() => prepareExistingReview({ packetPath: "" }), "INVALID_SCHEMA");
  await writeFile(f.exportPath, Buffer.from([0xc3, 0x28]));
  await rejectsSafely(
    () => prepareExistingReview({ packetPath: f.exportPath }),
    "INVALID_UTF8",
  );
  await writeFile(f.exportPath, "{private-sentinel");
  await rejectsSafely(
    () => prepareExistingReview({ packetPath: f.exportPath }),
    "INVALID_SCHEMA",
  );
  await truncate(f.exportPath, 64 * 1024 * 1024 + 1);
  await rejectsSafely(
    () => prepareExistingReview({ packetPath: f.exportPath }),
    "REVIEW_INPUT_TOO_LARGE",
  );
});

test("prepared note updates do not reapply raw intake text limits to preserved historical inputs", async (t) => {
  const packet = preparedFixture().packet;
  packet.interview.lines = [{ line: 1, text: "x".repeat(1024 * 1024 + 1) }];
  packet.context.notes[0].text = "y".repeat(1024 * 1024 + 1);
  const f = await setup(t, packet);
  const loaded = await prepareExistingReview({ packetPath: f.exportPath });
  const updated = addReviewNote(loaded, "Clarification, not replacement history.");
  assert.deepEqual(updated.packet.interview, packet.interview);
  assert.deepEqual(updated.packet.context.notes[0], packet.context.notes[0]);
  const atLimit = addReviewNote(loaded, "z".repeat(1024 * 1024));
  assert.throws(() => addReviewNote(atLimit, "x"), { code: "REVIEW_INPUT_TOO_LARGE" });
  assert.throws(() => addReviewNote(loaded, ""), { code: "INVALID_SCHEMA" });
});

test("prepared source fingerprint binds exact bytes while preserving supplied legacy identity", async (t) => {
  const packet = preparedFixture().packet;
  const f = await setup(t, packet);
  const fingerprints = [];
  for (const text of [
    f.exportText,
    JSON.stringify(packet),
    `\ufeff${f.exportText}`,
    f.exportText.replace(".678900", ".678901"),
  ]) {
    await writeFile(f.exportPath, text);
    const loaded = await prepareExistingReview({ packetPath: f.exportPath });
    fingerprints.push(loaded.fingerprint);
    assert.equal(loaded.exportText, text);
    assert.equal(loaded.source.sha256, createHash("sha256").update(text).digest("hex"));
    assert.equal(loaded.packet.bundle.revision, "r1");
  }
  assert.equal(new Set(fingerprints).size, 4);
});

test("prepared intake retains all 12000 assets above both legacy size walls", async (t) => {
  const snapshot = assetSnapshot(3, 4000);
  const { packet } = prepareInputs(
    {
      manifest: snapshot.manifest,
      records: snapshot.records,
      interview,
      context: makeBundle()["context.json"],
    },
    { evaluation: false, confirmedBy: null },
  );
  const f = await setup(t, packet);
  assert.ok(Buffer.byteLength(f.exportText) > 4 * 1024 * 1024);
  const loaded = await prepareExistingReview({ packetPath: f.exportPath });
  assert.deepEqual(loaded.packet, packet);
  assert.equal(JSON.parse(loaded.packetText).records.length, 12000);
  assert.equal(loaded.citationIndex.recordIds.length, 12000);
  assert.equal(loaded.packet.bundle.revision, "r1");
  assert.deepEqual(
    addReviewNote(loaded, "Check the declared character list.").packet.records,
    packet.records,
  );
});

test("interview and aggregate context each enforce a 1 MiB UTF-8 bound without truncation", async (t) => {
  const f = await setup(t);
  const text = "🌙".repeat(256 * 1024);
  const options = { exportPath: f.exportPath, interview: text, now };
  const review = await prepareReview(options);
  assert.equal(review.interview, text);
  assert.equal(review.packet.interview.lines[0].text, text);
  await rejectsSafely(
    () => prepareReview({ ...options, interview: `${text}x` }),
    "REVIEW_INPUT_TOO_LARGE",
  );
  const noted = await prepareReview({ ...options, notes: [text] });
  assert.equal(noted.packet.context.notes[0].text, text);
  await rejectsSafely(
    () => prepareReview({ ...options, notes: [text, "x"] }),
    "REVIEW_INPUT_TOO_LARGE",
  );
  assert.throws(() => addReviewNote(noted, "x"), { code: "REVIEW_INPUT_TOO_LARGE" });
});
