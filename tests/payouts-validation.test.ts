import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NEW_OPERATION_ERRORS, OPERATION_ERRORS } from "@/app/payouts/errors";
import {
  battleReportUrlFieldSchema,
  battleReportUrlProblem,
  buildCreateOperationSchema,
  corpSharePctFieldSchema,
  flatPoolFieldSchema,
  nameFieldSchema,
  occurredAtFieldSchema,
  parseYmd,
  participantNameFieldSchema,
  readValidationCode,
  sharesFieldSchema,
  unitPriceFieldSchema,
} from "@/app/payouts/validation";

// `todayUtc` fixed at a known instant so `date_future` is deterministic
// against it, rather than against whatever day the suite happens to run on.
const TODAY_UTC = new Date("2026-08-10T00:00:00.000Z");

describe("readValidationCode", () => {
  it("reads the first issue's message as the code when it is mapped", () => {
    const result = nameFieldSchema.safeParse("");
    if (result.success) throw new Error("expected rejection");
    expect(readValidationCode(result.error, NEW_OPERATION_ERRORS)).toBe("name_required");
  });

  it("throws on a code the destination page's map has no entry for", () => {
    // A schema that carries a code outside the target map at all — the
    // situation this reader exists to catch loudly rather than render nothing.
    const rogue = z.string().refine(() => false, { error: "not_a_real_code" });
    const result = rogue.safeParse("x");
    if (result.success) throw new Error("expected rejection");
    expect(() => readValidationCode(result.error, NEW_OPERATION_ERRORS)).toThrow(
      /unmapped code/,
    );
  });
});

describe("parseYmd / battleReportUrlProblem (still the single definitions, only reached via schemas below)", () => {
  it("parseYmd rejects a rollover date rather than normalizing it", () => {
    expect(parseYmd("2026-02-30")).toBeNull();
  });

  it("battleReportUrlProblem accepts a plain https link", () => {
    expect(battleReportUrlProblem("https://zkillboard.com/kill/1/")).toBeNull();
  });
});

describe("nameFieldSchema", () => {
  it("rejects an empty name with name_required", () => {
    const result = nameFieldSchema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("name_required");
  });

  it("accepts a non-empty name", () => {
    const result = nameFieldSchema.safeParse("Operation Foo");
    expect(result).toEqual({ success: true, data: "Operation Foo" });
  });
});

describe("occurredAtFieldSchema", () => {
  it("rejects a malformed date with date_invalid", () => {
    const result = occurredAtFieldSchema.safeParse("not-a-date");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("date_invalid");
  });

  it("rejects a rollover date (Feb 30) with date_invalid, not a normalized date", () => {
    const result = occurredAtFieldSchema.safeParse("2026-02-30");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("date_invalid");
  });

  it("parses a real calendar date to a Date with no future check on its own", () => {
    // This bare schema is what setOccurredAtAction uses directly — the
    // detail page's date editor has no future check, a pre-existing,
    // out-of-scope gap (see setOccurredAtAction's own comment) — so a date far
    // in the future must still parse successfully here.
    const result = occurredAtFieldSchema.safeParse("2099-01-01");
    expect(result.success).toBe(true);
  });
});

describe("buildCreateOperationSchema — date_invalid and date_future stay separately reachable", () => {
  it("rejects a malformed date with date_invalid", () => {
    const result = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "Op",
      occurredAt: "not-a-date",
      battleReportUrl: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(readValidationCode(result.error, NEW_OPERATION_ERRORS)).toBe("date_invalid");
    }
  });

  it("rejects a real, well-formed date in the future with date_future, not date_invalid", () => {
    const result = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "Op",
      occurredAt: "2026-08-11",
      battleReportUrl: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(readValidationCode(result.error, NEW_OPERATION_ERRORS)).toBe("date_future");
    }
  });

  it("accepts today's own date (the boundary itself is not future)", () => {
    const result = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "Op",
      occurredAt: "2026-08-10",
      battleReportUrl: "",
    });
    expect(result.success).toBe(true);
  });

  it("keeps declaration order: a blank name with a bad URL still lands on name_required", () => {
    const result = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "",
      occurredAt: "2026-08-01",
      battleReportUrl: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(readValidationCode(result.error, NEW_OPERATION_ERRORS)).toBe(
        "name_required",
      );
    }
  });

  it("battleReportUrl: an unparseable value is url_invalid, a bad scheme is url_scheme", () => {
    const invalid = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "Op",
      occurredAt: "2026-08-01",
      battleReportUrl: "zkillboard.com/related/1",
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(readValidationCode(invalid.error, NEW_OPERATION_ERRORS)).toBe("url_invalid");
    }

    const scheme = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "Op",
      occurredAt: "2026-08-01",
      battleReportUrl: "javascript:alert(1)",
    });
    expect(scheme.success).toBe(false);
    if (!scheme.success) {
      expect(readValidationCode(scheme.error, NEW_OPERATION_ERRORS)).toBe("url_scheme");
    }
  });

  it("an empty battle report URL is optional and does not reject", () => {
    const result = buildCreateOperationSchema(TODAY_UTC).safeParse({
      name: "Op",
      occurredAt: "2026-08-01",
      battleReportUrl: "",
    });
    expect(result.success).toBe(true);
  });
});

describe("battleReportUrlFieldSchema", () => {
  it("accepts an empty string as 'nothing submitted'", () => {
    const result = battleReportUrlFieldSchema.safeParse("");
    expect(result).toEqual({ success: true, data: null });
  });

  it("rejects a bare hostname with url_invalid", () => {
    const result = battleReportUrlFieldSchema.safeParse("zkillboard.com");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("url_invalid");
  });

  it("rejects a non-http(s) scheme with url_scheme", () => {
    const result = battleReportUrlFieldSchema.safeParse("javascript:alert(1)");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("url_scheme");
  });
});

describe("flatPoolFieldSchema — note_required before total_invalid", () => {
  it("rejects a blank note first even when totalValue is also bad", () => {
    const result = flatPoolFieldSchema.safeParse({ notes: "", totalValue: "abc" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(readValidationCode(result.error, OPERATION_ERRORS)).toBe("note_required");
    }
  });

  it("rejects a malformed total once the note is present", () => {
    const result = flatPoolFieldSchema.safeParse({
      notes: "from loot log",
      totalValue: "abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(readValidationCode(result.error, OPERATION_ERRORS)).toBe("total_invalid");
    }
  });

  it("accepts a plain two-decimal total", () => {
    const result = flatPoolFieldSchema.safeParse({
      notes: "note",
      totalValue: "12345.67",
    });
    expect(result).toEqual({
      success: true,
      data: { notes: "note", totalValue: "12345.67" },
    });
  });
});

describe("unitPriceFieldSchema", () => {
  it("rejects more than two decimal places with price_invalid", () => {
    const result = unitPriceFieldSchema.safeParse("1.234");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("price_invalid");
  });

  it("accepts a plain two-decimal price", () => {
    expect(unitPriceFieldSchema.safeParse("12.34")).toEqual({
      success: true,
      data: "12.34",
    });
  });
});

describe("participantNameFieldSchema", () => {
  it("rejects a blank name with participant_name_required", () => {
    const result = participantNameFieldSchema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("participant_name_required");
    }
  });
});

describe("sharesFieldSchema — order: shares_required, shares_invalid, shares_positive, shares_range", () => {
  it("rejects a blank value with shares_required", () => {
    const result = sharesFieldSchema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("shares_required");
  });

  it("rejects a non-numeric value with shares_invalid, never calling iskToCents", () => {
    // iskToCents throws on anything its own regex rejects; if the transform
    // ran anyway on "abc" this would throw an uncaught error instead of
    // producing a clean zod rejection.
    const result = sharesFieldSchema.safeParse("abc");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("shares_invalid");
  });

  it("rejects zero with shares_positive", () => {
    const result = sharesFieldSchema.safeParse("0");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("shares_positive");
  });

  it("rejects a negative value with shares_positive", () => {
    const result = sharesFieldSchema.safeParse("-5");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("shares_positive");
  });

  it("rejects a value past the max with shares_range", () => {
    const result = sharesFieldSchema.safeParse("10000");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("shares_range");
  });

  it("accepts an ordinary positive value within range", () => {
    expect(sharesFieldSchema.safeParse("1.5")).toEqual({ success: true, data: "1.5" });
  });
});

describe("corpSharePctFieldSchema — share_format before share_range", () => {
  it("rejects a malformed percentage with share_format", () => {
    const result = corpSharePctFieldSchema.safeParse("12,5");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("share_format");
  });

  it("rejects a well-formed percentage over 100 with share_range", () => {
    const result = corpSharePctFieldSchema.safeParse("120");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe("share_range");
  });

  it("accepts a plain in-range percentage", () => {
    expect(corpSharePctFieldSchema.safeParse("12.5")).toEqual({
      success: true,
      data: "12.5",
    });
  });
});

describe("every code emitted by these schemas is mapped in the destination page's own error map", () => {
  it("NEW_OPERATION_ERRORS covers every code buildCreateOperationSchema can emit", () => {
    const codes = [
      "name_required",
      "date_invalid",
      "date_future",
      "url_invalid",
      "url_scheme",
    ];
    for (const code of codes) {
      expect(Object.hasOwn(NEW_OPERATION_ERRORS, code)).toBe(true);
    }
  });

  it("OPERATION_ERRORS covers every code the field schemas can emit", () => {
    const codes = [
      "name_required",
      "date_invalid",
      "url_invalid",
      "url_scheme",
      "note_required",
      "total_invalid",
      "price_invalid",
      "participant_name_required",
      "shares_required",
      "shares_invalid",
      "shares_positive",
      "shares_range",
      "share_format",
      "share_range",
    ];
    for (const code of codes) {
      expect(Object.hasOwn(OPERATION_ERRORS, code)).toBe(true);
    }
  });
});
