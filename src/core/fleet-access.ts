export type LinkedFleetCharacter = { characterId: number; characterName: string };

/** Only current account links can be projected; an alt needs no grant of its own. */
export function linkedFleetCharacters(
  linked: readonly LinkedFleetCharacter[],
  rosterIds: readonly number[],
): LinkedFleetCharacter[] {
  const roster = new Set(rosterIds);
  return linked
    .filter((ch) => roster.has(ch.characterId))
    .sort((a, b) => a.characterId - b.characterId);
}

export type FleetAccessCode =
  | "checked"
  | "not_authorized"
  | "not_in_fleet"
  | "authorization_rejected"
  | "roster_unavailable"
  | "identity_changed"
  | "timed_out"
  | "service_unavailable"
  | "cooldown"
  | "not_eligible";

/** A point-in-time observation, never relay authorization or retained roster evidence. */
export type FleetAccessCheck = {
  code: FleetAccessCode;
  checkedAt: string | null;
  retryAt: string | null;
  characters: LinkedFleetCharacter[];
};
