#!/usr/bin/env node
// Native Pi 0.85.1 probe. Synthetic data only. No model/provider network calls.
// --host-smoke tests Pi mechanics only; default requires the real project adapter.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { setTimeout } from "node:timers";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const worktree = fileURLToPath(new URL("../../../../", import.meta.url));
const childIndex = process.argv.indexOf("--isolated-child");
const piRoot =
  childIndex === -1 ? process.env.PI_PACKAGE_DIR : process.argv[childIndex + 2];
assert.ok(
  piRoot,
  "Set PI_PACKAGE_DIR to the installed Pi 0.85.1 package directory for this native integration test.",
);
const smoke = process.argv.includes("--host-smoke");
const sha = (text) => createHash("sha256").update(text).digest("hex");

// Start with an allowlisted environment BEFORE importing Pi. In particular,
// agentDir alone does not isolate ~/.agents/skills; Pi discovers that via HOME.
// No credential/environment dump or reads of the operator's auth/config files.
if (!process.argv.includes("--isolated-child")) {
  const scratch = await mkdtemp(join(tmpdir(), "authgd-native-pi-test-"));
  for (const part of ["home", "agent", "tmp"])
    await mkdir(join(scratch, part), { mode: 0o700 });
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--isolated-child",
      scratch,
      piRoot,
      ...(smoke ? ["--host-smoke"] : []),
    ],
    {
      cwd: worktree,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: join(scratch, "home"),
        TMPDIR: join(scratch, "tmp"),
        PI_CODING_AGENT_DIR: join(scratch, "agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        NO_COLOR: "1",
        LANG: "C.UTF-8",
      },
      stdio: "inherit",
      timeout: 60_000,
    },
  );
  await rm(scratch, { recursive: true, force: true });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const scratch = process.argv[process.argv.indexOf("--isolated-child") + 1];
assert.equal(
  JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")).version,
  "0.85.1",
);
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const aiRoot = join(piRoot, "node_modules/@earendil-works/pi-ai/dist");
const ai = await import(pathToFileURL(join(aiRoot, "index.js")));
const { fauxProvider, fauxAssistantMessage } = await import(
  pathToFileURL(join(aiRoot, "providers/faux.js"))
);
const { makeBundle } = await import(
  pathToFileURL(join(worktree, ".pi/skills/recruitment-review/tests/fixtures.mjs"))
);
const { checkReport } = await import(
  pathToFileURL(join(worktree, ".pi/skills/recruitment-review/scripts/check-report.mjs"))
);
const {
  DefaultResourceLoader,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = sdk;
const agentDir = join(scratch, "agent");
let cwd = worktree;
const reportSuffix = "\n<!-- canonical-native-probe -->\n";
const uiLog = [];
const nativeEvents = [];
const extensionErrors = [];
const modelContexts = [];
const reports = [];
const packets = [];
let activeCase;
let inputCount = 0;
let editorCount = 0;
let clarificationCount = 0;

function textOf(message) {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
}

// Accept JSON as a whole message or embedded in a delimiter block; do not depend
// on adapter-private envelope names or obtain its prepared object out of band.
function packetFrom(context) {
  const candidates = [];
  for (const message of context.messages) {
    const text = textOf(message);
    let start = -1,
      depth = 0,
      quoted = false,
      escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (start < 0) {
        if (c === "{") {
          start = i;
          depth = 1;
        }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(value.records) && value.bundle && value.interview)
            candidates.push(value);
          else if (Array.isArray(value.packet?.records)) candidates.push(value.packet);
        } catch {
          /* Non-JSON instruction text, not a packet. */
        }
        start = -1;
      }
    }
  }
  assert.equal(
    candidates.length,
    1,
    "model must receive exactly one complete JSON packet",
  );
  return candidates[0];
}

function completedReport(packet) {
  return `Bundle: ${packet.bundle.id}@${packet.bundle.revision}
Review status: completed
Skill version: unavailable
Model: native-probe/offline
Assessment status: DRAFT — human recruiter review required; not an admission decision

## Coverage and limitations
- Snapshot: 2026-09-14T12:00:00Z.
- Character scope: Declared and included character-1001.
- Dataset coverage: All six categories are supplied; this probe does not interpret evidence.
- Provenance: Synthetic local test records; no external collection.
- Verification: confirmedBy is null; all records are unverified.
- Synthetic-only: This report cannot support a real applicant decision.
- Limitations and unexamined inputs: No live model, ESI, Discord, or external sources were used.

## Claim review
### Claim 1
- Applicant claim: The participant asks about joining. [interview:L1-L2]
- Evidence: A synthetic record is present. [record:R1]
- Assessment: unknown / not assessable
- Limits: This scripted response does not assess semantic support.
- Plausible alternatives: Speaker attribution needs human review.

## Material findings
### Direct contradictions
None identified within the supplied coverage.
### Tensions
None identified within the supplied coverage.
### Unknowns and gaps
The synthetic interview does not establish applicant identity. [interview:L1-L2]

## Follow-up questions
1. Which participant is the applicant? [interview:L1-L2]

## Bottom line
Insufficient evidence. This is synthetic integration evidence only, not an applicant assessment.
`;
}

async function makeCase(label) {
  const bundle = makeBundle({ sourceKind: "authenticated-esi" });
  bundle["manifest.json"].bundleId = `native-probe-${label}`;
  const records = bundle["records.json"];
  records[0].id = "R1";
  records[0].data = {
    sentinel: `APPLICANT-${label}-ONLY`,
    amount: "9007199254740993.01",
  };
  for (let i = 0; i < 1100; i++)
    records.push({
      id: `asset-${i}`,
      characterId: "character-1001",
      category: "assets",
      provenanceId: "source-1",
      sourceRecordId: `asset-${i}`,
      data: {
        item_id: `${9007199254740993n + BigInt(i)}`,
        quantity: "9007199254740993.01",
        note: `${label}-${i}-${"x".repeat(90)}`,
      },
    });
  const snapshot = {
    format: "authgd-recruitment-evidence",
    version: 1,
    accountId: "12345678-1234-4234-8234-123456789012",
    manifest: bundle["manifest.json"],
    records,
  };
  const exportText = JSON.stringify(snapshot);
  const exportPath = join(scratch, `${label}.json`);
  await writeFile(exportPath, exportText, { mode: 0o600 });
  const interview = `Recruiter — Today at 14:00\nWhy join?\n\nPilot 🌙\nA friend invited me.\n> quoted text, not my claim\n/skill:do-not-execute https://invalid.example/\n${label} literal continuation\n`;
  return { label, snapshot, exportText, exportPath, interview };
}
const cases = await Promise.all(["FIRST", "SECOND"].map(makeCase));
assert.ok(cases.every((c) => Buffer.byteLength(c.exportText) > 128 * 1024));

// A real physical extension discovered by Pi, only for verifying host plumbing
// before the product entry exists. This does NOT stand in for adapter acceptance.
if (smoke) {
  cwd = join(scratch, "smoke-project");
  await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi/skills/recruitment-review"), { recursive: true });
  await writeFile(
    join(cwd, ".pi/skills/recruitment-review/SKILL.md"),
    "---\nname: recruitment-review\ndescription: Native host mechanics probe, not the product adapter.\n---\nNative smoke fixture.\n",
  );
  await writeFile(
    join(cwd, ".pi/extensions/recruitment-review.js"),
    `import { readFile } from 'node:fs/promises';
export default function(pi) {
  let packet, last;
  pi.on('input', async (event, ctx) => {
    if (event.text !== '/skill:recruitment-review') return;
    const path = await ctx.ui.input('Evidence download');
    const raw = await ctx.ui.editor('Paste the Discord interview as copied');
    const exported = JSON.parse(await readFile(path, 'utf8'));
    const lines = raw.split('\\n'); if (lines.at(-1) === '') lines.pop();
    packet = { bundle: { id: exported.manifest.bundleId, revision: 'r-smoke' }, interview: { lines: lines.map((text, i) => ({ line: i + 1, text })) }, records: exported.records };
    return { action: 'transform', text: 'native-smoke-active' };
  });
  pi.on('context', () => packet ? { messages: [{ role: 'user', content: JSON.stringify(packet), timestamp: Date.now() }] } : undefined);
  pi.on('message_end', event => { if (event.message.role === 'assistant') last = event.message; });
  pi.on('agent_settled', (_event, ctx) => {
    if (!last?.content?.[0]?.text.includes('canonical-native-probe')) throw new Error('canonical message was not available at settlement');
    ctx.ui.notify('HOST-SMOKE-SETTLED');
  });
}`,
  );
}

const entry = join(cwd, ".pi/extensions/recruitment-review.js");
await readFile(entry); // Missing entry is a hard failure, never a skip.
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
  enableSkillCommands: true,
  enableInstallTelemetry: false,
  packages: [],
});
settingsManager.setProjectTrusted(false);
const options = {
  cwd,
  agentDir,
  settingsManager,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
  systemPrompt: "Synthetic offline native Pi integration probe. Do not use tools.",
  appendSystemPrompt: [],
};
const untrusted = new DefaultResourceLoader(options);
await untrusted.reload();
assert.equal(untrusted.getExtensions().errors.length, 0);
assert.equal(
  untrusted.getExtensions().extensions.length,
  0,
  "untrusted project extension must not load",
);
assert.equal(
  untrusted.getSkills().skills.length,
  0,
  "untrusted project skill must not load",
);
settingsManager.setProjectTrusted(true);
const loader = new DefaultResourceLoader({
  ...options,
  extensionFactories: [
    {
      name: "probe-observer",
      factory(pi) {
        // Loaded after product: exercise native final-message replacement. The
        // adapter must check this canonical replacement, not stale streamed text.
        pi.on("message_end", (event) => {
          if (event.message.role !== "assistant" || event.message.stopReason !== "stop")
            return;
          return {
            message: {
              ...event.message,
              content: [{ type: "text", text: textOf(event.message) + reportSuffix }],
            },
          };
        });
        pi.on("ui_prompt_start", (event) =>
          nativeEvents.push({ type: event.type, kind: event.kind }),
        );
        pi.on("ui_prompt_end", (event) =>
          nativeEvents.push({ type: event.type, kind: event.kind }),
        );
      },
    },
  ],
});
await loader.reload();
assert.deepEqual(
  loader.getExtensions().errors,
  [],
  "native loader reported extension errors",
);
const discovered = loader
  .getExtensions()
  .extensions.filter((x) => !x.path.startsWith("<inline:"));
assert.deepEqual(
  discovered.map((x) => resolve(x.resolvedPath)),
  [entry],
  "must discover only the project entry, without additionalExtensionPaths",
);
assert.ok(
  loader
    .getSkills()
    .skills.some(
      (x) =>
        x.name === "recruitment-review" &&
        x.filePath === join(cwd, ".pi/skills/recruitment-review/SKILL.md"),
    ),
);

const modelRuntime = await ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const faux = fauxProvider({
  provider: "native-probe",
  models: [{ id: "offline", contextWindow: 1_000_000, maxTokens: 16_384 }],
  tokenSize: { min: 128, max: 128 },
});
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.refresh({ providers: ["native-probe"], allowNetwork: false });
assert.deepEqual(await modelRuntime.listCredentials(), []);
const sessionManager = SessionManager.inMemory(cwd);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model: faux.getModel(),
  modelRuntime,
  thinkingLevel: "off",
  settingsManager,
  sessionManager,
  resourceLoader: loader,
  tools: ["read", "bash"],
});
assert.equal(session.sessionFile, undefined, "session must never persist");
session.agent.state.messages = [
  { role: "user", content: "OLD-CASE-CONVERSATION-SENTINEL", timestamp: Date.now() },
  fauxAssistantMessage("OLD-CASE-REPORT-SENTINEL [record:R1]"),
  {
    role: "compactionSummary",
    summary: "OLD-CASE-COMPACTION-SENTINEL",
    tokensBefore: 300,
    timestamp: Date.now(),
  },
  {
    role: "branchSummary",
    summary: "OLD-CASE-BRANCH-SENTINEL",
    fromId: "old",
    timestamp: Date.now(),
  },
];
const ui = {
  async input(title) {
    if (title === "Which Discord participant is the applicant?") {
      clarificationCount++;
      uiLog.push(["clarification", title]);
      return "Pilot 🌙 is the applicant.";
    }
    inputCount++;
    assert.equal(
      inputCount,
      cases.indexOf(activeCase) + 1,
      "unexpected repeated or extra intake input",
    );
    uiLog.push(["input", title]);
    return activeCase.exportPath;
  },
  async editor(title) {
    editorCount++;
    assert.equal(
      editorCount,
      cases.indexOf(activeCase) + 1,
      "unexpected repeated or extra editor",
    );
    assert.match(title, /Paste the Discord interview as copied/i);
    uiLog.push(["editor", title]);
    return activeCase.interview;
  },
  notify: (...args) => uiLog.push(["notify", ...args]),
  setStatus: (...args) => uiLog.push(["status", ...args]),
  setWorkingMessage: (...args) => uiLog.push(["working", ...args]),
  setWidget: (...args) => uiLog.push(["widget", ...args]),
  getEditorText: () => "",
  setEditorText: (...args) => uiLog.push(["setEditorText", ...args]),
  async select() {
    throw new Error("unexpected selector: three-input happy path changed");
  },
  async confirm() {
    throw new Error("unexpected mandatory confirmation");
  },
  async custom() {
    throw new Error("unexpected custom UI");
  },
};
session.subscribe((event) =>
  nativeEvents.push({ type: event.type, role: event.message?.role }),
);
await session.bindExtensions({
  uiContext: ui,
  mode: "tui",
  onError: (error) => extensionErrors.push(error),
});
assert.equal(session.extensionRunner.hasUI(), true);
const originalTools = session.getActiveToolNames();

try {
  for (const current of cases) {
    activeCase = current;
    const beforeUI = uiLog.length;
    const beforeEvents = nativeEvents.length;
    const beforeEntries = sessionManager.getEntries().length;
    const clarify = !smoke && current.label === "SECOND";
    const correct = !smoke && current.label === "FIRST";
    let firstRevision;
    let attempt = 0;
    const respond = (context, _options, _state, model) => {
      assert.equal(model.provider, "native-probe");
      assert.equal(model.id, "offline");
      const visible = JSON.stringify(context);
      assert.ok(
        !visible.includes("OLD-CASE-"),
        "prior conversation/report/summary leaked into model context",
      );
      if (current.label === "SECOND")
        assert.ok(
          !visible.includes("APPLICANT-FIRST-ONLY") &&
            !visible.includes("native-probe-FIRST"),
          "first applicant leaked into second model context",
        );
      if (!smoke)
        assert.deepEqual(
          context.tools ?? [],
          [],
          "arbitrary model tools remain exposed during review",
        );
      const packet = packetFrom(context);
      assert.equal(packet.bundle.id, current.snapshot.manifest.bundleId);
      assert.equal(
        packet.records.length,
        current.snapshot.records.length,
        "complete record count changed",
      );
      for (let i = 0; i < packet.records.length; i++) {
        assert.equal(packet.records[i].id, current.snapshot.records[i].id);
        assert.deepEqual(
          packet.records[i].data,
          current.snapshot.records[i].data,
          `record ${i} changed or rounded`,
        );
      }
      assert.deepEqual(
        packet.interview.lines.map((x) => x.text),
        current.interview.slice(0, -1).split("\n"),
        "literal multiline interview changed",
      );
      if (!smoke) {
        assert.match(
          packet.bundle.revision,
          /^r-[a-f0-9]{64}$/,
          "managed identity is not input-bound",
        );
        assert.equal(
          packet.preparation.confirmedBy,
          null,
          "intake invented source confirmation",
        );
        assert.ok(
          packet.records.every((record) => record.verification === "unverified"),
          "unconfirmed records were promoted to verified",
        );
      }
      modelContexts.push(context);
      attempt++;
      if ((clarify || correct) && attempt === 1) {
        firstRevision = packet.bundle.revision;
        return fauxAssistantMessage(
          clarify
            ? "Clarification needed: Which Discord participant is the applicant?"
            : "This is not a report.",
        );
      }
      if (correct) {
        assert.ok(
          visible.includes("INVALID_BUNDLE_MARKER"),
          "native correction diagnostics were filtered out",
        );
        assert.equal(
          packet.bundle.revision,
          firstRevision,
          "format repair must not change evidence identity",
        );
      }
      if (clarify) {
        assert.equal(
          packet.context.notes.at(-1)?.text,
          "Pilot 🌙 is the applicant.",
          "the native clarification was not added to the frozen case",
        );
        assert.notEqual(
          packet.bundle.revision,
          firstRevision,
          "clarification failed to change the review revision",
        );
      }
      const report = completedReport(packet);
      const prepared = {
        packet,
        citationIndex: {
          bundleId: packet.bundle.id,
          revision: packet.bundle.revision,
          transcriptLineCount: packet.interview.lines.length,
          recordIds: packet.records.map((x) => x.id),
          contextIds: [],
        },
      };
      assert.deepEqual(
        checkReport(report + reportSuffix, prepared),
        { ok: true, errors: [] },
        "probe report fixture must be checker-valid",
      );
      packets.push(packet);
      reports.push(report + reportSuffix);
      return fauxAssistantMessage(report);
    };
    faux.appendResponses(smoke ? [respond] : [respond, respond]);
    await session.prompt("/skill:recruitment-review", { source: "interactive" });
    // sendUserMessage may launch an asynchronous prompt from an input handler.
    // Wait on actual native agent_settled, not just resolution of input preflight.
    const deadline = Date.now() + 10_000;
    const receiptArrived = () =>
      smoke
        ? uiLog
            .slice(beforeUI)
            .some((entry) => JSON.stringify(entry).includes("HOST-SMOKE-SETTLED"))
        : sessionManager
            .getEntries()
            .slice(beforeEntries)
            .some(
              (entry) =>
                entry.type === "custom" &&
                entry.data?.status === "completed" &&
                entry.data.inputFingerprint === packets.at(-1)?.bundle.revision.slice(2),
            );
    while (
      (!nativeEvents.slice(beforeEvents).some((x) => x.type === "agent_settled") ||
        reports.length < cases.indexOf(current) + 1 ||
        !session.isIdle ||
        !receiptArrived()) &&
      Date.now() < deadline &&
      extensionErrors.length === 0
    )
      await new Promise((r) => setTimeout(r, 10));
    const finalAssistant = session.messages.filter((x) => x.role === "assistant").at(-1);
    assert.equal(
      finalAssistant?.stopReason,
      "stop",
      finalAssistant?.errorMessage ?? "scripted model did not finish",
    );
    assert.deepEqual(extensionErrors, [], "native extension handler threw");
    const events = nativeEvents.slice(beforeEvents);
    assert.ok(
      events.some((x) => x.type === "message_update" && x.role === "assistant"),
      "no real assistant streaming events",
    );
    assert.ok(
      events.some((x) => x.type === "message_end" && x.role === "assistant"),
      "no canonical native message",
    );
    assert.ok(
      events.some((x) => x.type === "agent_settled"),
      "agent never settled",
    );
    assert.equal(
      modelContexts.length,
      (cases.indexOf(current) + 1) * (smoke ? 1 : 2),
      "only the expected clarification and final report calls may run",
    );
    const canonical = session.messages.filter((x) => x.role === "assistant").at(-1);
    assert.equal(
      textOf(canonical),
      reports.at(-1),
      "canonical native replacement was not persisted",
    );
    const output = JSON.stringify({
      ui: uiLog.slice(beforeUI),
      entries: sessionManager
        .getEntries()
        .slice(beforeEntries)
        .filter((x) => x.type !== "message"),
    });
    if (smoke) assert.match(output, /HOST-SMOKE-SETTLED/);
    else {
      const customs = session.messages
        .filter((x) => x.role === "custom")
        .map((x) => ({ content: x.content, details: x.details }));
      const receiptText = output + JSON.stringify(customs);
      assert.match(
        receiptText,
        /Draft — mechanically checked; human review required/i,
        "no checked completion indication after native settlement",
      );
      assert.ok(
        receiptText.includes(sha(reports.at(-1))),
        "receipt does not bind the canonical post-transform report SHA-256",
      );
      assert.ok(
        receiptText.includes(packets.at(-1).bundle.revision.slice(2)),
        "receipt does not bind the active input fingerprint",
      );
      const receipt = sessionManager
        .getEntries()
        .slice(beforeEntries)
        .find((x) => x.type === "custom" && x.data?.status === "completed")?.data;
      assert.ok(receipt?.reportPath, "canonical report artifact was not offered");
      assert.equal(
        await readFile(receipt.reportPath, "utf8"),
        reports.at(-1),
        "canonical artifact differs from checked report",
      );
      assert.ok(
        !resolve(receipt.reportPath).startsWith(resolve(worktree) + "/"),
        "private artifact was written inside Git",
      );
      assert.deepEqual(
        session.getActiveToolNames(),
        originalTools,
        "tool selection was not restored",
      );
    }
    assert.equal(
      await readFile(current.exportPath, "utf8"),
      current.exportText,
      "selected download changed",
    );
  }
  assert.equal(inputCount, 2);
  assert.equal(editorCount, 2);
  assert.equal(faux.state.callCount, smoke ? 2 : 4);
  assert.equal(clarificationCount, smoke ? 0 : 1);
  assert.deepEqual(await modelRuntime.listCredentials(), []);
  if (!smoke) {
    const previousModel = session.agent.state.model;
    session.agent.state.model = {
      ...previousModel,
      provider: "unconfigured-native-probe",
    };
    const before = faux.state.callCount;
    const beforeUI = uiLog.length;
    await session.prompt(
      `/skill:recruitment-review ${cases[0].exportPath}\n${cases[0].interview}`,
      { source: "interactive" },
    );
    assert.equal(
      faux.state.callCount,
      before,
      "missing authentication must start no model request",
    );
    assert.deepEqual(
      session.getActiveToolNames(),
      originalTools,
      "authentication rejection stranded restricted tools",
    );
    assert.match(JSON.stringify(uiLog.slice(beforeUI)), /Authenticate|authentication/);
    session.agent.state.model = previousModel;
  }
  assert.equal(
    nativeEvents.filter((x) => x.type === "ui_prompt_start").length,
    smoke ? 4 : 5,
    "UI did not run through native ExtensionRunner prompt wrapper",
  );
  assert.equal(
    nativeEvents.filter((x) => x.type === "ui_prompt_end").length,
    smoke ? 4 : 5,
  );
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        scope: smoke
          ? "HOST MECHANICS ONLY — product adapter NOT exercised"
          : "NATIVE ADAPTER — synthetic model, not operational/live-data proof",
        piVersion: "0.85.1",
        discoveredEntry: entry,
        nativeEvents: [...new Set(nativeEvents.map((x) => x.type))],
        cases: cases.length,
        recordsPerCase: packets.map((x) => x.records.length),
        exportBytes: cases.map((x) => Buffer.byteLength(x.exportText)),
        modelCalls: faux.state.callCount,
        persistentSession: session.sessionFile ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  // SDK disposal does not emit session_shutdown; modes/runtime normally do it.
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
