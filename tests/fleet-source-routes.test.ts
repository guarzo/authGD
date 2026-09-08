import { createHash, randomUUID, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { createLocalJWKSet } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { fleetSourceAuthority, fleetSourceIntent, outbox } from "@/db/schema";
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
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
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
const path = "/api/fleet/v1/sources";
function request(
  p: Awaited<ReturnType<typeof pairDevice>>,
  method: "GET" | "PUT",
  body: unknown,
  revision: number,
  query = "",
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
    rosterIds: [boss.id, alt.id, 777],
    responses: {
      membership: {
        headers: { Date: new Date().toUTCString(), "Cache-Control": "max-age=60" },
      },
      roster: {
        headers: { Date: new Date().toUTCString(), "Cache-Control": "max-age=5" },
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
