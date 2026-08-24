import { describe, expect, it, vi } from "vitest";

// designateStructureHolderAction/checkNowAction both call requireAdminAction
// before parseId, so it must resolve for the test to reach id validation at
// all. Nothing below this mock touches a real database: a bad id throws
// before designateStructureHolder or getDb are ever called.
vi.mock("@/lib/admin-guard", () => ({
  requireAdminAction: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));

const { designateStructureHolderAction } = await import("@/app/admin/structures/actions");

describe("structures actions — id validation", () => {
  it("rejects a non-numeric character id", async () => {
    const fd = new FormData();
    fd.set("characterId", "12abc");
    await expect(designateStructureHolderAction(fd)).rejects.toThrow("invalid_id");
  });

  it("rejects a negative character id", async () => {
    const fd = new FormData();
    fd.set("characterId", "-1");
    await expect(designateStructureHolderAction(fd)).rejects.toThrow("invalid_id");
  });

  it("rejects a missing character id", async () => {
    await expect(designateStructureHolderAction(new FormData())).rejects.toThrow(
      "invalid_id",
    );
  });
});
