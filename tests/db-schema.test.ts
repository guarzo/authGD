import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  fleetSharingGate,
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
  it("replays the generated recovery migration additively with indexed expiry and bounded attempts", async () => {
    const migration = readFileSync(
      new URL("../drizzle/0019_first_spitfire.sql", import.meta.url),
      "utf8",
    );
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      await client.query("create temp table fleet_device (id text primary key)");
      await client.query("create temp table fleet_device_session (id text primary key)");
      await client.query("set local search_path to pg_temp");
      await client.query(
        "insert into fleet_device values ('retained'); insert into fleet_device_session values ('retained-session')",
      );
      await client.query(migration);
      expect((await client.query("select * from fleet_device")).rows).toEqual([
        { id: "retained" },
      ]);
      expect((await client.query("select * from fleet_device_session")).rows).toEqual([
        { id: "retained-session" },
      ]);
      const {
        rows: [challenge],
      } = await client.query<Record<string, unknown>>(
        "insert into fleet_recovery_challenge(public_key_spki_b64, nonce_digest, expires_at) values ('public-test-key', 'digest-only', now()) returning *",
      );
      expect(challenge).toMatchObject({ attempts: 0, consumed_at: null });
      expect(Object.keys(challenge).sort()).toEqual(
        [
          "id",
          "public_key_spki_b64",
          "nonce_digest",
          "created_at",
          "expires_at",
          "consumed_at",
          "attempts",
        ].sort(),
      );
      const indexes = await client.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = 'fleet_recovery_challenge' and schemaname = current_schema()",
      );
      expect(indexes.rows.map((r) => r.indexdef)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("(expires_at)"),
          expect.stringContaining("(public_key_spki_b64, expires_at)"),
        ]),
      );
      await expect(
        client.query("update fleet_recovery_challenge set attempts = -1"),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(MANAGED_TABLE_NAMES).toContain("fleet_recovery_challenge");
  });

  it("replays the additive identity migration without reconciling or rewriting old records", async () => {
    const migration = readFileSync(
      new URL("../drizzle/0020_chief_machine_man.sql", import.meta.url),
      "utf8",
    );
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      // Generated FK names public.fleet_device explicitly. PostgreSQL forbids a
      // temporary table referencing it, so replay unchanged SQL in a transaction-
      // local throwaway schema in the SAME test DB; rollback removes everything.
      await client.query("create schema task2_identity_migration_replay");
      await client.query("set local search_path to task2_identity_migration_replay");
      await client.query(
        "create table fleet_recovery_challenge (id uuid primary key, public_key_spki_b64 text, nonce_digest text, attempts integer)",
      );
      await client.query(
        "create table fleet_sharing_gate (id integer primary key, enabled boolean, revision integer)",
      );
      await client.query("insert into fleet_sharing_gate values (1, false, 7)");
      await client.query(
        "insert into fleet_recovery_challenge values ('00000000-0000-4000-8000-000000000020', 'old-public-key', 'digest-only', 4)",
      );
      await client.query(migration);
      expect((await client.query("select * from fleet_sharing_gate")).rows).toEqual([
        {
          id: 1,
          enabled: false,
          revision: 7,
          key_identity_phase: "pending",
          key_identity_cursor: null,
        },
      ]);
      expect(
        (await client.query("select * from fleet_device_key_identity")).rows,
      ).toEqual([]);
      expect((await client.query("select * from fleet_recovery_challenge")).rows).toEqual(
        [
          {
            id: "00000000-0000-4000-8000-000000000020",
            public_key_spki_b64: "old-public-key",
            nonce_digest: "digest-only",
            attempts: 4,
            request_id: null,
            request_issued_at: null,
          },
        ],
      );
      await client.query(
        "insert into fleet_device_key_identity(canonical_spki_b64, conflicted) values ('tombstone', false), ('conflict', true)",
      );
      await client.query("update fleet_recovery_challenge set request_id = 'same-id'");
      await expect(
        client.query(
          "insert into fleet_recovery_challenge values ('00000000-0000-4000-8000-000000000021', 'old-public-key', 'digest', 0, 'same-id', null)",
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(MANAGED_TABLE_NAMES).toContain("fleet_device_key_identity");
  });

  it("keeps the singleton disabled by default and rejects other singleton ids", async () => {
    const [gate] = await ctx.db.insert(fleetSharingGate).values({}).returning();
    expect(gate).toEqual({
      id: 1,
      enabled: false,
      revision: 0,
      transitionedAt: null,
      keyIdentityPhase: "pending",
      keyIdentityCursor: null,
    });
    await expect(ctx.db.insert(fleetSharingGate).values({ id: 2 })).rejects.toThrow();
    expect(MANAGED_TABLE_NAMES).toContain("fleet_sharing_gate");
  });

  it("the generated additive migration leaves pre-existing registrations and sessions unapproved and off", async () => {
    const migration = readFileSync(
      new URL("../drizzle/0018_amusing_iron_monger.sql", import.meta.url),
      "utf8",
    );
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      // Connection-local throwaway old table shapes in the SAME disposable DB.
      // Replay the generated bytes unchanged; never alter an applied migration
      // or any public table to manufacture the pre-feature path.
      await client.query("create temp table fleet_device (id text primary key)");
      await client.query("create temp table fleet_device_session (id text primary key)");
      await client.query("create temp table fleet_pairing_request (id text primary key)");
      await client.query("set local search_path to pg_temp");
      await client.query(
        "insert into fleet_device values ('retained-device'); insert into fleet_device_session values ('retained-session'); insert into fleet_pairing_request values ('pending-request')",
      );
      await client.query(migration);
      expect((await client.query("select * from fleet_device")).rows).toEqual([
        {
          id: "retained-device",
          approved_capabilities: [],
          participation_enabled: false,
          participation_generation: 0,
        },
      ]);
      expect((await client.query("select * from fleet_device_session")).rows).toEqual([
        {
          id: "retained-session",
          approved_capabilities: [],
          acknowledged_capabilities: [],
        },
      ]);
      expect((await client.query("select * from fleet_pairing_request")).rows).toEqual([
        { id: "pending-request", requested_capabilities: [] },
      ]);
      expect((await client.query("select * from fleet_sharing_gate")).rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
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
        "approvedCapabilities",
        "acknowledgedCapabilities",
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
