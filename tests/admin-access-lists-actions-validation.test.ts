import { describe, expect, it, vi } from "vitest";

// designateHolderAction/addWatchAction/removeWatchAction all call
// requireAdminAction before parseId, so it must resolve for the test to reach
// the id validation at all. Nothing below this mock touches a real database:
// a bad id throws before designateHolder/addWatch/removeWatch or getDb are
// ever called.
vi.mock("@/lib/admin-guard", () => ({
  requireAdminAction: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));

const { addWatchAction, designateHolderAction, removeWatchAction } =
  await import("@/app/admin/access-lists/actions");

describe("access-lists actions — id validation", () => {
  it("designateHolderAction rejects a non-numeric characterId with invalid_id", async () => {
    const formData = new FormData();
    formData.set("characterId", "not-a-number");
    await expect(designateHolderAction(formData)).rejects.toThrow("invalid_id");
  });

  it("addWatchAction rejects a zero/negative accessListId with invalid_id", async () => {
    const formData = new FormData();
    formData.set("accessListId", "0");
    await expect(addWatchAction(formData)).rejects.toThrow("invalid_id");
  });

  it("removeWatchAction rejects a missing accessListId (a scripted POST with no submitter) with invalid_id", async () => {
    // The one call site where accessListId arrives as a submit button's own
    // name/value rather than a hidden input, so a scripted POST with no
    // submitter gives FormData.get(...) === null — parseId(null) must still
    // throw invalid_id, not a TypeError coercing null.
    await expect(removeWatchAction(null, new FormData())).rejects.toThrow("invalid_id");
  });
});
