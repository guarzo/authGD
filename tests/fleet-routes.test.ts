import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, fleetDeviceSession } from "@/db/schema";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
} from "@/lib/fleet-route-auth";
import { canonicalFleetRequest } from "@/lib/fleet-signature";
import {
  approvePairing,
  beginPairing,
  pairingChallengePreimage,
  revokeFleetDevice,
} from "@/services/fleet-pairing";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  pairDevice,
  fleetKeyPair,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { combatAccounts } from "./helpers/fleet-combat";
import { POST as pairingRequestsRoute } from "@/app/api/fleet/v2/pairing-requests/route";
import { POST as completeRoute } from "@/app/api/fleet/v2/pairing-requests/[id]/complete/route";
import { GET as catalogueRoute } from "@/app/api/fleet/v2/catalogue/route";
import { PUT as sessionRenewRoute } from "@/app/api/fleet/v2/session/route";
import { GET as deviceGet, PUT as devicePut } from "@/app/api/fleet/v2/device/route";
import {
  GET as snapshotGet,
  PUT as snapshotPut,
} from "@/app/api/fleet/v2/snapshot/route";
process.env.DATABASE_URL = TEST_URL;
process.env.APP_BASE_URL = "https://auth.example";
const ROOT = "/api/fleet/v2/";
const SNAPSHOT_PATH = ROOT + "snapshot";
const CATALOGUE_PATH = ROOT + "catalogue";
const SESSION_PATH = ROOT + "session";
const cfg = testConfig();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
type Paired = Pick<Awaited<ReturnType<typeof pairDevice>>, "sessionId" | "privateKey">;
const raw = (body: unknown) =>
  Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
function signedRequest(
  p: Paired,
  method: "GET" | "PUT",
  path: string,
  body: unknown = "",
  revision = 1,
  query = "",
) {
  const bytes = raw(body);
  const fields = {
    protocol: 1 as const,
    method,
    path,
    sessionId: p.sessionId,
    issuedAt: new Date().toISOString(),
    revision,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
  };
  // Exact raw bytes and deployed signing1 are never translated from a v1 request.
  return new NextRequest(`https://auth.example${path}${query}`, {
    method,
    headers: {
      "x-fleet-session": p.sessionId,
      "x-fleet-issued-at": fields.issuedAt,
      "x-fleet-revision": String(revision),
      "x-fleet-body-sha256": fields.bodySha256,
      "x-fleet-signature": sign(
        null,
        canonicalFleetRequest(fields),
        p.privateKey,
      ).toString("base64url"),
    },
    ...(method === "PUT" ? { body: new Uint8Array(bytes) } : {}),
  });
}
function post(path: string, body: unknown) {
  return new NextRequest(`https://auth.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fleet-attempt": randomBytes(32).toString("base64url"),
    },
    body: new Uint8Array(raw(body)),
  });
}
async function memberPair(capabilities: string[] = []) {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  return { ...(await pairDevice(ctx.db, owner.id, new Date(), capabilities)), owner };
}
async function enabled() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  return ready;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 600));
const snapshotRequest = (
  p: Paired,
  method: "GET" | "PUT",
  revision: number,
  body: unknown = "",
  query = "",
) => signedRequest(p, method, SNAPSHOT_PATH, body, revision, query);
const currentFleet = () => combatAccounts(ctx.db, new Date(Date.now() - 3000));
const wireCombatRow = (character_id: number, outgoing_dps: number) => ({
  character_id,
  outgoing_dps,
  incoming_dps: null,
  activity_age_ms: 0,
  effects: [],
});
const deviceRequest = (
  p: Paired,
  method: "GET" | "PUT",
  body: unknown = "",
  revision = 1,
  query = "",
) => signedRequest(p, method, ROOT + "device", body, revision, query);
const catalogueRequest = (p: Paired, revision = 1, query = "") =>
  signedRequest(p, "GET", CATALOGUE_PATH, "", revision, query);
const renewalRequest = (p: Paired, revision = 1, query = "") =>
  signedRequest(p, "PUT", SESSION_PATH, { protocol: 2 }, revision, query);

// Production admission uses PostgreSQL after the actual wait. Unlike the former
// application-Date test, advancing a fake JS clock cannot make this test pass.
describe("production signed-route admission clock", () => {
  it.each([
    ["GET", CATALOGUE_PATH, catalogueRoute, 403],
    ["PUT", SESSION_PATH, sessionRenewRoute, 401],
  ] as const)(
    "%s %s does not admit a session that expired while waiting for its device lock",
    async (method, path, route, status) => {
      const p = await memberPair();
      const now = (await ctx.pool.query<{ now: Date }>("select clock_timestamp() as now"))
        .rows[0].now;
      const expiresAt = new Date(now.getTime() + 1000);
      await ctx.db
        .update(fleetDeviceSession)
        .set({ expiresAt })
        .where(eq(fleetDeviceSession.deviceId, p.device.id));
      const client = await ctx.pool.connect();
      let pending: ReturnType<typeof route> | undefined;
      try {
        await client.query("begin");
        const pid = (
          await client.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0].pid;
        await client.query("select id from fleet_device where id=$1 for update", [
          p.device.id,
        ]);
        pending = route(
          signedRequest(p, method, path, method === "PUT" ? { protocol: 2 } : ""),
        );
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        await client.query(
          "select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz-clock_timestamp()))))",
          [expiresAt],
        );
        await client.query("commit");
        expect((await pending).status).toBe(status);
        expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(0);
      } finally {
        await client.query("rollback");
        client.release();
        await pending;
      }
    },
  );
});
describe("explicit shared device wire contract", () => {
  it("returns explicit device versus session grants and participation without a browser cookie or roster", async () => {
    const p = await memberPair();
    const res = await deviceGet(deviceRequest(p, "GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [s] = await ctx.db.select().from(fleetDeviceSession);
    expect(await res.json()).toEqual({
      protocol: 2,
      server_time_ms: s.lastReadAt!.getTime(),
      device_id: p.device.id,
      session_expires_at: s.expiresAt.toISOString(),
      feature_enabled: false,
      approved_capabilities: [],
      session_approved_capabilities: [],
      acknowledged_capabilities: [],
      participation: { enabled: false, generation: 0 },
    });
  });
  it("binds explicit requested capabilities at enrollment and gates only shared requests while disabled", async () => {
    const keys = fleetKeyPair();
    const body = {
      protocol: 2,
      public_key_spki_b64url: Buffer.from(keys.publicKeySpki).toString("base64url"),
      requested_capabilities: [SHARED_CAPABILITY],
    };
    const disabled = await pairingRequestsRoute(post(ROOT + "pairing-requests", body));
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ protocol: 2, error: "feature_disabled" });
    const ready = await enabled();
    const res = await pairingRequestsRoute(post(ROOT + "pairing-requests", body));
    expect(res.status).toBe(200);
    const { pairing_id: id } = (await res.json()) as { pairing_id: string };
    await approvePairing(ctx.db, id, (await seedAccount(ctx.db, { tier: "member" })).id);
    await transitionFleetSharingMode(ctx.db, {
      enabled: false,
      expectedRevision: ready.revision + 1,
    });
    const refused = await completeRoute(
      post(ROOT + `pairing-requests/${id}/complete`, {
        protocol: 2,
        completion_signature: "A".repeat(86),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ protocol: 2, error: "feature_disabled" });
  });
  it("acknowledges the approved ceiling via the real signed PUT and shares read cadence", async () => {
    await enabled();
    const p = await memberPair([SHARED_CAPABILITY]);
    const body = { protocol: 2, capabilities: [SHARED_CAPABILITY] };
    const ack = await devicePut(deviceRequest(p, "PUT", body));
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({
      approved_capabilities: [SHARED_CAPABILITY],
      session_approved_capabilities: [SHARED_CAPABILITY],
      acknowledged_capabilities: [SHARED_CAPABILITY],
      participation: { enabled: false, generation: 0 },
    });
    expect((await deviceGet(deviceRequest(p, "GET", "", 2))).status).toBe(429);
    expect((await devicePut(deviceRequest(p, "PUT", body))).status).toBe(409);
  });
  it("legacy signed sessions cannot approve themselves into the shared model", async () => {
    await enabled();
    const p = await memberPair();
    const ack = await devicePut(
      deviceRequest(p, "PUT", { protocol: 2, capabilities: [SHARED_CAPABILITY] }),
    );
    expect(ack.status).toBe(403);
    expect(await ack.json()).toEqual({ protocol: 2, error: "capability_required" });
  });
  it.each([
    { value: { protocol: 2, capabilities: ["unknown"] }, error: "bad_request" },
    {
      value: { protocol: 2, capabilities: [SHARED_CAPABILITY, SHARED_CAPABILITY] },
      error: "bad_request",
    },
    {
      value: { protocol: 2, capabilities: [], account_id: "forged" },
      error: "bad_request",
    },
    { value: { protocol: 2, capabilities: [], fleet_id: 6200001 }, error: "bad_request" },
    { value: { protocol: 3, capabilities: [] }, error: "update_required" },
  ])("refuses unsigned selectors/unknown schema: $value", async ({ value, error }) => {
    const p = await memberPair();
    const result = await devicePut(deviceRequest(p, "PUT", value));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ protocol: 2, error });
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(0);
  });
  it("refuses queries, oversized bodies, tampering, and unproven session states without an oracle", async () => {
    const p = await memberPair();
    expect(
      (await deviceGet(deviceRequest(p, "GET", "", 1, "?account_id=forged"))).status,
    ).toBe(400);
    expect((await devicePut(deviceRequest(p, "PUT", "x".repeat(1025)))).status).toBe(400);
    const tampered = deviceRequest(p, "PUT", { protocol: 2, capabilities: [] });
    tampered.headers.set("x-fleet-body-sha256", "0".repeat(64));
    const badProof = await devicePut(tampered);
    const unknown = await deviceGet(
      deviceRequest({ ...p, sessionId: "A".repeat(43) }, "GET"),
    );
    await ctx.db
      .update(fleetDeviceSession)
      .set({ expiresAt: new Date(0) })
      .where(eq(fleetDeviceSession.deviceId, p.device.id));
    const expired = await deviceGet(deviceRequest(p, "GET"));
    await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, new Date());
    const revoked = await deviceGet(deviceRequest(p, "GET"));
    for (const res of [badProof, unknown, expired, revoked]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ protocol: 2, error: "unauthorized" });
    }
  });
});
const pairingBody = (spki: Uint8Array) => ({
  protocol: 2,
  public_key_spki_b64url: Buffer.from(spki).toString("base64url"),
  requested_capabilities: [],
});
describe("POST /api/fleet/v2/pairing-requests", () => {
  it("issues a pairing id, approval url and expiry for a valid Ed25519 public key", async () => {
    const res = await pairingRequestsRoute(
      post(ROOT + "pairing-requests", pairingBody(fleetKeyPair().publicKeySpki)),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(2);
    expect(typeof body.pairing_id).toBe("string");
    expect(body.approval_url).toBe(`/fleet/pair/${body.pairing_id}`);
    expect(typeof body.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.expires_at as string))).toBe(false);
  });
  it("rejects an unsupported protocol major with update_required", async () => {
    const res = await pairingRequestsRoute(
      post(ROOT + "pairing-requests", {
        ...pairingBody(fleetKeyPair().publicKeySpki),
        protocol: 3,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("update_required");
  });
  it("rejects a malformed JSON body", async () => {
    const res = await pairingRequestsRoute(post(ROOT + "pairing-requests", "{not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });
  it("rejects a raw body over the size bound before ever parsing it", async () => {
    const res = await pairingRequestsRoute(
      post(ROOT + "pairing-requests", "x".repeat(3000)),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });
  it("rejects unknown fields under the strict schema", async () => {
    const res = await pairingRequestsRoute(
      post(ROOT + "pairing-requests", {
        ...pairingBody(fleetKeyPair().publicKeySpki),
        extra: "nope",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });
  it("collapses a non-Ed25519 key and a previously-revoked key into the same generic invalid_key code", async () => {
    // X25519 has Ed25519's bounded SPKI shape but a different algorithm OID.
    const wrong = generateKeyPairSync("x25519").publicKey.export({
      type: "spki",
      format: "der",
    });
    const p = await memberPair();
    await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, new Date());
    for (const spki of [wrong, p.publicKeySpki]) {
      const res = await pairingRequestsRoute(
        post(ROOT + "pairing-requests", pairingBody(spki)),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_key");
    }
  });
});
const completeRequest = (id: string, signature: string, protocol = 2) =>
  post(ROOT + `pairing-requests/${id}/complete`, {
    protocol,
    completion_signature: signature,
  });
const complete = (id: string, signature: string, protocol = 2) =>
  completeRoute(completeRequest(id, signature, protocol), {
    params: Promise.resolve({ id }),
  });
describe("POST /api/fleet/v2/pairing-requests/[id]/complete", () => {
  it("completes an approved pairing and returns a session id and mapped catalogue", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, { id: 92900001, accountId: owner.id });
    const keys = fleetKeyPair();
    const { pairingId } = await beginPairing(ctx.db, {
      publicKeySpki: keys.publicKeySpki,
    });
    await approvePairing(ctx.db, pairingId, owner.id);
    const res = await complete(
      pairingId,
      sign(null, pairingChallengePreimage(pairingId), keys.privateKey).toString(
        "base64url",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(2);
    expect(typeof body.session_id).toBe("string");
    expect(body.catalogue).toEqual({
      revision: expect.any(Number),
      characters: [{ character_id: ch.id, character_name: ch.name }],
    });
  });
  it("rejects an unsupported protocol major with update_required", async () => {
    const res = await complete("11111111-1111-4111-8111-111111111111", "A".repeat(86), 3);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("update_required");
  });
  it("rejects a malformed pairing id in the path with 404 not_found", async () => {
    const res = await complete("not-a-uuid", "A".repeat(86));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
  it("collapses unknown/expired/not-approved/wrong-signature/already-consumed into the same not_completable code", async () => {
    const refused = async (id: string, sig: string) => {
      const res = await complete(id, sig);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("not_completable");
    };
    await refused("11111111-1111-4111-8111-111111111111", "A".repeat(86));
    const keys = fleetKeyPair();
    const { pairingId } = await beginPairing(ctx.db, {
      publicKeySpki: keys.publicKeySpki,
    });
    const right = sign(
      null,
      pairingChallengePreimage(pairingId),
      keys.privateKey,
    ).toString("base64url");
    await refused(pairingId, right);
    const owner = await seedAccount(ctx.db, { tier: "member" });
    await approvePairing(ctx.db, pairingId, owner.id);
    await refused(
      pairingId,
      sign(null, pairingChallengePreimage(pairingId), fleetKeyPair().privateKey).toString(
        "base64url",
      ),
    );
    await seedCharacter(ctx.db, cfg, { id: 92900002, accountId: owner.id });
    // Prove the first call consumed: any other refusal would make replay vacuous.
    expect((await complete(pairingId, right)).status).toBe(200);
    await refused(pairingId, right);
    const expired = await beginPairing(ctx.db, {
      publicKeySpki: keys.publicKeySpki,
      now: new Date(Date.now() - 11 * 60000),
    });
    await refused(expired.pairingId, "A".repeat(86));
  });
});
describe("GET /api/fleet/v2/catalogue", () => {
  it("refuses a request with no signed headers at all, even one carrying a browser session cookie", async () => {
    const res = await catalogueRoute(
      new NextRequest(`https://auth.example${CATALOGUE_PATH}`, {
        headers: { cookie: "authgd_session=some-value" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
  it("refuses a request whose X-Fleet-Revision header was sent twice", async () => {
    const req = catalogueRequest(await memberPair(), 5);
    req.headers.append("x-fleet-revision", "7");
    const res = await catalogueRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
  it("returns the account's own catalogue for a validly signed request", async () => {
    const p = await memberPair();
    const ch = await seedCharacter(ctx.db, cfg, { id: 92900010, accountId: p.owner.id });
    const res = await catalogueRoute(catalogueRequest(p));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      protocol: 2,
      revision: expect.any(Number),
      characters: [{ character_id: ch.id, character_name: ch.name }],
    });
  });
  it("collapses an unknown session and a revoked device's session into the same unauthorized code", async () => {
    const p = await memberPair();
    const unknown = await catalogueRoute(
      catalogueRequest({ ...p, sessionId: "A".repeat(43) }),
    );
    await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, new Date());
    const revoked = await catalogueRoute(catalogueRequest(p));
    for (const res of [unknown, revoked]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    }
  });
  it("refuses a request whose signature does not match a real, unexpired session", async () => {
    const p = await memberPair();
    const res = await catalogueRoute(
      catalogueRequest({ ...p, privateKey: fleetKeyPair().privateKey }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });
  it("rejects a signed request carrying a query string, even though nothing in the handler reads one", async () => {
    const res = await catalogueRoute(catalogueRequest(await memberPair(), 1, "?foo=bar"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
  it("refuses a replayed (non-increasing) revision and enforces the read cadence, exactly like GET /snapshot", async () => {
    const p = await memberPair();
    await seedCharacter(ctx.db, cfg, { id: 92900040, accountId: p.owner.id });
    expect((await catalogueRoute(catalogueRequest(p))).status).toBe(200);
    const replay = await catalogueRoute(catalogueRequest(p));
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("revision_replayed");
    const soon = await catalogueRoute(catalogueRequest(p, 2));
    expect(soon.status).toBe(429);
    expect((await soon.json()).error).toBe("rate_limited");
  });
  it("shares its revision counter and read cadence bucket with GET /snapshot -- a catalogue fetch cannot dodge either by switching endpoints", async () => {
    const p = await currentFleet();
    expect((await catalogueRoute(catalogueRequest(p.b, 3))).status).toBe(200);
    const replay = await snapshotGet(snapshotRequest(p.b, "GET", 3));
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("revision_replayed");
    const soon = await snapshotGet(snapshotRequest(p.b, "GET", 4));
    expect(soon.status).toBe(429);
    expect((await soon.json()).error).toBe("rate_limited");
    // Real elapsed DB time, not a fabricated issued_at claim, opens the bucket.
    await pause();
    expect((await snapshotGet(snapshotRequest(p.b, "GET", 4))).status).toBe(200);
  });
});
describe("PUT /api/fleet/v2/snapshot", () => {
  it("accepts a validly signed complete batch through real shared source authority", async () => {
    const p = await currentFleet();
    const res = await snapshotPut(
      snapshotRequest(p.b, "PUT", 3, {
        protocol: 2,
        sampled_at_ms: Date.now() - 100,
        rows: [
          {
            ...wireCombatRow(p.alts[0].id, 1000),
            effects: [{ kind: "POINT", observations: [{ name: null, age_ms: 0 }] }],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: 2 });
  });
  it("rejects a valid padded body over 512KiB before service admission", async () => {
    const p = await currentFleet();
    const before = await ctx.db.select().from(fleetDeviceSession);
    const res = await snapshotPut(
      snapshotRequest(
        p.b,
        "PUT",
        3,
        '{"protocol":2,"sampled_at_ms":0,"rows":[]}'.padEnd(524289, " "),
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  });
  it("rejects unknown fields and duplicate character IDs as whole requests", async () => {
    const p = await currentFleet();
    const before = await ctx.db.select().from(fleetDeviceSession);
    for (const body of [
      { protocol: 2, sampled_at_ms: 0, rows: [], extra: true },
      {
        protocol: 2,
        sampled_at_ms: Date.now() - 100,
        rows: [wireCombatRow(p.alts[0].id, 1), wireCombatRow(p.alts[0].id, 2)],
      },
    ]) {
      const res = await snapshotPut(snapshotRequest(p.b, "PUT", 3, body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("bad_request");
    }
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  });
  it("rejects an unsupported integer protocol as update_required before admission", async () => {
    const p = await currentFleet();
    const before = await ctx.db.select().from(fleetDeviceSession);
    const res = await snapshotPut(
      snapshotRequest(p.b, "PUT", 3, { protocol: 1, rows: [] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("update_required");
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  });
  it("maps current source not_verified refusal to its documented HTTP status", async () => {
    const p = await currentFleet();
    const res = await snapshotPut(
      snapshotRequest(p.b, "PUT", 3, {
        protocol: 2,
        sampled_at_ms: Date.now() - 100,
        rows: [wireCombatRow(p.alts[2].id, 1)],
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_verified");
  });
  it("refuses a wrong-key signed request as unauthorized without admission", async () => {
    const p = await currentFleet();
    const before = await ctx.db.select().from(fleetDeviceSession);
    const res = await snapshotPut(
      snapshotRequest({ ...p.b, privateKey: fleetKeyPair().privateKey }, "PUT", 3, {
        protocol: 2,
        sampled_at_ms: 0,
        rows: [],
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  });
  it("rejects a signed request carrying a query string", async () => {
    const p = await currentFleet();
    const res = await snapshotPut(
      snapshotRequest(p.b, "PUT", 3, { protocol: 2, sampled_at_ms: 0, rows: [] }, "?x=1"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
});
describe("GET /api/fleet/v2/snapshot", () => {
  it("returns the requester's own live fleet rows for a validly signed request", async () => {
    const p = await currentFleet();
    const sample = Date.now() - 100;
    expect(
      (
        await snapshotPut(
          snapshotRequest(p.b, "PUT", 3, {
            protocol: 2,
            sampled_at_ms: sample,
            rows: [wireCombatRow(p.alts[0].id, 500)],
          }),
        )
      ).status,
    ).toBe(200);
    const res = await snapshotGet(snapshotRequest(p.b, "GET", 4));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fleet-request-binding")).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.has("x-fleet-snapshot-format")).toBe(false);
    const body = await res.json();
    expect(body.protocol).toBe(2);
    expect(body.rows).toHaveLength(1);
    const [seen] = body.rows;
    expect(seen.character_id).toBe(p.alts[0].id);
    expect(seen.character_name).toBe(p.alts[0].name);
    expect(seen.outgoing_dps).toBe(500);
    expect(seen.incoming_dps).toBeNull();
    expect(seen.effects).toEqual([]);
    expect(seen.state).toBe("live");
    expect(seen.age_ms).toBeGreaterThanOrEqual(0);
    expect(seen.age_ms).toBeLessThan(3000);
    expect(seen.age_ms).toBe(body.server_time_ms - sample);
    expect(seen.activity_age_ms).toBe(body.server_time_ms - sample);
    expect(seen.publication_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("refuses a canonical unknown session with 401 unauthorized", async () => {
    const res = await snapshotGet(
      snapshotRequest({ ...fleetKeyPair(), sessionId: "A".repeat(43) }, "GET", 1),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });
  it("rejects a signed request carrying a query string", async () => {
    const p = await currentFleet();
    const res = await snapshotGet(snapshotRequest(p.b, "GET", 3, "", "?x=1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
});
describe("authenticateFleetRequest: canonical-path guard", () => {
  it("refuses a control character in the canonical path as bad_headers, before any DB lookup", async () => {
    const p = await memberPair();
    const parsed = extractFleetAuthHeaders(signedRequest(p, "GET", CATALOGUE_PATH));
    if (!parsed) throw new Error("unreachable");
    expect(
      await authenticateFleetRequest(ctx.db, parsed, new Uint8Array(), {
        method: "GET",
        path: CATALOGUE_PATH + "\u0000",
        now: new Date(),
      }),
    ).toEqual({ ok: false, code: "bad_headers" });
  });
});
describe("PUT /api/fleet/v2/session", () => {
  it("extends a validly signed device's session and returns its new expiry", async () => {
    const p = await memberPair();
    const now = Date.now();
    const res = await sessionRenewRoute(renewalRequest(p));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(2);
    expect(typeof body.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.expires_at as string))).toBe(false);
    expect(Date.parse(body.expires_at as string)).toBeGreaterThan(now);
  });
  it("refuses an unauthenticated request with 401 unauthorized", async () => {
    const p = await memberPair();
    const res = await sessionRenewRoute(
      renewalRequest({ ...p, privateKey: fleetKeyPair().privateKey }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });
  it("refuses a replayed revision with 409, and a too-soon retry with 429, then succeeds once past both", async () => {
    const p = await memberPair();
    expect((await sessionRenewRoute(renewalRequest(p))).status).toBe(200);
    const replay = await sessionRenewRoute(renewalRequest(p));
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("revision_replayed");
    const soon = await sessionRenewRoute(renewalRequest(p, 2));
    expect(soon.status).toBe(429);
    expect((await soon.json()).error).toBe("rate_limited");
    await pause();
    expect((await sessionRenewRoute(renewalRequest(p, 2))).status).toBe(200);
  });
  it("refuses with 403 forbidden once the account has dropped below Member tier", async () => {
    const p = await memberPair();
    await ctx.db
      .update(account)
      .set({ tier: "alumni" })
      .where(eq(account.id, p.owner.id));
    const res = await sessionRenewRoute(renewalRequest(p));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });
  it("rejects a signed request carrying a query string", async () => {
    const res = await sessionRenewRoute(renewalRequest(await memberPair(), 1, "?x=1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
});
