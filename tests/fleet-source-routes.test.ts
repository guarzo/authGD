import { createHash, randomUUID, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { createLocalJWKSet } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  character,
  fleetDeviceSession,
  fleetEligibility,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
  outbox,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { setFleetParticipation } from "@/services/fleet-participation";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE, createEsiClient } from "@/lib/esi/client";
import { createDiscordClient } from "@/lib/discord/rest";
import { createWandererClient } from "@/lib/wanderer/client";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { buildJobHandlers } from "@/worker/handlers";
import { dispatchOutbox } from "@/worker/dispatcher";
import { startFleetFixtures } from "../e2e/fleet-fixtures";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
process.env.DATABASE_URL = TEST_URL;
const { GET, PUT } = await import("@/app/api/fleet/v1/sources/route");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let fixture: Awaited<ReturnType<typeof startFleetFixtures>>;
beforeAll(async () => {
  ctx = await setupTestDb();
  fixture = await startFleetFixtures({
    appUrl: "http://127.0.0.1:43210",
    worktree: "/home/tng/workspace/authGD/.claude/worktrees/shared-boss-roster",
  });
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  await fixture.client.reset();
});
afterAll(async () => {
  await fixture.close();
  await ctx.cleanup();
});
function request(
  p: Awaited<ReturnType<typeof pairDevice>>,
  method: "GET" | "PUT",
  body: unknown,
  revision: number,
  query = "",
  path = "/api/fleet/v1/sources",
) {
  const text = method === "GET" ? "" : JSON.stringify(body);
  const hash = createHash("sha256").update(text).digest("hex");
  const issued = new Date().toISOString();
  const signature = sign(
    null,
    Buffer.from(
      ["fleet-v1", method, path, p.sessionId, issued, String(revision), hash].join("\n"),
    ),
    p.privateKey,
  ).toString("base64url");
  return new NextRequest(`https://auth.example${path}${query}`, {
    method,
    ...(method === "PUT" ? { body: text } : {}),
    headers: {
      "x-fleet-session": p.sessionId,
      "x-fleet-issued-at": issued,
      "x-fleet-revision": String(revision),
      "x-fleet-body-sha256": hash,
      "x-fleet-signature": signature,
      ...(method === "GET" && path === "/api/fleet/v1/snapshot"
        ? { "x-fleet-snapshot-format": "publication-v1" }
        : {}),
    },
  });
}
it("signed route -> committed outbox -> dispatcher -> strict registered handler -> actual job/parser, with zero request-side provider calls", async () => {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const now = new Date();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
    refreshToken: "fleet-test-source",
  });
  const alt = await seedCharacter(ctx.db, testConfig(), {
    id: 99002,
    accountId: owner.id,
    scopes: [],
    refreshToken: null,
  });
  const participant = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
  const included = await seedCharacter(ctx.db, testConfig(), {
    id: 99003,
    accountId: participant.id,
    scopes: [],
    refreshToken: null,
    tokenStatus: "missing",
  });
  const unmatched = await seedCharacter(ctx.db, testConfig(), {
    id: 99004,
    accountId: participant.id,
    scopes: [],
    refreshToken: null,
    tokenStatus: "missing",
  });
  const receiver = await pairDevice(ctx.db, participant.id, now, [SHARED_CAPABILITY]);
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: receiver.sessionId,
        revision: 1,
        capabilities: [SHARED_CAPABILITY],
      })
    ).ok,
  ).toBe(true);
  const p = await pairDevice(ctx.db, owner.id, now, [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    capabilities: [SHARED_CAPABILITY],
  });
  await new Promise((r) => setTimeout(r, 510));
  const sourceId = randomUUID();
  const start = {
    protocol: 1,
    operation: "start",
    source_id: sourceId,
    expected_generation: 0,
    character_id: boss.id,
    character_link_epoch: boss.fleetLinkEpoch,
    intent_created_at: new Date().toISOString(),
  };
  await fixture.client.scenario({
    characters: [
      {
        id: boss.id,
        name: boss.name,
        ownerHash: boss.ownerHash,
        scopes: boss.scopes,
        refreshToken: "fleet-test-source",
      },
    ],
    fleetId: 123,
    fleetBossId: boss.id,
    rosterIds: [boss.id, alt.id, included.id, 777],
    responses: {
      membership: {
        headers: {
          Date: new Date().toUTCString(),
          "Cache-Control": "max-age=60",
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      },
      roster: {
        headers: {
          Date: new Date().toUTCString(),
          "Cache-Control": "max-age=5",
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      },
    },
  });
  const denied = await PUT(
    request(
      p,
      "PUT",
      { ...start, character_id: alt.id, character_link_epoch: alt.fleetLinkEpoch },
      2,
    ),
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ protocol: 1, error: "fleet_read_required" });
  const response = await PUT(request(p, "PUT", start, 2));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    protocol: 1,
    source: { source_id: sourceId, generation: 1, state: "pending" },
  });
  expect((await fixture.client.snapshot()).requests).toEqual([]);
  expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  const jwks = await fixture.client.provider({
    url: "https://login.eveonline.com/oauth/jwks",
    method: "GET",
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await fixture.client.provider({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Response.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
  const cfg = testConfig({ EVE_SSO_CLIENT_ID: "cid", EVE_SSO_CLIENT_SECRET: "sec" });
  const esi = createEsiClient({ fetchImpl });
  const handlers = buildJobHandlers({
    db: ctx.db,
    cfg,
    esi,
    discord: createDiscordClient(cfg),
    wanderer: createWandererClient(cfg),
    fetchImpl,
    fleetSource: {
      esi,
      getKey: createLocalJWKSet(jwks.body as Parameters<typeof createLocalJWKSet>[0]),
    },
  });
  const queued: { queue: string; data: Record<string, unknown> }[] = [];
  await dispatchOutbox(ctx.db, async (queue, data) => {
    queued.push({ queue, data });
  });
  expect(queued).toEqual([
    { queue: "fleet-source", data: { jobType: "fleet-source", sourceId, generation: 1 } },
  ]);
  await expect(
    handlers["fleet-source"]({ ...queued[0].data, private: "do-not-log" }),
  ).rejects.toThrow("fleet_source_payload_invalid");
  await handlers[queued[0].queue](queued[0].data);
  expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].linkedCharacters).toEqual([
    { characterId: boss.id, linkEpoch: boss.fleetLinkEpoch },
    { characterId: alt.id, linkEpoch: alt.fleetLinkEpoch },
    { characterId: included.id, linkEpoch: included.fleetLinkEpoch },
  ]);
  await new Promise((r) => setTimeout(r, 510));
  const status = await GET(request(p, "GET", null, 3));
  expect(status.status).toBe(200);
  const dto = await status.json();
  expect(dto.characters).toContainEqual({
    character_id: alt.id,
    character_name: alt.name,
    character_link_epoch: alt.fleetLinkEpoch,
    has_fleet_read: false,
    token_usable: false,
  });
  expect(JSON.stringify(dto)).not.toMatch(/fleet_id|owner_hash|token_enc|access_token/);
  await new Promise((r) => setTimeout(r, 510));
  expect((await PUT(request(p, "PUT", { ...start, fleet_id: 123 }, 4))).status).toBe(400);
  expect((await GET(request(p, "GET", null, 4, "?source_id=123"))).status).toBe(400);
  // Real signed routes in both directions after the actual outbox/worker proof.
  // The quiet participant owns neither a lease nor any Fleet Read token.
  for (const [device, revision] of [
    [p, 4],
    [receiver, 2],
  ] as const)
    expect(
      (
        await setFleetParticipation(ctx.db, {
          sessionId: device.sessionId,
          revision,
          enabled: true,
          expectedGeneration: 0,
        })
      ).ok,
    ).toBe(true);
  await new Promise((r) => setTimeout(r, 510));
  const eligibility = await import("@/app/api/fleet/v1/eligibility/route");
  const snapshot = await import("@/app/api/fleet/v1/snapshot/route");
  const own = await eligibility.GET(
    request(receiver, "GET", null, 3, "", "/api/fleet/v1/eligibility"),
  );
  expect(own.status).toBe(200);
  expect(own.headers.get("cache-control")).toBe("no-store");
  const ownDto = await own.json();
  expect(ownDto).toMatchObject({
    protocol: 1,
    participation_generation: 1,
    state: "ready",
    characters: [
      {
        character_id: included.id,
        source_id: sourceId,
        source_generation: 1,
        authority_generation: 1,
      },
    ],
  });
  expect(ownDto.characters).toHaveLength(1);
  expect(ownDto.characters[0].expires_at).toMatch(/Z$/);
  expect(JSON.stringify(ownDto)).not.toMatch(/fleet_id|character_name|roster/);
  expect(
    (
      await eligibility.GET(
        request(receiver, "GET", null, 4, "?fleet_id=123", "/api/fleet/v1/eligibility"),
      )
    ).status,
  ).toBe(400);
  const aPut = await snapshot.PUT(
    request(
      p,
      "PUT",
      { protocol: 1, rows: [{ character_id: boss.id, dps: 42, ewar: [] }] },
      5,
      "",
      "/api/fleet/v1/snapshot",
    ),
  );
  expect(aPut.status).toBe(200);
  expect(aPut.headers.get("cache-control")).toBe("no-store");
  // Eligibility shares the snapshot read bucket and revision, including failures.
  expect(
    (await snapshot.GET(request(receiver, "GET", null, 4, "", "/api/fleet/v1/snapshot")))
      .status,
  ).toBe(429);
  await new Promise((r) => setTimeout(r, 510));
  const quietRequest = request(receiver, "GET", null, 4, "", "/api/fleet/v1/snapshot");
  const quiet = await snapshot.GET(quietRequest);
  expect(quiet.status).toBe(200);
  expect(quiet.headers.get("x-fleet-snapshot-format")).toBe("publication-v1");
  const h = quietRequest.headers;
  expect(quiet.headers.get("x-fleet-request-binding")).toBe(
    createHash("sha256")
      .update(
        [
          "fleet-snapshot-publication-v1",
          "fleet-v1",
          "GET",
          "/api/fleet/v1/snapshot",
          receiver.sessionId,
          h.get("x-fleet-issued-at"),
          "4",
          h.get("x-fleet-body-sha256"),
        ].join("\n"),
      )
      .digest("hex"),
  );
  const published = (await ctx.db.select().from(fleetTelemetryRow))[0];
  expect(published.publicationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect((await quiet.json()).rows).toEqual([
    expect.objectContaining({
      character_id: boss.id,
      dps: 42,
      publication_id: published.publicationId,
    }),
  ]);
  const bad = await snapshot.PUT(
    request(
      receiver,
      "PUT",
      {
        protocol: 1,
        rows: [
          { character_id: included.id, dps: 7, ewar: [] },
          { character_id: unmatched.id, dps: 1, ewar: [] },
        ],
      },
      5,
      "",
      "/api/fleet/v1/snapshot",
    ),
  );
  expect(bad.status).toBe(403);
  const bPut = await snapshot.PUT(
    request(
      receiver,
      "PUT",
      {
        protocol: 1,
        rows: [{ character_id: included.id, dps: 77, ewar: ["SCRAM/POINT"] }],
      },
      5,
      "",
      "/api/fleet/v1/snapshot",
    ),
  );
  expect(bPut.status).toBe(200);
  const back = await snapshot.GET(
    request(p, "GET", null, 6, "", "/api/fleet/v1/snapshot"),
  );
  expect(back.status).toBe(200);
  expect((await back.json()).rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        character_id: included.id,
        dps: 77,
        ewar: ["SCRAM/POINT"],
      }),
    ]),
  );
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
  expect(
    (
      await ctx.db.select().from(character).where(eq(character.accountId, participant.id))
    ).every(
      (ch) =>
        ch.scopes.length === 0 &&
        ch.refreshTokenEnc === null &&
        ch.tokenStatus === "missing",
    ),
  ).toBe(true);
  // Production path uses PostgreSQL clock_timestamp AFTER a real final relay
  // wait, not the route's pre-authentication timestamp or a supplied test clock.
  const beforeWait = await ctx.db.select().from(fleetTelemetryRow);
  const holder = await ctx.pool.connect();
  let waiting: ReturnType<typeof snapshot.PUT> | undefined;
  try {
    await ctx.db
      .update(fleetDeviceSession)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(fleetDeviceSession.deviceId, receiver.device.id));
    await holder.query("begin");
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    await holder.query("select pg_advisory_xact_lock(2, hashint8($1))", [included.id]);
    waiting = snapshot.PUT(
      request(
        receiver,
        "PUT",
        { protocol: 1, rows: [] },
        6,
        "",
        "/api/fleet/v1/snapshot",
      ),
    );
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    await holder.query("commit");
    expect((await waiting).status).toBe(403);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual(beforeWait);
  } finally {
    await holder.query("rollback");
    holder.release();
    await waiting;
  }
  const second = await pairDevice(ctx.db, owner.id, new Date(), [SHARED_CAPABILITY]);
  const foreignOwner = await seedAccount(ctx.db, { tier: "member" });
  const foreign = await pairDevice(ctx.db, foreignOwner.id, new Date(), [
    SHARED_CAPABILITY,
  ]);
  for (const device of [second, foreign])
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: device.sessionId,
      revision: 1,
      capabilities: [SHARED_CAPABILITY],
    });
  await new Promise((r) => setTimeout(r, 510));
  const foreignStatus = await GET(request(foreign, "GET", null, 2));
  expect(foreignStatus.status).toBe(200);
  expect((await foreignStatus.json()).sources).toEqual([]);
  const secondStatus = await GET(request(second, "GET", null, 2));
  expect(secondStatus.status).toBe(200);
  expect((await secondStatus.json()).sources).toContainEqual(
    expect.objectContaining({ source_id: sourceId, state: "active" }),
  );
  await new Promise((r) => setTimeout(r, 510));
  expect((await PUT(request(foreign, "PUT", start, 3))).status).toBe(403);
  expect(
    (
      await PUT(
        request(
          foreign,
          "PUT",
          { protocol: 1, operation: "stop", source_id: sourceId, expected_generation: 1 },
          3,
        ),
      )
    ).status,
  ).toBe(403);
  const stopped = await PUT(
    request(
      second,
      "PUT",
      { protocol: 1, operation: "stop", source_id: sourceId, expected_generation: 1 },
      3,
    ),
  );
  expect(stopped.status).toBe(200);
  expect((await stopped.json()).source.state).toBe("ended");
  expect((await ctx.db.select().from(fleetSourceIntent))[0].deviceId).toBe(p.device.id);
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
  await fixture.client.assertClean();
}, 15000);
