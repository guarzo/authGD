import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";
import { makeBundle } from "./fixtures.mjs";

const adapterUrl = new URL("../scripts/pi-review.mjs", import.meta.url);
const register = existsSync(adapterUrl)
  ? (await import(adapterUrl.href)).default
  : () => {};
const discord =
  "Recruiter — Today at 14:00\nWhy join?\n\nPilot 🌙\nA friend invited me.\nAnd I liked the fleet.\n";

async function hostFor(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "recruitment-pi-test-"));
  const handlers = new Map();
  const entries = [];
  const notices = [];
  const statuses = new Map();
  const prompts = [];
  const inputs = [];
  const editors = [];
  const queued = [];
  const receipts = [];
  let tools = ["read", "bash", "web_search"];
  let nextId = 1;
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    model: {
      id: "fixture",
      provider: "fixture",
      contextWindow: 1_000_000,
      maxTokens: 32768,
    },
    getSystemPrompt: () => "Host instructions.",
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000, percent: 0 }),
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {
      ctx.aborted = true;
    },
    sessionManager: {
      getSessionId: () => "fixture-session",
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries.slice(),
    },
    ui: {
      input: async (title) => {
        prompts.push(title);
        return inputs.shift();
      },
      editor: async (title) => {
        prompts.push(title);
        return editors.shift();
      },
      notify: (text, level) => notices.push({ text, level }),
      setStatus: (key, text) => statuses.set(key, text),
      setWidget: () => {},
    },
  };
  const pi = {
    on: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getActiveTools: () => tools.slice(),
    setActiveTools: (next) => {
      tools = next.slice();
    },
    sendUserMessage: (content, options) => queued.push({ content, options }),
    sendMessage: (message, options) => queued.push({ content: message.content, options }),
    appendEntry: (type, data) => receipts.push({ type, data }),
  };
  register(pi, {
    temporaryRoot: join(root, "private"),
    hostVersion: "0.85.1",
    ...options,
  });
  async function emit(name, event = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }
  function append(message) {
    entries.push({ type: "message", id: String(nextId++), message });
  }
  async function invoke(text) {
    const input = await emit("input", { text, source: "interactive" });
    if (input?.action === "handled") return input;
    append({ role: "user", content: input?.text ?? text, timestamp: Date.now() });
    await emit("before_agent_start", {
      prompt: input?.text ?? text,
      systemPrompt: "Host instructions.",
    });
    return input;
  }
  async function outgoing() {
    const result = await emit("context", { messages: entries.map((x) => x.message) });
    return result?.messages ?? entries.map((x) => x.message);
  }
  async function finish(text, stopReason = "stop", canonicalSuffix = "") {
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      api: "fixture",
      provider: "fixture",
      model: "fixture",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    append(message);
    await emit("message_end", { message });
    entries.at(-1).message = {
      ...message,
      content: [{ type: "text", text: text + canonicalSuffix }],
    };
    await emit("agent_settled");
  }
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await rm(root, { recursive: true, force: true });
  });
  await emit("session_start", { reason: "startup" });
  return {
    root,
    ctx,
    emit,
    append,
    invoke,
    outgoing,
    finish,
    prompts,
    inputs,
    editors,
    notices,
    queued,
    receipts,
    statuses,
    tools: () => tools,
  };
}

async function exportFor(host, name = "NEW-APPLICANT-SENTINEL") {
  const bundle = makeBundle();
  bundle["records.json"][0].id = "R1";
  bundle["records.json"][0].data = { name, amount: "9007199254740993.01" };
  const path = join(host.root, `${name}.json`);
  await writeFile(
    path,
    JSON.stringify({
      format: "authgd-recruitment-evidence",
      version: 1,
      accountId: "00000000-0000-4000-8000-000000000001",
      manifest: bundle["manifest.json"],
      records: bundle["records.json"],
    }),
  );
  return path;
}

function packetIn(messages) {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    try {
      const value = JSON.parse(message.content);
      if (value.bundle && value.interview && value.records) return value;
    } catch {
      /* Instructions are not packet JSON. */
    }
  }
  return undefined;
}

function reportFor(packet, status = "completed") {
  const header = `Bundle: ${packet.bundle.id}@${packet.bundle.revision}\nReview status: ${status}\nSkill version: fixture\nModel: fixture\nAssessment status: DRAFT — human recruiter review required; not an admission decision\n`;
  if (status === "aborted")
    return (
      header +
      `Attempted review timestamp: 2026-09-14T12:00:00Z\nBlocking reason: Insufficient interpretation.\nUnreviewed inputs: The supplied packet.\nCorrective action: Clarify the inputs.\n`
    );
  return (
    header +
    `
## Coverage and limitations
- Snapshot: 2026-09-14T12:00:00Z.
- Character scope: One included character.
- Dataset coverage: All six categories supplied.
- Provenance: Artificial test records.
- Verification: Unverified; confirmedBy is null.
- Synthetic-only: Test data, not applicant evidence.
- Limitations and unexamined inputs: No live sources examined.

## Claim review
### Claim 1
- Applicant claim: A friend invited me. [interview:L5-L5]
- Evidence: This record does not establish an invitation. [record:R1]
- Assessment: unknown / not assessable
- Limits: No independent invitation evidence supplied.
- Plausible alternatives: A private conversation may explain the invitation.

## Material findings
### Direct contradictions
None identified within the supplied coverage.
### Tensions
None identified within the supplied coverage.
### Unknowns and gaps
Invitation is not established. [interview:L5-L5]

## Follow-up questions
1. Which friend invited you? [interview:L5-L5]

## Bottom line
Insufficient evidence. The invitation cannot be independently established.
`
  );
}

async function startCase(host, name) {
  const path = await exportFor(host, name);
  await host.invoke(`/skill:recruitment-review ${path}\n${discord}`);
  return packetIn(await host.outgoing());
}

test("skill invocation accepts a download and literal Discord paste without operator preparation", async (t) => {
  const host = await hostFor(t);
  const path = await exportFor(host);
  const original = await readFile(path, "utf8");
  host.inputs.push(path);
  host.editors.push(discord);
  await host.invoke("/skill:recruitment-review");
  const packet = packetIn(await host.outgoing());
  assert.ok(
    packet,
    "invocation should prepare and deliver the packet, not request shell preparation",
  );
  assert.deepEqual(
    packet.interview.lines.map((line) => line.text),
    [
      "Recruiter — Today at 14:00",
      "Why join?",
      "",
      "Pilot 🌙",
      "A friend invited me.",
      "And I liked the fleet.",
    ],
  );
  assert.equal(packet.records.length, 6);
  assert.equal(packet.records[0].data.amount, "9007199254740993.01");
  assert.equal(packet.preparation.confirmedBy, null);
  assert.deepEqual(host.tools(), []);
  assert.equal(host.prompts.length, 2);
  assert.equal(await readFile(path, "utf8"), original);
});

test("inline supplied inputs are not requested again", async (t) => {
  const host = await hostFor(t);
  const path = await exportFor(host);
  await host.invoke(`/skill:recruitment-review ${path}\n${discord}`);
  assert.ok(packetIn(await host.outgoing()));
  assert.equal(host.prompts.length, 0);
});

test("prior applicant records, reports and summaries cannot enter the new case context", async (t) => {
  const host = await hostFor(t);
  host.append({ role: "user", content: "OLD-APPLICANT-SENTINEL owns R1", timestamp: 1 });
  host.append({
    role: "assistant",
    content: [{ type: "text", text: "OLD-REPORT-SENTINEL [record:R1]" }],
    stopReason: "stop",
    timestamp: 2,
  });
  host.append({
    role: "compactionSummary",
    summary: "OLD-SUMMARY-SENTINEL",
    tokensBefore: 200,
    timestamp: 3,
  });
  const path = await exportFor(host);
  await host.invoke(`/skill:recruitment-review ${path}\n${discord}`);
  const messages = await host.outgoing();
  const text = JSON.stringify(messages);
  assert.ok(text.includes("NEW-APPLICANT-SENTINEL"));
  for (const old of [
    "OLD-APPLICANT-SENTINEL",
    "OLD-REPORT-SENTINEL",
    "OLD-SUMMARY-SENTINEL",
  ]) {
    assert.ok(!text.includes(old), `${old} leaked into the new case`);
  }
});

test("cancelling intake stops before review and leaves previous tools enabled", async (t) => {
  const host = await hostFor(t);
  const result = await host.invoke("/skill:recruitment-review");
  assert.equal(result?.action, "handled");
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
  assert.equal(packetIn(await host.outgoing()), undefined);
  assert.equal(host.receipts.length, 0);
});

test("insufficient model context is rejected without partial packet delivery", async (t) => {
  const host = await hostFor(t);
  host.ctx.model.contextWindow = 200;
  const path = await exportFor(host);
  const result = await host.invoke(`/skill:recruitment-review ${path}\n${discord}`);
  assert.equal(result?.action, "handled");
  assert.ok(host.notices.some(({ text }) => /context|capacity/i.test(text)));
  assert.equal(packetIn(await host.outgoing()), undefined);
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
});

test("active review blocks unrelated tools and restores them on shutdown", async (t) => {
  const host = await hostFor(t);
  const path = await exportFor(host);
  await host.invoke(`/skill:recruitment-review ${path}\n${discord}`);
  const result = await host.emit("tool_call", {
    toolName: "bash",
    input: { command: "untrusted command" },
  });
  assert.equal(result?.block, true);
  assert.equal((await host.emit("session_before_compact", {}))?.cancel, true);
  await host.emit("session_shutdown", { reason: "reload" });
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
});

test("a checked receipt and artifact bind the post-transform canonical report", async (t) => {
  const host = await hostFor(t);
  const packet = await startCase(host);
  const report = reportFor(packet);
  const suffix = "\n<!-- canonical replacement -->\n";
  await host.finish(report, "stop", suffix);
  const receipt = host.receipts.find((x) => x.data.status === "completed")?.data;
  assert.ok(receipt, "a completed checked report needs a receipt");
  assert.equal(
    receipt.reportHash,
    createHash("sha256")
      .update(report + suffix)
      .digest("hex"),
  );
  assert.equal(receipt.inputFingerprint, packet.bundle.revision.slice(2));
  assert.equal(await readFile(receipt.reportPath, "utf8"), report + suffix);
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
  assert.ok(host.notices.some(({ text }) => /mechanically checked/.test(text)));
});

test("a checker-valid aborted report remains aborted rather than completed", async (t) => {
  const host = await hostFor(t);
  const packet = await startCase(host);
  await host.finish(reportFor(packet, "aborted"));
  assert.equal(host.receipts.filter((x) => x.data.status === "completed").length, 0);
  assert.match(host.statuses.get("recruitment-review"), /aborted/i);
  assert.equal(host.queued.length, 0);
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
});

for (const stop of ["length", "error", "aborted"]) {
  test(`a ${stop} host termination cannot certify even a valid report`, async (t) => {
    const host = await hostFor(t);
    const packet = await startCase(host);
    await host.finish(reportFor(packet), stop);
    assert.equal(host.receipts.filter((x) => x.data.status === "completed").length, 0);
    assert.equal(host.queued.length, 0);
    assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
  });
}

test("clarification updates attributed context and revision without repeating intake", async (t) => {
  const host = await hostFor(t);
  const packet = await startCase(host);
  host.inputs.push("Pilot 🌙 is the applicant.");
  await host.finish("Clarification needed: Which Discord participant is the applicant?");
  const updated = packetIn(await host.outgoing());
  assert.notEqual(updated.bundle.revision, packet.bundle.revision);
  assert.deepEqual(updated.interview, packet.interview);
  assert.equal(updated.context.notes.at(-1).text, "Pilot 🌙 is the applicant.");
  assert.equal(host.prompts.length, 1);
  assert.equal(host.receipts.length, 0);
  assert.equal(host.queued.length, 1);
  assert.ok(!host.queued[0].content.includes("INVALID_REPORT"));
});

test("mechanical correction is bounded and repeated settle events do not spend retries", async (t) => {
  const host = await hostFor(t);
  await startCase(host);
  await host.finish("Not a report.");
  assert.equal(host.queued.length, 1);
  await host.emit("agent_settled");
  assert.equal(host.queued.length, 1);
  await host.finish("Still not a report.");
  assert.equal(host.queued.length, 2);
  await host.finish("Third invalid draft.");
  assert.equal(host.queued.length, 2);
  assert.equal(host.receipts.length, 0);
  assert.match(host.statuses.get("recruitment-review"), /failed/i);
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
});

test("two completed applicants with R1 never share outgoing evidence or reports", async (t) => {
  const host = await hostFor(t);
  const first = await startCase(host, "FIRST-APPLICANT");
  await host.finish(reportFor(first) + "\n<!-- FIRST-REPORT -->\n");
  const second = await startCase(host, "SECOND-APPLICANT");
  const text = JSON.stringify(await host.outgoing());
  assert.ok(!text.includes("FIRST-APPLICANT"));
  assert.ok(!text.includes("FIRST-REPORT"));
  assert.equal(second.records[0].id, "R1");
  assert.ok(text.includes("SECOND-APPLICANT"));
  await host.finish(reportFor(second));
  assert.equal(host.receipts.filter((x) => x.data.status === "completed").length, 2);
});

test("prepared packets keep historical identity and do not ask for another interview", async (t) => {
  const host = await hostFor(t);
  const { prepareReview } = await import("../scripts/review-input.mjs");
  const path = await exportFor(host);
  const prepared = await prepareReview({ exportPath: path, interview: discord });
  const packet = JSON.parse(prepared.packetText);
  packet.bundle.revision = "historical-r1";
  const packetPath = join(host.root, "prepared.json");
  await writeFile(packetPath, JSON.stringify(packet));
  await host.invoke(`/skill:recruitment-review --prepared ${packetPath}`);
  const supplied = packetIn(await host.outgoing());
  assert.deepEqual(supplied, packet);
  assert.equal(host.prompts.length, 0);
  await host.finish(reportFor(supplied));
  assert.equal(host.receipts.at(-1).data.status, "completed");
});

test("unsupported Pi versions explain setup instead of silently starting an unfinishable review", async (t) => {
  const host = await hostFor(t, { hostVersion: "0.84.0" });
  const path = await exportFor(host);
  const result = await host.invoke(`/skill:recruitment-review ${path}\n${discord}`);
  assert.equal(result?.action, "handled");
  assert.equal(packetIn(await host.outgoing()), undefined);
  assert.ok(host.notices.some(({ text }) => /update.*Pi|Pi.*0\.85\.1/i.test(text)));
});

test("shutdown during input capture cannot revive the cancelled case or restrict tools", async (t) => {
  const host = await hostFor(t);
  const path = await exportFor(host);
  host.inputs.push(path);
  let release;
  let opened;
  const started = new Promise((resolve) => {
    opened = resolve;
  });
  host.ctx.ui.editor = () => {
    opened();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const invocation = host.invoke("/skill:recruitment-review");
  await started;
  await host.emit("session_shutdown", { reason: "reload" });
  release(discord);
  const result = await invocation;
  assert.equal(result?.action, "handled");
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
  assert.equal(packetIn(await host.outgoing()), undefined);
});

test("a lost case boundary cannot fall back to the entire session history", async (t) => {
  const host = await hostFor(t);
  host.append({ role: "user", content: "PRIVATE-OLDER-CASE", timestamp: 1 });
  await startCase(host);
  host.ctx.sessionManager.getBranch = () => [
    {
      type: "message",
      id: "other-branch",
      message: { role: "user", content: "PRIVATE-OTHER-BRANCH", timestamp: 2 },
    },
  ];
  assert.deepEqual(await host.outgoing(), []);
  assert.equal(host.ctx.aborted, true);
});

test("raw temporary inputs disappear after success and the canonical artifact disappears on shutdown", async (t) => {
  const host = await hostFor(t);
  const packet = await startCase(host);
  await host.finish(reportFor(packet));
  const receipt = host.receipts.at(-1).data;
  const directory = join(receipt.reportPath, "..");
  await assert.rejects(readFile(join(directory, "interview.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(directory, "packet.json")), { code: "ENOENT" });
  assert.equal((await stat(receipt.reportPath)).mode & 0o777, 0o600);
  await host.emit("session_shutdown", { reason: "quit" });
  await assert.rejects(readFile(receipt.reportPath), { code: "ENOENT" });
});

test("a later unvalidated response cannot retain the completed status badge", async (t) => {
  const host = await hostFor(t);
  const packet = await startCase(host);
  await host.finish(reportFor(packet));
  await host.emit("agent_start");
  await host.finish("A later unvalidated revision.");
  assert.ok(!/completed|checked/i.test(host.statuses.get("recruitment-review") ?? ""));
});

test("stale crash workspaces are pruned but live process workspaces survive", async (t) => {
  const host = await hostFor(t);
  const privateRoot = join(host.root, "private");
  for (const [name, pid] of [
    ["case-dead", 2147483647],
    ["case-live", process.pid],
  ]) {
    const dir = join(privateRoot, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, "owner.json"),
      JSON.stringify({
        format: "authgd-recruitment-workspace",
        pid,
        createdAt: Date.now() - 48 * 3600000,
      }),
      { mode: 0o600 },
    );
  }
  await host.emit("session_start", { reason: "startup" });
  assert.deepEqual(await readdir(privateRoot), ["case-live"]);
});

test("unrelated commands and lookalike skill names do not start intake", async (t) => {
  const host = await hostFor(t);
  for (const text of [
    "hello",
    "/skill:recruitment-review-other",
    "Explain /skill:recruitment-review",
  ]) {
    const result = await host.emit("input", { text, source: "interactive" });
    assert.notEqual(result?.action, "handled");
    assert.notEqual(result?.action, "transform");
  }
  assert.equal(host.prompts.length, 0);
  assert.deepEqual(host.tools(), ["read", "bash", "web_search"]);
});
