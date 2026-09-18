import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** Own the original process and FIFO replies, including during complete relaunch. */
export function startCurrentDriver<R>(
  python: string,
  checkout: string,
  config: { root: string; ca: string },
) {
  const nativeCheckout = process.env.E2E_WINGMAN_NATIVE_ROOT || checkout;
  const nativePath = (path: string) =>
    execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
  const input = process.env.E2E_WINGMAN_NATIVE_ROOT
    ? { ...config, root: nativePath(config.root), ca: nativePath(config.ca) }
    : config;
  const bootstrap =
    "import runpy,sys; root=sys.argv[1]; sys.path.insert(0,root); runpy.run_path(root+'/tests/fixtures/fleet_current_client.py',run_name='__main__')";
  const child = spawn(python, ["-c", bootstrap, nativeCheckout], {
    cwd: checkout,
    env: { ...process.env, PYTHONPATH: nativeCheckout },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    closing = false,
    closeTask: Promise<void> | undefined;
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const exited = once(child, "exit");
  const pending: Array<{ resolve: (r: R) => void; reject: (error: Error) => void }> = [];
  const buffered: R[] = [];
  function fail(error: Error) {
    for (const p of pending.splice(0)) p.reject(error);
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("Current client exited: " + stderr)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const result = JSON.parse(line) as R;
      const next = pending.shift();
      if (next) next.resolve(result);
      else buffered.push(result);
    } catch {
      fail(new Error("Invalid current-client reply: " + stderr));
    }
  });
  function receive(): Promise<R> {
    if (buffered.length) return Promise.resolve(buffered.shift()!);
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.reject(new Error("Current client exited: " + stderr));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        closing = true;
        fail(new Error("Current client timed out: " + stderr));
      }, 20000);
      pending.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  async function close() {
    if (closeTask) return closeTask;
    closing = true;
    return (closeTask = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (child.exitCode !== 0) throw new Error("Current client failed: " + stderr);
        return;
      }
      child.stdin.end(JSON.stringify({ action: "close" }) + "\n");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        const [code] = await exited;
        if (code !== 0)
          throw new Error("Current client did not close cleanly: " + stderr);
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    })());
  }
  child.stdin.write(JSON.stringify(input) + "\n");
  return {
    ready: receive(),
    close,
    pid: child.pid,
    call(command: unknown) {
      if (closing) return Promise.reject(new Error("Original client is closed"));
      child.stdin.write(JSON.stringify(command) + "\n");
      return receive();
    },
  };
}
