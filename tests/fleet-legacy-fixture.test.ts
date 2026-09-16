import { expect, it } from "vitest";
import {
  legacyFixtureUrls,
  legacyFixtureProvisionPlan as provisionPlan,
} from "./helpers/fleet-legacy-db";

const main = "postgres://authgd:authgd@127.0.0.1:55462/authgd_test_fleet_v2_backend";
const legacy = `${main}_legacy_migration`;
const approved = { TEST_DATABASE_URL: main, FLEET_LEGACY_TEST_DATABASE_URL: legacy };
const ci = { ...approved, GITHUB_ACTIONS: "true", CI: "true" };
it("builds one create-only sibling statement connected through the explicit main DB", () => {
  expect(typeof provisionPlan).toBe("function");
  expect(provisionPlan(ci)).toEqual({
    connectionString: main,
    sql: 'CREATE DATABASE "authgd_test_fleet_v2_backend_legacy_migration" OWNER authgd',
  });
});
it.each([
  [{ ...ci, GITHUB_ACTIONS: undefined }, "legacy_fixture_provision_ci_only"],
  [{ ...ci, CI: undefined }, "legacy_fixture_provision_ci_only"],
  [{ ...ci, TEST_DATABASE_URL: undefined }, "TEST_DATABASE_URL_required"],
  [{ ...ci, FLEET_LEGACY_TEST_DATABASE_URL: main }, "legacy_fixture_must_be_distinct"],
  [
    { ...ci, FLEET_LEGACY_TEST_DATABASE_URL: `${legacy}%22;DROP%20DATABASE%20authgd;` },
    "FLEET_LEGACY_TEST_DATABASE_URL_unsafe",
  ],
  [
    {
      ...ci,
      TEST_DATABASE_URL: `${main}${"x".repeat(64)}`,
      FLEET_LEGACY_TEST_DATABASE_URL: `${main}${"x".repeat(64)}_legacy_migration`,
    },
    "legacy_fixture_identifier_too_long",
  ],
] as const)(
  "refuses unsafe CI provisioning plans %# without creating any database",
  (env, code) => {
    expect(() => provisionPlan(env)).toThrow(code);
  },
);
it("accepts only explicit separate owned test URLs without connecting or provisioning", () => {
  expect(legacyFixtureUrls(approved)).toEqual({ main, legacy });
  expect(
    legacyFixtureUrls({
      ...approved,
      FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace("127.0.0.1", "localhost"),
    }).legacy,
  ).toContain("localhost:55462");
});
it.each([
  { FLEET_LEGACY_TEST_DATABASE_URL: legacy },
  { TEST_DATABASE_URL: main },
  { ...approved, FLEET_LEGACY_TEST_DATABASE_URL: main },
  { ...approved, FLEET_LEGACY_TEST_DATABASE_URL: main.replace("127.0.0.1", "localhost") },
  {
    ...approved,
    FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace("127.0.0.1", "db.example"),
  },
  { ...approved, FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace(":55462", "") },
  { ...approved, FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace(":55462", ":5433") },
  {
    ...approved,
    FLEET_LEGACY_TEST_DATABASE_URL: `${legacy}?options=-csearch_path=public`,
  },
  { ...approved, FLEET_LEGACY_TEST_DATABASE_URL: `${legacy}#ignored` },
  {
    ...approved,
    FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace(
      "authgd_test_fleet_v2_backend_legacy_migration",
      "authgd",
    ),
  },
  {
    ...approved,
    FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace("authgd_test", "%61uthgd_test"),
  },
  { ...approved, FLEET_LEGACY_TEST_DATABASE_URL: legacy.replace("postgres:", "https:") },
  {
    ...approved,
    TEST_DATABASE_URL: main.replace("authgd_test_fleet_v2_backend", "authgd"),
  },
])(
  "rejects missing, overlapping or unsafe fixture URLs %# before any connection",
  (env) => {
    expect(() => legacyFixtureUrls(env)).toThrow();
  },
);
