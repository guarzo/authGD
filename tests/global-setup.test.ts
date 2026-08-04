import { describe, expect, it } from "vitest";
import { buildContentionMessage, deriveWorktreeDbName } from "./helpers/global-setup";

describe("deriveWorktreeDbName", () => {
  it("lowercases and keeps the authgd_test_ prefix", () => {
    expect(deriveWorktreeDbName("/home/tng/workspace/authGD")).toBe("authgd_test_authgd");
  });

  it("collapses illegal characters to underscores", () => {
    expect(deriveWorktreeDbName("/worktrees/fix+account-page-mechanics")).toBe(
      "authgd_test_fix_account_page_mechanics",
    );
  });

  it("collapses runs of separators instead of leaving repeats", () => {
    expect(deriveWorktreeDbName("/worktrees/a---b")).toBe("authgd_test_a_b");
  });

  it("trims leading and trailing separators produced by sanitizing", () => {
    expect(deriveWorktreeDbName("/worktrees/-leading-and-trailing-")).toBe(
      "authgd_test_leading_and_trailing",
    );
  });

  it("caps the result at 63 characters, Postgres's identifier limit", () => {
    const long = "a".repeat(100);
    const name = deriveWorktreeDbName(`/worktrees/${long}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toBe("authgd_test_" + long.slice(0, 63 - "authgd_test_".length));
  });

  it("accepts a trailing underscore left behind by truncation", () => {
    // Trimming happens before the length cap, so a separator sitting exactly
    // at the cut point survives into the final name. That is a legal unquoted
    // Postgres identifier — asserted here so nobody 'fixes' it by trimming
    // again afterwards and quietly changes the name every worktree derives.
    const budget = 63 - "authgd_test_".length;
    const name = deriveWorktreeDbName(
      `/worktrees/${"a".repeat(budget - 1)}-${"b".repeat(10)}`,
    );

    expect(name).toBe(`authgd_test_${"a".repeat(budget - 1)}_`);
    expect(name.length).toBe(63);
  });

  it("falls back to a placeholder if the basename sanitizes to nothing", () => {
    expect(deriveWorktreeDbName("/worktrees/---")).toBe("authgd_test_worktree");
  });
});

describe("buildContentionMessage", () => {
  it("names the host, port, database, and a CREATE DATABASE escape hatch", () => {
    const message = buildContentionMessage({
      host: "localhost",
      port: "5433",
      database: "authgd_test",
      containerName: "authgd-design-postgres-1",
      worktreeDbName: "authgd_test_mine",
    });

    expect(message).toContain("authgd_test (localhost:5433)");
    expect(message).toContain(
      'docker exec authgd-design-postgres-1 psql -U authgd -d postgres \\\n    -c "CREATE DATABASE authgd_test_mine OWNER authgd;"',
    );
    expect(message).toContain(
      "export TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_mine",
    );
    expect(message).toContain("docs/ops.md");
  });

  it("falls back to a placeholder container name when docker lookup found nothing", () => {
    const message = buildContentionMessage({
      host: "localhost",
      port: "5433",
      database: "authgd_test",
      containerName: "<postgres-container>",
      worktreeDbName: "authgd_test_mine",
    });

    expect(message).toContain("docker exec <postgres-container> psql");
  });
});
