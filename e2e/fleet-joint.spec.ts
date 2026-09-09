import { eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withFleetCertificateContext } from "./fleet-certificate";
import { type FleetScenario } from "./fleet-fixtures";
import { WORKTREE_ROOT } from "./env";
import {
  test,
  expect,
  installFleetBrowserBoundary,
  disposeFleetResources,
} from "./fleet-browser";
import { BASE_URL, SYNTHETIC_APP_ENV, TEST_DATABASE_URL } from "./env";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import {
  createInstallations,
  startFleetWorker,
  runLegacyRecoveryProbe,
  type InstallationStatus,
} from "./fleet-installations";
import { loadConfig } from "../src/config";
import { encryptToken } from "../src/lib/crypto";
import { FLEET_READ_SCOPE } from "../src/lib/esi/client";
import {
  fleetKeyPair,
  pairDevice,
  reconcileFleetKeys,
} from "../tests/helpers/fleet-sharing";
import { acknowledgeFleetCapabilities } from "../src/services/fleet-device";
import { setFleetParticipation } from "../src/services/fleet-participation";
import { replaceDeviceProjection } from "../src/services/fleet-relay";
import { SHARED_CAPABILITY } from "../src/core/fleet-sharing";
import { transitionFleetSharingMode } from "../src/services/fleet-sharing-mode";
import {
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetEligibility,
  fleetPairingRequest,
  fleetSourceIntent,
  fleetTelemetryRow,
  outbox,
} from "../src/db/schema";

test("HTTPS serves the current Next mode and development HMR uses WSS", async ({
  page,
}) => {
  const development = process.env.E2E_FLEET_SERVER_MODE === "dev";
  const hmr = development
    ? page.waitForEvent("websocket", {
        predicate: (socket) => new URL(socket.url()).pathname.includes("hmr"),
      })
    : null;
  expect((await page.goto("/login"))?.status()).toBe(200);
  if (hmr) {
    const socket = await hmr;
    expect(new URL(socket.url()).origin).toBe(BASE_URL.replace(/^http/, "ws"));
    await socket.waitForEvent("framereceived");
  }
});

test("Chromium itself verifies the owned CA and refuses wrong hostname and untrusted CA", async () => {
  for (const mode of ["trusted", "untrusted", "wrong-host"] as const) {
    await withFleetCertificateContext(mode, async (context, appUrl) => {
      const page = await context.newPage();
      // NO route.fetch/fulfill: Chromium itself validates the certificate.
      const navigation = page.goto(`${appUrl}/login`);
      if (mode === "trusted") expect((await navigation)?.status()).toBe(200);
      else
        await expect(navigation).rejects.toThrow(
          mode === "untrusted"
            ? /ERR_CERT_AUTHORITY_INVALID/
            : /ERR_CERT_COMMON_NAME_INVALID/,
        );
    });
  }
});

for (const conflict of [false, true])
  test(`real Python recovery retries preserve the challenge and classify legacy conflict=${conflict}`, async () => {
    const { db, pool } = testDb();
    try {
      await resetDb(db);
      const owner = await seedMember(db, {
        name: "Task10 Legacy Fixture",
        tier: "member",
      });
      const key = fleetKeyPair();
      await pairDevice(db, owner.id, new Date(), [], {
        ...key,
        publicKeySpki: new Uint8Array([...key.publicKeySpki, 0]),
      });
      if (conflict) await pairDevice(db, owner.id, new Date(), [], key);
      const ready = await reconcileFleetKeys(db);
      await transitionFleetSharingMode(db, {
        enabled: true,
        expectedRevision: ready.revision,
      });
      const exported = key.privateKey.export({ format: "jwk" });
      expect(await runLegacyRecoveryProbe(Buffer.from(exported.d!, "base64url"))).toEqual(
        {
          idempotent: true,
          result: conflict ? "device_key_conflict" : "reconnected",
          fresh_key_required: conflict,
        },
      );
      expect(await db.select().from(fleetDevice)).toHaveLength(conflict ? 2 : 1);
      expect(await db.select().from(fleetTelemetryRow)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

function assertCadence(status: InstallationStatus) {
  const last = new Map<string, number>();
  const revisions = new Map<number, number>();
  for (const req of status.requests) {
    if (req.revision === null) continue;
    expect(req.status, "healthy coordinator must not self-rate-limit").not.toBe(429);
    expect(req.revision).toBeGreaterThan(revisions.get(req.session!) ?? 0);
    revisions.set(req.session!, req.revision);
    const bucket =
      req.method === "PUT" && req.operation === "snapshot" ? "publish" : "read";
    const prior = last.get(bucket);
    if (prior !== undefined) expect(req.start - prior).toBeGreaterThanOrEqual(0.5);
    if (req.status !== null) {
      expect(req.headers_received).toBeGreaterThanOrEqual(req.start);
    }
    if (req.completed !== null) {
      expect(req.completed).toBeGreaterThanOrEqual(req.headers_received ?? req.start);
      if (req.body_received !== null)
        expect(req.completed).toBeGreaterThanOrEqual(req.body_received);
      last.set(bucket, req.completed);
    }
  }
  expect(
    status.requests.some(
      (r) =>
        r.body_received !== null &&
        r.headers_received !== null &&
        r.body_received > r.headers_received,
    ),
  ).toBe(true);
  expect(status.denials).toBe(0);
}

test("two pinned Python installations pair in real HTTPS browsers and share through the owned source worker", async ({
  page,
  context,
  browser,
  fleet,
}) => {
  // New multi-stage integration budget; no retries or product timeout changes.
  test.setTimeout(180_000);
  expect(BASE_URL).toMatch(/^https:\/\/localhost:/);
  const { db, pool } = testDb();
  const resources: Array<() => Promise<void>> = [() => pool.end()];
  let primary: unknown;
  try {
    await resetDb(db);
    const ready = await reconcileFleetKeys(db);
    await transitionFleetSharingMode(db, {
      enabled: true,
      expectedRevision: ready.revision,
    });
    const a = await seedMember(db, {
      name: "Task10 Boss",
      tier: "member",
      alts: ["Task10 Boss Alt", "Task10 Outside A", "Task10 Successor"],
    });
    const b = await seedMember(db, {
      name: "Task10 Quiet",
      tier: "member",
      status: "cryo",
      alts: ["Task10 Included Alt", "Task10 Outside B"],
    });
    const aChars = await db
      .select()
      .from(character)
      .where(eq(character.accountId, a.id))
      .orderBy(character.id);
    const bChars = await db
      .select()
      .from(character)
      .where(eq(character.accountId, b.id))
      .orderBy(character.id);
    let tokenlessChecks = 0;
    const assertTokenless = async () => {
      const participants = await db
        .select()
        .from(character)
        .where(eq(character.accountId, b.id));
      expect(
        participants.every(
          (ch) =>
            ch.refreshTokenEnc === null &&
            ch.scopes.length === 0 &&
            ch.tokenStatus === "missing",
        ),
      ).toBe(true);
      expect(await db.select().from(fleetEligibility)).toEqual([]);
      tokenlessChecks++;
    };
    const cfg = loadConfig({
      NODE_ENV: "test",
      ...SYNTHETIC_APP_ENV,
      DATABASE_URL: TEST_DATABASE_URL,
      APP_BASE_URL: BASE_URL,
      SYNC_MODE: "live",
    });
    await db.update(character).set({ tokenStatus: "missing" });
    await db
      .update(character)
      .set({
        refreshTokenEnc: encryptToken("fleet-test-task10-boss", cfg.tokenEncryptionKey),
        tokenStatus: "valid",
        scopes: [FLEET_READ_SCOPE],
      })
      .where(eq(character.id, aChars[0].id));
    const scenario: FleetScenario = {
      characters: [
        {
          id: aChars[0].id,
          name: aChars[0].name,
          ownerHash: aChars[0].ownerHash,
          scopes: [FLEET_READ_SCOPE],
          refreshToken: "fleet-test-task10-boss",
        },
      ],
      fleetId: 123456,
      fleetBossId: aChars[0].id,
      rosterIds: [aChars[0].id, aChars[1].id, bChars[0].id, bChars[1].id],
      responses: { membership: { freshness: "live" }, roster: { freshness: "live" } },
    };
    await fleet.scenario(scenario);
    await assertTokenless();
    const installs = createInstallations();
    resources.push(() => installs.close());
    const first = await installs.start("a");
    let second = await installs.start("b");
    const secondContext = await browser.newContext({
      baseURL: BASE_URL,
      serviceWorkers: "block",
      proxy: { server: fleet.connection.url, bypass: "<-loopback>" },
    });
    resources.push(() => secondContext.close());
    const drain = await installFleetBrowserBoundary(secondContext, fleet);
    resources.push(drain);
    const secondPage = await secondContext.newPage();
    // NO fixture reset here: both independent browser accounts share this scenario.
    await context.addCookies([await sessionCookieFor(db, a.id)]);
    await secondContext.addCookies([await sessionCookieFor(db, b.id)]);
    for (const [installation, approvalPage] of [
      [first, page],
      [second, secondPage],
    ] as const) {
      await installation.command("pair");
      await expect.poll(() => installation.approval(), { timeout: 10_000 }).toBeTruthy();
      const approval = await installation.approval();
      if (!approval || new URL(approval).origin !== BASE_URL)
        throw new Error("wrong pairing origin");
      await approvalPage.goto(approval);
      await expect(
        approvalPage.getByText(/Participation is a separate, default-off choice/),
      ).toBeVisible();
      await approvalPage.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(
        approvalPage.getByText(
          "Approved. Waiting for the desktop app to finish pairing.",
        ),
      ).toBeVisible();
      await expect
        .poll(async () => (await installation.command("status")).paired, {
          timeout: 10_000,
        })
        .toBe(true);
    }
    await assertTokenless();
    const approvals = await db.select().from(fleetPairingRequest);
    expect(approvals).toHaveLength(2);
    expect(approvals.every((p) => p.consumedAt !== null)).toBe(true);
    expect(
      (await db.select().from(fleetDevice)).every((d) => !d.participationEnabled),
    ).toBe(true);
    expect(await db.select().from(fleetSourceIntent)).toEqual([]);
    expect(await db.select().from(fleetTelemetryRow)).toEqual([]);
    // A local stream while Off cannot publish. B opts in but stays genuinely quiet.
    await first.command("local");
    // A real local admission must drain through the presentation owner before
    // remote exclusion can be meaningful on the otherwise quiet receiver.
    await expect.poll(async () => (await first.command("status")).seen).toBe(3);
    await expect
      .poll(async () => (await first.command("status")).presented_characters)
      .toBe(3);
    expect(await first.command("status")).toMatchObject({
      settings_characters: 3,
      persisted_seen: 3,
      pending_roster: 0,
      unexpected_settings: 0,
    });
    await second.command("on");
    await expect
      .poll(async () => (await second.command("status")).observed_on, { timeout: 10_000 })
      .toBe(true);
    await assertTokenless();
    expect((await second.command("status")).eligible).toBe(0);
    expect(await db.select().from(fleetTelemetryRow)).toEqual([]);
    await first.command("watch");
    await expect
      .poll(
        async () =>
          (await first.command("status")).requests.some(
            (r) => r.operation === "sources" && r.status === 200,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await first.command("start-first");
    await expect
      .poll(async () => (await db.select().from(fleetSourceIntent))[0]?.state, {
        timeout: 10_000,
      })
      .toBe("pending");
    expect((await fleet.snapshot()).requests).toEqual([]);
    expect((await db.select().from(outbox)).map((r) => r.payload.kind)).toEqual([
      "fleet-source",
    ]);
    const worker = await startFleetWorker(fleet.connection);
    resources.push(() => worker.close());
    await expect
      .poll(async () => (await db.select().from(fleetSourceIntent))[0]?.state, {
        timeout: 10_000,
      })
      .toBe("active");
    // The third lease fixture is NOT either Python installation. Default Off
    // contributes nothing; only explicit fixture consent admits its lease.
    await assertTokenless();
    const fixtureNow = new Date(Date.now() - 2000);
    const holder = await pairDevice(db, a.id, fixtureNow, [SHARED_CAPABILITY]);
    expect(holder.device.participationEnabled).toBe(false);
    expect(await db.select().from(fleetTelemetryRow)).toEqual([]);
    expect(
      (
        await acknowledgeFleetCapabilities(db, {
          sessionId: holder.sessionId,
          revision: 1,
          now: fixtureNow,
          capabilities: [SHARED_CAPABILITY],
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await setFleetParticipation(db, {
          sessionId: holder.sessionId,
          revision: 2,
          now: new Date(fixtureNow.getTime() + 500),
          enabled: true,
          expectedGeneration: 0,
        })
      ).ok,
    ).toBe(true);
    expect(
      await replaceDeviceProjection(db, {
        sessionId: holder.sessionId,
        revision: 3,
        now: new Date(),
        rows: [{ characterId: aChars[0].id, dps: 9, ewar: [] }],
      }),
    ).toEqual({ ok: true });
    await first.command("on");
    await expect
      .poll(
        async () =>
          (await first.command("status")).requests.some(
            (r) => r.operation === "snapshot" && r.method === "PUT" && r.status === 409,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(
      await replaceDeviceProjection(db, {
        sessionId: holder.sessionId,
        revision: 4,
        now: new Date(),
        rows: [],
      }),
    ).toEqual({ ok: true });
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 15_000,
      })
      .toBe(2);
    await assertTokenless();
    const quiet = await second.command("status");
    expect(quiet.local).toBe(0);
    expect(quiet).toMatchObject({
      seen: 0,
      settings_characters: 0,
      persisted_seen: 0,
      pending_roster: 0,
      unexpected_settings: 0,
      presented_characters: 0,
    });
    expect(quiet.fleet_presentations).toBeGreaterThan(0);
    expect(quiet.remote.map((r) => r.dps).sort()).toEqual([42, 43]);
    expect(quiet.remote.some((r) => r.ewar.includes("SCRAM/POINT"))).toBe(true);
    expect(
      (await db.select().from(fleetTelemetryRow)).map((r) => r.characterId).sort(),
    ).toEqual([aChars[0].id, aChars[1].id]);
    await second.command("local");
    await expect
      .poll(async () => (await first.command("status")).remote.length, {
        timeout: 10_000,
      })
      .toBe(2);
    expect(
      (await db.select().from(fleetTelemetryRow)).map((r) => r.characterId).sort(),
    ).toEqual([aChars[0].id, aChars[1].id, bChars[0].id, bChars[1].id].sort());
    assertCadence(await first.command("status"));
    assertCadence(await second.command("status"));
    // Same-valued heartbeats and repeated reads enter the actual 9b store.
    await expect
      .poll(async () => (await second.command("status")).same_publication, {
        timeout: 8000,
      })
      .toBeGreaterThan(0);
    // Measurement, not a retry: assert every sample, including across more
    // than one ten-second evidence lease, instead of waiting out a dropout.
    const continuity: Array<{ sample: number; states: string[] }> = [];
    for (let sample = 0; sample < 24; sample++) {
      await assertTokenless();
      const live = await second.command("status");
      if (live.remote.length !== 2 || live.remote.some((row) => row.state !== "live")) {
        const publisher = await first.command("status");
        writeFileSync(
          join(WORKTREE_ROOT, `tmp/task-10/fix1/continuity-failure-${Date.now()}.json`),
          JSON.stringify(
            {
              sample,
              receiverStates: live.remote.map((row) => row.state),
              publisherState: publisher.state,
              publisherDetail: publisher.detail,
              receiverState: live.state,
              receiverDetail: live.detail,
              publisherRequests: publisher.requests.slice(-30),
              receiverRequests: live.requests.slice(-30),
            },
            null,
            2,
          ),
        );
      }
      continuity.push({ sample, states: live.remote.map((row) => row.state) });
      expect(live.remote).toHaveLength(2);
      expect(live.remote.every((row) => row.state === "live")).toBe(true);
      expect(live.age_violations).toBe(0);
      await delay(500);
    }
    writeFileSync(
      join(WORKTREE_ROOT, `tmp/task-10/fix1/healthy-cadence-${Date.now()}.json`),
      JSON.stringify(
        {
          continuity,
          intervalMs: 500,
          publisherRequests: (await first.command("status")).requests,
          receiverRequests: (await second.command("status")).requests,
        },
        null,
        2,
      ),
    );
    const beforeCapture = (await second.command("status")).remote_deliveries;
    await fleet.relayMode("capture");
    await expect
      .poll(async () => (await second.command("status")).remote_deliveries, {
        timeout: 8000,
      })
      .toBeGreaterThan(beforeCapture + 1);
    await fleet.relayMode("replay");
    await expect
      .poll(async () => (await second.command("status")).details, { timeout: 10_000 })
      .toContain("malformed_response");
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 12_000,
      })
      .toBe(0);
    await assertTokenless();
    expect((await second.command("status")).age_violations).toBe(0);
    await fleet.relayMode("normal");
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 15_000,
      })
      .toBe(2);
    // A disconnected Off inhibits immediately but cannot acknowledge deletion.
    await fleet.relayMode("disconnect");
    const off = await second.command("off");
    expect(off.inhibited).toBe(true);
    expect(off.remote).toEqual([]);
    expect(off.observed_on).toBe(true);
    await expect
      .poll(async () => (await second.command("status")).details, { timeout: 8000 })
      .toContain("transport_error");
    await expect
      .poll(async () =>
        (await second.command("status")).requests.some(
          (r) => r.failed === true && r.completed !== null && r.headers_received === null,
        ),
      )
      .toBe(true);
    await assertTokenless();
    expect((await first.command("status")).local).toBe(3);
    await fleet.relayMode("normal");
    await expect
      .poll(async () => (await second.command("status")).observed_on, { timeout: 10_000 })
      .toBe(false);
    await second.command("on");
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 10_000,
      })
      .toBe(2);
    await assertTokenless();
    // Restart is a NEW process with the same persisted installation and key.
    await second.close();
    second = await installs.start("b");
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 12_000,
      })
      .toBeGreaterThan(0);
    expect(await db.select().from(fleetPairingRequest)).toHaveLength(3);
    await assertTokenless();
    // Expire only synthetic fixture sessions; no real-time half-hour wait.
    const [bDevice] = await db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, b.id));
    await db
      .update(fleetDeviceSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fleetDeviceSession.deviceId, bDevice.id));
    await expect
      .poll(
        async () =>
          (await second.command("status")).requests.some(
            (r) => r.operation === "recovery-complete" && r.status === 200,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 12_000,
      })
      .toBe(2);
    expect(await db.select().from(fleetPairingRequest)).toHaveLength(3);
    await assertTokenless();
    await second.command("off");
    await expect
      .poll(async () => (await second.command("status")).observed_on, { timeout: 10_000 })
      .toBe(false);
    expect((await second.command("status")).remote).toEqual([]);
    expect((await first.command("status")).local).toBe(3);
    await assertTokenless();
    // Separate sources/fleets form a flat union. B keeps no token or grant.
    for (const index of [1, 3]) {
      const ch = aChars[index];
      const refreshToken = `fleet-test-task10-${index}`;
      await db
        .update(character)
        .set({
          refreshTokenEnc: encryptToken(refreshToken, cfg.tokenEncryptionKey),
          tokenStatus: "valid",
          scopes: [FLEET_READ_SCOPE],
        })
        .where(eq(character.id, ch.id));
      scenario.characters.push({
        id: ch.id,
        name: ch.name,
        ownerHash: ch.ownerHash,
        scopes: [FLEET_READ_SCOPE],
        refreshToken,
      });
    }
    scenario.fleets = [
      {
        fleetId: 123456,
        fleetBossId: aChars[0].id,
        memberIds: [aChars[0].id, aChars[3].id],
        rosterIds: [aChars[0].id, aChars[3].id, bChars[0].id],
        responses: scenario.responses,
      },
      {
        fleetId: 123457,
        fleetBossId: aChars[1].id,
        memberIds: [aChars[1].id],
        rosterIds: [aChars[1].id, bChars[1].id],
        responses: scenario.responses,
      },
    ];
    await fleet.scenario(scenario);
    await expect
      .poll(async () => (await first.command("status")).source_choices, { timeout: 8000 })
      .toBe(3);
    await first.command("start-second");
    await expect
      .poll(
        async () =>
          (await db.select().from(fleetSourceIntent)).filter((s) => s.state === "active")
            .length,
        { timeout: 15_000 },
      )
      .toBe(2);
    await second.command("on");
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 12_000,
      })
      .toBe(2);
    await assertTokenless();
    scenario.fleets[0].fleetBossId = aChars[3].id;
    await fleet.scenario(scenario);
    await first.command("start-third");
    await expect
      .poll(
        async () =>
          (await db.select().from(fleetSourceIntent)).some(
            (s) => s.bossCharacterId === aChars[3].id && s.state === "active",
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 12_000,
      })
      .toBe(2);
    await assertTokenless();
    // Replaying old ESI evidence cannot refresh authorization. The unrelated
    // fleet remains usable; this is not a global network outage approximation.
    scenario.fleets[0].responses = {
      membership: { freshness: "live" },
      roster: {
        headers: {
          Date: new Date(Date.now() - 20_000).toUTCString(),
          Age: "20",
          "Cache-Control": "max-age=5",
        },
      },
    };
    await fleet.scenario(scenario);
    await expect
      .poll(
        async () =>
          (await db.select().from(fleetSourceIntent)).some(
            (s) => s.bossCharacterId === aChars[3].id && s.state === "paused",
          ),
        { timeout: 12_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 12_000,
      })
      .toBe(1);
    await assertTokenless();
    await first.command("stop-sources");
    await expect
      .poll(
        async () =>
          (await db.select().from(fleetSourceIntent)).every((s) => s.state === "ended"),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(await db.select().from(fleetEligibility)).toEqual([]);
    expect(
      (await db.select().from(character).where(eq(character.accountId, b.id))).every(
        (ch) =>
          ch.refreshTokenEnc === null &&
          ch.scopes.length === 0 &&
          ch.tokenStatus === "missing",
      ),
    ).toBe(true);
    expect((await fleet.snapshot()).requests.map((r) => r.stage)).toEqual(
      expect.arrayContaining(["token", "jwks", "membership", "roster"]),
    );
    await expect
      .poll(async () => (await second.command("status")).remote.length, {
        timeout: 10_000,
      })
      .toBe(0);
    await assertTokenless();
    const finalA = await first.command("status");
    const finalB = await second.command("status");
    assertCadence(finalA);
    assertCadence(finalB);
    expect(finalA.age_violations + finalB.age_violations).toBe(0);
    expect(finalA.unexpected_settings + finalB.unexpected_settings).toBe(0);
    expect(finalA.persisted_seen).toBe(3);
    expect(finalB.persisted_seen).toBe(3);
    expect(finalA.pending_roster + finalB.pending_roster).toBe(0);
    expect(finalA.new_publication).toBeGreaterThan(2);
    writeFileSync(
      join(WORKTREE_ROOT, `tmp/task-10/fix1/journey-counts-${Date.now()}.json`),
      JSON.stringify(
        {
          installations: 2,
          continuitySamples: 24,
          continuityIntervalMs: 500,
          browserApprovals: 2,
          leaseFixtures: 1,
          signedAttemptsInFinalProcesses:
            finalA.requests.filter((r) => r.revision !== null).length +
            finalB.requests.filter((r) => r.revision !== null).length,
          samePublicationObservations: finalA.same_publication + finalB.same_publication,
          newPublicationObservations: finalA.new_publication + finalB.new_publication,
          ageRegressions: finalA.age_violations + finalB.age_violations,
          egressDenials: finalA.denials + finalB.denials,
          endedSources: (await db.select().from(fleetSourceIntent)).filter(
            (s) => s.state === "ended",
          ).length,
          participantTokens: 0,
          tokenlessChecks,
        },
        null,
        2,
      ),
    );
    await first.close();
    await second.close();
  } catch (error) {
    primary = error;
  }
  try {
    await disposeFleetResources(resources);
  } catch (cleanup) {
    if (primary)
      throw new AggregateError(
        [primary, cleanup],
        "[fleet-e2e] journey and cleanup failed",
      );
    throw cleanup;
  }
  if (primary instanceof Error) throw primary;
  if (primary !== undefined)
    throw new Error("[fleet-e2e] non-Error journey failure", { cause: primary });
});
