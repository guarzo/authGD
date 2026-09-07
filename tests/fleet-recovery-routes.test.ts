import { createHash, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { account, fleetDevice, fleetRecoveryChallenge } from "@/db/schema";
import { getDb } from "@/db";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { recoveryInitiation } from "./helpers/fleet-recovery";
import { fleetKeyPair, pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
import { seedAccount } from "./helpers/seed";

process.env.DATABASE_URL = TEST_URL;
process.env.APP_BASE_URL = "https://auth.example/app/?ignored=1";
const { POST: beginRoute } = await import("@/app/api/fleet/v1/recovery-challenges/route");
const { POST: completeRoute } =
  await import("@/app/api/fleet/v1/recovery-challenges/[id]/complete/route");
const { GET: deviceRoute } = await import("@/app/api/fleet/v1/device/route");
const { canonicalFleetRequest } = await import("@/lib/fleet-signature");

const PATH = "/api/fleet/v1/recovery-challenges";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await truncateAll(ctx.db);
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
});
function request(path: string, body: unknown) {
  return new NextRequest(`https://attacker.example${path}`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      host: "attacker.example",
      "x-forwarded-host": "attacker.example",
    },
    body: JSON.stringify(body),
  });
}
function initiationBody(keys: ReturnType<typeof fleetKeyPair>) {
  const signed = recoveryInitiation(keys);
  return {
    protocol: 1,
    public_key_spki_b64url: Buffer.from(keys.publicKeySpki).toString("base64url"),
    request_id: signed.requestId,
    issued_at: signed.issuedAt,
    initiation_signature: signed.initiationSignature,
  };
}
async function challenge(candidate?: ReturnType<typeof fleetKeyPair>) {
  const keys =
    candidate ??
    (await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      new Date(),
    ));
  const bodyInput = initiationBody(keys);
  const response = await beginRoute(request(PATH, bodyInput));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as {
    protocol: number;
    request_id: string;
    challenge_id: string;
    nonce: string;
    expires_at: string;
  };
  expect(body).toEqual({
    protocol: 1,
    request_id: bodyInput.request_id,
    challenge_id: expect.any(String),
    nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    expires_at: expect.stringMatching(/Z$/),
  });
  return { ...body, keys };
}
function complete(
  c: Awaited<ReturnType<typeof challenge>>,
  origin = "https://auth.example",
) {
  const preimage = Buffer.from(
    [
      "fleet-recovery-v1",
      origin,
      c.challenge_id,
      c.nonce,
      createHash("sha256").update(c.keys.publicKeySpki).digest("hex"),
    ].join("\n"),
  );
  return completeRoute(
    request(`${PATH}/${c.challenge_id}/complete`, {
      protocol: 1,
      nonce: c.nonce,
      recovery_signature: sign(null, preimage, c.keys.privateKey).toString("base64url"),
    }),
    { params: Promise.resolve({ id: c.challenge_id }) },
  );
}

describe("actual key recovery routes", () => {
  it("returns only the terminal proven conflict outcome for real reconciled legacy aliases", async () => {
    await truncateAll(ctx.db);
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const keys = fleetKeyPair();
    await pairDevice(ctx.db, owner.id, new Date(), [], keys);
    await pairDevice(ctx.db, owner.id, new Date(), [], {
      ...keys,
      publicKeySpki: Buffer.concat([Buffer.from(keys.publicKeySpki), Buffer.from([0])]),
    });
    const before = await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id);
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
    });
    const c = await challenge(keys);
    const response = await complete(c);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ protocol: 1, result: "device_key_conflict" });
    expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(
      before,
    );
  });

  it("requires strict initiation fields and refuses invalid proofs uniformly without allocating", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, owner.id, new Date());
    for (const keys of [paired, fleetKeyPair()]) {
      const body = initiationBody(keys);
      for (const change of [
        { initiation_signature: "A".repeat(86) },
        { request_id: "A".repeat(42) + "B" },
        { issued_at: "2026-02-30T12:00:00.000Z" },
      ]) {
        const response = await beginRoute(request(PATH, { ...body, ...change }));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ protocol: 1, error: "unauthorized" });
      }
      const missing = await beginRoute(
        request(PATH, {
          protocol: 1,
          public_key_spki_b64url: body.public_key_spki_b64url,
        }),
      );
      expect(missing.status).toBe(400);
    }
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
  });

  it.each(["55P03", "57014"])(
    "issuance timeout %s remains generic transport failure without a consumption claim",
    async (code) => {
      const c = await challenge();
      const response = await withInjectedPgFault(
        getDb().$client,
        { matchSql: /insert into "fleet_device_session"/i, code },
        () => complete(c),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        protocol: 1,
        error: "service_unavailable",
      });
      const [row] = await ctx.db.select().from(fleetRecoveryChallenge);
      expect(row.consumedAt).toBeNull();
      expect((await complete(c)).status).toBe(200);
    },
  );

  it("bounds a real canonical-key lock wait with fixed transport retry and no allocation", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const keys = await pairDevice(ctx.db, owner.id, new Date());
    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(5, hashtext($1))", [
        Buffer.from(keys.publicKeySpki).toString("base64"),
      ]);
      const response = await beginRoute(request(PATH, initiationBody(keys)));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        protocol: 1,
        error: "service_unavailable",
      });
      expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect((await challenge(keys)).challenge_id).toBeTruthy();
  });

  it("reports an outer transaction failure as a fixed transport refusal, never a proven result", async () => {
    const c = await challenge();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await withInjectedPgFault(
        getDb().$client,
        { matchSql: /pg_advisory_xact_lock_shared/i, code: "40001" },
        () => complete(c),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        protocol: 1,
        error: "service_unavailable",
      });
      const [row] = await ctx.db.select().from(fleetRecoveryChallenge);
      expect(row.consumedAt).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("unwraps the closed reconnected DTO and the new credential works on the actual signed device route", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(
      ctx.db,
      member.id,
      new Date(Date.now() - 31 * 60000),
      [SHARED_CAPABILITY],
    );
    const c = await challenge(paired);
    const response = await complete(c);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      protocol: 1,
      result: "reconnected",
      device_id: paired.device.id,
      session_id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      session_expires_at: expect.stringMatching(/Z$/),
      approved_capabilities: [SHARED_CAPABILITY],
      participation: { enabled: false, generation: 0 },
    });
    const replay = await complete(c);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ protocol: 1, error: "unauthorized" });
    const bodySha256 = createHash("sha256").update("").digest("hex");
    const issuedAt = new Date().toISOString();
    const signature = sign(
      null,
      canonicalFleetRequest({
        protocol: 1,
        method: "GET",
        path: "/api/fleet/v1/device",
        sessionId: body.session_id,
        issuedAt,
        revision: 1,
        bodySha256,
      }),
      paired.privateKey,
    ).toString("base64url");
    const device = await deviceRoute(
      new NextRequest("https://auth.example/api/fleet/v1/device", {
        headers: {
          "x-fleet-session": body.session_id,
          "x-fleet-issued-at": issuedAt,
          "x-fleet-revision": "1",
          "x-fleet-body-sha256": bodySha256,
          "x-fleet-signature": signature,
        },
      }),
    );
    expect(device.status).toBe(200);
    expect(await device.json()).toMatchObject({
      acknowledged_capabilities: [],
      session_approved_capabilities: [SHARED_CAPABILITY],
    });
  });

  it("ignores caller Origin/Host for proof verification; the configured canonical origin is authoritative", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, new Date());
    const c = await challenge(paired);
    const refused = await complete(c, "https://attacker.example");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ protocol: 1, error: "unauthorized" });
    expect((await complete(c)).status).toBe(200);
  });

  it("exposes revocation only for a proven key; browser cookies and wrong signatures cannot serve as proof", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, owner.id, new Date());
    await revokeFleetDevice(ctx.db, paired.device.id, owner.id, new Date());
    const c = await challenge(paired);
    const bad = request(`${PATH}/${c.challenge_id}/complete`, {
      protocol: 1,
      nonce: c.nonce,
      recovery_signature: "A".repeat(86),
    });
    bad.headers.set("cookie", "authgd_session=browser-cookie");
    const refused = await completeRoute(bad, {
      params: Promise.resolve({ id: c.challenge_id }),
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ protocol: 1, error: "unauthorized" });
    const proven = await complete(c);
    expect(await proven.json()).toEqual({ protocol: 1, result: "device_revoked" });
  });

  it("maps proven Member loss and transient issuance failure to bounded retry DTOs", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, new Date());
    await ctx.db.update(account).set({ tier: "alumni" }).where(eq(account.id, member.id));
    const ineligible = await complete(await challenge(paired));
    expect(ineligible.status).toBe(200);
    expect(await ineligible.json()).toEqual({
      protocol: 1,
      result: "account_ineligible",
      retry_after_ms: 60000,
    });
    await ctx.db.update(account).set({ tier: "member" }).where(eq(account.id, member.id));
    const c = await challenge(paired);
    const retry = await withInjectedPgFault(
      getDb().$client,
      { matchSql: /insert into "fleet_device_session"/i, code: "40001" },
      () => complete(c),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      protocol: 1,
      result: "retry_later",
      retry_after_ms: 1000,
    });
    expect((await complete(c)).status).toBe(401);
  });

  it("uniformly refuses unknown/expired/consumed/malformed challenge identities", async () => {
    const c = await challenge();
    expect((await complete(c)).status).toBe(200);
    expect((await complete(c)).status).toBe(401);
    const expired = await challenge();
    await ctx.db
      .update(fleetRecoveryChallenge)
      .set({ expiresAt: new Date(0) })
      .where(eq(fleetRecoveryChallenge.id, expired.challenge_id));
    expect((await complete(expired)).status).toBe(401);
    const body = { protocol: 1, nonce: c.nonce, recovery_signature: "A".repeat(86) };
    for (const id of [
      c.challenge_id,
      "00000000-0000-0000-0000-000000000099",
      "not-a-uuid",
    ]) {
      const response = await completeRoute(request(`${PATH}/${id}/complete`, body), {
        params: Promise.resolve({ id }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ protocol: 1, error: "unauthorized" });
    }
  });

  it("uniformly gates disabled mode and bounds per-key requests without state disclosure", async () => {
    const keys = await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      new Date(),
    );
    const c = await challenge(keys);
    for (let i = 0; i < 3; i++) await challenge(keys);
    const limited = await beginRoute(request(PATH, initiationBody(keys)));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ protocol: 1, error: "rate_limited" });
    await transitionFleetSharingMode(ctx.db, { enabled: false, expectedRevision: 3 });
    const disabled = await beginRoute(request(PATH, initiationBody(keys)));
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ protocol: 1, error: "feature_disabled" });
    const completion = await complete(c);
    expect(completion.status).toBe(503);
    expect(await completion.json()).toEqual({ protocol: 1, error: "feature_disabled" });
  });

  it.each(["begin", "complete"])(
    "strictly bounds and validates the %s envelope",
    async (which) => {
      const c = await challenge();
      const path = which === "begin" ? PATH : `${PATH}/${c.challenge_id}/complete`;
      const body =
        which === "begin"
          ? initiationBody(c.keys)
          : { protocol: 1, nonce: c.nonce, recovery_signature: "A".repeat(86) };
      const call = (req: NextRequest) =>
        which === "begin"
          ? beginRoute(req)
          : completeRoute(req, { params: Promise.resolve({ id: c.challenge_id }) });
      for (const extra of [
        { origin: "https://attacker.example" },
        { requested_capabilities: [SHARED_CAPABILITY] },
        { account_id: "forged" },
        { participation: true },
      ]) {
        const res = await call(request(path, { ...body, ...extra }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ protocol: 1, error: "bad_request" });
      }
      const version = await call(request(path, { ...body, protocol: 2 }));
      expect(await version.json()).toEqual({ protocol: 1, error: "update_required" });
      const query = await call(request(path + "?origin=forged", body));
      expect(query.status).toBe(400);
      for (const text of ["{bad json", "x".repeat(2049)]) {
        const res = await call(
          new NextRequest(`https://auth.example${path}`, { method: "POST", body: text }),
        );
        expect(res.status).toBe(400);
      }
    },
  );
});
