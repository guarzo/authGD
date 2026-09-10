import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { startFleetWorker } from "../e2e/fleet-installations";
import { BASE_URL, WORKTREE_ROOT } from "../e2e/env";

const launch = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: launch.spawn,
}));
vi.mock("esbuild", async (importOriginal) => ({
  ...(await importOriginal<typeof import("esbuild")>()),
  buildSync: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

class WorkerChild extends EventEmitter {
  pid = 123;
  exitCode: number | null = null;
  signalCode = null;
  stderr = new PassThrough();
  tail: Buffer[] = [];
  closed = false;
  kill() {
    if (this.exitCode !== null) return true;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      // Child exit precedes stdio close. Output arriving in this interval still
      // belongs to the worker and must be classified before close resolves.
      setImmediate(() => {
        for (const part of this.tail) this.stderr.write(part);
        this.stderr.end();
        this.closed = true;
        this.emit("close", 0, null);
      });
    });
    return true;
  }
}
const warning =
  "(node:123) ExperimentalWarning: VM Modules is an experimental feature and might change at any time\n";
const hint = "(Use `node --trace-warnings ...` to show where the warning was created)\n";
async function exercise(parts: Buffer[], tail: Buffer[] = []) {
  const child = new WorkerChild();
  child.tail = tail;
  launch.spawn.mockReturnValueOnce(child);
  const starting = startFleetWorker({
    url: "http://127.0.0.1:1/",
    token: "a".repeat(64),
    worktree: WORKTREE_ROOT,
    appUrl: BASE_URL,
  });
  // Deliberately no W path, Python, real process, TLS or provider. Readiness
  // remains the launcher's actual IPC contract, not stderr content.
  for (const part of parts) child.stderr.write(part);
  child.emit("message", { ready: true });
  const handle = await starting;
  const result = await handle.close().catch((error: unknown) => error);
  if (!child.closed) await new Promise<void>((resolve) => child.once("close", resolve));
  return { result, child };
}

it("accepts complete warning records at every byte boundary and coalesced records", async () => {
  const bytes = Buffer.from(warning + hint + warning);
  for (let cut = 1; cut < bytes.length; cut++) {
    const { result } = await exercise([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(result, `warning split at byte ${cut}`).toBeUndefined();
  }
  expect((await exercise([bytes])).result).toBeUndefined();
  // The bound is per unfinished record, not a lifetime/chunk output quota.
  expect((await exercise([Buffer.from(warning.repeat(100))])).result).toBeUndefined();
});
it("decodes multibyte records across one-byte pipe events", async () => {
  const bytes = Buffer.from(warning.replace("VM Modules", "VM Modules (試験)"));
  expect(
    (await exercise([...bytes].map((byte) => Buffer.from([byte])))).result,
  ).toBeUndefined();
});
it.each([
  [warning + "unknown private text\n", "unclassified-worker-stderr"],
  ["\uFEFF" + warning, "ExperimentalWarning"],
  [warning + "fleet_source_scheduler_failed\n", "fleet_source_scheduler_failed"],
  [warning.replace("VM Modules", "ERR_REQUIRE_ESM"), "ERR_REQUIRE_ESM"],
  ["prefix " + warning, "ExperimentalWarning"],
  [hint, "unclassified-worker-stderr"],
  [hint.replace("created)", "created) private suffix"), "unclassified-worker-stderr"],
  [warning.trimEnd(), "unclassified-worker-stderr"],
  ["fleet_source_scheduler_failed", "fleet_source_scheduler_failed"],
])(
  "rejects unknown, fatal, standalone-hint or incomplete records %#",
  async (text, classification) => {
    const bytes = Buffer.from(text);
    for (const parts of [[bytes], [...bytes].map((byte) => Buffer.from([byte]))]) {
      const { result } = await exercise(parts);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain(classification);
      expect((result as Error).message).not.toContain("private");
    }
  },
);
it("refuses overflow before decoding, for terminated and split unbounded lines", async () => {
  for (const parts of [
    [Buffer.from("x".repeat(8192) + "\n" + warning)],
    Array.from({ length: 8192 }, () => Buffer.from("x")),
    [Buffer.from(warning.replace("VM Modules", "x".repeat(8192)))],
  ]) {
    const { result } = await exercise(parts);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("oversized-worker-stderr");
  }
});
it("refuses invalid UTF-8 even inside a standard-looking warning record", async () => {
  const bytes = Buffer.from(warning);
  const invalid = Buffer.concat([
    bytes.subarray(0, 35),
    Buffer.from([0xc3]),
    bytes.subarray(35),
  ]);
  for (const parts of [[invalid], [...invalid].map((byte) => Buffer.from([byte]))]) {
    const { result } = await exercise(parts);
    expect(result).toBeInstanceOf(Error);
  }
});
it("waits for stdio close and classifies the final tail after child exit", async () => {
  const { result, child } = await exercise(
    [Buffer.from(warning)],
    [Buffer.from("ERR_"), Buffer.from("REQUIRE_ESM")],
  );
  expect(child.closed).toBe(true);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain("ERR_REQUIRE_ESM");
});
