import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import {
  API_VERSION,
  SIGNING_SCHEME_VERSION,
  FLEET_V2_BYTE_LIMITS,
  FLEET_V2_ERROR_BYTES,
  FLEET_V2_STATUS_BY_CODE,
  FleetV2ErrorSchema,
  ExistingUuidSchema,
  UuidV4Schema,
  TokenSchema,
  IsoDateSchema,
  Int4Schema,
  PositiveInt4Schema,
  SourceExpectedGenerationSchema,
  SafeCounterSchema,
  PositiveIdSchema,
  CapabilitiesSchema,
  CharacterNameSchema,
  CatalogueRevisionSchema,
  CatalogueSchema,
  CatalogueGetSchema,
  PairingCompletedSchema,
  CombatPutSchema,
  CombatGetSchema,
  CombatPutSuccessSchema,
  DeviceAckSchema,
  ControlDeviceSchema,
  checkedCounterAdd,
  checkedDateAdd,
  type CombatPut,
  type CombatGet,
  type Catalogue,
} from "@/core/fleet-api-v2";
import {
  classifyFleetV2Version,
  parseBoundedFleetV2Json,
  readFleetV2Json,
  hasEmptyFleetV2GetFraming,
  fleetV2RequestBinding,
  extractFleetV2Attempt,
  fleetV2PreSessionBinding,
  serializeFleetV2Json,
} from "@/lib/fleet-api-v2";
import { canonicalFleetRequest, verifyFleetRequest } from "@/lib/fleet-signature";

const bytes = (value: string) => new TextEncoder().encode(value);
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const uuid = (id: number) =>
  `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
const token = Buffer.alloc(32, 255).toString("base64url");
const safeMax = 9_007_199_254_740_991;

function put(): CombatPut {
  return {
    protocol: 2,
    sampled_at_ms: 100_000,
    rows: [
      {
        character_id: 1,
        outgoing_dps: null,
        incoming_dps: 0,
        activity_age_ms: 5000,
        effects: [
          {
            kind: "SCRAM",
            observations: [
              { name: "é", age_ms: 6000 },
              { name: null, age_ms: 7000 },
            ],
          },
          { kind: "POINT", observations: [{ name: "é", age_ms: 5000 }] },
          { kind: "NEUT", observations: [{ name: null, age_ms: 8000 }] },
        ],
      },
    ],
  };
}

function get(): CombatGet {
  return {
    protocol: 2,
    server_time_ms: 100_000,
    rows: [
      {
        ...put().rows[0],
        character_name: " Pilot <tag> e\u0301 ",
        state: "live",
        age_ms: 2999,
        publication_id: uuid(1),
      },
    ],
  };
}

function maximumPut(): CombatPut {
  return {
    protocol: 2,
    sampled_at_ms: safeMax,
    rows: Array.from({ length: 32 }, (_, index) => ({
      character_id: safeMax - index,
      outgoing_dps: 10_000_000,
      incoming_dps: 10_000_000,
      activity_age_ms: 29_999,
      effects: ["SCRAM", "POINT", "NEUT"].map((kind) => ({
        kind: kind as "SCRAM" | "POINT" | "NEUT",
        observations: [
          ...(kind === "NEUT"
            ? []
            : Array.from({ length: 8 }, (_, i) => ({
                name: String.fromCodePoint(0x20000 + i).repeat(64),
                age_ms: 29_999,
              }))),
          { name: null, age_ms: 29_999 },
        ],
      })),
    })),
  };
}

describe("complete DTO boundary rejects prototype keys without rewriting names", () => {
  it.each(['{"protocol":2,"__proto__":null}', '{"protocol":2,"\\u005f_proto__":{}}'])(
    "rejects a single own key in %s before output serialization",
    (text) => {
      expect(
        serializeFleetV2Json(JSON.parse(text), CombatPutSuccessSchema, 1024),
      ).toEqual({
        ok: false,
        code: "service_unavailable",
      });
    },
  );
  it("rejects nested own keys in otherwise valid combat DTOs", () => {
    const value = put();
    Object.defineProperty(value.rows[0].effects[0].observations[0], "__proto__", {
      value: null,
      enumerable: true,
    });
    expect(serializeFleetV2Json(value, CombatPutSchema, 524288)).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });
  it("retains __proto__ observed string values and shared DTO references", () => {
    const value = put();
    value.rows[0].effects[0].observations[0].name = "__proto__";
    const shared = { text: "__proto__" };
    const schema = z
      .object({
        a: z.object({ text: z.string() }).strict(),
        b: z.object({ text: z.string() }).strict(),
      })
      .strict();
    expect(serializeFleetV2Json({ a: shared, b: shared }, schema, 1024)).toEqual({
      ok: true,
      json: '{"a":{"text":"__proto__"},"b":{"text":"__proto__"}}',
    });
    const output = serializeFleetV2Json(value, CombatPutSchema, 524288);
    expect(output.ok).toBe(true);
    if (output.ok)
      expect(JSON.parse(output.json).rows[0].effects[0].observations[0].name).toBe(
        "__proto__",
      );
  });
  it("walks deeply shared structured input once per node, preserving aliases", () => {
    let value: unknown = { name: "__proto__" };
    for (let i = 0; i < 20000; i++) value = { a: value, b: value };
    const result = safeParseFleetV2Dto(z.unknown(), value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(value);
  });
  it("rejects a prototype key hidden on a shared descendant, including non-enumerable keys", () => {
    const child = {};
    Object.defineProperty(child, "__proto__", { value: null });
    expect(safeParseFleetV2Dto(z.unknown(), { a: child, b: child }).success).toBe(false);
  });
  it("refuses cyclic structured input rather than throwing or traversing forever", () => {
    const value: { next?: unknown } = {};
    value.next = value;
    expect(serializeFleetV2Json(value, z.unknown(), 1024)).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });
});

const device = () => ({
  protocol: 2,
  device_id: "ABCDEFAB-1234-1234-8123-ABCDEFABCDEF",
  session_expires_at: "2026-08-13T00:00:00.000Z",
  feature_enabled: true,
  approved_capabilities: ["shared-source-v1", "combat-v2"],
  session_approved_capabilities: ["shared-source-v1"],
  acknowledged_capabilities: [],
  participation: { enabled: false, generation: 2_147_483_647 },
  server_time_ms: 100_000,
});

const operationLimits = [
  ["snapshotPut", 524288, 1048576],
  ["snapshotGet", 0, 67108864],
  ["automaticGet", 0, 16384],
  ["automaticPut", 2048, 16384],
  ["receiptGet", 0, 16384],
  ["sourcesGet", 0, 1048576],
  ["sourcesPut", 2048, 1048576],
  ["preSessionPost", 2048, 65536],
  ["deviceGet", 0, 1048576],
  ["devicePut", 1024, 1048576],
  ["catalogueGet", 0, 1048576],
  ["sessionPut", 1024, 1048576],
  ["participationPut", 1024, 1048576],
  ["eligibilityGet", 0, 1048576],
] as const;

describe("v2 operation byte budgets", () => {
  it.each(operationLimits)(
    "bounds actual bytes for %s",
    (operation, requestBytes, successBytes) => {
      const limit = FLEET_V2_BYTE_LIMITS[operation];
      if (requestBytes > 0) {
        const raw = bytes(`{"protocol":2}${" ".repeat(requestBytes - 14)}`);
        expect(raw.byteLength).toBe(requestBytes);
        expect(parseBoundedFleetV2Json(raw, limit.requestBytes).ok).toBe(true);
        expect(
          parseBoundedFleetV2Json(
            bytes(`${new TextDecoder().decode(raw)} `),
            limit.requestBytes,
          ),
        ).toEqual({ ok: false, code: "bad_request" });
      } else {
        expect(parseBoundedFleetV2Json(bytes("{}"), limit.requestBytes).ok).toBe(false);
      }
      // A generic closed shape isolates the serializer's operation budget from
      // each operation's independent cardinality limits.
      const schema = z.object({ text: z.string() }).strict();
      const value = { text: "x".repeat(successBytes - 11) };
      const exact = serializeFleetV2Json(value, schema, limit.successBytes);
      expect(exact.ok).toBe(true);
      if (exact.ok) expect(Buffer.byteLength(exact.json)).toBe(successBytes);
      expect(
        serializeFleetV2Json({ text: `${value.text}x` }, schema, limit.successBytes),
      ).toEqual({ ok: false, code: "service_unavailable" });
    },
    30000,
  );

  it("counts UTF-8 bytes rather than UTF-16 units in compact output", () => {
    const schema = z.object({ text: z.string() }).strict();
    expect(serializeFleetV2Json({ text: "é" }, schema, 13)).toEqual({
      ok: true,
      json: '{"text":"é"}',
    });
    expect(serializeFleetV2Json({ text: "é" }, schema, 12)).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });

  it("bounds error output separately from success and refuses malformed output", () => {
    expect(FLEET_V2_ERROR_BYTES).toBe(65536);
    expect(serializeFleetV2Json({ protocol: 2 }, CombatPutSuccessSchema, 14)).toEqual({
      ok: true,
      json: '{"protocol":2}',
    });
    expect(serializeFleetV2Json({ protocol: 2 }, CombatPutSuccessSchema, 13)).toEqual({
      ok: false,
      code: "service_unavailable",
    });
    expect(
      serializeFleetV2Json({ protocol: 2, extra: null }, CombatPutSuccessSchema, 100).ok,
    ).toBe(false);
    expect(
      serializeFleetV2Json({ ...put(), sampled_at_ms: Infinity }, CombatPutSchema, 524288)
        .ok,
    ).toBe(false);
    const value = { text: 'é<>\\"' };
    expect(
      serializeFleetV2Json(value, z.object({ text: z.string() }).strict(), 100),
    ).toEqual({ ok: true, json: JSON.stringify(value) });
  });
});

describe("closed v2 wire primitives", () => {
  it.each([
    ["bad_headers", 400],
    ["bad_request", 400],
    ["update_required", 400],
    ["invalid_intent", 400],
    ["invalid_key", 400],
    ["unauthorized", 401],
    ["forbidden", 403],
    ["capability_required", 403],
    ["fleet_read_required", 403],
    ["not_verified", 403],
    ["receipt_not_found", 404],
    ["not_found", 404],
    ["method_not_allowed", 405],
    ["conflict", 409],
    ["request_id_conflict", 409],
    ["revision_replayed", 409],
    ["not_completable", 409],
    ["rate_limited", 429],
    ["receipt_capacity", 429],
    ["feature_disabled", 503],
    ["service_unavailable", 503],
  ] as const)("maps the closed %s error", (error, status) => {
    expect(FleetV2ErrorSchema.safeParse({ protocol: 2, error }).success).toBe(true);
    expect(FLEET_V2_STATUS_BY_CODE[error]).toBe(status);
  });

  it.each([
    { protocol: 2, error: "provider_error" },
    { protocol: 1, error: "unauthorized" },
    { protocol: 2, error: "forbidden", reason: "secret" },
  ])("refuses an unknown/extended error %j", (value) => {
    expect(FleetV2ErrorSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a final newline rather than accepting a UUID prefix", () => {
    expect(ExistingUuidSchema.safeParse(`${uuid(1)}\n`).success).toBe(false);
    expect(UuidV4Schema.safeParse(`${uuid(1)}\n`).success).toBe(false);
  });

  it("preserves existing UUID spellings but requires new UUIDv4 lowercase", () => {
    for (const value of [
      device().device_id,
      "00000000-0000-0000-0000-000000000000",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "abcdefab-1234-8234-8123-abcdefabcdef",
    ]) {
      expect(ExistingUuidSchema.parse(value)).toBe(value);
      expect(UuidV4Schema.safeParse(value).success).toBe(false);
    }
    expect(UuidV4Schema.parse(uuid(15))).toBe(uuid(15));
    expect(UuidV4Schema.safeParse(uuid(15).toUpperCase()).success).toBe(false);
    expect(
      ExistingUuidSchema.safeParse("abcdefab-1234-9234-8123-abcdefabcdef").success,
    ).toBe(false);
  });

  it.each([
    `${token}=`,
    `${token} `,
    `${token}\n`,
    token.slice(1),
    `${token.slice(0, -1)}9`,
    "+".repeat(43),
    null,
    32,
  ])("refuses noncanonical tokens %s", (value) => {
    expect(TokenSchema.safeParse(value).success).toBe(false);
  });

  it("accepts exactly canonical 32-byte tokens", () => {
    expect(TokenSchema.parse(token)).toBe(token);
    expect(TokenSchema.parse(Buffer.alloc(32).toString("base64url"))).toBe(
      "A".repeat(43),
    );
  });

  it.each([
    "2025-02-29T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-08-13T24:00:00.000Z",
    "2026-08-13T00:00:00Z",
    "2026-08-13T00:00:00.000+00:00",
    "+010000-01-01T00:00:00.000Z",
    "bad",
    null,
  ])("rejects invalid/noncanonical UTC dates %s", (value) => {
    expect(IsoDateSchema.safeParse(value).success).toBe(false);
  });

  describe("authority date year bounds", () => {
    it("rejects year zero even when it round-trips through Date", () => {
      const value = "0000-01-01T00:00:00.000Z";
      expect(new Date(value).toISOString()).toBe(value);
      expect(IsoDateSchema.safeParse(value).success).toBe(false);
      expect(checkedDateAdd(value, 0)).toBeNull();
    });

    it("refuses additions crossing below year 0001", () => {
      expect(checkedDateAdd("0001-01-01T00:00:00.000Z", -1)).toBeNull();
    });

    it("refuses additions crossing above year 9999", () => {
      expect(checkedDateAdd("9999-12-31T23:59:59.999Z", 1)).toBeNull();
    });

    it.each([
      ["0001-01-01T00:00:00.000Z", 0, "0001-01-01T00:00:00.000Z"],
      ["9999-12-31T23:59:59.999Z", 0, "9999-12-31T23:59:59.999Z"],
      ["0001-01-01T00:00:00.000Z", 1, "0001-01-01T00:00:00.001Z"],
      ["0001-01-01T00:00:00.001Z", -1, "0001-01-01T00:00:00.000Z"],
      ["9999-12-31T23:59:59.999Z", -1, "9999-12-31T23:59:59.998Z"],
      ["9999-12-31T23:59:59.998Z", 1, "9999-12-31T23:59:59.999Z"],
    ] as const)(
      "preserves representable endpoint addition %s + %i",
      (value, delta, expected) => {
        expect(IsoDateSchema.parse(value)).toBe(value);
        expect(checkedDateAdd(value, delta)).toBe(expected);
      },
    );
  });

  it("checks date and counter additions without clamping or wrapping", () => {
    expect(IsoDateSchema.parse("2024-02-29T00:00:00.000Z")).toBe(
      "2024-02-29T00:00:00.000Z",
    );
    expect(checkedDateAdd("2024-02-28T23:59:59.999Z", 1)).toBe(
      "2024-02-29T00:00:00.000Z",
    );
    expect(checkedDateAdd("9999-12-31T23:59:59.999Z", 1)).toBeNull();
    expect(checkedDateAdd("bad", 1)).toBeNull();
    expect(checkedDateAdd(device().session_expires_at, 0.5)).toBeNull();
    expect(checkedDateAdd(device().session_expires_at, Infinity)).toBeNull();
    expect(checkedCounterAdd(safeMax - 1, 1)).toBe(safeMax);
    expect(checkedCounterAdd(safeMax, 1)).toBeNull();
    expect(checkedCounterAdd(2_147_483_646, 1, 2_147_483_647)).toBe(2_147_483_647);
    expect(checkedCounterAdd(2_147_483_647, 1, 2_147_483_647)).toBeNull();
    for (const value of [-1, 0.5, Infinity, NaN, safeMax + 1]) {
      expect(checkedCounterAdd(value, 1)).toBeNull();
      expect(checkedCounterAdd(0, value)).toBeNull();
    }
  });

  it.each([true, false, "1", 0.1, -1, NaN, Infinity, safeMax + 1])(
    "rejects non-safe counters %s",
    (value) => {
      expect(SafeCounterSchema.safeParse(value).success).toBe(false);
      expect(PositiveIdSchema.safeParse(value).success).toBe(false);
    },
  );

  it("keeps int4, expected-source, and safe consent counters distinct", () => {
    expect(SafeCounterSchema.parse(safeMax)).toBe(safeMax);
    expect(PositiveIdSchema.parse(safeMax)).toBe(safeMax);
    expect(PositiveIdSchema.safeParse(0).success).toBe(false);
    expect(Int4Schema.parse(2_147_483_647)).toBe(2_147_483_647);
    expect(Int4Schema.parse(0)).toBe(0);
    expect(Int4Schema.safeParse(2_147_483_648).success).toBe(false);
    expect(PositiveInt4Schema.safeParse(0).success).toBe(false);
    expect(PositiveInt4Schema.parse(1)).toBe(1);
    expect(SourceExpectedGenerationSchema.parse(2_147_483_646)).toBe(2_147_483_646);
    expect(SourceExpectedGenerationSchema.safeParse(2_147_483_647).success).toBe(false);
  });

  it.each(
    [[], ["shared-source-v1"], ["shared-source-v1", "combat-v2"]].map((value) => [value]),
  )("accepts canonical rights %j unchanged", (value) => {
    expect(CapabilitiesSchema.parse(value)).toEqual(value);
    expect(DeviceAckSchema.parse({ protocol: 2, capabilities: value })).toEqual({
      protocol: 2,
      capabilities: value,
    });
  });

  it.each(
    [
      ["combat-v2"],
      ["combat-v2", "shared-source-v1"],
      ["shared-source-v1", "shared-source-v1"],
      ["shared-source-v1", "combat-v2", "combat-v2"],
      ["automatic"],
      null,
    ].map((value) => [value]),
  )("rejects noncanonical rights %j", (value) => {
    expect(CapabilitiesSchema.safeParse(value).success).toBe(false);
    expect(DeviceAckSchema.safeParse({ protocol: 2, capabilities: value }).success).toBe(
      false,
    );
  });

  it("validates each complete device array without substituting device approval", () => {
    expect(ControlDeviceSchema.parse(device())).toEqual(device());
    for (const key of Object.keys(device())) {
      const value = { ...device() } as Record<string, unknown>;
      delete value[key];
      expect(ControlDeviceSchema.safeParse(value).success, key).toBe(false);
    }
    expect(
      ControlDeviceSchema.safeParse({
        ...device(),
        participation: { enabled: false, generation: 0, extra: true },
      }).success,
    ).toBe(false);
    expect(
      ControlDeviceSchema.safeParse({ ...device(), server_time_ms: true }).success,
    ).toBe(false);
    expect(
      DeviceAckSchema.safeParse({ protocol: 2, capabilities: [], extra: null }).success,
    ).toBe(false);
  });

  it.each([
    "",
    "x".repeat(201),
    "\u{20000}".repeat(201),
    "a\n",
    "\u200d",
    "\ue000",
    "\u0378",
    "\u2028",
    "\u2029",
    "\ud800",
  ])("rejects forbidden character display names %s", (name) => {
    expect(CharacterNameSchema.safeParse(name).success).toBe(false);
    const value = get();
    value.rows[0].character_name = name;
    expect(CombatGetSchema.safeParse(value).success).toBe(false);
  });

  it.each([" <Pilot> e\u0301 ", "\u{20000}".repeat(200), "\u{1c89}", "\u{1cc00}"])(
    "retains identity spelling and Unicode-16 assigned characters %s",
    (name) => {
      expect(CharacterNameSchema.parse(name)).toBe(name);
      const value = get();
      value.rows[0].character_name = name;
      expect(CombatGetSchema.safeParse(value).success).toBe(true);
    },
  );
});

describe("closed catalogue envelopes", () => {
  const catalogue = (): Catalogue => ({
    revision: 0,
    characters: [{ character_id: 1, character_name: "Alpha" }],
  });

  describe.each(["nested", "standalone", "pairing"] as const)("%s catalogue", (form) => {
    const schema =
      form === "nested"
        ? CatalogueSchema
        : form === "standalone"
          ? CatalogueGetSchema
          : PairingCompletedSchema;
    const wrap = (value: Catalogue) =>
      form === "nested"
        ? value
        : form === "standalone"
          ? { protocol: 2, ...value }
          : { protocol: 2, session_id: token, catalogue: value };

    it.each([
      0, 2_147_483_647, 2_147_483_648, 3_112_514_310, 3_820_012_610, 4_294_967_295,
    ])("accepts unsigned catalogue revision %i unchanged", (revision) => {
      const value = wrap({ ...catalogue(), revision });
      expect(CatalogueRevisionSchema.parse(revision)).toBe(revision);
      expect(schema.parse(value)).toEqual(value);
    });

    it.each([4_294_967_296, -1, 0.5, true, false, "1", null, NaN, Infinity])(
      "refuses non-uint32 catalogue revision %s",
      (revision) => {
        const value = catalogue();
        Object.assign(value, { revision });
        expect(CatalogueRevisionSchema.safeParse(revision).success).toBe(false);
        expect(schema.safeParse(wrap(value)).success).toBe(false);
      },
    );

    it("requires every key and refuses extras at every level", () => {
      const nested = catalogue();
      const value = wrap(nested);
      const targets = [
        value,
        ...(form === "pairing" ? [nested] : []),
        nested.characters[0],
      ];
      for (const target of targets) {
        const record = target as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          const previous = record[key];
          delete record[key];
          expect(schema.safeParse(value).success, key).toBe(false);
          record[key] = previous;
        }
        record.extra = null;
        expect(schema.safeParse(value).success).toBe(false);
        delete record.extra;
      }
      if (form !== "nested") {
        Object.assign(value, { protocol: 1 });
        expect(schema.safeParse(value).success).toBe(false);
      }
    });

    it("accepts empty and 8192 unique characters without imposing sort order", () => {
      expect(schema.parse(wrap({ revision: 0, characters: [] }))).toEqual(
        wrap({ revision: 0, characters: [] }),
      );
      const value = catalogue();
      value.characters = Array.from({ length: 8192 }, (_, i) => ({
        character_id: safeMax - i,
        character_name: " <Pilot> e\u0301 \u{1c89}\u{1cc00}",
      }));
      expect(schema.parse(wrap(value))).toEqual(wrap(value));
      value.characters.push({ character_id: 1, character_name: "Overflow" });
      expect(schema.safeParse(wrap(value)).success).toBe(false);
    });

    it("refuses duplicate IDs even with different valid names", () => {
      const value = catalogue();
      value.characters.push({ character_id: 1, character_name: "Different" });
      expect(schema.safeParse(wrap(value)).success).toBe(false);
    });

    it.each([0, -1, 0.5, true, "1", safeMax + 1])("refuses invalid ID %s", (id) => {
      const value = catalogue();
      Object.assign(value.characters[0], { character_id: id });
      expect(schema.safeParse(wrap(value)).success).toBe(false);
    });

    it.each([
      "",
      "x".repeat(201),
      "\u{20000}".repeat(201),
      "a\n",
      "\u200d",
      "\ue000",
      "\u0378",
      "\u2028",
      "\u2029",
      "\ud800",
      null,
    ])("refuses invalid character name %s", (name) => {
      const value = catalogue();
      Object.assign(value.characters[0], { character_name: name });
      expect(schema.safeParse(wrap(value)).success).toBe(false);
    });

    it("accepts 200 supplementary scalars without trim, NFC or markup rewriting", () => {
      const value = catalogue();
      value.characters[0].character_name = "\u{20000}".repeat(200);
      expect(schema.parse(wrap(value))).toEqual(wrap(value));
    });
  });

  it.each([`${token}=`, `${token.slice(0, -1)}9`, null, 32])(
    "refuses invalid pairing session token %s",
    (session_id) => {
      expect(
        PairingCompletedSchema.safeParse({
          protocol: 2,
          session_id,
          catalogue: catalogue(),
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["standalone", 1_048_576, 8192],
    ["pairing", 65_536, 400],
  ] as const)(
    "bounds the complete %s DTO at exactly %i UTF-8 bytes",
    (form, maximum, count) => {
      const nested = catalogue();
      nested.characters = Array.from({ length: count }, (_, i) => ({
        character_id: i + 1,
        character_name: "x",
      }));
      const value =
        form === "standalone"
          ? { protocol: 2, ...nested }
          : { protocol: 2, session_id: token, catalogue: nested };
      const schema: z.ZodType =
        form === "standalone" ? CatalogueGetSchema : PairingCompletedSchema;
      const budget =
        form === "standalone"
          ? FLEET_V2_BYTE_LIMITS.catalogueGet.successBytes
          : FLEET_V2_BYTE_LIMITS.preSessionPost.successBytes;
      let remaining = maximum - Buffer.byteLength(JSON.stringify(value));
      for (const character of nested.characters) {
        const extra = Math.min(199, remaining);
        character.character_name += "x".repeat(extra);
        remaining -= extra;
      }
      expect(remaining).toBe(0);
      expect(Buffer.byteLength(JSON.stringify(value))).toBe(maximum);
      const exact = serializeFleetV2Json(value, schema, budget);
      expect(exact.ok).toBe(true);
      if (exact.ok) {
        expect(Buffer.byteLength(exact.json)).toBe(maximum);
        expect(JSON.parse(exact.json)).toEqual(value);
      }
      nested.characters[count - 1].character_name += "x";
      expect(schema.safeParse(value).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(value))).toBe(maximum + 1);
      expect(serializeFleetV2Json(value, schema, budget)).toEqual({
        ok: false,
        code: "service_unavailable",
      });
    },
  );

  it("refuses a whole pairing catalogue that fits the standalone budget", () => {
    const nested = catalogue();
    nested.characters = Array.from({ length: 100 }, (_, i) => ({
      character_id: i + 1,
      character_name: "\u{20000}".repeat(200),
    }));
    const standalone = { protocol: 2, ...nested };
    const pairing = { protocol: 2, session_id: token, catalogue: nested };
    expect(PairingCompletedSchema.safeParse(pairing).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(pairing))).toBeGreaterThan(65_536);
    const serialized = serializeFleetV2Json(
      standalone,
      CatalogueGetSchema,
      FLEET_V2_BYTE_LIMITS.catalogueGet.successBytes,
    );
    expect(serialized.ok).toBe(true);
    if (serialized.ok) expect(JSON.parse(serialized.json)).toEqual(standalone);
    expect(
      serializeFleetV2Json(
        pairing,
        PairingCompletedSchema,
        FLEET_V2_BYTE_LIMITS.preSessionPost.successBytes,
      ),
    ).toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });
});

describe("raw JSON and framing", () => {
  describe("exact numeric lexemes", () => {
    it.each(["1e-400", "-1e-400", "0.0000000000000000000001e-400"])(
      "rejects fractional sampled_at_ms %s before it can become a withdrawal",
      (sample) => {
        const raw = bytes(`{"protocol":2,"sampled_at_ms":${sample},"rows":[]}`);
        const parsed = parseBoundedFleetV2Json(raw, 2048);
        const accepted = parsed.ok && CombatPutSchema.safeParse(parsed.value).success;
        expect(accepted).toBe(false);
        expect(parsed).toEqual({ ok: false, code: "bad_request" });
      },
    );

    it.each([
      "9007199254740991.1",
      "9007199254740990.9",
      "2147483647.00000001",
      "1.0000000000000001",
    ])(
      "rejects fractional generation %s before safe-counter validation",
      (generation) => {
        const parsed = parseBoundedFleetV2Json(
          bytes(`{"generation":${generation}}`),
          2048,
        );
        const schema = z.object({ generation: SafeCounterSchema }).strict();
        expect(parsed.ok && schema.safeParse(parsed.value).success).toBe(false);
        expect(parsed).toEqual({ ok: false, code: "bad_request" });
      },
    );

    it.each([
      ["2.0000000000000001", "bad_request"],
      ["1.99999999999999999999", "bad_request"],
      ["1.0000000000000001", "bad_request"],
      ["1e-400", "bad_request"],
      ["2.5", "bad_request"],
      ["2.0", "ok"],
      ["2e0", "ok"],
      ["20e-1", "ok"],
      ["0.002e3", "ok"],
      ["1.0", "update_required"],
      ["3e0", "update_required"],
      ["300e-2", "update_required"],
      ["-1.0", "update_required"],
      ["1e100", "update_required"],
      ["true", "bad_request"],
      ['"2"', "bad_request"],
      ["2e", "bad_request"],
    ] as const)(
      "classifies raw protocol %s without rounding into a version",
      (protocol, expected) => {
        const parsed = parseBoundedFleetV2Json(bytes(`{"protocol":${protocol}}`), 2048);
        expect(parsed.ok ? classifyFleetV2Version(parsed.value) : parsed.code).toBe(
          expected,
        );
      },
    );

    it.each([
      ["2.0", 2],
      ["2e0", 2],
      ["2E+000", 2],
      ["20e-1", 2],
      ["200.00e-2", 2],
      ["0.00200e3", 2],
      ["-20e-1", -2],
      ["9007199254740991.000", 9007199254740991],
      ["90071992547409910e-1", 9007199254740991],
      ["0.000e-400", 0],
      ["0e400", 0],
    ] as const)("preserves mathematically integral spelling %s", (lexeme, expected) => {
      const parsed = parseBoundedFleetV2Json(bytes(`{"value":${lexeme}}`), 2048);
      expect(parsed).toEqual({ ok: true, value: { value: expected } });
    });

    it("handles entity-bounded enormous exponents without expanding a power of ten", () => {
      const huge = "9".repeat(100_000);
      const padding = "0".repeat(100_000);
      for (const lexeme of [`1e-${huge}`, `1e${huge}`]) {
        expect(parseBoundedFleetV2Json(bytes(`{"value":${lexeme}}`), 524288)).toEqual({
          ok: false,
          code: "bad_request",
        });
      }
      for (const lexeme of [`0e-${huge}`, `0e${huge}`, `20e-${padding}1`]) {
        const parsed = parseBoundedFleetV2Json(bytes(`{"value":${lexeme}}`), 524288);
        expect(parsed).toEqual({
          ok: true,
          value: { value: lexeme.startsWith("20") ? 2 : 0 },
        });
      }
      const coefficient = `2${"0".repeat(100_000)}e-100000`;
      expect(
        parseBoundedFleetV2Json(bytes(`{"protocol":${coefficient}}`), 524288),
      ).toEqual({ ok: true, value: { protocol: 2 } });
    });
  });

  it.each([
    '{"protocol":2,"protocol":2}',
    '{"protocol":2,"\\u0070rotocol":2}',
    '{"row":{"name":1,"na\\u006de":2}}',
    '{"rows":[{"a":1,"a":2}]}',
    '{"\\ud83d\\ude00":1,"😀":2}',
    '{"a":{"x":1},"a":2}',
    '{"__proto__":1,"__proto__":2}',
    '{"a":1e400}',
    '{"a":-1e400}',
    '{"a":NaN}',
    '{"a":Infinity}',
    '{"a":undefined}',
    '{"a":01}',
    '{"a":1,}',
    "[1,]",
    "{}{}",
    "",
    '\ufeff{"protocol":2}',
  ])("rejects duplicate keys/nonfinite/invalid JSON: %s", (text) => {
    expect(parseBoundedFleetV2Json(bytes(text), 1024)).toEqual({
      ok: false,
      code: "bad_request",
    });
  });

  it("allows repeated keys in separate objects and string punctuation without rewriting bytes", async () => {
    const text =
      ' {"protocol":2,"rows":[{"name":"\\"{},:[]\\\\","x":1},{"name":"é","x":2}],"__proto__":null}\n';
    const raw = bytes(text);
    expect(parseBoundedFleetV2Json(raw, raw.byteLength)).toEqual({
      ok: true,
      value: JSON.parse(text),
    });
    const result = await readFleetV2Json(
      {
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(raw.subarray(0, 5));
            controller.enqueue(raw.subarray(5));
            controller.close();
          },
        }),
      },
      raw.byteLength,
    );
    expect(result).toEqual({ ok: true, value: JSON.parse(text), bytes: raw });
  });

  it.each(
    [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98]].map((value) => [
      value,
    ]),
  )("refuses invalid UTF-8 rather than replacement decoding %j", (invalid) => {
    const raw = new Uint8Array([...bytes('{"name":"'), ...invalid, ...bytes('"}')]);
    expect(parseBoundedFleetV2Json(raw, 1024)).toEqual({
      ok: false,
      code: "bad_request",
    });
  });

  it("bounds raw bytes before decoding/parsing, not characters or compact JSON", () => {
    const raw = bytes('{"é":"é"}');
    expect(parseBoundedFleetV2Json(raw, raw.byteLength).ok).toBe(true);
    expect(parseBoundedFleetV2Json(raw, raw.byteLength - 1).ok).toBe(false);
    expect(
      parseBoundedFleetV2Json(bytes(`{"protocol":2}${" ".repeat(524275)}`), 524288).ok,
    ).toBe(false);
  });

  it("cancels an overflowing stream without draining it, ignoring understated lengths", async () => {
    let cancelled = false;
    let pulls = 0;
    const result = await readFleetV2Json(
      {
        headers: new Headers({ "content-length": "1" }),
        body: new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(bytes("x".repeat(2049)));
          },
          cancel() {
            cancelled = true;
          },
        }),
      },
      2048,
    );
    expect(result).toEqual({ ok: false, code: "bad_request" });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(1);
  });

  it("refuses declared overflow and stream faults as closed input errors", async () => {
    expect(
      await readFleetV2Json(
        { headers: new Headers({ "content-length": "2049" }), body: null },
        2048,
      ),
    ).toEqual({ ok: false, code: "bad_request" });
    expect(
      await readFleetV2Json(
        {
          headers: new Headers(),
          body: new ReadableStream({
            pull(controller) {
              controller.error(new Error("private I/O failure"));
            },
          }),
        },
        2048,
      ),
    ).toEqual({ ok: false, code: "bad_request" });
  });

  it.each([
    [{ protocol: 2 }, "ok"],
    [{ protocol: 1 }, "update_required"],
    [{ protocol: -1 }, "update_required"],
    [{ protocol: 3 }, "update_required"],
    [{}, "bad_request"],
    [{ protocol: "2" }, "bad_request"],
    [{ protocol: true }, "bad_request"],
    [{ protocol: 2.5 }, "bad_request"],
    [{ protocol: NaN }, "bad_request"],
    [{ protocol: Infinity }, "bad_request"],
    [null, "bad_request"],
    [[], "bad_request"],
    [Object.create({ protocol: 2 }), "bad_request"],
  ])("classifies explicit integer version vs invalid shape %j", (value, expected) => {
    expect(classifyFleetV2Version(value)).toBe(expected);
  });

  it.each([null, "0", "00", "000"])("accepts decimal-zero GET length %s", (length) => {
    const headers = new Headers();
    if (length !== null) headers.set("content-length", length);
    expect(
      hasEmptyFleetV2GetFraming(
        { headers, url: "https://auth.example/api/fleet/v2/snapshot" },
        new Uint8Array(),
      ),
    ).toBe(true);
  });

  it.each(["1", "-0", "+0", "0.0", "0e0", "0, 0", ""])(
    "rejects nonempty/nondecimal GET length %s",
    (length) => {
      expect(
        hasEmptyFleetV2GetFraming(
          {
            headers: new Headers({ "content-length": length }),
            url: "https://auth.example/api/fleet/v2/snapshot",
          },
          new Uint8Array(),
        ),
      ).toBe(false);
    },
  );

  it("rejects query, transfer framing, and actual GET bytes", () => {
    const base = {
      headers: new Headers(),
      url: "https://auth.example/api/fleet/v2/snapshot",
    };
    expect(hasEmptyFleetV2GetFraming(base, bytes(" "))).toBe(false);
    expect(
      hasEmptyFleetV2GetFraming({ ...base, url: `${base.url}?` }, new Uint8Array()),
    ).toBe(false);
    expect(
      hasEmptyFleetV2GetFraming(
        { ...base, url: `${base.url}?format=old` },
        new Uint8Array(),
      ),
    ).toBe(false);
    expect(
      hasEmptyFleetV2GetFraming(
        { ...base, headers: new Headers({ "transfer-encoding": "chunked" }) },
        new Uint8Array(),
      ),
    ).toBe(false);
  });
});

describe("closed complete combat envelopes", () => {
  it("accepts unavailable, measured zero, incoming-only and quiet active rows unchanged", () => {
    expect(CombatPutSchema.parse(put())).toEqual(put());
    expect(CombatGetSchema.parse(get())).toEqual(get());
    const value = put();
    value.rows[0].effects = [];
    expect(CombatPutSchema.parse(value)).toEqual(value);
    expect(CombatPutSchema.parse({ protocol: 2, sampled_at_ms: 0, rows: [] })).toEqual({
      protocol: 2,
      sampled_at_ms: 0,
      rows: [],
    });
    expect(
      CombatPutSchema.safeParse({ protocol: 2, sampled_at_ms: 1, rows: [] }).success,
    ).toBe(false);
    expect(CombatGetSchema.parse({ protocol: 2, server_time_ms: 0, rows: [] })).toEqual({
      protocol: 2,
      server_time_ms: 0,
      rows: [],
    });
  });

  it("requires all keys and rejects extensions at every nesting level", () => {
    const value = put();
    for (const target of [
      value,
      value.rows[0],
      value.rows[0].effects[0],
      value.rows[0].effects[0].observations[0],
    ]) {
      const record = target as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const previous = record[key];
        delete record[key];
        expect(CombatPutSchema.safeParse(value).success, key).toBe(false);
        record[key] = previous;
      }
      record.extra = null;
      expect(CombatPutSchema.safeParse(value).success).toBe(false);
      delete record.extra;
    }
    const response = get();
    for (const key of Object.keys(response.rows[0])) {
      const copy = structuredClone(response) as unknown as {
        rows: Record<string, unknown>[];
      };
      delete copy.rows[0][key];
      expect(CombatGetSchema.safeParse(copy).success, key).toBe(false);
    }
    expect(CombatPutSuccessSchema.safeParse({ protocol: 2, rows: [] }).success).toBe(
      false,
    );
  });

  const badPuts: [string, (value: CombatPut) => void][] = [
    [
      "duplicate characters",
      (v) => {
        v.rows.push(structuredClone(v.rows[0]));
      },
    ],
    [
      "33 rows",
      (v) => {
        v.rows = Array.from({ length: 33 }, (_, i) => ({
          ...v.rows[0],
          character_id: i + 1,
        }));
      },
    ],
    [
      "duplicate effect kinds",
      (v) => {
        v.rows[0].effects[1].kind = "SCRAM";
      },
    ],
    [
      "effect order",
      (v) => {
        v.rows[0].effects.reverse();
      },
    ],
    [
      "empty effect observations",
      (v) => {
        v.rows[0].effects[0].observations = [];
      },
    ],
    [
      "duplicate canonical names",
      (v) => {
        v.rows[0].effects[0].observations.push({ name: "é", age_ms: 8000 });
      },
    ],
    [
      "duplicate null buckets",
      (v) => {
        v.rows[0].effects[0].observations.push({ name: null, age_ms: 8000 });
      },
    ],
    [
      "nine named observations without null",
      (v) => {
        v.rows[0].effects[0].observations = Array.from({ length: 9 }, (_, i) => ({
          name: `Pilot ${i}`,
          age_ms: 8000,
        }));
      },
    ],
    [
      "named NEUT",
      (v) => {
        v.rows[0].effects[2].observations[0].name = "Pilot";
      },
    ],
    [
      "two NEUT observations",
      (v) => {
        v.rows[0].effects[2].observations.push({ name: null, age_ms: 8000 });
      },
    ],
    [
      "row activity older than effect",
      (v) => {
        v.rows[0].activity_age_ms = 6001;
      },
    ],
    [
      "negative row origin",
      (v) => {
        v.sampled_at_ms = 4999;
        v.rows[0].effects = [];
      },
    ],
    [
      "negative observation origin",
      (v) => {
        v.sampled_at_ms = 7999;
      },
    ],
    [
      "expired observation",
      (v) => {
        v.rows[0].effects[0].observations[0].age_ms = 30000;
      },
    ],
    [
      "expired row",
      (v) => {
        v.rows[0].activity_age_ms = 30000;
        v.rows[0].effects = [];
      },
    ],
    [
      "negative age",
      (v) => {
        v.rows[0].activity_age_ms = -1;
      },
    ],
    [
      "too much DPS",
      (v) => {
        v.rows[0].incoming_dps = 10000001;
      },
    ],
    [
      "fractional DPS",
      (v) => {
        v.rows[0].outgoing_dps = 0.5;
      },
    ],
    [
      "negative DPS",
      (v) => {
        v.rows[0].outgoing_dps = -1;
      },
    ],
    [
      "unsafe ID",
      (v) => {
        v.rows[0].character_id = safeMax + 1;
      },
    ],
    [
      "fractional ID",
      (v) => {
        v.rows[0].character_id = 1.1;
      },
    ],
    [
      "zero ID",
      (v) => {
        v.rows[0].character_id = 0;
      },
    ],
    [
      "nonfinite sample",
      (v) => {
        v.sampled_at_ms = Infinity;
      },
    ],
    [
      "negative sample",
      (v) => {
        v.sampled_at_ms = -1;
      },
    ],
    [
      "fractional sample",
      (v) => {
        v.sampled_at_ms = 1.5;
      },
    ],
  ];
  it.each(badPuts)("rejects whole PUT: %s", (_name, mutate) => {
    const value = put();
    mutate(value);
    expect(CombatPutSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    "e\u0301",
    " Pilot ",
    "<Pilot>",
    "a\n",
    "\u200d",
    "\ud800",
    "\u{20000}".repeat(65),
  ])("rejects rather than normalizes observed name %s", (name) => {
    const value = put();
    value.rows[0].effects[0].observations[0].name = name;
    expect(CombatPutSchema.safeParse(value).success).toBe(false);
  });

  it("uses exact canonical names on wire, not casefold retention identities", () => {
    const value = put();
    value.rows[0].effects[0].observations = [
      { name: "Pilot", age_ms: 5000 },
      { name: "PILOT", age_ms: 6000 },
    ];
    expect(CombatPutSchema.safeParse(value).success).toBe(true);
    value.sampled_at_ms = 6000;
    expect(CombatPutSchema.safeParse(value).success).toBe(false); // other kind's 8000-age still participates
    value.sampled_at_ms = 8000;
    expect(CombatPutSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    [
      "duplicate publication",
      (v: CombatGet) => {
        v.rows.push({ ...v.rows[0], character_id: 2 });
      },
    ],
    [
      "duplicate ID",
      (v: CombatGet) => {
        v.rows.push({ ...v.rows[0], publication_id: uuid(2) });
      },
    ],
    [
      "bad publication",
      (v: CombatGet) => {
        v.rows[0].publication_id = device().device_id;
      },
    ],
    [
      "expired transport",
      (v: CombatGet) => {
        v.rows[0].age_ms = 10000;
      },
    ],
    [
      "inconsistent live state",
      (v: CombatGet) => {
        v.rows[0].age_ms = 3000;
      },
    ],
    [
      "inconsistent stale state",
      (v: CombatGet) => {
        v.rows[0].state = "stale";
      },
    ],
    [
      "activity after sample",
      (v: CombatGet) => {
        v.rows[0].activity_age_ms = 2998;
      },
    ],
    [
      "negative transport origin",
      (v: CombatGet) => {
        v.server_time_ms = 2998;
      },
    ],
    [
      "negative effect origin",
      (v: CombatGet) => {
        v.server_time_ms = 7999;
      },
    ],
  ] as const)("rejects whole GET: %s", (_name, mutate) => {
    const value = get();
    mutate(value);
    expect(CombatGetSchema.safeParse(value).success).toBe(false);
  });

  it("accepts transport boundary 3000/9999 as stale and nonnegative origins at equality", () => {
    for (const age of [3000, 9999]) {
      const value = get();
      Object.assign(value.rows[0], {
        age_ms: age,
        state: "stale",
        activity_age_ms: age,
        effects: [],
      });
      value.server_time_ms = age;
      expect(CombatGetSchema.safeParse(value).success).toBe(true);
    }
  });

  it("validates maximum-cardinality PUT using actual ASCII-escaped/spaced client bytes", () => {
    const value = maximumPut();
    expect(Buffer.byteLength(JSON.stringify(value.rows[0]))).toBe(4833);
    const raw = JSON.stringify(value)
      .replace(
        /[\u0080-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
      .replaceAll(",", ", ")
      .replaceAll(":", ": ");
    expect(Buffer.byteLength(raw)).toBe(419900);
    const parsed = parseBoundedFleetV2Json(
      bytes(raw),
      FLEET_V2_BYTE_LIMITS.snapshotPut.requestBytes,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(CombatPutSchema.parse(parsed.value)).toEqual(value);
  });

  it("validates/serializes all 8192 maximal GET rows without subsets or truncation", () => {
    const row = maximumPut().rows[0];
    const value: CombatGet = {
      protocol: 2,
      server_time_ms: safeMax,
      rows: Array.from({ length: 8192 }, (_, i) => ({
        ...row,
        character_id: safeMax - i,
        character_name: "\u{20000}".repeat(200),
        state: "stale",
        age_ms: 9999,
        publication_id: uuid(i + 1),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(value.rows[0]))).toBe(5739);
    const serialized = serializeFleetV2Json(
      value,
      CombatGetSchema,
      FLEET_V2_BYTE_LIMITS.snapshotGet.successBytes,
    );
    expect(serialized.ok).toBe(true);
    if (serialized.ok) {
      expect(Buffer.byteLength(serialized.json)).toBe(47022137);
      const parsed = parseBoundedFleetV2Json(
        bytes(serialized.json),
        FLEET_V2_BYTE_LIMITS.snapshotGet.successBytes,
      );
      expect(parsed.ok).toBe(true);
    }
    value.rows.push({ ...value.rows[0], character_id: 1, publication_id: uuid(9000) });
    expect(CombatGetSchema.safeParse(value).success).toBe(false);
  }, 30000);
});

describe("v2 correlation, unchanged signing scheme", () => {
  const raw = bytes('{ "protocol":2, "sampled_at_ms":0, "rows":[] }');
  const request = {
    method: "PUT" as const,
    path: "/api/fleet/v2/snapshot",
    sessionId: token,
    issuedAt: "2026-08-13T00:00:00.000Z",
    revision: 7,
    bodySha256: sha256(raw),
  };
  const independentCanonical = (input: typeof request) =>
    bytes(
      [
        "fleet-v1",
        input.method,
        input.path,
        input.sessionId,
        input.issuedAt,
        String(input.revision),
        input.bodySha256,
      ].join("\n"),
    );

  it("keeps the fleet-v1 primitive on literal v2 paths and binds exact authenticated bytes", () => {
    expect(API_VERSION).toBe(2);
    expect(SIGNING_SCHEME_VERSION).toBe(1);
    const expected = independentCanonical(request);
    expect(canonicalFleetRequest({ protocol: 1, ...request })).toEqual(expected);
    expect(fleetV2RequestBinding(request)).toBe(
      createHash("sha256").update("fleet-api-v2\n").update(expected).digest("hex"),
    );
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const headers = {
      ...request,
      signature: sign(null, expected, privateKey).toString("base64url"),
    };
    const key = publicKey.export({ format: "der", type: "spki" });
    const verification = {
      method: "PUT",
      path: request.path,
      now: new Date(request.issuedAt),
    };
    expect(verifyFleetRequest(key, headers, raw, verification)).toBe("ok");
    expect(
      verifyFleetRequest(key, headers, raw, {
        ...verification,
        path: "/api/fleet/v1/snapshot",
      }),
    ).toBe("bad_signature");
  });

  it.each([
    { method: "GET" },
    { path: "/api/fleet/v2/device" },
    { sessionId: "A".repeat(43) },
    { issuedAt: "2026-08-13T00:00:00.001Z" },
    { revision: 8 },
    { bodySha256: sha256(JSON.stringify({ protocol: 2, sampled_at_ms: 0, rows: [] })) },
  ])("changes signed binding for each changed dimension %j", (change) => {
    const changed = { ...request, ...change } as typeof request;
    expect(fleetV2RequestBinding(changed)).not.toBe(fleetV2RequestBinding(request));
    expect(fleetV2RequestBinding(changed)).toBe(
      createHash("sha256")
        .update("fleet-api-v2\n")
        .update(independentCanonical(changed))
        .digest("hex"),
    );
  });

  it("requires exactly one canonical per-attempt token and refuses caller response bindings", () => {
    expect(extractFleetV2Attempt(new Headers({ "X-Fleet-Attempt": token }))).toBe(token);
    for (const headers of [
      new Headers(),
      new Headers({ "X-Fleet-Attempt": `${token}, ${token}` }),
      new Headers({ "X-Fleet-Attempt": `${token.slice(0, -1)}9` }),
      new Headers({ "X-Fleet-Request-Binding": token }),
      new Headers({ "X-Fleet-Attempt": token, "X-Fleet-Request-Binding": "x" }),
    ]) {
      expect(extractFleetV2Attempt(headers)).toBeNull();
    }
    const duplicate = new Headers({ "X-Fleet-Attempt": token });
    duplicate.append("x-fleet-attempt", token);
    expect(extractFleetV2Attempt(duplicate)).toBeNull();
  });

  it.each([
    "/api/fleet/v2/pairing-requests",
    `/api/fleet/v2/pairing-requests/${device().device_id}/complete`,
    "/api/fleet/v2/recovery-challenges",
    `/api/fleet/v2/recovery-challenges/${uuid(2)}/complete`,
  ])(
    "binds exact pre-session path/body/origin/attempt without a trailing newline: %s",
    (path) => {
      const input = {
        origin: "https://auth.example",
        path,
        attempt: token,
        rawBody: raw,
      };
      const expected = sha256(
        ["fleet-api-v2-pre-session", input.origin, "POST", path, token, sha256(raw)].join(
          "\n",
        ),
      );
      expect(fleetV2PreSessionBinding(input)).toBe(expected);
      for (const change of [
        { origin: "https://other.example" },
        { attempt: "A".repeat(43) },
        { rawBody: bytes('{"protocol":2}') },
      ]) {
        expect(fleetV2PreSessionBinding({ ...input, ...change })).not.toBe(expected);
      }
    },
  );

  it.each([
    "/api/fleet/v1/pairing-requests",
    "/api/fleet/v2/pairing-requests/",
    "/api/fleet/v2/pairing-requests\n",
    `/api/fleet/v2/pairing-requests/${uuid(1)}/complete\n`,
    "/api/fleet/v2/pairing-requests?",
    `/api/fleet/v2/pairing-requests/%30${uuid(1).slice(1)}/complete`,
    "/api/fleet/v2/recovery-challenges/bad/complete",
    "/api/fleet/v2/snapshot",
  ])("refuses nonliteral pre-session paths %s", (path) => {
    expect(
      fleetV2PreSessionBinding({
        origin: "https://auth.example",
        path,
        attempt: token,
        rawBody: raw,
      }),
    ).toBeNull();
  });

  it("does not canonicalize a supplied origin or attempt into authority", () => {
    for (const origin of [
      "https://auth.example/",
      "https://user@auth.example",
      "https://AUTH.example",
      "https://auth.example/path",
      "http://auth.example",
      "not-url",
    ]) {
      expect(
        fleetV2PreSessionBinding({
          origin,
          path: "/api/fleet/v2/pairing-requests",
          attempt: token,
          rawBody: raw,
        }),
      ).toBeNull();
    }
    expect(
      fleetV2PreSessionBinding({
        origin: "https://auth.example",
        path: "/api/fleet/v2/pairing-requests",
        attempt: `${token}=`,
        rawBody: raw,
      }),
    ).toBeNull();
  });
});
