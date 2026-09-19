import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { WORKTREE_ROOT } from "../e2e/env";
import { legacyFixtureUrls, legacyFixtureProvisionPlan } from "./helpers/fleet-legacy-db";
import { LEGACY_REVISION, PRE_COMBAT_REVISION } from "./helpers/fleet-legacy";

const workflow = readFileSync(join(WORKTREE_ROOT, ".github/workflows/ci.yml"), "utf8");
// Read only this job: no CI installs execute locally, and prerequisites from
// the separate e2e/build jobs cannot satisfy these guards.
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

it("unit CI names two safe sibling databases and creates only the sibling before npm test", () => {
  const main = unitJob.match(/^ {6}TEST_DATABASE_URL: (\S+)$/m)?.[1];
  const legacy = unitJob.match(/^ {6}FLEET_LEGACY_TEST_DATABASE_URL: (\S+)$/m)?.[1];
  expect(main, "unit CI must explicitly name its main disposable DB").toBeDefined();
  expect(legacy, "unit CI must explicitly name the pre-combat fixture DB").toBeDefined();
  const urls = legacyFixtureUrls({
    TEST_DATABASE_URL: main,
    FLEET_LEGACY_TEST_DATABASE_URL: legacy,
  });
  const database = new URL(urls.main).pathname.slice(1);
  expect(unitJob.match(/^ {10}POSTGRES_DB: (\S+)$/m)?.[1]).toBe(database);
  expect(unitJob).toContain(`--health-cmd "pg_isready -U authgd -d ${database}"`);
  expect(unitJob).toContain(`- ${new URL(urls.main).port}:5432`);
  const install = unitJob.indexOf("run: npm ci");
  const provision = unitJob.indexOf("name: Provision isolated legacy fixture database");
  const suite = unitJob.indexOf("run: npm test");
  expect(provision).toBeGreaterThan(install);
  expect(provision).toBeLessThan(suite);
  expect(unitJob).toContain("legacyFixtureProvisionPlan(process.env)");
  expect(unitJob).toContain("connectionString: plan.connectionString");
  expect(unitJob).toContain("await client.query(plan.sql)");
  expect(unitJob).toContain("await client.end()");
  expect(unitJob).toContain("process.exitCode = 1");
});

it.each(["fresh", "duplicate", "connection failure"])(
  "executes the actual CI provisioning script against a socket-free mock: %s",
  async (fault) => {
    const script = unitJob.match(/node --import tsx -e '([\s\S]*?)^\s*'\s*$/m)?.[1];
    expect(script, "unit provisioning must remain executable Node code").toBeDefined();
    const main = "postgres://authgd:authgd@127.0.0.1:55462/authgd_test_mock_ci";
    const env = {
      TEST_DATABASE_URL: main,
      FLEET_LEGACY_TEST_DATABASE_URL: `${main}_legacy_migration`,
      CI: "true",
      GITHUB_ACTIONS: "true",
    };
    const process = { env, exitCode: 0 };
    const calls: string[] = [],
      errors: unknown[] = [];
    const databases = new Set(["authgd_test_mock_ci"]);
    class Client {
      constructor(config: { connectionString: string; connectionTimeoutMillis: number }) {
        expect(config.connectionString).toBe(main);
        expect(config.connectionTimeoutMillis).toBe(3000);
      }
      async connect() {
        calls.push("connect");
        if (fault === "connection failure") throw new Error("unreachable");
      }
      async query(sql: string) {
        calls.push(sql);
        expect(sql).toBe(
          'CREATE DATABASE "authgd_test_mock_ci_legacy_migration" OWNER authgd',
        );
        if (fault === "duplicate") throw new Error("duplicate_database");
        expect(databases.has("authgd_test_mock_ci_legacy_migration")).toBe(false);
        databases.add("authgd_test_mock_ci_legacy_migration");
      }
      async end() {
        calls.push("end");
      }
    }
    await runInNewContext(script!, {
      process,
      console: { error: (error: unknown) => errors.push(error) },
      require: (name: string) => {
        if (name === "pg") return { Client };
        if (name === "./tests/helpers/fleet-legacy-db.ts")
          return { legacyFixtureProvisionPlan };
        throw new Error(`unexpected CI dependency ${name}`);
      },
    });
    expect(calls[0]).toBe("connect");
    expect(calls.at(-1)).toBe("end");
    expect(calls).toHaveLength(fault === "connection failure" ? 2 : 3);
    expect(process.exitCode).toBe(fault === "fresh" ? 0 : 1);
    expect(errors).toHaveLength(fault === "fresh" ? 0 : 1);
    expect([...databases]).toEqual(
      fault === "fresh"
        ? ["authgd_test_mock_ci", "authgd_test_mock_ci_legacy_migration"]
        : ["authgd_test_mock_ci"],
    );
  },
);

it("fetches both published immutable historical pins before the unit suite", () => {
  expect(PRE_COMBAT_REVISION).toBe("123a4d2547e2a93fefd1044645fedff1ad581b8b");
  expect(LEGACY_REVISION).toBe("62b2c6cd8d5ad7cc346ad4f96205e96e19f3e07d");
  for (const revision of [LEGACY_REVISION, PRE_COMBAT_REVISION]) {
    const fetch = unitJob.indexOf(`git fetch --no-tags origin ${revision}`);
    expect(fetch, `unit CI must fetch historical pin ${revision}`).toBeGreaterThan(
      unitJob.indexOf("run: npm ci"),
    );
    expect(fetch).toBeLessThan(unitJob.indexOf("run: npm test"));
  }
});

it("keeps the public Wingman fork and immutable runner/action pins aligned", () => {
  const revision = "911ae540db00d822e01c80b6c5236c1fffe719c3";
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
