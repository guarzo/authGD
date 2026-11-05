import type { Db } from "@/db";
import type { PublishedRow } from "@/services/fleet-relay";
import { NOW, participatingDevice, sharedAccounts } from "./fleet-shared-admission";

export const COMBAT_APPROVAL = ["shared-source-v1", "combat-v2"];

/** Synthetic measured combat input only — never permission, proof or a clock.
 * Call sites must supply the original sample explicitly to the real relay. */
export function combatRow(
  characterId: number,
  outgoingDps: number | null,
  effects: PublishedRow["effects"] = [],
): PublishedRow {
  return { characterId, outgoingDps, incomingDps: null, activityAgeMs: 0, effects };
}
export const POINT = [
  { kind: "POINT", observations: [{ name: null, ageMs: 0 }] },
] as const;

/** These tests explicitly exercise publishers; do not change the shared-only
 * defaults used by receiver/source-only and non-disclosure fixtures. */
export function combatAccounts(db: Db, now = NOW) {
  return sharedAccounts(db, now, COMBAT_APPROVAL);
}
export function combatDevice(db: Db, accountId: string, now = NOW) {
  return participatingDevice(db, accountId, now, COMBAT_APPROVAL);
}
