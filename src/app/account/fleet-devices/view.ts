/**
 * The pure half of `/account/fleet-devices`'s confirmation notice — same
 * split, and same reason, as `account/view.ts`'s `accountConfirmation`.
 */

const DONE_CODES = ["revoke"] as const;

export type FleetDevicesDoneCode = (typeof DONE_CODES)[number];

function isDoneCode(value: string | undefined): value is FleetDevicesDoneCode {
  return value !== undefined && (DONE_CODES as readonly string[]).includes(value);
}

/** The one-line outcome of the press that landed here, or `""` for no
 *  confirmation to show — see `accountConfirmation`'s identical contract. */
export function fleetDevicesConfirmation(done: string | undefined): string {
  if (!isDoneCode(done)) return "";
  switch (done) {
    case "revoke":
      return "Device revoked. It can no longer read or publish fleet data.";
  }
}
