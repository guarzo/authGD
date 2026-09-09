import { createHash, randomUUID, sign } from "node:crypto";
import PgBoss from "pg-boss";
import { eq } from "drizzle-orm";
import { test, expect } from "./fleet-browser";
import { getFleetHttp } from "../tests/helpers/fleet-http";
import {
  BASE_URL,
  FLEET_UPSTREAM_URL,
  SYNTHETIC_APP_ENV,
  TEST_DATABASE_URL,
} from "./env";
import { resetDb, seedMember, testDb } from "./helpers";
import { loadConfig } from "../src/config";
import {
  character,
  fleetEligibility,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetTelemetryRow,
  fleetSourceAuthority,
  fleetSourceIntent,
  outbox,
} from "../src/db/schema";
import { SHARED_CAPABILITY } from "../src/core/fleet-sharing";
import { FLEET_READ_SCOPE, createEsiClient } from "../src/lib/esi/client";
import { encryptToken } from "../src/lib/crypto";
import { createDiscordClient } from "../src/lib/discord/rest";
import { createWandererClient } from "../src/lib/wanderer/client";
import { transitionFleetSharingMode } from "../src/services/fleet-sharing-mode";
import {
  cleanupFleetSources,
  reserveDueFleetSources,
} from "../src/services/fleet-source-maintenance";
import { buildJobHandlers } from "../src/worker/handlers";
import { startDispatcher } from "../src/worker/dispatcher";
import {
  createFleetSourceOwner,
  startFleetSourceScheduler,
} from "../src/worker/fleet-source-scheduler";
import { createQueues, QUEUES } from "../src/worker/queues";
import { pairDevice, reconcileFleetKeys } from "../tests/helpers/fleet-sharing";

/** Real signed HTTP -> outbox/pg-boss -> actual SSO/JWT/ESI -> shared relay.
 * Only the provider boundary is synthetic; native/TLS desktop proof is later. */
test("signed HTTP source Start, worker authority and two-account shared snapshots without any participant token", async ({
  page,
  context,
  fleet,
}) => {
  const { db, pool } = testDb();
  const boss = new PgBoss({ connectionString: TEST_DATABASE_URL });
  boss.on("error", () => {});
  const owner = createFleetSourceOwner();
  let stopDispatch: (() => Promise<void>) | undefined;
  let stopScheduler: (() => Promise<void>) | undefined;
  try {
    await resetDb(db);
    const ready = await reconcileFleetKeys(db);
    await transitionFleetSharingMode(db, {
      enabled: true,
      expectedRevision: ready.revision,
    });
    const acc = await seedMember(db, {
      name: "Source Boss",
      tier: "member",
      alts: ["Ungrantable Alt"],
    });
    const chars = await db
      .select()
      .from(character)
      .where(eq(character.accountId, acc.id));
    const anchor = chars.find((ch) => ch.id === acc.mainCharacterId)!;
    const alt = chars.find((ch) => ch.id !== anchor.id)!;
    const cfg = loadConfig({
      NODE_ENV: "test",
      ...SYNTHETIC_APP_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      APP_BASE_URL: BASE_URL,
      SYNC_MODE: "live",
    });
    const pair = await pairDevice(db, acc.id, new Date(), [SHARED_CAPABILITY]);
    const participant = await seedMember(db, {
      name: "Quiet Member",
      tier: "member",
      status: "cryo",
      alts: ["Included Alt", "Unmatched Alt"],
    });
    const bChars = await db
      .select()
      .from(character)
      .where(eq(character.accountId, participant.id))
      .orderBy(character.id);
    await db
      .update(character)
      .set({ tokenStatus: "missing" })
      .where(eq(character.accountId, participant.id));
    const b = await pairDevice(db, participant.id, new Date(), [SHARED_CAPABILITY]);
    const revisions = new Map<string, number>();
    const send = async (
      method: "GET" | "PUT",
      path: string,
      body?: unknown,
      device = pair,
    ) => {
      const text = body === undefined ? "" : JSON.stringify(body);
      const hash = createHash("sha256").update(text).digest("hex");
      const issued = new Date().toISOString();
      const n = (revisions.get(device.sessionId) ?? 0) + 1;
      revisions.set(device.sessionId, n);
      const canonical = [
        "fleet-v1",
        method,
        path,
        device.sessionId,
        issued,
        String(n),
        hash,
      ].join("\n");
      const signature = sign(null, Buffer.from(canonical), device.privateKey).toString(
        "base64url",
      );
      const publication = method === "GET" && path === "/api/fleet/v1/snapshot";
      const response = await context.request.fetch(`${BASE_URL}${path}`, {
        method,
        ...(body === undefined ? {} : { data: text }),
        headers: {
          "x-fleet-session": device.sessionId,
          "x-fleet-issued-at": issued,
          "x-fleet-revision": String(n),
          "x-fleet-body-sha256": hash,
          "x-fleet-signature": signature,
          ...(publication ? { "x-fleet-snapshot-format": "publication-v1" } : {}),
        },
      });
      if (publication && response.status() === 200) {
        expect(response.headers()["x-fleet-snapshot-format"]).toBe("publication-v1");
        expect(response.headers()["x-fleet-request-binding"]).toBe(
          createHash("sha256")
            .update("fleet-snapshot-publication-v1\n" + canonical)
            .digest("hex"),
        );
        for (const row of (await response.json()).rows)
          expect(row.publication_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
      }
      return response;
    };
    expect(
      (
        await send("PUT", "/api/fleet/v1/device", {
          protocol: 1,
          capabilities: [SHARED_CAPABILITY],
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await send(
          "PUT",
          "/api/fleet/v1/device",
          { protocol: 1, capabilities: [SHARED_CAPABILITY] },
          b,
        )
      ).status(),
    ).toBe(200);
    await fleet.scenario({
      characters: [
        {
          id: anchor.id,
          name: anchor.name,
          ownerHash: anchor.ownerHash,
          scopes: [FLEET_READ_SCOPE],
          refreshToken: "fleet-test-source-flow",
        },
      ],
      fleetId: 123456,
      fleetBossId: anchor.id,
      rosterIds: [anchor.id, alt.id, bChars[0].id, bChars[1].id],
      // This is the healthy raw-Next framing control, not a replayed-evidence
      // case. Let actual source refreshes observe fresh fixture responses;
      // freezing Date here expires authority during the longer framing matrix.
      responses: {
        membership: { freshness: "live" },
        roster: { freshness: "live" },
      },
    });
    await db
      .update(character)
      .set({
        refreshTokenEnc: encryptToken("fleet-test-source-flow", cfg.tokenEncryptionKey),
        tokenStatus: "valid",
        scopes: [FLEET_READ_SCOPE],
      })
      .where(eq(character.id, anchor.id));
    await new Promise((r) => setTimeout(r, 510));
    const sourceId = randomUUID();
    const started = await send("PUT", "/api/fleet/v1/sources", {
      protocol: 1,
      operation: "start",
      source_id: sourceId,
      expected_generation: 0,
      character_id: anchor.id,
      character_link_epoch: anchor.fleetLinkEpoch,
      intent_created_at: new Date().toISOString(),
    });
    expect(started.status()).toBe(200);
    expect((await started.json()).source.state).toBe("pending");
    expect((await fleet.snapshot()).requests).toEqual([]);
    expect((await db.select().from(outbox)).map((row) => row.payload)).toEqual([
      { kind: "fleet-source", sourceId, generation: 1 },
    ]);
    // The ONLY fetch boundary available to this source worker is the owned
    // fixture's loopback channel. Unknown endpoints are denied by its ledger.
    const fetchImpl: typeof fetch = async (url, init) => {
      const res = await fleet.provider({
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Response.json(res.body, { status: res.status, headers: res.headers });
    };
    const esi = createEsiClient({ fetchImpl });
    const handlers = buildJobHandlers({
      db,
      cfg,
      esi,
      discord: createDiscordClient(cfg),
      wanderer: createWandererClient(cfg),
      fetchImpl,
      fleetSource: { signal: owner.signal, esi },
    });
    await boss.start();
    await createQueues(boss);
    const handler = owner.wrap(handlers[QUEUES.fleetSource]);
    await boss.work(QUEUES.fleetSource, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
    const dispatchedAt = Date.now();
    stopDispatch = startDispatcher(
      db,
      (queue, data, options) => boss.send(queue, data, options),
      500,
      "fleet-source",
    );
    stopScheduler = startFleetSourceScheduler(async () => {
      await cleanupFleetSources(db);
      await reserveDueFleetSources(db);
    });
    await page.goto("/login"); // Closing/navigating the control surface is NOT Stop.
    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(fleetSourceIntent)
              .where(eq(fleetSourceIntent.id, sourceId))
          )[0]?.state,
        { timeout: 8000 },
      )
      .toBe("active");
    const elapsed = Date.now() - dispatchedAt;
    expect(elapsed).toBeLessThan(8000);
    const [dispatch] = await db.select().from(outbox);
    const [attempt] = await db
      .select()
      .from(fleetSourceIntent)
      .where(eq(fleetSourceIntent.id, sourceId));
    console.info(
      `[synthetic source timing] dispatcher-start-to-observed-active=${elapsed}ms outbox=${dispatch.dispatchedAt!.getTime() - dispatch.createdAt.getTime()}ms queue-to-claim=${attempt.lastAttemptAt!.getTime() - dispatch.dispatchedAt!.getTime()}ms`,
    );
    const [authority] = await db.select().from(fleetSourceAuthority);
    expect(authority.linkedCharacters.map((ch) => ch.characterId).sort()).toEqual(
      [anchor.id, alt.id, bChars[0].id, bChars[1].id].sort(),
    );
    expect(authority.expiresAt!.getTime() - authority.verifiedAt!.getTime()).toBe(10000);
    const status = await send("GET", "/api/fleet/v1/sources");
    expect(status.status()).toBe(200);
    const dto = await status.json();
    expect(dto.characters).toContainEqual({
      character_id: alt.id,
      character_name: alt.name,
      character_link_epoch: alt.fleetLinkEpoch,
      has_fleet_read: false,
      token_usable: false,
    });
    expect(JSON.stringify(dto)).not.toMatch(/fleet_id|owner_hash|access_token/);
    await new Promise((r) => setTimeout(r, 510));
    // Source-only bootstrap above deliberately happened before either On.
    for (const device of [pair, b])
      expect(
        (
          await send(
            "PUT",
            "/api/fleet/v1/participation",
            {
              protocol: 1,
              enabled: true,
              expected_generation: 0,
            },
            device,
          )
        ).status(),
      ).toBe(200);
    await new Promise((r) => setTimeout(r, 510));
    const eligibility = await send("GET", "/api/fleet/v1/eligibility", undefined, b);
    expect(eligibility.status()).toBe(200);
    const view = (await eligibility.json()) as {
      state: string;
      characters: { character_id: number }[];
    };
    expect(view.state).toBe("ready");
    expect(view.characters.map((ch) => ch.character_id)).toEqual([
      bChars[0].id,
      bChars[1].id,
    ]);
    expect(JSON.stringify(view)).not.toMatch(/fleet_id|character_name|roster/);
    expect(
      (
        await send("PUT", "/api/fleet/v1/snapshot", {
          protocol: 1,
          rows: [{ character_id: anchor.id, dps: 42, ewar: [] }],
        })
      ).status(),
    ).toBe(200);
    await new Promise((r) => setTimeout(r, 510));
    const quiet = await send("GET", "/api/fleet/v1/snapshot", undefined, b);
    expect(quiet.status()).toBe(200);
    expect((await quiet.json()).rows).toEqual([
      expect.objectContaining({ character_id: anchor.id, dps: 42 }),
    ]);
    expect(
      (
        await send(
          "PUT",
          "/api/fleet/v1/snapshot",
          {
            protocol: 1,
            rows: [{ character_id: bChars[1].id, dps: 77, ewar: ["SCRAM/POINT"] }],
          },
          b,
        )
      ).status(),
    ).toBe(200);
    const back = await send("GET", "/api/fleet/v1/snapshot");
    expect(back.status()).toBe(200);
    expect((await back.json()).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ character_id: bChars[1].id, dps: 77 }),
      ]),
    );
    // A real Node HTTP peer can attach GET bytes which Fetch clients prohibit.
    // Sign EMPTY bytes, then send framing/bytes independently through managed Next.
    const framedSnapshot = async (
      publication: boolean,
      framing: string[],
      bytes = "",
    ) => {
      const n = (revisions.get(pair.sessionId) ?? 0) + 1;
      revisions.set(pair.sessionId, n);
      const issued = new Date().toISOString();
      const digest = createHash("sha256").update("").digest("hex");
      const canonical = [
        "fleet-v1",
        "GET",
        "/api/fleet/v1/snapshot",
        pair.sessionId,
        issued,
        String(n),
        digest,
      ].join("\n");
      const headers = new Headers({
        "x-fleet-session": pair.sessionId,
        "x-fleet-issued-at": issued,
        "x-fleet-revision": String(n),
        "x-fleet-body-sha256": digest,
        "x-fleet-signature": sign(null, Buffer.from(canonical), pair.privateKey).toString(
          "base64url",
        ),
        ...(publication ? { "x-fleet-snapshot-format": "publication-v1" } : {}),
      });
      return {
        response: await getFleetHttp(
          `${FLEET_UPSTREAM_URL}/api/fleet/v1/snapshot`,
          headers,
          framing,
          bytes,
        ),
        canonical,
      };
    };
    const retainedRelay = async () => ({
      rows: await db
        .select()
        .from(fleetTelemetryRow)
        .orderBy(fleetTelemetryRow.characterId),
      leases: await db
        .select()
        .from(fleetPublisherLease)
        .orderBy(fleetPublisherLease.characterId),
      sessions: await db.select().from(fleetDeviceSession).orderBy(fleetDeviceSession.id),
    });
    for (const publication of [false, true]) {
      for (const framing of [
        ["Content-Length", "2"],
        ["Transfer-Encoding", "chunked"],
      ]) {
        // Ensure a buggy admitted read would succeed, not fail cadence instead.
        await new Promise((r) => setTimeout(r, 510));
        const before = await retainedRelay();
        const { response } = await framedSnapshot(publication, framing, "{}");
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ protocol: 1, error: "bad_headers" });
        expect(response.headers["x-fleet-snapshot-format"]).toBeUndefined();
        expect(response.headers["x-fleet-request-binding"]).toBeUndefined();
        expect(await retainedRelay()).toEqual(before);
      }
      for (const framing of [[], ["Content-Length", "0"]]) {
        await new Promise((r) => setTimeout(r, 510));
        const { response, canonical } = await framedSnapshot(publication, framing);
        expect(response.status).toBe(200);
        const rows = (JSON.parse(response.body) as { rows: Record<string, unknown>[] })
          .rows;
        expect(rows.length).toBeGreaterThan(0);
        if (publication) {
          expect(response.headers["x-fleet-snapshot-format"]).toBe("publication-v1");
          expect(response.headers["x-fleet-request-binding"]).toBe(
            createHash("sha256")
              .update("fleet-snapshot-publication-v1\n" + canonical)
              .digest("hex"),
          );
          for (const row of rows)
            expect(row.publication_id).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
        } else {
          expect(response.headers["x-fleet-snapshot-format"]).toBeUndefined();
          expect(response.headers["x-fleet-request-binding"]).toBeUndefined();
          for (const row of rows)
            expect(Object.keys(row).sort()).toEqual([
              "age_ms",
              "character_id",
              "character_name",
              "dps",
              "ewar",
              "state",
            ]);
        }
      }
    }
    expect(await db.select().from(fleetEligibility)).toEqual([]);
    expect(
      (
        await db.select().from(character).where(eq(character.accountId, participant.id))
      ).every(
        (ch) =>
          ch.refreshTokenEnc === null &&
          ch.scopes.length === 0 &&
          ch.tokenStatus === "missing",
      ),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 510));
    const stopped = await send("PUT", "/api/fleet/v1/sources", {
      protocol: 1,
      operation: "stop",
      source_id: sourceId,
      expected_generation: 1,
    });
    expect(stopped.status()).toBe(200);
    expect((await db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
    expect((await fleet.snapshot()).requests.map((r) => r.stage)).toEqual(
      expect.arrayContaining(["token", "jwks", "membership", "roster"]),
    );
  } finally {
    owner.stopAdmission();
    await stopScheduler?.();
    await stopDispatch?.();
    await boss.offWork(QUEUES.fleetSource);
    await owner.drain();
    await boss.stop({ graceful: true, wait: true });
    await pool.end();
  }
});
