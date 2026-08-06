/**
 * Pure display formatting for character location. No database, no ESI: the job
 * writes ids to `character`, the view layer resolves the names, and this turns
 * the pair into the one line a row renders.
 */
export const LOCATION_CADENCE_MS = 15 * 60 * 1000;

export type LocationSnapshot = {
  systemId: number | null;
  stationId: number | null;
  structureId: number | null;
  online: boolean | null;
  checkedAt: Date | null;
};

export type LocationNames = {
  /** Resolved solar-system name, or null when the cache has not got one. */
  system: string | null;
  /** Resolved station or structure name, or null. */
  docked: string | null;
};

export type LocationDisplay =
  { kind: "none" } | { kind: "line"; text: string; offline: boolean };

/**
 * Degrades to less detail, never to a wrong answer: an unresolved system falls
 * back to its id, an unresolved dock to the bare word "Docked". A character
 * never read at all — no `checkedAt`, or no system — renders nothing, because
 * the re-authorize control already present in that row is the remedy.
 */
export function formatLocation(
  snap: LocationSnapshot,
  names: LocationNames,
): LocationDisplay {
  if (snap.checkedAt === null || snap.systemId === null) return { kind: "none" };
  const system = names.system ?? `System ${snap.systemId}`;
  const place =
    names.docked ??
    (snap.stationId !== null || snap.structureId !== null ? "Docked" : "in space");
  const text = `${system} — ${place}`;
  // `online === null` means read_online was never granted: show the location
  // plainly rather than assert a presence nobody told us about.
  const offline = snap.online === false;
  return { kind: "line", text: offline ? `last seen ${text}` : text, offline };
}

export type LocationFreshness = {
  /** Oldest checkedAt among rows that render a line; null when none do. */
  asOf: Date | null;
  /** Ids lagging the newest reading by more than one cadence interval. */
  staleIds: number[];
};

/**
 * Oldest-wins, deliberately unlike `mapObservedAt` in the admin accounts page:
 * a failed location read leaves that character's timestamp untouched, so the
 * timestamps within one manifest diverge after any partial failure, and a
 * newest-wins label would advertise freshness that some visible rows do not
 * have. Understating freshness is the safe direction. `staleIds` then names the
 * individual laggards, so one broken token does not make every other row look
 * stale.
 */
export function locationFreshness(
  rows: Array<{ id: number; checkedAt: Date | null }>,
): LocationFreshness {
  const read = rows.filter(
    (r): r is { id: number; checkedAt: Date } => r.checkedAt !== null,
  );
  if (read.length === 0) return { asOf: null, staleIds: [] };
  const times = read.map((r) => r.checkedAt.getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (max - min <= LOCATION_CADENCE_MS) return { asOf: new Date(min), staleIds: [] };
  return {
    asOf: new Date(min),
    staleIds: read
      .filter((r) => max - r.checkedAt.getTime() > LOCATION_CADENCE_MS)
      .map((r) => r.id),
  };
}
