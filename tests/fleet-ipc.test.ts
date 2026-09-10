import { it, expect, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInstallations, runLegacyRecoveryProbe } from "../e2e/fleet-installations";
import { WORKTREE_ROOT } from "../e2e/env";

const script = join(WORKTREE_ROOT, "tests/helpers/fleet-ipc-child.py");
const scopes: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of scopes.splice(0).reverse()) await close();
  } finally {
    vi.unstubAllEnvs();
  }
});
function fixture(parent = join(WORKTREE_ROOT, "tmp/task-10/fix1")) {
  chmodSync(script, 0o700);
  mkdirSync(parent, { recursive: true });
  const trust = mkdtempSync(join(parent, "ipc-"));
  scopes.push(async () => rmSync(trust, { recursive: true, force: true }));
  vi.stubEnv("E2E_WINGMAN_PYTHON", script);
  vi.stubEnv("E2E_FLEET_TLS_ROOT", trust);
  return trust;
}
async function installation(mode: string) {
  fixture();
  const installs = createInstallations();
  scopes.push(async () => {
    await installs.close().catch(() => {});
  });
  const root = join(installs.root, "a");
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "fixture-mode"), mode);
  const peer = await installs.start("a");
  return { peer, root };
}
for (const mode of [
  "overflow",
  "overflow-newline",
  "overflow-utf8",
  "overflow-utf8-newline",
])
  it(`bounds incremental bytes and reaps ${mode} before returning refusal`, async () => {
    const { peer, root } = await installation(mode);
    const pid = Number(readFileSync(join(root, "fixture-pid"), "utf8"));
    const started = Date.now();
    await expect(peer.command("status")).rejects.toThrow("oversized Python reply");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
  });
it("refuses a concurrent command without sending any bytes or breaking the first reply", async () => {
  const { peer, root } = await installation("normal");
  const first = peer.command("status");
  await expect(peer.command("status")).rejects.toThrow("concurrent Python command");
  expect(await first).toEqual({ count: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(readFileSync(join(root, "fixture-count"), "utf8")).toBe("1");
  expect(await peer.command("status")).toEqual({ count: 2 });
  // This intentionally abrupt adversarial peer has no graceful signal handler.
});
it("creates its IPC scratch parent on a fresh owned path", async () => {
  const scratch = join(WORKTREE_ROOT, "tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "fleet-ipc-parent-"));
  scopes.push(async () => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "fresh", "scratch");
  expect(existsSync(parent)).toBe(false);
  const trust = fixture(parent);
  await expect(runLegacyRecoveryProbe(Buffer.alloc(32))).rejects.toThrow(
    "oversized Python probe",
  );
  expect(existsSync(trust)).toBe(true);
});

for (const newline of [0, 1])
  it(`bounds and reaps the ${newline ? "terminated" : "unterminated"} recovery probe`, async () => {
    const root = fixture();
    const started = Date.now();
    await expect(runLegacyRecoveryProbe(Buffer.alloc(32, newline))).rejects.toThrow(
      "oversized Python probe",
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(existsSync(root)).toBe(true);
  });
