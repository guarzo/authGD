import { describe, expect, it } from "vitest";
import {
  formatLocation,
  locationFreshness,
  LOCATION_CADENCE_MS,
  type LocationDisplay,
  type LocationNames,
  type LocationSnapshot,
} from "@/core/location";

const CHECKED = new Date("2026-08-06T12:00:00Z");

const snap = (over: Partial<LocationSnapshot> = {}): LocationSnapshot => ({
  systemId: 31000123,
  stationId: null,
  structureId: null,
  online: null,
  checkedAt: CHECKED,
  ...over,
});

const names = (over: Partial<LocationNames> = {}): LocationNames => ({
  system: "J123456",
  docked: null,
  ...over,
});

// Narrows the union so tests can read `.text` directly instead of asserting
// the whole object every time.
function text(display: LocationDisplay): string {
  if (display.kind !== "line") throw new Error("expected a line, got none");
  return display.text;
}

describe("formatLocation", () => {
  it("names the structure when the cache has resolved it", () => {
    expect(
      formatLocation(
        snap({ structureId: 1035466617946 }),
        names({ docked: "Home Astrahus" }),
      ),
    ).toEqual({ kind: "line", text: "J123456 — Home Astrahus", offline: false });
  });

  it("falls back to a bare Docked when the name is unavailable", () => {
    expect(formatLocation(snap({ structureId: 1035466617946 }), names())).toEqual({
      kind: "line",
      text: "J123456 — Docked",
      offline: false,
    });
  });

  it("says Docked for a station with no resolved name too", () => {
    expect(formatLocation(snap({ stationId: 60003760 }), names())).toEqual({
      kind: "line",
      text: "J123456 — Docked",
      offline: false,
    });
  });

  it("renders in space when neither station nor structure is set", () => {
    expect(formatLocation(snap(), names())).toEqual({
      kind: "line",
      text: "J123456 — in space",
      offline: false,
    });
  });

  it("flags offline without putting it in the text", () => {
    expect(
      formatLocation(
        snap({ structureId: 1035466617946, online: false }),
        names({ docked: "Home Astrahus" }),
      ),
    ).toEqual({
      kind: "line",
      text: "J123456 — Home Astrahus",
      offline: true,
    });
  });

  // An NPC station name is "<celestial> - <name>", and the celestial starts with
  // the system — so the composed line said "Jita" twice before this.
  it("keeps only the last segment of a station name", () => {
    expect(
      text(
        formatLocation(
          snap({ stationId: 60003760 }),
          names({
            system: "Jita",
            docked: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
          }),
        ),
      ),
    ).toBe("Jita — Caldari Navy Assembly Plant");
  });

  it("keeps only the last segment of a player structure name", () => {
    expect(
      text(
        formatLocation(
          snap({ structureId: 1035466617946 }),
          names({ system: "J214811", docked: "J214811 - Derelicte" }),
        ),
      ),
    ).toBe("J214811 — Derelicte");
  });

  // No separator to split on: the name survives whole.
  it("leaves an unprefixed structure name alone", () => {
    expect(
      text(
        formatLocation(
          snap({ structureId: 1035466617946 }),
          names({ system: "J214811", docked: "Derelicte" }),
        ),
      ),
    ).toBe("J214811 — Derelicte");
  });

  // Degradation is unchanged: an unresolved dock is still the bare word, and a
  // character in space still says so.
  it("does not shorten the fallback words", () => {
    expect(
      text(formatLocation(snap({ stationId: 60003760 }), names({ docked: null }))),
    ).toContain("Docked");
    expect(text(formatLocation(snap(), names({ docked: null })))).toContain("in space");
  });

  it("treats a null online exactly like online — read_online was never granted", () => {
    const withoutScope = formatLocation(snap({ online: null }), names());
    const present = formatLocation(snap({ online: true }), names());
    expect(withoutScope).toEqual(present);
    expect(withoutScope).toMatchObject({ offline: false });
  });

  it("reports never when checkedAt is null, regardless of systemId", () => {
    expect(formatLocation(snap({ checkedAt: null }), names())).toEqual({ kind: "never" });
    expect(formatLocation(snap({ checkedAt: null, systemId: null }), names())).toEqual({
      kind: "never",
    });
  });

  // Not reachable through the location job's only writer today (it sets
  // systemId and checkedAt together), but the columns are independently
  // nullable and the formatter is honest to whatever snapshot it is given.
  it("reports unresolved when a read landed with no system", () => {
    expect(formatLocation(snap({ systemId: null }), names())).toEqual({
      kind: "unresolved",
    });
  });

  it("falls back to the system id when the name cache has no system", () => {
    expect(formatLocation(snap(), names({ system: null }))).toEqual({
      kind: "line",
      text: "System 31000123 — in space",
      offline: false,
    });
  });
});

describe("locationFreshness", () => {
  const at = (offsetMs: number) => new Date(CHECKED.getTime() + offsetMs);

  it("reports the oldest reading and no laggards when all are within a cadence", () => {
    expect(
      locationFreshness([
        { id: 1, checkedAt: at(0) },
        { id: 2, checkedAt: at(LOCATION_CADENCE_MS) },
        { id: 3, checkedAt: at(60_000) },
      ]),
    ).toEqual({ asOf: at(0), staleIds: [] });
  });

  it("names only the characters lagging by more than one cadence", () => {
    const stale = at(-3 * 60 * 60 * 1000);
    expect(
      locationFreshness([
        { id: 1, checkedAt: at(0) },
        { id: 2, checkedAt: stale },
        { id: 3, checkedAt: at(-60_000) },
      ]),
    ).toEqual({ asOf: stale, staleIds: [2] });
  });

  it("ignores rows that were never read", () => {
    expect(
      locationFreshness([
        { id: 1, checkedAt: null },
        { id: 2, checkedAt: at(0) },
      ]),
    ).toEqual({ asOf: at(0), staleIds: [] });
  });

  it("returns a null asOf when no row has been read", () => {
    expect(
      locationFreshness([
        { id: 1, checkedAt: null },
        { id: 2, checkedAt: null },
      ]),
    ).toEqual({ asOf: null, staleIds: [] });
    expect(locationFreshness([])).toEqual({ asOf: null, staleIds: [] });
  });

  it("never marks a single row stale against itself", () => {
    expect(locationFreshness([{ id: 1, checkedAt: at(-86_400_000) }])).toEqual({
      asOf: at(-86_400_000),
      staleIds: [],
    });
  });
});
