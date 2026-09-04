import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  account,
  character,
  discordLink,
  fleetDevice,
  fleetDeviceSession,
  fleetEligibility,
  fleetPairingRequest,
  fleetPublisherLease,
  fleetTelemetryRow,
  universeName,
} from "@/db/schema";
import { MANAGED_TABLE_NAMES } from "@/db/tables";
import { canonicalDevicePublicKeyB64 } from "@/lib/fleet-signature";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("schema", () => {
  it("creates an account with defaults and a character", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    expect(acc.tier).toBe("alumni");
    expect(acc.tierLocked).toBe(false);
    expect(acc.status).toBe("active");
    expect(acc.isAdmin).toBe(false);

    const [ch] = await ctx.db
      .insert(character)
      .values({
        id: 90000001,
        accountId: acc.id,
        name: "Pilot One",
        ownerHash: "oh1",
        scopes: ["esi-characters.read_contacts.v1"],
        tokenStatus: "valid",
      })
      .returning();
    expect(ch.affiliationInvalid).toBe(false);
    expect(ch.tokenStatus).toBe("valid");
  });

  it("enforces unique discord_user_id", async () => {
    const [a1] = await ctx.db.insert(account).values({}).returning();
    const [a2] = await ctx.db.insert(account).values({}).returning();
    await ctx.db
      .insert(discordLink)
      .values({ accountId: a1.id, discordUserId: "duid-1" });
    await expect(
      ctx.db.insert(discordLink).values({ accountId: a2.id, discordUserId: "duid-1" }),
    ).rejects.toThrow();
  });

  it("rejects a main character belonging to another account", async () => {
    const [a1] = await ctx.db.insert(account).values({}).returning();
    const [a2] = await ctx.db.insert(account).values({}).returning();
    await ctx.db.insert(character).values({
      id: 90000042,
      accountId: a1.id,
      name: "Owned by a1",
      ownerHash: "oh",
      scopes: [],
      tokenStatus: "missing",
    });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx
          .update(account)
          .set({ mainCharacterId: 90000042 })
          .where(eq(account.id, a2.id));
      }),
    ).rejects.toThrow();
  });

  it("tier enum carries the generic vocabulary in declaration order", async () => {
    const res = await ctx.db.execute(
      sql`SELECT e.enumlabel AS label
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'tier'
          ORDER BY e.enumsortorder`,
    );
    expect(res.rows.map((r) => r.label)).toEqual([
      "member",
      "associate",
      "alumni",
      "pending",
    ]);
  });

  it("account.tier defaults to alumni", async () => {
    const res = await ctx.db.execute(
      sql`SELECT column_default FROM information_schema.columns
          WHERE table_name = 'account' AND column_name = 'tier'`,
    );
    expect(String(res.rows[0]?.column_default)).toContain("alumni");
  });
});

describe("location columns", () => {
  it("defaults every location column to null on a fresh character", async () => {
    const acc = await seedAccount(ctx.db);
    const ch = await seedCharacter(ctx.db, cfg, { id: 90000201, accountId: acc.id });
    expect(ch.locationSystemId).toBeNull();
    expect(ch.locationStationId).toBeNull();
    expect(ch.locationStructureId).toBeNull();
    expect(ch.locationOnline).toBeNull();
    expect(ch.locationCheckedAt).toBeNull();
  });

  it("round-trips a written location", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90000202, accountId: acc.id });
    const checkedAt = new Date("2026-08-06T12:00:00Z");
    await ctx.db
      .update(character)
      .set({
        locationSystemId: 31000123,
        locationStructureId: 1035466617946,
        locationOnline: true,
        locationCheckedAt: checkedAt,
      })
      .where(eq(character.id, 90000202));
    const [row] = await ctx.db.select().from(character).where(eq(character.id, 90000202));
    expect(row.locationSystemId).toBe(31000123);
    expect(row.locationStationId).toBeNull();
    expect(row.locationStructureId).toBe(1035466617946);
    expect(row.locationOnline).toBe(true);
    expect(row.locationCheckedAt).toEqual(checkedAt);
  });
});

describe("universe_name", () => {
  it("stores one row per id across all three kinds, stamped with fetchedAt", async () => {
    await ctx.db.insert(universeName).values([
      { id: 31000123, kind: "system", name: "J123456" },
      { id: 60003760, kind: "station", name: "Jita IV - Moon 4" },
      { id: 1035466617946, kind: "structure", name: "Home Astrahus" },
    ]);
    const rows = await ctx.db.select().from(universeName).orderBy(universeName.id);
    expect(rows.map((r) => r.kind)).toEqual(["system", "station", "structure"]);
    expect(rows[2].name).toBe("Home Astrahus");
    expect(rows[0].fetchedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate id", async () => {
    await ctx.db
      .insert(universeName)
      .values({ id: 31000999, kind: "system", name: "J999999" });
    await expect(
      ctx.db
        .insert(universeName)
        .values({ id: 31000999, kind: "system", name: "J999999" }),
    ).rejects.toThrow();
  });
});

describe("fleet relay schema", () => {
  it("exports all six relay tables and registers them in MANAGED_TABLES", () => {
    expect(fleetPairingRequest).toBeDefined();
    expect(fleetDevice).toBeDefined();
    expect(fleetDeviceSession).toBeDefined();
    expect(fleetEligibility).toBeDefined();
    expect(fleetPublisherLease).toBeDefined();
    expect(fleetTelemetryRow).toBeDefined();

    for (const name of [
      "fleet_pairing_request",
      "fleet_device",
      "fleet_device_session",
      "fleet_eligibility",
      "fleet_publisher_lease",
      "fleet_telemetry_row",
    ]) {
      expect(MANAGED_TABLE_NAMES).toContain(name);
    }
  });

  it("stores an inserted session's hash, never a raw session id column", async () => {
    const acc = await seedAccount(ctx.db);
    const [device] = await ctx.db
      .insert(fleetDevice)
      .values({ accountId: acc.id, publicKeySpkiB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" })
      .returning();

    // A raw opaque session value never touches this table: only its SHA-256
    // digest does, mirroring the browser `session` table above.
    const rawSessionValue = "test-only-raw-session-value-not-a-real-secret";
    const sessionId = createHash("sha256").update(rawSessionValue).digest("base64url");
    const [row] = await ctx.db
      .insert(fleetDeviceSession)
      .values({
        id: sessionId,
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    expect(row.id).toBe(sessionId);
    expect(row.id).not.toBe(rawSessionValue);
    // Enumerates every column the table actually has: proves there is no
    // second column anywhere that could hold the raw session value.
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "deviceId",
        "expiresAt",
        "lastRevision",
        "lastPublishAt",
        "lastReadAt",
      ].sort(),
    );
  });

  it("stores only the documented columns on a current relay row", async () => {
    const acc = await seedAccount(ctx.db);
    const ch = await seedCharacter(ctx.db, cfg, { id: 91500001, accountId: acc.id });
    const [device] = await ctx.db
      .insert(fleetDevice)
      .values({ accountId: acc.id, publicKeySpkiB64: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==" })
      .returning();
    const [session] = await ctx.db
      .insert(fleetDeviceSession)
      .values({
        id: createHash("sha256").update("another-test-only-value").digest("base64url"),
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const now = new Date("2026-09-04T12:00:00.000Z");
    const [row] = await ctx.db
      .insert(fleetTelemetryRow)
      .values({
        characterId: ch.id,
        fleetId: 5000001,
        deviceId: device.id,
        sessionId: session.id,
        dps: 1234,
        ewar: ["SCRAM/POINT"],
        receivedAt: now,
        staleAt: new Date(now.getTime() + 3_000),
        hardExpiresAt: new Date(now.getTime() + 10_000),
      })
      .returning();

    // No column for log content, target/source, an event timestamp beyond
    // receivedAt, fleet name, system, ship, or an EVE token — only exactly
    // these nine columns exist on the table.
    expect(Object.keys(row).sort()).toEqual(
      [
        "characterId",
        "fleetId",
        "deviceId",
        "sessionId",
        "dps",
        "ewar",
        "receivedAt",
        "staleAt",
        "hardExpiresAt",
      ].sort(),
    );
  });

  it("permanently bars a revoked device's public key from ever being reused", async () => {
    const acc = await seedAccount(ctx.db);
    const keyB64 = canonicalDevicePublicKeyB64(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i)),
    );

    const [device] = await ctx.db
      .insert(fleetDevice)
      .values({ accountId: acc.id, publicKeySpkiB64: keyB64 })
      .returning();
    await ctx.db
      .update(fleetDevice)
      .set({ revokedAt: new Date() })
      .where(eq(fleetDevice.id, device.id));

    // Re-pairing with the SAME (now-revoked) key must fail: the unique
    // constraint is not scoped by revokedAt, by design.
    await expect(
      ctx.db.insert(fleetDevice).values({ accountId: acc.id, publicKeySpkiB64: keyB64 }),
    ).rejects.toThrow();
  });

  it('permits ewar to be exactly [] or ["SCRAM/POINT"], and rejects any other JSON', async () => {
    const acc = await seedAccount(ctx.db);
    const [device] = await ctx.db
      .insert(fleetDevice)
      .values({
        accountId: acc.id,
        publicKeySpkiB64: canonicalDevicePublicKeyB64(new Uint8Array([9, 9, 9])),
      })
      .returning();
    const [session] = await ctx.db
      .insert(fleetDeviceSession)
      .values({
        id: createHash("sha256").update("ewar-check-session").digest("base64url"),
        deviceId: device.id,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const now = new Date("2026-09-04T12:00:00.000Z");
    const insertWithEwar = async (characterId: number, ewar: string[]) => {
      const ch = await seedCharacter(ctx.db, cfg, { id: characterId, accountId: acc.id });
      return ctx.db.insert(fleetTelemetryRow).values({
        characterId: ch.id,
        fleetId: 5000002,
        deviceId: device.id,
        sessionId: session.id,
        dps: 0,
        ewar,
        receivedAt: now,
        staleAt: new Date(now.getTime() + 3_000),
        hardExpiresAt: new Date(now.getTime() + 10_000),
      });
    };

    await expect(insertWithEwar(91500010, [])).resolves.toBeDefined();
    await expect(insertWithEwar(91500011, ["SCRAM/POINT"])).resolves.toBeDefined();
    await expect(insertWithEwar(91500012, ["WARP_SCRAMBLE"])).rejects.toThrow();
    await expect(
      insertWithEwar(91500013, ["SCRAM/POINT", "SCRAM/POINT"]),
    ).rejects.toThrow();
  });
});
