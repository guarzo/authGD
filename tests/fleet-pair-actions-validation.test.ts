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
const { approvePairing } = await import("@/services/fleet-pairing");
const { approvePairingAction } = await import("@/app/fleet/pair/[id]/actions");

describe("approvePairingAction — early DeviceBoundToAnotherAccountError", () => {
  it("swallows the refusal instead of letting it escape to error.tsx", async () => {
    await expect(
      approvePairingAction("11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeUndefined();
  });

  it("still revalidates the pairing page so the next render picks up the terminal state", async () => {
    vi.mocked(revalidatePath).mockClear();
    await approvePairingAction("11111111-1111-4111-8111-111111111111");
    expect(revalidatePath).toHaveBeenCalledWith(
      "/fleet/pair/11111111-1111-4111-8111-111111111111",
    );
  });
});

/**
 * `approvePairingAction`'s Zod UUID check on a forged `pairingId` (a bound
 * server-action argument round-trips through the client like any other,
 * so a malformed value is reachable regardless of what the rendered page
 * ever passes). Unlike `revokeFleetDeviceAction`'s own equivalent check
 * (`fleet-devices/actions.ts`), a failure here returns SILENTLY: this
 * action has no error-notice channel of its own — every reachable refusal
 * already resolves by re-rendering `/fleet/pair/[id]`'s current state, and
 * a pairing id that never parsed as a UUID names no real page to revalidate
 * either, so neither the service nor `revalidatePath` is called at all.
 */
describe("approvePairingAction — malformed pairingId", () => {
  it("returns silently, calling neither approvePairing nor revalidatePath, for an id that is not a UUID", async () => {
    vi.mocked(approvePairing).mockClear();
    vi.mocked(revalidatePath).mockClear();

    await expect(approvePairingAction("not-a-uuid")).resolves.toBeUndefined();

    expect(approvePairing).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
