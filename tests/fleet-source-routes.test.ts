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
import { PUT as acknowledgeRoute } from "@/app/api/fleet/v2/device/route";
import { COMBAT_APPROVAL } from "./helpers/fleet-combat";
const SNAPSHOT_PATH = "/api/fleet/v2/snapshot";
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
import { controlFleetSource, readFleetSourceState } from "@/services/fleet-source";
import type { SourceCommand } from "@/services/fleet-source";
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
// The production bucket uses post-lock PostgreSQL time, not Node's timer clock.
// Observe its condition without retrying any service/HTTP operation. The deadline
// only bounds a stalled test; it never authorizes a call before the bucket is ready.
async function waitForReadCadence(...devices: Awaited<ReturnType<typeof pairDevice>>[]) {
  const deadline = performance.now() + 5000;
  while (true) {
    const { rows } = await ctx.pool.query<{
      now: Date;
      last_read_at: Date | null;
    }>(
      "select clock_timestamp() as now, last_read_at from fleet_device_session where device_id = any($1::uuid[])",
      [devices.map((device) => device.device.id)],
    );
    expect(rows).toHaveLength(devices.length);
    const remaining = Math.max(
      ...rows.map((row) =>
        row.last_read_at === null
          ? 0
          : 500 - (row.now.getTime() - row.last_read_at.getTime()),
      ),
    );
    if (remaining <= 0) return;
    if (performance.now() >= deadline)
      throw new Error(`database read cadence stalled: ${remaining}ms remaining`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 50)));
  }
}
function request(
  p: Awaited<ReturnType<typeof pairDevice>>,
  method: "GET" | "PUT",
  body: unknown,
  revision: number,
  query = "",
  path = SNAPSHOT_PATH,
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
    },
  });
}
it("source service -> committed outbox -> dispatcher -> strict registered handler -> actual job/parser, then real API2 eligibility/relay routes", async () => {
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
  const receiver = await pairDevice(ctx.db, participant.id, now, COMBAT_APPROVAL);
  const p = await pairDevice(ctx.db, owner.id, now, COMBAT_APPROVAL);
  for (const device of [receiver, p])
    expect(
      (
        await acknowledgeRoute(
          request(
            device,
            "PUT",
            { protocol: 2, capabilities: COMBAT_APPROVAL },
            1,
            "",
            "/api/fleet/v2/device",
          ),
        )
      ).status,
    ).toBe(200);
  await waitForReadCadence(p);
  const sourceId = randomUUID();
  // Keep worker/authorization guards on the actual v2 service; independent
  // route-control tests exercise request-bound HTTP handlers without a server.
  const start: SourceCommand = {
    protocol: 2,
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
  const denied = await controlFleetSource(ctx.db, {
    sessionId: p.sessionId,
    revision: 2,
    command: { ...start, character_id: alt.id, character_link_epoch: alt.fleetLinkEpoch },
  });
  expect(denied).toEqual({ ok: false, code: "fleet_read_required" });
  const beforeStart = await ctx.db
    .select()
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, p.device.id));
  const response = await controlFleetSource(ctx.db, {
    sessionId: p.sessionId,
    revision: 2,
    command: start,
  });
  expect(response).toMatchObject({
    ok: true,
    value: {
      protocol: 2,
      source: { source_id: sourceId, generation: 1, state: "pending", automatic: null },
    },
  });
  const [startedSession] = await ctx.db
    .select()
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, p.device.id));
  expect(startedSession.lastRevision).toBe(2);
  expect(
    startedSession.lastReadAt!.getTime() - beforeStart[0].lastReadAt!.getTime(),
  ).toBeGreaterThanOrEqual(500);
  expect((await ctx.db.select().from(fleetSourceIntent))[0].nextFetchAt).toEqual(
    startedSession.lastReadAt,
  );
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
  const [afterWorkerSession] = await ctx.db
    .select()
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, p.device.id));
  expect(afterWorkerSession).toEqual(startedSession);
  // A 510ms Node sleep did not prove 500ms on the admission clock. Exercise
  // the exact boundary through the existing service seam, after the real job,
  // without changing source authority, bypassing admission, or retrying failures.
  const lastReadAt = startedSession.lastReadAt!.getTime();
  expect(
    await readFleetSourceState(ctx.db, {
      sessionId: p.sessionId,
      revision: 3,
      now: new Date(lastReadAt + 499),
    }),
  ).toEqual({ ok: false, code: "rate_limited" });
  expect(
    await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, p.device.id)),
  ).toEqual([startedSession]);
  const catalogueNow = new Date(lastReadAt + 500);
  const status = await readFleetSourceState(ctx.db, {
    sessionId: p.sessionId,
    revision: 3,
    now: catalogueNow,
  });
  if (!status.ok) throw new Error(status.code);
  expect(
    await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, p.device.id)),
  ).toEqual([{ ...startedSession, lastRevision: 3, lastReadAt: catalogueNow }]);
  expect(status.value.characters).toContainEqual({
    character_id: alt.id,
    character_name: alt.name,
    character_link_epoch: alt.fleetLinkEpoch,
    has_fleet_read: false,
    token_usable: false,
  });
  expect(JSON.stringify(status.value)).not.toMatch(
    /fleetId|ownerHash|tokenEnc|accessToken/,
  );
  await waitForReadCadence(p, receiver);
  const extra = { ...start, fleetId: 123 };
  expect(
    await controlFleetSource(ctx.db, {
      sessionId: p.sessionId,
      revision: 4,
      command: extra,
    }),
  ).toEqual({ ok: false, code: "bad_request" });
  // Raw old-route selector/method refusal is covered exhaustively by retirement tests.
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
  await waitForReadCadence(receiver);
  const eligibility = await import("@/app/api/fleet/v2/eligibility/route");
  const snapshot = await import("@/app/api/fleet/v2/snapshot/route");
  const own = await eligibility.GET(
    request(receiver, "GET", null, 3, "", "/api/fleet/v2/eligibility"),
  );
  expect(own.status).toBe(200);
  expect(own.headers.get("cache-control")).toBe("no-store");
  const ownDto = await own.json();
  expect(ownDto).toMatchObject({
    protocol: 2,
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
        request(receiver, "GET", null, 4, "?fleet_id=123", "/api/fleet/v2/eligibility"),
      )
    ).status,
  ).toBe(400);
  const aPut = await snapshot.PUT(
    request(
      p,
      "PUT",
      {
        protocol: 2,
        sampled_at_ms: Date.now() - 100,
        rows: [
          {
            character_id: boss.id,
            outgoing_dps: 42,
            incoming_dps: null,
            activity_age_ms: 0,
            effects: [],
          },
        ],
      },
      5,
      "",
      SNAPSHOT_PATH,
    ),
  );
  expect(aPut.status).toBe(200);
  expect(aPut.headers.get("cache-control")).toBe("no-store");
  // Eligibility shares the snapshot read bucket and revision, including failures.
  expect(
    (await snapshot.GET(request(receiver, "GET", null, 4, "", SNAPSHOT_PATH))).status,
  ).toBe(429);
  await waitForReadCadence(receiver);
  const quietRequest = request(receiver, "GET", null, 4, "", SNAPSHOT_PATH);
  const quiet = await snapshot.GET(quietRequest);
  expect(quiet.status).toBe(200);
  expect(quiet.headers.has("x-fleet-snapshot-format")).toBe(false);
  const h = quietRequest.headers;
  expect(quiet.headers.get("x-fleet-request-binding")).toBe(
    createHash("sha256")
      .update(
        [
          "fleet-api-v2",
          "fleet-v1",
          "GET",
          SNAPSHOT_PATH,
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
      outgoing_dps: 42,
      incoming_dps: null,
      publication_id: published.publicationId,
    }),
  ]);
  const bad = await snapshot.PUT(
    request(
      receiver,
      "PUT",
      {
        protocol: 2,
        sampled_at_ms: Date.now() - 100,
        rows: [
          {
            character_id: included.id,
            outgoing_dps: 7,
            incoming_dps: null,
            activity_age_ms: 0,
            effects: [],
          },
          {
            character_id: unmatched.id,
            outgoing_dps: 1,
            incoming_dps: null,
            activity_age_ms: 0,
            effects: [],
          },
        ],
      },
      5,
      "",
      SNAPSHOT_PATH,
    ),
  );
  expect(bad.status).toBe(403);
  const bPut = await snapshot.PUT(
    request(
      receiver,
      "PUT",
      {
        protocol: 2,
        sampled_at_ms: Date.now() - 100,
        rows: [
          {
            character_id: included.id,
            outgoing_dps: 77,
            incoming_dps: null,
            activity_age_ms: 0,
            effects: [{ kind: "POINT", observations: [{ name: null, age_ms: 0 }] }],
          },
        ],
      },
      5,
      "",
      SNAPSHOT_PATH,
    ),
  );
  expect(bPut.status).toBe(200);
  const back = await snapshot.GET(request(p, "GET", null, 6, "", SNAPSHOT_PATH));
  expect(back.status).toBe(200);
  expect((await back.json()).rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        character_id: included.id,
        outgoing_dps: 77,
        incoming_dps: null,
        effects: [
          { kind: "POINT", observations: [{ name: null, age_ms: expect.any(Number) }] },
        ],
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
        { protocol: 2, sampled_at_ms: 0, rows: [] },
        6,
        "",
        SNAPSHOT_PATH,
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
    expect(
      (
        await acknowledgeRoute(
          request(
            device,
            "PUT",
            { protocol: 2, capabilities: [SHARED_CAPABILITY] },
            1,
            "",
            "/api/fleet/v2/device",
          ),
        )
      ).status,
    ).toBe(200);
  await waitForReadCadence(foreign, second);
  const foreignStatus = await readFleetSourceState(ctx.db, {
    sessionId: foreign.sessionId,
    revision: 2,
  });
  expect(foreignStatus).toMatchObject({ ok: true, value: { sources: [] } });
  const secondStatus = await readFleetSourceState(ctx.db, {
    sessionId: second.sessionId,
    revision: 2,
  });
  if (!secondStatus.ok) throw new Error(secondStatus.code);
  expect(secondStatus.value.sources).toContainEqual(
    expect.objectContaining({ source_id: sourceId, state: "active" }),
  );
  await waitForReadCadence(foreign, second);
  expect(
    await controlFleetSource(ctx.db, {
      sessionId: foreign.sessionId,
      revision: 3,
      command: start,
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const stop: SourceCommand = {
    protocol: 2,
    operation: "stop",
    request_id: randomUUID(),
    intent_created_at: new Date().toISOString(),
    source_id: sourceId,
    expected_generation: 1,
    expected_automatic: null,
  };
  expect(
    await controlFleetSource(ctx.db, {
      sessionId: foreign.sessionId,
      revision: 3,
      command: stop,
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const stopped = await controlFleetSource(ctx.db, {
    sessionId: second.sessionId,
    revision: 3,
    command: stop,
  });
  expect(stopped).toMatchObject({ ok: true, value: { source: { state: "ended" } } });
  expect((await ctx.db.select().from(fleetSourceIntent))[0].deviceId).toBe(p.device.id);
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
  await fixture.client.assertClean();
}, 15000);
