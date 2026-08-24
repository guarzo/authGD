import { describe, expect, it } from "vitest";
import {
  compareRosterRows,
  extractStructureEvent,
  formatStructureAlert,
  isStructureEventType,
  parseNotificationBody,
  STRUCTURE_EVENT_TYPES,
} from "@/core/structure-event";

const UNDER_ATTACK = `allianceID: 99005338
allianceName: Northern Coalition.
armorPercentage: 100.0
charID: 96068617
corpName: Ceptaerin
hullPercentage: 100.0
shieldPercentage: 94.98
solarsystemID: 30004268
structureID: &id001 1029209158734
structureShowInfoData:
- showinfo
- 35832
- *id001
structureTypeID: 35832`;

const LOST_SHIELDS = `solarsystemID: 30004268
structureID: &id001 1029209158734
structureShowInfoData:
- showinfo
- 35832
- *id001
structureTypeID: 35832
timeLeft: 892668963753
vulnerableTime: 9000000000`;

describe("STRUCTURE_EVENT_TYPES", () => {
  it("is exactly the four damage types", () => {
    expect([...STRUCTURE_EVENT_TYPES].sort()).toEqual([
      "StructureDestroyed",
      "StructureLostArmor",
      "StructureLostShields",
      "StructureUnderAttack",
    ]);
  });

  it("rejects non-damage structure notifications", () => {
    expect(isStructureEventType("StructureFuelAlert")).toBe(false);
    expect(isStructureEventType("StructureUnderAttack")).toBe(true);
  });
});

describe("parseNotificationBody", () => {
  it("strips a YAML anchor from a scalar", () => {
    expect(parseNotificationBody(UNDER_ATTACK).structureID).toBe("1029209158734");
  });

  it("skips block sequence items", () => {
    expect(parseNotificationBody(UNDER_ATTACK)).not.toHaveProperty("showinfo");
    expect(parseNotificationBody(UNDER_ATTACK).structureShowInfoData).toBeUndefined();
  });

  it("resolves an alias to its anchor's value", () => {
    const parsed = parseNotificationBody("a: &x 42\nb: *x");
    expect(parsed.b).toBe("42");
  });

  it("returns an empty object for junk rather than throwing", () => {
    expect(parseNotificationBody("!!! not yaml at all")).toEqual({});
  });
});

describe("extractStructureEvent", () => {
  it("pulls the structure id and the damage percentages", () => {
    const e = extractStructureEvent(UNDER_ATTACK);
    expect(e.structureId).toBe(1029209158734);
    expect(e.details.shieldPercentage).toBe(94.98);
    expect(e.details.corpName).toBe("Ceptaerin");
    expect(e.details.allianceName).toBe("Northern Coalition.");
  });

  it("returns a null structure id when the body will not parse", () => {
    const e = extractStructureEvent("garbage");
    expect(e.structureId).toBeNull();
    expect(e.details).toEqual({});
  });

  it("keeps timeLeft for a reinforcement notification", () => {
    expect(extractStructureEvent(LOST_SHIELDS).details.timeLeft).toBe(892668963753);
  });
});

describe("formatStructureAlert", () => {
  it("names the structure, the system and the attacker", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "Home Fortizar",
      typeName: "Fortizar",
      systemName: "Jita",
      details: { corpName: "Ceptaerin", allianceName: "Northern Coalition." },
    });
    expect(line).toContain("under attack");
    expect(line).toContain("Home Fortizar");
    expect(line).toContain("Jita");
    expect(line).toContain("Northern Coalition.");
  });

  it("falls back to the type name when the structure has no name", () => {
    const line = formatStructureAlert({
      type: "StructureDestroyed",
      structureName: null,
      typeName: "Astrahus",
      systemName: "Jita",
      details: {},
    });
    expect(line).toContain("Astrahus");
    expect(line).toContain("destroyed");
  });

  it("never exceeds the webhook clamp", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "x".repeat(5000),
      typeName: "Fortizar",
      systemName: "Jita",
      details: {},
    });
    expect(line.length).toBeLessThanOrEqual(1900);
  });
});

describe("compareRosterRows", () => {
  it("sorts reinforced above vulnerable above healthy", () => {
    const rows = [
      { state: "shield_vulnerable", name: "b" },
      { state: "online", name: "a" },
      { state: "hull_reinforce", name: "c" },
      { state: "armor_reinforce", name: "d" },
    ];
    expect([...rows].sort(compareRosterRows).map((r) => r.state)).toEqual([
      "hull_reinforce",
      "armor_reinforce",
      "shield_vulnerable",
      "online",
    ]);
  });

  it("breaks ties by name so the order is stable across runs", () => {
    const rows = [
      { state: "online", name: "zeta" },
      { state: "online", name: "alpha" },
    ];
    expect([...rows].sort(compareRosterRows).map((r) => r.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});
