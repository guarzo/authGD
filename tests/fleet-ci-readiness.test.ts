import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WORKTREE_ROOT } from "../e2e/env";

const workflow = readFileSync(join(WORKTREE_ROOT, ".github/workflows/ci.yml"), "utf8");
// Deliberately lexical: guard this job's known commands without executing CI
// installs locally or accepting prerequisites from the separate e2e/build jobs.
const unitJob = workflow.match(/^ {2}unit:\n([\s\S]*?)(?=^ {2}\w+:)/m)?.[1] ?? "";
const commands = [...unitJob.matchAll(/^ +(?:- )?run: (.+)$/gm)].map((match) => match[1]);

it.each(["npx playwright install --with-deps chromium", "npm run build"])(
  "the unit job provisions %s after npm ci and before the runner tests",
  (command) => {
    const install = commands.indexOf("npm ci");
    const prerequisite = commands.indexOf(command);
    const suite = commands.indexOf("npm test");
    expect(install, "unit job must install Node dependencies").toBeGreaterThanOrEqual(0);
    expect(suite, "unit job must run its suite").toBeGreaterThan(install);
    expect(prerequisite, `unit job is missing ${command}`).toBeGreaterThan(install);
    expect(prerequisite, `${command} must precede npm test`).toBeLessThan(suite);
  },
);

it("keeps the public Wingman fork and immutable runner/action pins aligned", () => {
  const revision = "3aa1cf28668d159ff42763ac542009bbcd727af7";
  const action = readFileSync(
    join(WORKTREE_ROOT, ".github/actions/fleet-proof-prerequisites/action.yml"),
    "utf8",
  );
  const runner = readFileSync(join(WORKTREE_ROOT, "e2e/fleet-run.ts"), "utf8");
  expect(action.match(/^ +repository: (.+)$/m)?.[1]).toBe("guarzo/FlyGD-Wingman");
  expect(action.match(/^ +ref: (.+)$/m)?.[1]).toBe(revision);
  expect(runner.match(/export const WINGMAN_REVISION = "([a-f0-9]+)";/)?.[1]).toBe(
    revision,
  );
  expect(unitJob).toContain("uses: ./.github/actions/fleet-proof-prerequisites");
});
