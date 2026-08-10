import { describe, expect, it, vi } from "vitest";

// Every action below now validates its bound arguments (via `assertValid`)
// AFTER calling `requireAdminAction()`, not before — see the docblock at the
// top of src/app/admin/accounts/actions.ts. That means the guard has to
// resolve for any of these throws to be reached at all, mocked rather than
// exercised for real, the same pattern
// admin-sync-actions-validation.test.ts and
// admin-access-lists-actions-validation.test.ts already use. Nothing below
// this mock touches a real database: every rejection throws before
// getDb/logAudit/enqueueSync or any service call.
vi.mock("@/lib/admin-guard", () => ({
  requireAdminAction: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));

const {
  approveAction,
  demoteAdminAction,
  promoteAdminAction,
  returnToAutoAction,
  saveNoteAction,
  setMainAction,
  setStatusAction,
  setTierAction,
  syncAccountAction,
  unlinkDiscordAction,
} = await import("@/app/admin/accounts/actions");

const VALID_UUID = "00000000-0000-0000-0000-000000000000";

describe("admin/accounts actions — bound-argument validation", () => {
  it("setTierAction rejects a malformed accountId with invalid_account_id", async () => {
    await expect(
      setTierAction("not-a-uuid", "member", "", "Some Pilot", null, new FormData()),
    ).rejects.toThrow("invalid_account_id");
  });

  it("setTierAction rejects a tier outside its own enum with invalid_tier", async () => {
    await expect(
      setTierAction(VALID_UUID, "bogus" as never, "", "Some Pilot", null, new FormData()),
    ).rejects.toThrow("invalid_tier");
  });

  it("approveAction rejects the wider setTierAction tier union with invalid_tier", async () => {
    // approveAction's own tier union is narrower ("alumni" | "associate") than
    // setTierAction's three-tier union — "member" is valid for its sibling but
    // not here.
    await expect(
      approveAction(
        VALID_UUID,
        "member" as never,
        "",
        "Some Pilot",
        null,
        new FormData(),
      ),
    ).rejects.toThrow("invalid_tier");
  });

  it("returnToAutoAction rejects a malformed accountId with invalid_account_id", async () => {
    await expect(
      returnToAutoAction("not-a-uuid", "", "Some Pilot", null, new FormData()),
    ).rejects.toThrow("invalid_account_id");
  });

  it("setStatusAction rejects a status outside its own enum with invalid_status", async () => {
    await expect(
      setStatusAction(
        VALID_UUID,
        "bogus" as never,
        "",
        "Some Pilot",
        null,
        new FormData(),
      ),
    ).rejects.toThrow("invalid_status");
  });

  it("saveNoteAction rejects a malformed accountId before ever reading the note", async () => {
    await expect(
      saveNoteAction("not-a-uuid", "", { seq: 0, changed: false }, new FormData()),
    ).rejects.toThrow("invalid_account_id");
  });

  it("syncAccountAction rejects a malformed accountId with invalid_account_id", async () => {
    await expect(syncAccountAction("not-a-uuid", "", "Some Pilot")).rejects.toThrow(
      "invalid_account_id",
    );
  });

  it("promoteAdminAction rejects a malformed accountId with invalid_account_id", async () => {
    await expect(promoteAdminAction("not-a-uuid", "", "Some Pilot")).rejects.toThrow(
      "invalid_account_id",
    );
  });

  it("demoteAdminAction rejects a malformed accountId with invalid_account_id", async () => {
    await expect(demoteAdminAction("not-a-uuid", "", "Some Pilot")).rejects.toThrow(
      "invalid_account_id",
    );
  });

  it("unlinkDiscordAction rejects a malformed accountId with invalid_account_id", async () => {
    await expect(
      unlinkDiscordAction("not-a-uuid", "", "Some Pilot", null, new FormData()),
    ).rejects.toThrow("invalid_account_id");
  });

  it("setMainAction rejects a non-positive characterId with invalid_character_id", async () => {
    await expect(setMainAction(VALID_UUID, 0, "", null, new FormData())).rejects.toThrow(
      "invalid_character_id",
    );
  });

  it("setMainAction rejects a malformed accountId before the characterId is even considered", async () => {
    await expect(
      setMainAction("not-a-uuid", 0, "", null, new FormData()),
    ).rejects.toThrow("invalid_account_id");
  });
});
