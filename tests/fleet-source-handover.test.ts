import { randomUUID } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fleetSourceAuthority, fleetSourceIntent } from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { controlFleetSource } from "@/services/fleet-source";
import { runFleetSourceJob, createFleetSourceMemory } from "@/jobs/fleet-source";
import { startFleetFixtures } from "../e2e/fleet-fixtures";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let fixture: Awaited<ReturnType<typeof startFleetFixtures>>;
const cfg = testConfig({ EVE_SSO_CLIENT_ID: "cid", EVE_SSO_CLIENT_SECRET: "sec" });
let epoch: number;
let now: Date;
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
  epoch = Math.floor(Date.now() / 1000) * 1000;
  now = new Date(epoch);
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
});
afterAll(async () => {
  await fixture.close();
  await ctx.cleanup();
});
const at = (ms: number) => new Date(epoch + ms);
async function enroll(id: number) {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, cfg, {
    id,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
    refreshToken: `fleet-test-${id}`,
  });
  const p = await pairDevice(ctx.db, owner.id, at(0), [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: at(0),
    capabilities: [SHARED_CAPABILITY],
  });
  const sourceId = randomUUID();
  expect(
    (
      await controlFleetSource(ctx.db, {
        sessionId: p.sessionId,
        revision: 2,
        now: at(500),
        command: {
          operation: "start",
          sourceId,
          expectedGeneration: 0,
          characterId: boss.id,
          characterLinkEpoch: boss.fleetLinkEpoch,
          intentCreatedAt: at(0),
        },
      })
    ).ok,
  ).toBe(true);
  return { boss, sourceId };
}
async function scenario(
  bossId: number,
  characters: Awaited<ReturnType<typeof enroll>>[],
  hold?: string,
  status = 200,
) {
  await fixture.client.scenario({
    characters: characters.map(({ boss }) => ({
      id: boss.id,
      name: boss.name,
      ownerHash: boss.ownerHash,
      scopes: boss.scopes,
      refreshToken: `fleet-test-${boss.id}`,
    })),
    fleetId: 123,
    fleetBossId: bossId,
    rosterIds: characters.map((p) => p.boss.id),
    responses: {
      membership: { headers: { Date: now.toUTCString(), "Cache-Control": "max-age=60" } },
      roster: {
        hold,
        status,
        headers: { Date: now.toUTCString(), "Cache-Control": "max-age=5" },
      },
    },
  });
}
async function deps() {
  const keys = await fixture.client.provider({
    url: "https://login.eveonline.com/oauth/jwks",
    method: "GET",
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await fixture.client.provider({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Response.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
  return {
    db: ctx.db,
    cfg,
    fetchImpl,
    now: () => now,
    memory: createFleetSourceMemory(),
    getKey: createLocalJWKSet(keys.body as Parameters<typeof createLocalJWKSet>[0]),
  };
}
async function held(name: string) {
  for (let i = 0; i < 100; i++) {
    if ((await fixture.client.snapshot()).pending.includes(name)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("synthetic hold not reached");
}
it("a later observation cannot replace intervening cross-source authority; refused pending candidate cannot clear incumbent", async () => {
  const a = await enroll(99001),
    b = await enroll(99002);
  const d = await deps();
  now = at(1000);
  await scenario(b.boss.id, [a, b], "B");
  const pendingB = runFleetSourceJob(d, { sourceId: b.sourceId, generation: 1 });
  await held("B");
  now = at(4000);
  await scenario(a.boss.id, [a, b], "A");
  const pendingA = runFleetSourceJob(d, { sourceId: a.sourceId, generation: 1 });
  await held("A");
  try {
    now = at(5000);
    await fixture.client.release("B");
    await pendingB;
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: b.sourceId,
      verifiedAt: at(1000),
    });
    await fixture.client.release("A");
    await pendingA;
    // A's observation at :04 is NEWER than B's :01; order alone would allow
    // replacement. The independently captured authority-generation fence must win.
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: b.sourceId,
      verifiedAt: at(1000),
    });
    now = at(10000);
    await scenario(b.boss.id, [a, b]);
    await runFleetSourceJob(d, { sourceId: a.sourceId, generation: 1 });
    expect(
      (
        await ctx.db
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, a.sourceId))
      )[0].state,
    ).toBe("ended");
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBe(
      b.sourceId,
    );
  } finally {
    await fixture.client.release("A");
    await fixture.client.release("B");
    await Promise.all([pendingA, pendingB]);
  }
}, 15000);
it("handover ends an activated paused predecessor", async () => {
  const a = await enroll(99001),
    b = await enroll(99002);
  const d = await deps();
  now = at(1000);
  await scenario(a.boss.id, [a, b]);
  await runFleetSourceJob(d, { sourceId: a.sourceId, generation: 1 });
  now = at(6000);
  await scenario(a.boss.id, [a, b], undefined, 503);
  await runFleetSourceJob(d, { sourceId: a.sourceId, generation: 1 });
  expect(
    (
      await ctx.db
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.id, a.sourceId))
    )[0].state,
  ).toBe("paused");
  now = at(7000);
  await scenario(b.boss.id, [a, b]);
  await runFleetSourceJob(d, { sourceId: b.sourceId, generation: 1 });
  expect(
    (
      await ctx.db
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.id, a.sourceId))
    )[0],
  ).toMatchObject({ state: "ended", terminalReason: "superseded", generation: 2 });
  expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBe(b.sourceId);
});
