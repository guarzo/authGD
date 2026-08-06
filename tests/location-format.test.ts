import { describe, expect, it } from "vitest";
import {
  formatLocation,
  locationFreshness,
  LOCATION_CADENCE_MS,
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

  it("prefixes last seen and flags offline when online is false", () => {
    expect(
      formatLocation(
        snap({ structureId: 1035466617946, online: false }),
        names({ docked: "Home Astrahus" }),
      ),
    ).toEqual({
      kind: "line",
      text: "last seen J123456 — Home Astrahus",
      offline: true,
    });
  });

  it("treats a null online exactly like online — read_online was never granted", () => {
    const withoutScope = formatLocation(snap({ online: null }), names());
    const present = formatLocation(snap({ online: true }), names());
    expect(withoutScope).toEqual(present);
    expect(withoutScope).toMatchObject({ offline: false });
  });

  it("renders nothing when the location was never read", () => {
    expect(formatLocation(snap({ checkedAt: null }), names())).toEqual({ kind: "none" });
    expect(formatLocation(snap({ systemId: null }), names())).toEqual({ kind: "none" });
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
