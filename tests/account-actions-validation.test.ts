import { describe, expect, it, vi } from "vitest";

// setMainAction/unlinkAction now validate characterId AFTER requireAccount(),
// matching every sibling file's guard-before-validation order — see
// account/actions.ts's own comment on parseCharacterId. That means this test
// needs requireAccount's own dependencies (next/headers's cookies and
// getSessionAccount) mocked to resolve, the same way
// admin-sync-actions-validation.test.ts mocks admin-guard for the equivalent
// reason. Nothing below this mock reaches a real database: `getDb()` is
// evaluated (it is the argument to the mocked `getSessionAccount`), but it
// only builds a client — no query is issued, and the schema rejection throws
// before setMainCharacter/unlinkCharacter are ever called.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "session-id" }) }),
}));
vi.mock("@/services/session", () => ({
  getSessionAccount: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));

const { setMainAction, unlinkAction } = await import("@/app/account/actions");

describe("account actions — bound characterId validation", () => {
  it("setMainAction rejects a non-positive characterId with invalid_character_id", async () => {
    await expect(setMainAction(0)).rejects.toThrow("invalid_character_id");
    await expect(setMainAction(-1)).rejects.toThrow("invalid_character_id");
  });

  it("setMainAction rejects a non-integer characterId with invalid_character_id", async () => {
    await expect(setMainAction(1.5)).rejects.toThrow("invalid_character_id");
  });

  it("unlinkAction rejects a non-positive characterId with invalid_character_id", async () => {
    await expect(unlinkAction(0)).rejects.toThrow("invalid_character_id");
  });
});
