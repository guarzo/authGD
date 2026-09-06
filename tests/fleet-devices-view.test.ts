import { describe, expect, it } from "vitest";
import { fleetDevicesConfirmation } from "@/app/account/fleet-devices/view";

describe("fleetDevicesConfirmation", () => {
  it("returns the revoke confirmation for done=revoke", () => {
    expect(fleetDevicesConfirmation("revoke")).toBe(
      "Device revoked. It can no longer read or publish fleet data.",
    );
  });

  it("returns an empty string for an unrecognized or missing code", () => {
    expect(fleetDevicesConfirmation(undefined)).toBe("");
    expect(fleetDevicesConfirmation("bogus")).toBe("");
  });
});
