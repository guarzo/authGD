import { describe, expect, it, vi } from "vitest";

/**
 * The other `*-validation.test.ts` files mock their guard so it *resolves*,
 * which is what lets them reach the schema rejections at all — but a resolving
 * guard cannot tell guard-first from validation-first apart, because both
 * orders reach the same throw. This file mocks the guards so they *reject*,
 * which is the only arrangement where the two orders differ: with the guard
 * first, a caller who fails it gets the guard's own outcome no matter how
 * malformed their arguments were; with validation first, a malformed argument
 * throws `invalid_*` and tells an unauthorized caller something about the
 * shape of the input it sent.
 *
 * That order was written the wrong way round once already in this change, and
 * every assertion here fails if it is written that way again.
 */
vi.mock("@/lib/admin-guard", () => ({
  requireAdminAction: async () => {
    throw new Error("guard_denied");
  },
}));

// `requireAccount` (account/actions.ts) is not a shared helper — it is local to
// that module and redirects rather than throwing, so its denial is staged by
// giving it no session cookie and capturing the `redirect()` it reaches for.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected:${url}`);
  },
}));

const { setTierAction, saveNoteAction, syncAccountAction } =
  await import("@/app/admin/accounts/actions");
const { setMainAction, unlinkAction } = await import("@/app/account/actions");

describe("admin/accounts actions — the admin guard runs before any argument is parsed", () => {
  it("setTierAction denies an unauthorized caller rather than reporting invalid_account_id", async () => {
    await expect(
      setTierAction(
        "not-a-uuid",
        "bogus" as never,
        "",
        "Some Pilot",
        null,
        new FormData(),
      ),
    ).rejects.toThrow("guard_denied");
  });

  it("saveNoteAction denies before it reads the note field at all", async () => {
    const formData = new FormData();
    formData.set("note", new Blob(["x"]));
    await expect(
      saveNoteAction("not-a-uuid", "", { seq: 0, changed: false }, formData),
    ).rejects.toThrow("guard_denied");
  });

  it("syncAccountAction denies before enqueueing or parsing", async () => {
    await expect(syncAccountAction("not-a-uuid", "", "Some Pilot")).rejects.toThrow(
      "guard_denied",
    );
  });
});

describe("account actions — requireAccount runs before characterId is parsed", () => {
  it("setMainAction redirects a signed-out caller rather than reporting invalid_character_id", async () => {
    await expect(setMainAction(0)).rejects.toThrow("redirected:/login");
  });

  it("unlinkAction redirects a signed-out caller rather than reporting invalid_character_id", async () => {
    await expect(unlinkAction(-1)).rejects.toThrow("redirected:/login");
  });
});
