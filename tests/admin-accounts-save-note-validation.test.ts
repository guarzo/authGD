import { describe, expect, it, vi } from "vitest";

// saveNoteAction calls requireAdminAction() first, then validates
// accountId/listSearch, and only then reads the note — so this rejection, like
// every other one in admin-accounts-actions-validation.test.ts, needs the
// guard mocked to be reached at all. Nothing below this mock touches a real
// database: the note rejection throws before setStatusNote/getDb are called.
vi.mock("@/lib/admin-guard", () => ({
  requireAdminAction: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));

const { saveNoteAction } = await import("@/app/admin/accounts/actions");

const VALID_UUID = "00000000-0000-0000-0000-000000000000";

describe("saveNoteAction — note validation", () => {
  it("rejects a non-string note (a File field) with invalid_note, same as the original typeof check", async () => {
    const formData = new FormData();
    formData.set("note", new Blob(["x"]));
    await expect(
      saveNoteAction(VALID_UUID, "", { seq: 0, changed: false }, formData),
    ).rejects.toThrow("invalid_note");
  });

  it("rejects a missing note field with invalid_note", async () => {
    await expect(
      saveNoteAction(VALID_UUID, "", { seq: 0, changed: false }, new FormData()),
    ).rejects.toThrow("invalid_note");
  });
});
