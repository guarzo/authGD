import { createHash, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { account, fleetDevice, fleetEligibility } from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  authenticateFleetRequest,
  extractFleetAuthHeaders,
} from "@/lib/fleet-route-auth";
import {
  canonicalDevicePublicKeyB64,
  canonicalFleetRequest,
} from "@/lib/fleet-signature";
import {
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
  revokeFleetDevice,
} from "@/services/fleet-pairing";
import { setupTestDb, TEST_URL } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";

// Route modules read config + db lazily via getConfig()/getDb(); set env
// first, mirroring tests/auth-routes.test.ts.
process.env.DATABASE_URL = TEST_URL;
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.ALLIANCE_ID = "99000001";
process.env.EVE_SSO_CLIENT_ID = "cid";
process.env.EVE_SSO_CLIENT_SECRET = "sec";
process.env.EVE_SSO_SCOPES = "esi-characters.read_contacts.v1";
process.env.DISCORD_CLIENT_ID = "d";
process.env.DISCORD_CLIENT_SECRET = "d";
process.env.DISCORD_BOT_TOKEN = "d";
process.env.DISCORD_GUILD_ID = "1";
process.env.DISCORD_ROLE_ID_MEMBER = "10";
process.env.DISCORD_ROLE_ID_ASSOCIATE = "11";
process.env.DISCORD_ROLE_ID_ALUMNI = "12";
process.env.WANDERER_BASE_URL = "https://w.example";
process.env.WANDERER_API_KEY = "k";
process.env.WANDERER_ACL_ID = "a";
process.env.ESI_CONTACT = "ops@example.com";
process.env.SYNC_MODE = "live";

const { POST: pairingRequestsRoute } =
  await import("@/app/api/fleet/v1/pairing-requests/route");
const { POST: completeRoute } =
  await import("@/app/api/fleet/v1/pairing-requests/[id]/complete/route");
const { GET: catalogueRoute } = await import("@/app/api/fleet/v1/catalogue/route");
const { PUT: snapshotPut, GET: snapshotGet } =
  await import("@/app/api/fleet/v1/snapshot/route");
const { PUT: sessionRenewRoute } = await import("@/app/api/fleet/v1/session/route");

const cfg = testConfig();
// Real wall-clock time, deliberately, unlike the fixed literal `NOW` fleet-
// pairing.test.ts/fleet-relay.test.ts use: those call the SERVICE layer
// directly, which takes an explicit `now: Date` parameter precisely so tests
// can pin it. These route handlers call `new Date()` themselves internally
// (the same convention every other route in this codebase already follows,
// e.g. src/services/session.ts) rather than accepting an injected clock, so
// a signed request's `X-Fleet-Issued-At` has to sit within `verifyFleetRequest`'s
// +-60s skew window of whatever real moment the route actually runs at.
const NOW = new Date();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  return { spki, privateKey };
}

/** Runs the real pairing lifecycle (begin -> approve -> complete), exactly
 *  as tests/fleet-relay.test.ts's identically-named helper does, so route
 *  tests exercise a genuine hashed device session rather than a hand-crafted
 *  one. Kept as its own local copy rather than imported from that test file:
 *  this repo's convention (see fleet-pairing.test.ts vs fleet-relay.test.ts)
 *  is each test file owns its own fixture helpers. */
async function pairDevice(db: Db, accountId: string, now: Date) {
  const { spki, privateKey } = newKeyPair();
  const { pairingId } = await beginPairing(db, { publicKeySpki: spki, now });
  await approvePairing(db, pairingId, accountId, now);
  const completionSignature = ed25519Sign(
    null,
    pairingChallengePreimage(pairingId),
    privateKey,
  ).toString("base64url");
  const { sessionId } = await completePairing(db, {
    pairingId,
    completionSignature,
    now,
  });
  const [device] = await db
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.publicKeySpkiB64, canonicalDevicePublicKeyB64(spki)));
  return { sessionId, privateKey, spki, device };
}

async function seedEligibleCharacter(
  db: Db,
  opts: { characterId: number; accountId: string; fleetId: number; now: Date },
) {
  await seedCharacter(db, cfg, {
    id: opts.characterId,
    accountId: opts.accountId,
    scopes: [FLEET_READ_SCOPE],
  });
  await db.insert(fleetEligibility).values({
    characterId: opts.characterId,
    accountId: opts.accountId,
    fleetId: opts.fleetId,
    rosterCharacterIds: [opts.characterId],
    verifiedAt: opts.now,
    expiresAt: new Date(opts.now.getTime() + 60_000),
    outcomeCode: "ok",
  });
}

/** Builds the five `X-Fleet-*` headers a real device would sign, over the
 *  exact raw body bytes being sent — the same canonical contract
 *  fleet-signature.ts's `verifyFleetRequest` checks a request against. */
function signedHeaders(opts: {
  privateKey: ReturnType<typeof newKeyPair>["privateKey"];
  method: "GET" | "PUT";
  path: string;
  sessionId: string;
  issuedAt: string;
  revision: number;
  body: Uint8Array;
}): Headers {
  const bodySha256 = createHash("sha256").update(opts.body).digest("hex");
  const canonical = canonicalFleetRequest({
    protocol: 1,
    method: opts.method,
    path: opts.path,
    sessionId: opts.sessionId,
    issuedAt: opts.issuedAt,
    revision: opts.revision,
    bodySha256,
  });
  const signature = ed25519Sign(null, canonical, opts.privateKey).toString("base64url");
  const headers = new Headers();
  headers.set("x-fleet-session", opts.sessionId);
  headers.set("x-fleet-issued-at", opts.issuedAt);
  headers.set("x-fleet-revision", String(opts.revision));
  headers.set("x-fleet-body-sha256", bodySha256);
  headers.set("x-fleet-signature", signature);
  return headers;
}

describe("POST /api/fleet/v1/pairing-requests", () => {
  it("issues a pairing id, approval url and expiry for a valid Ed25519 public key", async () => {
    const { spki } = newKeyPair();
    const req = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: 1,
        public_key_spki_b64url: Buffer.from(spki).toString("base64url"),
      }),
    });
    const res = await pairingRequestsRoute(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(1);
    expect(typeof body.pairing_id).toBe("string");
    expect(body.approval_url).toBe(`/fleet/pair/${body.pairing_id}`);
    expect(typeof body.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.expires_at as string))).toBe(false);
  });

  it("rejects an unsupported protocol major with update_required", async () => {
    const { spki } = newKeyPair();
    const req = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      body: JSON.stringify({
        protocol: 2,
        public_key_spki_b64url: Buffer.from(spki).toString("base64url"),
      }),
    });
    const res = await pairingRequestsRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("update_required");
  });

  it("rejects a malformed JSON body", async () => {
    const req = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      body: "{not json",
    });
    const res = await pairingRequestsRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("rejects a raw body over the size bound before ever parsing it", async () => {
    const req = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      body: "x".repeat(3000),
    });
    const res = await pairingRequestsRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("rejects unknown fields under the strict schema", async () => {
    const { spki } = newKeyPair();
    const req = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      body: JSON.stringify({
        protocol: 1,
        public_key_spki_b64url: Buffer.from(spki).toString("base64url"),
        extra: "nope",
      }),
    });
    const res = await pairingRequestsRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("collapses a non-Ed25519 key and a previously-revoked key into the same generic invalid_key code", async () => {
    // X25519 SPKI DER is the same 44 bytes/59-base64url-character shape as
    // Ed25519 (same SubjectPublicKeyInfo structure, different OID), so this
    // clears the route's size pre-check and reaches beginPairing's own
    // algorithm check -- unlike an RSA key, which is large enough to be
    // rejected earlier, at the schema layer, as bad_request instead.
    const { publicKey } = generateKeyPairSync("x25519");
    const wrongAlgoSpki = publicKey.export({ type: "spki", format: "der" });
    const badAlgo = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      body: JSON.stringify({
        protocol: 1,
        public_key_spki_b64url: wrongAlgoSpki.toString("base64url"),
      }),
    });
    const badAlgoRes = await pairingRequestsRoute(badAlgo);
    expect(badAlgoRes.status).toBe(400);
    expect((await badAlgoRes.json()).error).toBe("invalid_key");

    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki, device } = await pairDevice(ctx.db, acc.id, NOW);
    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);
    const revokedReq = new NextRequest("http://localhost/api/fleet/v1/pairing-requests", {
      method: "POST",
      body: JSON.stringify({
        protocol: 1,
        public_key_spki_b64url: Buffer.from(spki).toString("base64url"),
      }),
    });
    const revokedRes = await pairingRequestsRoute(revokedReq);
    expect(revokedRes.status).toBe(400);
    expect((await revokedRes.json()).error).toBe("invalid_key");
  });
});

describe("POST /api/fleet/v1/pairing-requests/[id]/complete", () => {
  it("completes an approved pairing and returns a session id and mapped catalogue", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, { id: 92900001, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    const signature = ed25519Sign(
      null,
      pairingChallengePreimage(pairingId),
      privateKey,
    ).toString("base64url");
    const req = new NextRequest(
      `http://localhost/api/fleet/v1/pairing-requests/${pairingId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ protocol: 1, completion_signature: signature }),
      },
    );
    const res = await completeRoute(req, { params: Promise.resolve({ id: pairingId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(1);
    expect(typeof body.session_id).toBe("string");
    expect(body.catalogue).toEqual({
      revision: expect.any(Number),
      characters: [{ character_id: ch.id, character_name: ch.name }],
    });
  });

  it("rejects an unsupported protocol major with update_required", async () => {
    const req = new NextRequest(
      "http://localhost/api/fleet/v1/pairing-requests/00000000-0000-0000-0000-000000000001/complete",
      {
        method: "POST",
        body: JSON.stringify({ protocol: 2, completion_signature: "a".repeat(86) }),
      },
    );
    const res = await completeRoute(req, {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("update_required");
  });

  it("rejects a malformed pairing id in the path with 404 not_found", async () => {
    const req = new NextRequest(
      "http://localhost/api/fleet/v1/pairing-requests/not-a-uuid/complete",
      {
        method: "POST",
        body: JSON.stringify({ protocol: 1, completion_signature: "a".repeat(86) }),
      },
    );
    const res = await completeRoute(req, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("collapses unknown/expired/not-approved/wrong-signature/already-consumed into the same not_completable code", async () => {
    const unknownId = "00000000-0000-0000-0000-000000000099";
    const unknownReq = new NextRequest(
      `http://localhost/api/fleet/v1/pairing-requests/${unknownId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ protocol: 1, completion_signature: "a".repeat(86) }),
      },
    );
    const unknownRes = await completeRoute(unknownReq, {
      params: Promise.resolve({ id: unknownId }),
    });
    expect(unknownRes.status).toBe(409);
    expect((await unknownRes.json()).error).toBe("not_completable");

    // Not yet approved.
    const { spki, privateKey } = newKeyPair();
    const { pairingId: pendingId } = await beginPairing(ctx.db, {
      publicKeySpki: spki,
      now: NOW,
    });
    const pendingSig = ed25519Sign(
      null,
      pairingChallengePreimage(pendingId),
      privateKey,
    ).toString("base64url");
    const pendingReq = new NextRequest(
      `http://localhost/api/fleet/v1/pairing-requests/${pendingId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ protocol: 1, completion_signature: pendingSig }),
      },
    );
    const pendingRes = await completeRoute(pendingReq, {
      params: Promise.resolve({ id: pendingId }),
    });
    expect(pendingRes.status).toBe(409);
    expect((await pendingRes.json()).error).toBe("not_completable");

    // Wrong signature.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { pairingId: approvedId } = await beginPairing(ctx.db, {
      publicKeySpki: spki,
      now: NOW,
    });
    await approvePairing(ctx.db, approvedId, acc.id, NOW);
    const { privateKey: wrongKey } = newKeyPair();
    const wrongSig = ed25519Sign(
      null,
      pairingChallengePreimage(approvedId),
      wrongKey,
    ).toString("base64url");
    const wrongReq = new NextRequest(
      `http://localhost/api/fleet/v1/pairing-requests/${approvedId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ protocol: 1, completion_signature: wrongSig }),
      },
    );
    const wrongRes = await completeRoute(wrongReq, {
      params: Promise.resolve({ id: approvedId }),
    });
    expect(wrongRes.status).toBe(409);
    expect((await wrongRes.json()).error).toBe("not_completable");

    // Already consumed.
    await seedCharacter(ctx.db, cfg, { id: 92900002, accountId: acc.id });
    const rightSig = ed25519Sign(
      null,
      pairingChallengePreimage(approvedId),
      privateKey,
    ).toString("base64url");
    await completeRoute(
      new NextRequest(
        `http://localhost/api/fleet/v1/pairing-requests/${approvedId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ protocol: 1, completion_signature: rightSig }),
        },
      ),
      { params: Promise.resolve({ id: approvedId }) },
    );
    const consumedRes = await completeRoute(
      new NextRequest(
        `http://localhost/api/fleet/v1/pairing-requests/${approvedId}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ protocol: 1, completion_signature: rightSig }),
        },
      ),
      { params: Promise.resolve({ id: approvedId }) },
    );
    expect(consumedRes.status).toBe(409);
    expect((await consumedRes.json()).error).toBe("not_completable");
  });
});

describe("GET /api/fleet/v1/catalogue", () => {
  it("refuses a request with no signed headers at all, even one carrying a browser session cookie", async () => {
    const req = new NextRequest("http://localhost/api/fleet/v1/catalogue", {
      method: "GET",
      headers: { cookie: "authgd_session=some-value" },
    });
    const res = await catalogueRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });

  it("refuses a request whose X-Fleet-Revision header was sent twice", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const issuedAt = NOW.toISOString();
    const headers = signedHeaders({
      privateKey,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId,
      issuedAt,
      revision: 5,
      body: new Uint8Array(0),
    });
    headers.append("x-fleet-revision", "7"); // duplicate raw header line
    const req = new NextRequest("http://localhost/api/fleet/v1/catalogue", {
      method: "GET",
      headers,
    });
    const res = await catalogueRoute(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });

  it("returns the account's own catalogue for a validly signed request", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, { id: 92900010, accountId: acc.id });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const headers = signedHeaders({
      privateKey,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });
    const req = new NextRequest("http://localhost/api/fleet/v1/catalogue", {
      method: "GET",
      headers,
    });
    const res = await catalogueRoute(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      protocol: 1,
      revision: expect.any(Number),
      characters: [{ character_id: ch.id, character_name: ch.name }],
    });
  });

  it("collapses an unknown session and a revoked device's session into the same unauthorized code", async () => {
    const { privateKey } = newKeyPair();
    const unknownHeaders = signedHeaders({
      privateKey,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId: "a".repeat(32),
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });
    const unknownRes = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers: unknownHeaders,
      }),
    );
    expect(unknownRes.status).toBe(401);
    expect((await unknownRes.json()).error).toBe("unauthorized");

    const acc = await seedAccount(ctx.db, { tier: "member" });
    const {
      sessionId,
      privateKey: devicePrivateKey,
      device,
    } = await pairDevice(ctx.db, acc.id, NOW);
    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);
    const revokedHeaders = signedHeaders({
      privateKey: devicePrivateKey,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });
    const revokedRes = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers: revokedHeaders,
      }),
    );
    expect(revokedRes.status).toBe(401);
    expect((await revokedRes.json()).error).toBe("unauthorized");
  });

  it("refuses a request whose signature does not match a real, unexpired session", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    const { privateKey: wrongKey } = newKeyPair();
    const headers = signedHeaders({
      privateKey: wrongKey,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });
    const res = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers,
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("rejects a signed request carrying a query string, even though nothing in the handler reads one", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const headers = signedHeaders({
      privateKey,
      method: "GET",
      path: "/api/fleet/v1/catalogue",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });
    const res = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue?foo=bar", {
        method: "GET",
        headers,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });

  it("refuses a replayed (non-increasing) revision and enforces the read cadence, exactly like GET /snapshot", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92900040, accountId: acc.id });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);

    const first = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/catalogue",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(first.status).toBe(200);

    const replay = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/catalogue",
          sessionId,
          issuedAt: new Date().toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("revision_replayed");

    // Cadence is enforced against the SERVER's own real clock (this file's
    // top-of-file note: these route handlers call `new Date()` internally,
    // not an injected one), so this relies on real elapsed time rather than
    // a fabricated `issuedAt` offset -- a call immediately after `first`,
    // with no delay, is always well under the 500ms bound.
    const tooSoon = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/catalogue",
          sessionId,
          issuedAt: new Date().toISOString(),
          revision: 2,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(tooSoon.status).toBe(429);
    expect((await tooSoon.json()).error).toBe("rate_limited");
  });

  it("shares its revision counter and read cadence bucket with GET /snapshot -- a catalogue fetch cannot dodge either by switching endpoints", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedEligibleCharacter(ctx.db, {
      characterId: 92900041,
      accountId: acc.id,
      fleetId: 6300041,
      now: NOW,
    });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);

    const catalogueRes = await catalogueRoute(
      new NextRequest("http://localhost/api/fleet/v1/catalogue", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/catalogue",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(catalogueRes.status).toBe(200);

    // A snapshot GET replaying the SAME revision the catalogue fetch just
    // consumed is refused, even on a different endpoint.
    const snapshotReplay = await snapshotGet(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: new Date(NOW.getTime() + 600).toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(snapshotReplay.status).toBe(409);
    expect((await snapshotReplay.json()).error).toBe("revision_replayed");

    // A snapshot GET arriving too soon after the catalogue fetch (same read
    // cadence bucket) is refused too, even with a strictly greater revision.
    // Cadence is enforced against the SERVER's own real clock (these route
    // handlers call `new Date()` internally, per this file's own top-of-file
    // note -- `issuedAt` is the caller's claim, not what is compared), so
    // this relies on real elapsed time rather than a fabricated `issuedAt`
    // offset: back-to-back calls with no delay are always well under the
    // 500ms bound.
    const snapshotTooSoon = await snapshotGet(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: new Date().toISOString(),
          revision: 2,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(snapshotTooSoon.status).toBe(429);
    expect((await snapshotTooSoon.json()).error).toBe("rate_limited");

    await new Promise((resolve) => setTimeout(resolve, 600));
    const snapshotOk = await snapshotGet(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: new Date().toISOString(),
          revision: 2,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(snapshotOk.status).toBe(200);
  });
});

describe("PUT /api/fleet/v1/snapshot", () => {
  it("accepts a validly signed batch and relays replaceDeviceProjection's own success", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 92900020,
      accountId: acc.id,
      fleetId: 6300001,
      now: NOW,
    });
    const bodyObj = {
      protocol: 1,
      rows: [{ character_id: 92900020, dps: 1000, ewar: ["SCRAM/POINT"] }],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj));
    const headers = signedHeaders({
      privateKey,
      method: "PUT",
      path: "/api/fleet/v1/snapshot",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: bodyBytes,
    });
    const req = new NextRequest("http://localhost/api/fleet/v1/snapshot", {
      method: "PUT",
      headers,
      body: bodyBytes,
    });
    const res = await snapshotPut(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: 1 });
  });

  it("rejects a raw body over the size bound as invalid_batch, before authenticating or parsing", async () => {
    const req = new NextRequest("http://localhost/api/fleet/v1/snapshot", {
      method: "PUT",
      headers: {
        "x-fleet-session": "a".repeat(32),
        "x-fleet-issued-at": NOW.toISOString(),
        "x-fleet-revision": "1",
        "x-fleet-body-sha256": "0".repeat(64),
        "x-fleet-signature": "a".repeat(86),
      },
      body: "x".repeat(9000),
    });
    const res = await snapshotPut(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_batch");
  });

  it("rejects unknown fields and duplicate character ids under the strict schema, only after authenticating", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);

    const extraFieldBody = new TextEncoder().encode(
      JSON.stringify({ protocol: 1, rows: [], extra: true }),
    );
    const extraFieldRes = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: extraFieldBody,
        }),
        body: extraFieldBody,
      }),
    );
    expect(extraFieldRes.status).toBe(400);
    expect((await extraFieldRes.json()).error).toBe("bad_request");

    const dupBody = new TextEncoder().encode(
      JSON.stringify({
        protocol: 1,
        rows: [
          { character_id: 92900021, dps: 1, ewar: [] },
          { character_id: 92900021, dps: 2, ewar: [] },
        ],
      }),
    );
    const dupRes = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 2,
          body: dupBody,
        }),
        body: dupBody,
      }),
    );
    expect(dupRes.status).toBe(400);
    expect((await dupRes.json()).error).toBe("bad_request");
  });

  it("rejects an unsupported protocol major with update_required, only after authenticating", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ protocol: 2, rows: [] }));
    const res = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: bodyBytes,
        }),
        body: bodyBytes,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("update_required");
  });

  it("maps a relay-service refusal (character_not_eligible) to its documented HTTP status", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    await seedCharacter(ctx.db, cfg, { id: 92900022, accountId: acc.id }); // linked, not eligible

    const bodyBytes = new TextEncoder().encode(
      JSON.stringify({
        protocol: 1,
        rows: [{ character_id: 92900022, dps: 1, ewar: [] }],
      }),
    );
    const res = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: bodyBytes,
        }),
        body: bodyBytes,
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("character_not_eligible");
  });

  it("refuses an unauthenticated request with 401 unauthorized, never reaching the schema", async () => {
    const { privateKey: wrongKey } = newKeyPair();
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ protocol: 1, rows: [] }));
    const res = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "PUT",
        headers: signedHeaders({
          privateKey: wrongKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: bodyBytes,
        }),
        body: bodyBytes,
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("rejects a signed request carrying a query string", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const bodyBytes = new TextEncoder().encode(JSON.stringify({ protocol: 1, rows: [] }));
    const res = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot?x=1", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: bodyBytes,
        }),
        body: bodyBytes,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
});

describe("GET /api/fleet/v1/snapshot", () => {
  it("returns the requester's own live fleet rows for a validly signed request", async () => {
    const publisherAcc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId: publisherSession, privateKey: publisherKey } = await pairDevice(
      ctx.db,
      publisherAcc.id,
      NOW,
    );
    await seedEligibleCharacter(ctx.db, {
      characterId: 92900030,
      accountId: publisherAcc.id,
      fleetId: 6300010,
      now: NOW,
    });
    const publishBody = new TextEncoder().encode(
      JSON.stringify({
        protocol: 1,
        rows: [{ character_id: 92900030, dps: 500, ewar: [] }],
      }),
    );
    const publishRes = await snapshotPut(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "PUT",
        headers: signedHeaders({
          privateKey: publisherKey,
          method: "PUT",
          path: "/api/fleet/v1/snapshot",
          sessionId: publisherSession,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: publishBody,
        }),
        body: publishBody,
      }),
    );
    expect(publishRes.status).toBe(200);

    // Route handlers capture real wall-clock time internally (see the NOW
    // comment above) rather than accepting an injected clock, so this can only
    // assert a bounded, non-negative age -- not an exact millisecond value.
    // The exact liveness boundaries (2,999ms/3,000ms/10,000ms) are already
    // pinned precisely at the service layer in tests/fleet-relay.test.ts,
    // which controls `now` directly; this only has to prove the route wires
    // the signed request through to that service and maps its response.
    const readHeaders = signedHeaders({
      privateKey: publisherKey,
      method: "GET",
      path: "/api/fleet/v1/snapshot",
      sessionId: publisherSession,
      issuedAt: new Date().toISOString(),
      // The prior PUT above already consumed revision 1 on this SAME
      // session/counter (fleet-relay.ts's shared gateSignedSession) -- this
      // read must use a strictly greater value or it is refused as a replay.
      revision: 2,
      body: new Uint8Array(0),
    });
    const res = await snapshotGet(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "GET",
        headers: readHeaders,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(1);
    expect(body.rows).toHaveLength(1);
    const [seen] = body.rows;
    expect(seen.character_id).toBe(92900030);
    expect(typeof seen.character_name).toBe("string");
    expect(seen.dps).toBe(500);
    expect(seen.ewar).toEqual([]);
    expect(seen.state).toBe("live");
    expect(seen.age_ms).toBeGreaterThanOrEqual(0);
    expect(seen.age_ms).toBeLessThan(3_000);
  });

  it("refuses an unknown session with 401 unauthorized", async () => {
    const { privateKey } = newKeyPair();
    const res = await snapshotGet(
      new NextRequest("http://localhost/api/fleet/v1/snapshot", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/snapshot",
          sessionId: "b".repeat(32),
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("rejects a signed request carrying a query string", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const res = await snapshotGet(
      new NextRequest("http://localhost/api/fleet/v1/snapshot?x=1", {
        method: "GET",
        headers: signedHeaders({
          privateKey,
          method: "GET",
          path: "/api/fleet/v1/snapshot",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
});

describe("authenticateFleetRequest: canonical-path guard", () => {
  it("refuses a control character in the canonical path as bad_headers, before any DB lookup", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const headers = signedHeaders({
      privateKey,
      method: "GET",
      // Signed over the real canonical path -- the point is that the guard
      // fires on `request.path` itself, independent of whether the
      // signature would otherwise have verified against it.
      path: "/api/fleet/v1/catalogue",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });

    const parsedHeaders = extractFleetAuthHeaders({ headers });
    if (!parsedHeaders) throw new Error("unreachable");
    const result = await authenticateFleetRequest(
      ctx.db,
      parsedHeaders,
      new Uint8Array(0),
      {
        method: "GET",
        path: "/api/fleet/v1/catalogue\u0000",
        now: NOW,
      },
    );
    expect(result).toEqual({ ok: false, code: "bad_headers" });
  });
});

describe("PUT /api/fleet/v1/session", () => {
  it("extends a validly signed device's session and returns its new expiry", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const headers = signedHeaders({
      privateKey,
      method: "PUT",
      path: "/api/fleet/v1/session",
      sessionId,
      issuedAt: NOW.toISOString(),
      revision: 1,
      body: new Uint8Array(0),
    });
    const res = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocol).toBe(1);
    expect(typeof body.expires_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.expires_at as string))).toBe(false);
    expect(Date.parse(body.expires_at as string)).toBeGreaterThan(NOW.getTime());
  });

  it("refuses an unauthenticated request with 401 unauthorized", async () => {
    const { privateKey: wrongKey } = newKeyPair();
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    const res = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers: signedHeaders({
          privateKey: wrongKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("refuses a replayed revision with 409, and a too-soon retry with 429, then succeeds once past both", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);

    const first = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(first.status).toBe(200);

    const replay = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: new Date(NOW.getTime() + 600).toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe("revision_replayed");

    const tooSoon = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: new Date().toISOString(),
          revision: 2,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(tooSoon.status).toBe(429);
    expect((await tooSoon.json()).error).toBe("rate_limited");

    await new Promise((resolve) => setTimeout(resolve, 600));
    const later = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: new Date().toISOString(),
          revision: 2,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(later.status).toBe(200);
  });

  it("refuses with 403 not_eligible once the account has dropped below Member tier", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    await ctx.db.update(account).set({ tier: "alumni" }).where(eq(account.id, acc.id));

    const res = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_eligible");
  });

  it("rejects a signed request carrying a query string", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, privateKey } = await pairDevice(ctx.db, acc.id, NOW);
    const res = await sessionRenewRoute(
      new NextRequest("http://localhost/api/fleet/v1/session?x=1", {
        method: "PUT",
        headers: signedHeaders({
          privateKey,
          method: "PUT",
          path: "/api/fleet/v1/session",
          sessionId,
          issuedAt: NOW.toISOString(),
          revision: 1,
          body: new Uint8Array(0),
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_headers");
  });
});
