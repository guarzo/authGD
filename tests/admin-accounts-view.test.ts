import { describe, expect, it } from "vitest";
import { accountsConfirmation, matchesAccountSearch } from "@/app/admin/accounts/view";

// The success confirmation the eight redirecting /admin/accounts server
// actions carry back — setTierAction, approveAction, returnToAutoAction,
// setStatusAction (both directions), promoteAdminAction, demoteAdminAction,
// unlinkDiscordAction and syncAccountAction all end in the pressed control
// unmounting or (setTierAction) disabling itself, and this is the only
// evidence an admin gets that the press landed. `done`, `name` and `tier`
// arrive off the query string, exactly like `accountConfirmation`'s own
// `done`/`name` in account/view.ts, so an unrecognized or missing value is
// untrusted input reaching copy and has to degrade rather than throw or
// print garbage.
describe("accountsConfirmation", () => {
  it("names the account and the tier for a manual tier change", () => {
    expect(accountsConfirmation("tier", "Aiden Sol", "Alumni")).toBe(
      "Aiden Sol pinned to Alumni. Press auto to unpin.",
    );
  });

  // The reason the sentence says "pinned" rather than "set": setTierManual
  // writes `tierLocked: true` on every manual set, including a set to the tier
  // the account already shows — and that button is live, painted
  // `aria-pressed`, and looks exactly like the filter chips above it that mean
  // "you are already here, this does nothing". An admin who presses it takes
  // the account out of the membership job's reach for good. Every shape of the
  // sentence has to say so, including the two degraded ones, which is what
  // makes this worth asserting as a rule over all three rather than three
  // separate literals: the pin is the fact, not a decoration on the full form.
  it("names the pin, and the control that undoes it, in every shape", () => {
    for (const text of [
      accountsConfirmation("tier", "Aiden Sol", "Alumni"),
      accountsConfirmation("tier", undefined, "Alumni"),
      accountsConfirmation("tier", undefined, undefined),
    ]) {
      expect(text).toMatch(/pinned/i);
      // `auto` is the word written on the button that clears the lock, which
      // only renders once the lock exists — i.e. as a result of this press.
      expect(text).toContain("auto");
    }
  });

  it("falls back to just the tier when the name didn't survive the redirect", () => {
    expect(accountsConfirmation("tier", undefined, "Alumni")).toBe(
      "Pinned to Alumni. Press auto to unpin.",
    );
  });

  it("falls back to a bare verb when neither name nor tier survived", () => {
    expect(accountsConfirmation("tier", undefined, undefined)).toBe(
      "Tier pinned. Press auto to unpin.",
    );
  });

  it("names the account and the tier for an approval", () => {
    expect(accountsConfirmation("approve", "Someone Else", "Associate")).toBe(
      "Someone Else approved as Associate.",
    );
  });

  it("falls back to a bare verb for an approval with nothing to name", () => {
    expect(accountsConfirmation("approve", undefined, undefined)).toBe(
      "Account approved.",
    );
  });

  it("names the account for a return to automatic tier", () => {
    expect(accountsConfirmation("auto", "Aiden Sol", undefined)).toBe(
      "Aiden Sol returned to automatic tier.",
    );
  });

  it("names the account for a freeze", () => {
    expect(accountsConfirmation("freeze", "Aiden Sol", undefined)).toBe(
      "Aiden Sol frozen.",
    );
  });

  it("names the account for a wake", () => {
    expect(accountsConfirmation("wake", "Aiden Sol", undefined)).toBe(
      "Aiden Sol active again.",
    );
  });

  it("names the account for an admin grant", () => {
    expect(accountsConfirmation("grant", "Aiden Sol", undefined)).toBe(
      "Aiden Sol granted admin.",
    );
  });

  it("names the account for an admin revoke", () => {
    expect(accountsConfirmation("revoke", "Aiden Sol", undefined)).toBe(
      "Aiden Sol's admin access revoked.",
    );
  });

  it("names the account for a Discord unlink", () => {
    expect(accountsConfirmation("discord", "Aiden Sol", undefined)).toBe(
      "Discord unlinked for Aiden Sol.",
    );
  });

  it("confirms a Discord unlink without a name", () => {
    expect(accountsConfirmation("discord", undefined, undefined)).toBe(
      "Discord unlinked.",
    );
  });

  it("names the account for a queued sync", () => {
    expect(accountsConfirmation("sync", "Aiden Sol", undefined)).toBe(
      "Sync queued for Aiden Sol. The worker picks it up within a few seconds.",
    );
  });

  it("confirms a queued sync without a name", () => {
    expect(accountsConfirmation("sync", undefined, undefined)).toBe(
      "Sync queued. The worker picks it up within a few seconds.",
    );
  });

  it("renders nothing for a missing done code", () => {
    expect(accountsConfirmation(undefined, undefined, undefined)).toBe("");
  });

  it("renders nothing for a done code this build doesn't recognize", () => {
    // A hand-typed `?done=` (or one a future rollback no longer emits) must
    // not silently pass through to become copy on the page.
    expect(accountsConfirmation("delete_account", undefined, undefined)).toBe("");
  });
});

describe("matchesAccountSearch", () => {
  const row = {
    accountId: "7f3a2b1c-0000-4000-8000-000000000001",
    mainName: "Zed Alt",
    discordUsername: "zedalt",
    characters: [{ name: "Zed Alt" }, { name: "Old Zed" }],
  };

  it("matches an empty or whitespace-only query unconditionally", () => {
    expect(matchesAccountSearch(row, "")).toBe(true);
    expect(matchesAccountSearch(row, "   ")).toBe(true);
  });

  it("matches the main name, case-insensitively and by substring", () => {
    expect(matchesAccountSearch(row, "zed")).toBe(true);
    expect(matchesAccountSearch(row, "ALT")).toBe(true);
  });

  it("matches an alt's name even when it isn't the main", () => {
    expect(matchesAccountSearch(row, "Old Zed")).toBe(true);
  });

  it("matches the Discord handle", () => {
    expect(matchesAccountSearch(row, "zedalt")).toBe(true);
  });

  it("matches the account uuid by exact, case-insensitive equality", () => {
    expect(matchesAccountSearch(row, "7F3A2B1C-0000-4000-8000-000000000001")).toBe(true);
  });

  it("does not match a partial uuid paste", () => {
    expect(matchesAccountSearch(row, "7f3a2b1c")).toBe(false);
  });

  it("does not match an unrelated query", () => {
    expect(matchesAccountSearch(row, "nobody here")).toBe(false);
  });

  it("does not match on a null main name or Discord handle", () => {
    const noMain = {
      accountId: "00000000-0000-0000-0000-000000000000",
      mainName: null,
      discordUsername: null,
      characters: [{ name: "Only Alt" }],
    };
    expect(matchesAccountSearch(noMain, "only")).toBe(true);
    expect(matchesAccountSearch(noMain, "nothing")).toBe(false);
  });
});
