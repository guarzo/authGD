import { describe, expect, it } from "vitest";
import { buildContentionMessage, hasCode } from "./helpers/global-setup";
import {
  deriveWorktreeDbName,
  ownsTestDatabase,
  resolveTestUrl,
} from "./helpers/test-db-url";

describe("deriveWorktreeDbName", () => {
  const HASH = /_[0-9a-f]{6}$/;

  it("lowercases and keeps the authgd_test_ prefix", () => {
    expect(deriveWorktreeDbName("/home/tng/workspace/authGD")).toMatch(
      /^authgd_test_authgd_[0-9a-f]{6}$/,
    );
  });

  it("collapses illegal characters to underscores", () => {
    expect(deriveWorktreeDbName("/worktrees/fix+account-page-mechanics")).toMatch(
      /^authgd_test_fix_account_page_mechanics_[0-9a-f]{6}$/,
    );
  });

  it("collapses runs of separators instead of leaving repeats", () => {
    expect(deriveWorktreeDbName("/worktrees/a---b")).toMatch(
      /^authgd_test_a_b_[0-9a-f]{6}$/,
    );
  });

  it("trims leading and trailing separators produced by sanitizing", () => {
    expect(deriveWorktreeDbName("/worktrees/-leading-and-trailing-")).toMatch(
      /^authgd_test_leading_and_trailing_[0-9a-f]{6}$/,
    );
  });

  it("falls back to a placeholder if the basename sanitizes to nothing", () => {
    expect(deriveWorktreeDbName("/worktrees/---")).toMatch(
      /^authgd_test_worktree_[0-9a-f]{6}$/,
    );
  });

  // The reason the hash exists: two worktrees can share a basename.
  it("gives two worktrees with the same basename different databases", () => {
    const a = deriveWorktreeDbName("/home/tng/a/authGD");
    const b = deriveWorktreeDbName("/home/tng/b/authGD");
    expect(a).not.toBe(b);
    expect(a.replace(HASH, "")).toBe(b.replace(HASH, ""));
  });

  it("is stable for the same directory", () => {
    expect(deriveWorktreeDbName("/home/tng/a/authGD")).toBe(
      deriveWorktreeDbName("/home/tng/a/authGD"),
    );
  });

  it("caps the result at 63 characters with the hash still intact", () => {
    const name = deriveWorktreeDbName(`/worktrees/${"a".repeat(100)}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(HASH);
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

describe("hasCode", () => {
  it("matches an object carrying the given code", () => {
    expect(hasCode({ code: "3D000" }, "3D000")).toBe(true);
  });

  it("does not match an object with a different code", () => {
    expect(hasCode({ code: "42P04" }, "3D000")).toBe(false);
  });

  it("does not match a plain Error with no code", () => {
    expect(hasCode(new Error("boom"), "3D000")).toBe(false);
  });

  it("does not match null", () => {
    expect(hasCode(null, "3D000")).toBe(false);
  });

  it("does not match undefined", () => {
    expect(hasCode(undefined, "3D000")).toBe(false);
  });

  it("does not match a string", () => {
    expect(hasCode("3D000", "3D000")).toBe(false);
  });
});

describe("resolveTestUrl", () => {
  it("prefers an explicit TEST_DATABASE_URL over everything", () => {
    expect(
      resolveTestUrl(
        { TEST_DATABASE_URL: "postgres://u:p@example:5432/mine", CI: "true" },
        "/worktrees/x",
      ),
    ).toBe("postgres://u:p@example:5432/mine");
  });

  // CI stands up a shared Postgres service and sets no override. Changing this
  // would point CI at a database nothing creates.
  it("uses the historical shared database under CI", () => {
    expect(resolveTestUrl({ CI: "true" }, "/worktrees/x")).toBe(
      "postgres://authgd:authgd@localhost:5433/authgd_test",
    );
  });

  it("otherwise derives a database for this worktree", () => {
    expect(resolveTestUrl({}, "/worktrees/my-branch")).toMatch(
      /^postgres:\/\/authgd:authgd@localhost:5433\/authgd_test_my_branch_[0-9a-f]{6}$/,
    );
  });

  it("ignores an empty TEST_DATABASE_URL rather than connecting nowhere", () => {
    expect(resolveTestUrl({ TEST_DATABASE_URL: "" }, "/worktrees/x")).toMatch(
      /authgd_test_x_[0-9a-f]{6}$/,
    );
  });
});

describe("ownsTestDatabase", () => {
  it("owns the database it derived itself", () => {
    expect(ownsTestDatabase({})).toBe(true);
  });

  it("does not own a database named by TEST_DATABASE_URL", () => {
    expect(ownsTestDatabase({ TEST_DATABASE_URL: "postgres://u:p@h:1/d" })).toBe(false);
  });

  it("does not own CI's shared database", () => {
    expect(ownsTestDatabase({ CI: "true" })).toBe(false);
  });
});
