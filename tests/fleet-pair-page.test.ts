import { describe, expect, it } from "vitest";
import { derivePairingState } from "@/app/fleet/pair/[id]/page";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function pendingRow(
  overrides: Partial<{
    expiresAt: Date;
    consumedAt: Date | null;
    approvedAt: Date | null;
  }> = {},
) {
  return {
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    approvedAt: null,
    ...overrides,
  };
}

// `derivePairingState` is the page's own copy of the states
// `approvePairing`/`completePairing` (fleet-pairing.ts) can leave a pairing
// request row in, plus the one condition (device already bound to a
// different account) that row's own columns never record. This suite covers
// every branch without a database.
describe("derivePairingState", () => {
  it.each([null, NOW])(
    "maintenance overrides pending/approved state (%s) without a fresh-key demand",
    (approvedAt) => {
      expect(
        derivePairingState({
          row: pendingRow({ approvedAt }),
          now: NOW,
          deviceBoundToAnotherAccount: false,
          identityMaintenance: true,
          keyUnavailable: true,
        }),
      ).toBe("maintenance");
    },
  );
  it.each([null, NOW])(
    "indexed conflicts/tombstones/revocations never offer approval (%s)",
    (approvedAt) => {
      expect(
        derivePairingState({
          row: pendingRow({ approvedAt }),
          now: NOW,
          deviceBoundToAnotherAccount: false,
          keyUnavailable: true,
        }),
      ).toBe("key_unavailable");
    },
  );
  it("offers no approval for shared enrollment while the gate is disabled", () => {
    expect(
      derivePairingState({
        row: pendingRow(),
        now: NOW,
        deviceBoundToAnotherAccount: false,
        sharingDisabled: true,
        keyUnavailable: true,
      }),
    ).toBe("feature_disabled");
    expect(
      derivePairingState({
        row: pendingRow({ approvedAt: NOW }),
        now: NOW,
        deviceBoundToAnotherAccount: false,
        sharingDisabled: true,
        keyUnavailable: true,
      }),
    ).toBe("feature_disabled");
  });
  it.each([
    pendingRow({ expiresAt: NOW, approvedAt: NOW }),
    pendingRow({ consumedAt: NOW, approvedAt: NOW }),
  ])(
    "closed requests outrank maintenance, disabled sharing and unavailable keys",
    (row) => {
      expect(
        derivePairingState({
          row,
          now: NOW,
          deviceBoundToAnotherAccount: true,
          identityMaintenance: true,
          sharingDisabled: true,
          keyUnavailable: true,
        }),
      ).toBe("closed");
    },
  );
  it("is closed when there is no row at all (missing/malformed id)", () => {
    expect(
      derivePairingState({
        row: undefined,
        now: NOW,
        deviceBoundToAnotherAccount: false,
      }),
    ).toBe("closed");
  });

  it("is closed once the request has expired", () => {
    const row = pendingRow({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(
      derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: false }),
    ).toBe("closed");
  });

  it("is closed once the request has been consumed (completed)", () => {
    const row = pendingRow({ consumedAt: NOW });
    expect(
      derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: false }),
    ).toBe("closed");
  });

  it("is approved once approvedAt is set", () => {
    const row = pendingRow({ approvedAt: NOW });
    expect(
      derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: false }),
    ).toBe("approved");
  });

  it("is pending for a fresh, unapproved, unexpired request", () => {
    const row = pendingRow();
    expect(
      derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: false }),
    ).toBe("pending");
  });

  // The regression this function exists for (final review finding C1):
  // `approvePairing` throws `DeviceBoundToAnotherAccountError` BEFORE writing
  // `approvedAt`, so the row alone still looks "pending" -- without this
  // flag, a viewer who cannot ever complete this pairing would be handed the
  // identical Approve control back, forever, instead of a terminal state.
  it("is device_bound_elsewhere for an otherwise-pending request whose key is already bound to a different account", () => {
    const row = pendingRow();
    expect(derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: true })).toBe(
      "device_bound_elsewhere",
    );
  });

  // Terminal states outrank the bound-elsewhere flag: an already-closed or
  // already-approved request must not regress to a DIFFERENT terminal state
  // just because a device row also happens to match.
  it("stays closed even if deviceBoundToAnotherAccount is true for an expired request", () => {
    const row = pendingRow({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: true })).toBe(
      "closed",
    );
  });

  it("stays approved even if deviceBoundToAnotherAccount is true", () => {
    const row = pendingRow({ approvedAt: NOW });
    expect(derivePairingState({ row, now: NOW, deviceBoundToAnotherAccount: true })).toBe(
      "approved",
    );
  });
});
