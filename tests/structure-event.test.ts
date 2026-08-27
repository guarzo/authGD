import { describe, expect, it } from "vitest";
import {
  buildStructureAlertEmbed,
  compareRosterRows,
  extractStructureEvent,
  formatStructureAlert,
  isStructureEventType,
  parseNotificationBody,
  STRUCTURE_EVENT_TYPES,
  type StructureAlertEmbedInput,
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

  it("does not resolve an alias to a prototype-chain member", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      const parsed = parseNotificationBody(`b: *${name}`);
      expect(parsed.b).toBeUndefined();
      expect(typeof parsed.b).not.toBe("function");
    }
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

  it("omits the redundant location clause when the structure name already names the system", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "J214811 - Derelicte",
      typeName: "Astrahus",
      systemName: "J214811",
      details: {},
    });
    expect(line).toBe("J214811 - Derelicte is under attack");
    expect(line).not.toContain(" in J214811");
  });

  it("keeps the location clause when the structure name does not name the system", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "Home Fortizar",
      typeName: "Fortizar",
      systemName: "Jita",
      details: {},
    });
    expect(line).toBe("Home Fortizar in Jita is under attack");
  });
});

describe("buildStructureAlertEmbed", () => {
  const base: StructureAlertEmbedInput = {
    type: "StructureUnderAttack",
    structureName: "Home Fortizar",
    typeName: "Fortizar",
    systemName: "Jita",
    systemId: 30000142,
    sentAt: new Date("2026-01-01T00:00:00.000Z"),
    notificationId: 555,
    details: {},
  };

  it("colors each type on the severity ramp", () => {
    expect(
      buildStructureAlertEmbed({ ...base, type: "StructureUnderAttack" }).color,
    ).toBe(0xf1c40f);
    expect(
      buildStructureAlertEmbed({ ...base, type: "StructureLostShields" }).color,
    ).toBe(0xe67e22);
    expect(buildStructureAlertEmbed({ ...base, type: "StructureLostArmor" }).color).toBe(
      0xe74c3c,
    );
    expect(buildStructureAlertEmbed({ ...base, type: "StructureDestroyed" }).color).toBe(
      0x992d22,
    );
  });

  it("includes a rounded damage field when at least one percentage is present", () => {
    const embed = buildStructureAlertEmbed({
      ...base,
      details: {
        shieldPercentage: 94.97126130184571,
        armorPercentage: 100,
        hullPercentage: 100,
      },
    });
    expect(embed.fields).toContainEqual({
      name: "Damage",
      value: "Shield 95% · Armor 100% · Hull 100%",
    });
  });

  it("omits the damage field entirely when no percentage is present", () => {
    const embed = buildStructureAlertEmbed({ ...base, details: {} });
    expect(embed.fields ?? []).not.toContainEqual(
      expect.objectContaining({ name: "Damage" }),
    );
  });

  it("computes the reinforcement timer for a real LOST_SHIELDS fixture", () => {
    // A GOLDEN value, deliberately not recomputed from the implementation's
    // formula: 2026-01-01T00:00:00Z is unix 1767225600, and timeLeft
    // 892668963753 100ns-ticks is 89266.9s (24.80h), landing on unix
    // 1767314866 — 2026-01-02T00:47:46Z. Restating the arithmetic here would
    // only prove the code agrees with itself.
    const sentAt = new Date("2026-01-01T00:00:00.000Z");
    const embed = buildStructureAlertEmbed({
      ...base,
      type: "StructureLostShields",
      sentAt,
      details: { timeLeft: 892668963753 },
    });
    expect(embed.fields).toContainEqual({
      name: "Reinforcement ends",
      value: "<t:1767314866:F> (<t:1767314866:R>)",
    });
  });

  it("omits the timer field when timeLeft implies an absurd duration", () => {
    // 100 days of ticks — far beyond any real reinforcement window.
    const absurdTicks = 100 * 24 * 60 * 60 * 1e7;
    const embed = buildStructureAlertEmbed({
      ...base,
      type: "StructureLostShields",
      details: { timeLeft: absurdTicks },
    });
    expect(embed.fields ?? []).not.toContainEqual(
      expect.objectContaining({ name: "Reinforcement ends" }),
    );
  });

  it("includes a thumbnail when structureTypeID is known", () => {
    const embed = buildStructureAlertEmbed({
      ...base,
      details: { structureTypeID: 35832 },
    });
    expect(embed.thumbnail).toEqual({
      url: "https://images.evetech.net/types/35832/render?size=1024",
    });
  });

  it("omits the thumbnail when structureTypeID is unknown", () => {
    const embed = buildStructureAlertEmbed({ ...base, details: {} });
    expect(embed.thumbnail).toBeUndefined();
  });

  // `asNumberIfNumeric` leaves a non-coercing value as a raw string, so a junk
  // notification body can put arbitrary text where a type id belongs — that
  // must never reach the url. `"-1"` and `"0"` DO coerce to numbers; they are
  // rejected by the separate positivity gate, not the numeric-ness check.
  it("omits the thumbnail when structureTypeID is not a usable positive id", () => {
    for (const junk of ["../../evil", "35832x", "NaN", "-1", "0"]) {
      const embed = buildStructureAlertEmbed({
        ...base,
        details: { structureTypeID: junk },
      });
      expect(embed.thumbnail).toBeUndefined();
    }
  });

  it("stamps the timestamp with the EVENT time, not now", () => {
    const sentAt = new Date("2020-05-01T12:00:00.000Z");
    const embed = buildStructureAlertEmbed({ ...base, sentAt });
    expect(embed.timestamp).toBe(sentAt.toISOString());
  });

  it("truncates an oversized title to 256 code points with an ellipsis", () => {
    const embed = buildStructureAlertEmbed({
      ...base,
      structureName: "x".repeat(5000),
    });
    expect(Array.from(embed.title).length).toBeLessThanOrEqual(256);
    expect(embed.title.endsWith("…")).toBe(true);
  });

  // Pure BMP characters would pass under a plain `.slice()` truncation just
  // as well as under `truncateCodePoints`, so that alone would not pin the
  // surrogate-pair-safety this helper exists for. This case puts an
  // astral-plane character (outside the BMP, encoded as a UTF-16 surrogate
  // pair) straddling the exact UTF-16-unit cut a naive `.slice(0, 255)`
  // would make: 254 BMP chars (units 0-253) followed by two astral chars
  // (units 254-255 and 256-257). A unit-based slice to 255 units would keep
  // only the first HIGH surrogate of the first astral pair — an unpaired
  // surrogate, invalid UTF-16. `truncateCodePoints` iterates by code point
  // (`Array.from`), so it keeps that whole astral character intact instead.
  it("never splits an astral-plane character's surrogate pair when truncating", () => {
    const astral = "𝕏"; // U+1D54F, a surrogate pair in UTF-16
    const structureName = `${"x".repeat(254)}${astral}${astral}`;
    const embed = buildStructureAlertEmbed({ ...base, structureName, systemName: null });
    // A lone high surrogate (what a naive UTF-16 `.slice` would produce here)
    // is a code unit in 0xD800-0xDBFF with no matching low surrogate
    // immediately after it.
    for (let i = 0; i < embed.title.length; i++) {
      const code = embed.title.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = embed.title.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
    expect(embed.title).toContain(astral);
    expect(embed.title.endsWith("…")).toBe(true);
  });

  it("shares its title sentence with formatStructureAlert's line", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "Home Fortizar",
      typeName: "Fortizar",
      systemName: "Jita",
      details: {},
    });
    const embed = buildStructureAlertEmbed({ ...base, details: {} });
    expect(line).toBe(embed.title);
  });

  it("omits description when there is no attacker, includes it when there is", () => {
    expect(
      buildStructureAlertEmbed({ ...base, details: {} }).description,
    ).toBeUndefined();
    const embed = buildStructureAlertEmbed({
      ...base,
      details: { allianceName: "Northern Coalition." },
    });
    expect(embed.description).toContain("Northern Coalition.");
  });

  it("omits url when the system id is unknown", () => {
    const embed = buildStructureAlertEmbed({ ...base, systemId: null });
    expect(embed.url).toBeUndefined();
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
