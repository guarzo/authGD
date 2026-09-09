import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { BASE_URL, FLEET_UPSTREAM_URL, TEST_DATABASE_URL, WORKTREE_ROOT } from "./env";
import { fleetEnvironment } from "./fleet-server";
import type { FixtureConnection } from "./fleet-fixtures";
import { pinnedWingmanRoot } from "./fleet-run";
import { withFleetResources } from "./fleet-resources";

export interface InstallationStatus {
  state: string;
  detail: string | null;
  pairing: string | null;
  paired: boolean;
  revision: number;
  participation: string | null;
  inhibited: boolean;
  observed_on: boolean;
  eligible: number;
  sources: Array<{ state: string; reason: string | null }>;
  pending_sources: number;
  source_choices: number;
  remote: Array<{ dps: number; state: string; ewar: string[] }>;
  local: number;
  seen: number;
  settings_characters: number;
  persisted_seen: number;
  pending_roster: number;
  unexpected_settings: number;
  presented_characters: number;
  fleet_presentations: number;
  denials: number;
  details: string[];
  same_publication: number;
  new_publication: number;
  age_violations: number;
  remote_deliveries: number;
  requests: Array<{
    operation: string;
    method: string;
    revision: number | null;
    session: number | null;
    start: number;
    headers_received: number | null;
    body_received: number | null;
    completed: number | null;
    failed: boolean | null;
    status: number | null;
  }>;
}
export type InstallationCommand =
  | "pair"
  | "on"
  | "off"
  | "watch"
  | "unwatch"
  | "start-first"
  | "start-second"
  | "start-third"
  | "stop-sources"
  | "local"
  | "quiet"
  | "status"
  | "stop";

export async function stopOwnedChild(child: ChildProcess) {
  if (!child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0) throw new Error("[fleet-e2e] owned child failed");
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code] = await exited;
    if (code !== 0) throw new Error("[fleet-e2e] owned child failed or did not drain");
  } finally {
    clearTimeout(timer);
  }
}

export async function startFleetWorker(
  connection: FixtureConnection,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const script = join(WORKTREE_ROOT, "tmp/task-10/fix1/fleet-worker.mjs");
  buildSync({
    entryPoints: [join(WORKTREE_ROOT, "e2e/fleet-worker-child.ts")],
    outfile: script,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    define: { __dirname: JSON.stringify(join(WORKTREE_ROOT, "e2e")) },
  });
  const child = spawn(process.execPath, [script], {
    cwd: WORKTREE_ROOT,
    env: fleetEnvironment({
      databaseUrl: TEST_DATABASE_URL,
      appUrl: BASE_URL,
      upstreamUrl: FLEET_UPSTREAM_URL,
      mode: "start",
      fixture: connection,
    }),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("[fleet-e2e] worker startup cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  // Never print arbitrary library error objects or job data.
  const stderr = new Set<string>();
  child.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const known = [
      "fleet_source_scheduler_failed",
      "outbox dispatch failed",
      "ExperimentalWarning",
      "DeprecationWarning",
      "denied outbound socket",
      "ERR_REQUIRE_ESM",
    ];
    const matches = known.filter((code) => text.includes(code));
    // Node runtime warnings are not swallowed job failures. Keep all unknown
    // output fatal; only the standard warning record is a separate class.
    if (
      /^\(node:\d+\) ExperimentalWarning: [^\n]+\n(?:\(Use `node --trace-warnings[^\n]+\n)?$/.test(
        text,
      )
    )
      return;
    for (const code of matches.length ? matches : ["unclassified-worker-stderr"])
      stderr.add(code);
  });
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancelled,
      once(child, "message").then(([message]) => {
        if (!message || message.ready !== true)
          throw new Error("[fleet-e2e] worker not ready");
      }),
      once(child, "exit").then(() => {
        throw new Error("[fleet-e2e] worker startup failed");
      }),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("[fleet-e2e] worker startup deadline")),
          15_000,
        );
      }),
    ]);
    return {
      async close() {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        await stopOwnedChild(child);
        if (stderr.size)
          throw new Error(
            `[fleet-e2e] worker error classifications: ${[...stderr].join(",")}`,
          );
      },
    };
  } catch (error) {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    try {
      await stopOwnedChild(child);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "[fleet-e2e] worker startup and cleanup failed",
      );
    }
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
}

/** Separate legacy/conflict fixture, never seeds either journey installation. */
export async function runLegacyRecoveryProbe(privateKey: Buffer) {
  const wingman = pinnedWingmanRoot();
  const python = process.env.E2E_WINGMAN_PYTHON;
  const trust = process.env.E2E_FLEET_TLS_ROOT;
  if (!python || !trust)
    throw new Error("[fleet-e2e] pinned Python/TLS prerequisites required");
  return withFleetResources(async (own) => {
    const root = own(mkdtempSync(join(trust, "legacy-recovery-")), (root) =>
      rmSync(root, { recursive: true, force: true }),
    );
    chmodSync(root, 0o700);
    writeFileSync(join(root, "legacy-key.bin"), privateKey, { mode: 0o600 });
    const child = own(
      spawn(python, [join(WORKTREE_ROOT, "e2e/fleet-python.py")], {
        cwd: root,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          E2E_WINGMAN_ROOT: wingman,
          FLEET_INSTALL_ROOT: root,
          FLEET_ORIGIN: BASE_URL,
          FLEET_PROBE: "legacy-recovery",
          SSL_CERT_FILE: join(trust, "ca.pem"),
          SSL_CERT_DIR: join(trust, "empty-ca"),
          LOCALAPPDATA: root,
          HOME: root,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      async (child) => {
        if (child.exitCode === null && child.signalCode === null)
          await stopOwnedChild(child);
      },
    );
    const output: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (oversized) return;
      if (bytes + chunk.length > 512) {
        oversized = true;
        output.length = 0;
        child.kill("SIGTERM");
        return;
      }
      bytes += chunk.length;
      output.push(chunk);
    });
    // No key/session/proof payload is printed, even on a failed probe.
    let stderr = false;
    child.stderr.on("data", () => {
      stderr = true;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code] = await once(child, "close");
      if (oversized) throw new Error("[fleet-e2e] oversized Python probe");
      if (code !== 0 || stderr)
        throw new Error("[fleet-e2e] legacy recovery probe failed");
      return JSON.parse(Buffer.concat(output, bytes).toString("utf8")) as {
        idempotent: boolean;
        result: string;
        fresh_key_required: boolean;
      };
    } finally {
      clearTimeout(timeout);
    }
  });
}

export function createInstallations() {
  const wingman = pinnedWingmanRoot();
  const python = process.env.E2E_WINGMAN_PYTHON;
  const trust = process.env.E2E_FLEET_TLS_ROOT;
  if (!python || !trust)
    throw new Error(
      "[fleet-e2e] joint proof requires explicit Python and owned TLS bootstrap",
    );
  mkdirSync(join(WORKTREE_ROOT, "tmp/task-10/fix1"), { recursive: true });
  const root = mkdtempSync(join(WORKTREE_ROOT, "tmp/task-10/fix1/installations-"));
  try {
    chmodSync(root, 0o700);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const children = new Set<ChildProcess>();
  async function start(slot: "a" | "b") {
    const install = join(root, slot);
    mkdirSync(install, { recursive: true, mode: 0o700 });
    const child = spawn(python!, [join(WORKTREE_ROOT, "e2e/fleet-python.py")], {
      cwd: install,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        E2E_WINGMAN_ROOT: wingman,
        FLEET_INSTALL_ROOT: install,
        FLEET_INSTALL_SLOT: slot,
        FLEET_ORIGIN: BASE_URL,
        SSL_CERT_FILE: join(trust!, "ca.pem"),
        SSL_CERT_DIR: join(trust!, "empty-ca"),
        LOCALAPPDATA: install,
        HOME: install,
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let waiting:
      { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
    let errorOutput = false;
    let terminalError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let chunks: Buffer[] = [];
    let bytes = 0;
    const fail = (message: string) => {
      if (terminalError) return;
      terminalError = new Error(`[fleet-e2e] ${message}`);
      chunks = [];
      bytes = 0;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    };
    child.stderr.on("data", () => {
      errorOutput = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (!terminalError && offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const count = end - offset;
        // Bound BYTES before decoding, copying, or newline accumulation.
        if (bytes + count > 512 * 1024) {
          fail("oversized Python reply");
          return;
        }
        chunks.push(chunk.subarray(offset, end));
        bytes += count;
        if (newline < 0) return;
        if (!waiting) {
          fail("unsolicited Python reply");
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
        } catch {
          fail("invalid Python reply");
          return;
        }
        chunks = [];
        bytes = 0;
        const pending = waiting;
        waiting = undefined;
        pending.resolve(value);
        offset = newline + 1;
      }
    });
    child.on("close", () => {
      clearTimeout(killTimer);
      waiting?.reject(
        terminalError ?? new Error("[fleet-e2e] Python exited before reply"),
      );
      waiting = undefined;
    });
    child.on("error", () => {
      fail("Python executable unavailable");
    });
    const reply = () => {
      // A rejected concurrent call must acquire NO slot and send NO bytes.
      if (waiting) throw new Error("[fleet-e2e] concurrent Python command");
      if (terminalError) throw terminalError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("[fleet-e2e] Python already exited");
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => fail("Python command deadline"), 10_000);
        waiting = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      });
    };
    const send = async (command: string) => {
      const result = reply();
      child.stdin.write(JSON.stringify({ command }) + "\n", (error) => {
        if (error) fail("Python input closed");
      });
      const response = (await result) as { ok: boolean; value: unknown };
      if (!response.ok) throw new Error("[fleet-e2e] Python command/invariant refused");
      return response.value;
    };
    try {
      const ready = (await reply()) as { ready: boolean; trust_anchors: number };
      if (!ready.ready || ready.trust_anchors !== 1)
        throw new Error("[fleet-e2e] Python bootstrap failed");
    } catch (error) {
      try {
        await stopOwnedChild(child);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "[fleet-e2e] Python startup and cleanup failed",
        );
      }
      throw error;
    }
    return {
      command: async (command: InstallationCommand) =>
        (await send(command)) as InstallationStatus,
      approval: async () =>
        ((await send("approval")) as { approval_url: string | null }).approval_url,
      async close() {
        await stopOwnedChild(child);
        children.delete(child);
        if (errorOutput) throw new Error("[fleet-e2e] Python emitted an error");
      },
    };
  }
  return {
    start,
    root,
    async close() {
      const failures = [];
      for (const child of children) {
        try {
          await stopOwnedChild(child);
        } catch (error) {
          failures.push(error);
        }
      }
      rmSync(root, { recursive: true, force: true });
      if (failures.length)
        throw new AggregateError(failures, "[fleet-e2e] installation cleanup failed");
    },
  };
}
