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

/**
 * Three states, not two, because "no line to render" is not one fact:
 *
 * - `never`: `checkedAt` is null. Nobody has ever completed a location read for
 *   this character — a missing scope, a dead token, or a job that has not
 *   reached them yet, all indistinguishable from here.
 * - `unresolved`: `checkedAt` is set but `systemId` is not. The columns are
 *   independently nullable (src/db/schema.ts), and the location job's only
 *   writer sets all five together on success, so this combination is not
 *   reachable through it today — but a pure formatter should describe the
 *   snapshot it was actually given, not assume a specific caller's invariant.
 * - `line`: a location to print.
 *
 * All three are payload-free except `line`, and deliberately: this union
 * carries what a renderer needs, and no member carries `checkedAt`. Timestamps
 * are a manifest-level fact, computed by `locationFreshness` from the raw
 * `{ id, checkedAt }` rows rather than from these values — an `unresolved`
 * member dating its own check would be the one exception to that rule, and
 * would have no reader, since `buildManifestLocations` already holds the
 * column where it would want it.
 *
 * Collapsing `never` and `unresolved` into one `{ kind: "none" }` (the
 * previous shape) hid a real distinction from every component downstream:
 * "we have never successfully read this character" reads very differently
 * from "we read it and got nothing", even though both currently render
 * nothing. Widening this type makes the fact available; which of the two
 * renders differently, if at all, is the view's call.
 */
export type LocationDisplay =
  | { kind: "never" }
  | { kind: "unresolved" }
  | { kind: "line"; text: string; offline: boolean };

/**
 * EVE dock names already contain their system: an NPC station is
 * "<celestial> - <name>" and the celestial begins with the system name, and
 * players name structures after the hole they live in. Composing
 * "system — dock" therefore printed the system twice in every docked row, on a
 * page whose scarcest resource is line width.
 *
 * Taking the last segment keeps the system (the fact a wormhole corp navigates
 * by) and drops the celestial (which nobody reads off a roster). A structure
 * with an internal " - " loses its first segment — the accepted cost of a rule
 * with no special cases. Falls back to the whole name rather than an empty
 * string, so a name ending in the separator degrades to more detail, never to
 * nothing.
 */
function shortenDock(name: string): string {
  const parts = name.split(" - ");
  const last = parts[parts.length - 1].trim();
  return last.length > 0 ? last : name;
}

/**
 * Degrades to less detail, never to a wrong answer: an unresolved system NAME
 * falls back to its id, an unresolved dock to the bare word "Docked". A
 * character never read at all gets `{ kind: "never" }` — the re-authorize
 * control already present in that row is the remedy — and one read that
 * came back with no system id at all gets `{ kind: "unresolved" }` rather
 * than being folded into the same bucket; see `LocationDisplay`'s doc for why
 * the two are kept apart even though today's only writer never produces the
 * second.
 */
export function formatLocation(
  snap: LocationSnapshot,
  names: LocationNames,
): LocationDisplay {
  if (snap.checkedAt === null) return { kind: "never" };
  if (snap.systemId === null) return { kind: "unresolved" };
  const system = names.system ?? `System ${snap.systemId}`;
  const docked = names.docked === null ? null : shortenDock(names.docked);
  const place =
    docked ??
    (snap.stationId !== null || snap.structureId !== null ? "Docked" : "in space");
  const text = `${system} — ${place}`;
  // `online === null` means read_online was never granted: show the location
  // plainly rather than assert a presence nobody told us about.
  //
  // The word "last seen" no longer rides in `text`. It is the view's to render,
  // because the view is where the `.dim` treatment that already means "true,
  // but not now" lives — and where it can be given to screen readers without
  // spending a line's width on it.
  const offline = snap.online === false;
  return { kind: "line", text, offline };
}

export type LocationFreshness = {
  /** Oldest `checkedAt` among the rows that have one at all. Keyed on the raw
   *  column, not on what a row renders: a row can hold a real reading and still
   *  print no location line, and its check still happened. Null when no row has
   *  been read. */
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
