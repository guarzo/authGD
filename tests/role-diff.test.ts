import { describe, expect, it } from "vitest";
import { diffRoles, stripManagedRoles, validateRoleConfig } from "@/core/role-diff";

const managed = { flygd: "10", blue: "11", green: "12" };

describe("diffRoles", () => {
  it("adds the tier role and removes the other managed roles only", () => {
    expect(
      diffRoles({ tier: "flygd", managed, memberRoleIds: ["11", "12", "999"] }),
    ).toEqual({ add: ["10"], remove: ["11", "12"] });
  });
  it("is a no-op when exactly the tier role is present", () => {
    expect(diffRoles({ tier: "green", managed, memberRoleIds: ["12", "999"] })).toEqual({
      add: [],
      remove: [],
    });
  });
});

describe("stripManagedRoles", () => {
  it("returns only the managed roles the member has", () => {
    expect(stripManagedRoles(managed, ["11", "999", "12"])).toEqual(["11", "12"]);
    expect(stripManagedRoles(managed, ["999"])).toEqual([]);
  });
});

describe("validateRoleConfig", () => {
  const MANAGE_ROLES = String(1 << 28);
  const guildRoles = [
    { id: "10", position: 5, permissions: "0" },
    { id: "11", position: 4, permissions: "0" },
    { id: "12", position: 3, permissions: "0" },
    { id: "bot-role", position: 9, permissions: MANAGE_ROLES },
  ];

  it("accepts a valid config", () => {
    expect(
      validateRoleConfig({ managed, guildRoles, botRoleIds: ["bot-role"] }),
    ).toEqual({ ok: true });
  });
  it("rejects duplicate managed role ids", () => {
    const r = validateRoleConfig({
      managed: { flygd: "10", blue: "10", green: "12" },
      guildRoles,
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false });
  });
  it("rejects managed roles missing from the guild", () => {
    const r = validateRoleConfig({
      managed: { ...managed, blue: "404" },
      guildRoles,
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("404") });
  });
  it("rejects a bot without Manage Roles", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, permissions: "0" } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Manage Roles") });
  });
  it("accepts Administrator in place of Manage Roles", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, permissions: String(1 << 3) } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toEqual({ ok: true });
  });
  it("rejects a bot whose highest role is not above the managed roles", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, position: 4 } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false });
  });
  it("accepts Manage Roles granted only via the @everyone role", () => {
    const guildId = "everyone-1";
    const r = validateRoleConfig({
      managed,
      guildRoles: [
        ...guildRoles.map((g) => (g.id === "bot-role" ? { ...g, permissions: "0" } : g)),
        { id: guildId, position: 0, permissions: MANAGE_ROLES },
      ],
      botRoleIds: ["bot-role"],
      everyoneRoleId: guildId,
    });
    expect(r).toEqual({ ok: true });
  });
  it("a malformed permissions string doesn't throw and fails closed", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, permissions: "not-a-number" } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Manage Roles") });
  });
});
