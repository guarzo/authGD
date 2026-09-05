import { describe, expect, it, vi } from "vitest";

/**
 * `approvePairingAction`'s own behavior on the early
 * `DeviceBoundToAnotherAccountError` refusal (final-review finding C1):
 * swallowed exactly like every other per-request refusal, not escalated to
 * `error.tsx`. Isolated from the real database the same way
 * `account-actions-validation.test.ts` isolates `setMainAction`/`unlinkAction`
 * — `next/headers`'s cookies and `@/services/session`'s getSessionAccount are
 * mocked so the action reaches `approvePairing` at all, and `next/cache`'s
 * `revalidatePath` is mocked because it throws outside a real request scope
 * (`Invariant: static generation store missing`) — this action calls it on
 * EVERY reachable path, including this one, so leaving it real would fail
 * this test for a reason that has nothing to do with the refusal under test.
 * `@/services/fleet-pairing` is mocked down to ONLY `approvePairing`,
 * keeping every real error class (`importOriginal`) so the action's own
 * `instanceof` checks run against the real constructors, not a mock's.
 */
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "session-id" }) }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
vi.mock("@/services/session", () => ({
  getSessionAccount: async () => ({ accountId: "00000000-0000-0000-0000-000000000000" }),
}));
vi.mock("@/services/fleet-pairing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/fleet-pairing")>();
  return {
    ...actual,
    approvePairing: vi.fn(async () => {
      throw new actual.DeviceBoundToAnotherAccountError(
        "this device key is already bound to a different account and cannot be re-paired to another account",
      );
    }),
  };
});

const { revalidatePath } = await import("next/cache");
const { approvePairingAction } = await import("@/app/fleet/pair/[id]/actions");

describe("approvePairingAction — early DeviceBoundToAnotherAccountError", () => {
  it("swallows the refusal instead of letting it escape to error.tsx", async () => {
    await expect(
      approvePairingAction("11111111-1111-1111-1111-111111111111"),
    ).resolves.toBeUndefined();
  });

  it("still revalidates the pairing page so the next render picks up the terminal state", async () => {
    vi.mocked(revalidatePath).mockClear();
    await approvePairingAction("11111111-1111-1111-1111-111111111111");
    expect(revalidatePath).toHaveBeenCalledWith(
      "/fleet/pair/11111111-1111-1111-1111-111111111111",
    );
  });
});
