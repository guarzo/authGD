import { withFleetCertificateContext } from "./fleet-certificate";
import { test, expect } from "./fleet-browser";
import { BASE_URL } from "./env";
import { resetDb, seedMember, testDb } from "./helpers";
import { createInstallations, runLegacyRecoveryProbe } from "./fleet-installations";
import { withFleetResources } from "./fleet-resources";
import {
  fleetKeyPair,
  pairDevice,
  reconcileFleetKeys,
} from "../tests/helpers/fleet-sharing";
import { transitionFleetSharingMode } from "../src/services/fleet-sharing-mode";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetPairingRequest,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
  outbox,
} from "../src/db/schema";

// The immutable Task9b clients are deliberately NOT current-client proof.
// Their former sharing-success journey is preserved in pre-cutover history at
// 123a4d2547e2a93fefd1044645fedff1ad581b8b. Against this backend they must fail
// closed. The maintained API2 source flow and opt-in fleet-current-v2.test.ts
// exercise the new protocol; neither is replaced by a passing legacy fixture.

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
      // Chromium validates the real certificate; no route.fetch/fulfill seam.
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

for (const conflict of [false, true]) {
  test(`pinned pre-v2 recovery is refused without changing legacy identity, conflict=${conflict}`, async () => {
    const { db, pool } = testDb();
    try {
      await resetDb(db);
      const account = await seedMember(db, {
        name: "Legacy retirement fixture",
        tier: "member",
      });
      const key = fleetKeyPair();
      await pairDevice(db, account.id, new Date(), [], {
        ...key,
        publicKeySpki: new Uint8Array([...key.publicKeySpki, 0]),
      });
      if (conflict) await pairDevice(db, account.id, new Date(), [], key);
      const ready = await reconcileFleetKeys(db);
      await transitionFleetSharingMode(db, {
        enabled: true,
        expectedRevision: ready.revision,
      });
      const beforeDevices = await db.select().from(fleetDevice).orderBy(fleetDevice.id);
      const beforeSessions = await db
        .select()
        .from(fleetDeviceSession)
        .orderBy(fleetDeviceSession.id);
      const exported = key.privateKey.export({ format: "jwk" });
      expect(
        await runLegacyRecoveryProbe(Buffer.from(exported.d!, "base64url"), true),
      ).toEqual({
        retired: true,
        statuses: [400, 400],
        denials: 0,
      });
      expect(await db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(
        beforeDevices,
      );
      expect(
        await db.select().from(fleetDeviceSession).orderBy(fleetDeviceSession.id),
      ).toEqual(beforeSessions);
      expect(beforeDevices).toHaveLength(conflict ? 2 : 1);
      expect(await db.select().from(fleetTelemetryRow)).toEqual([]);
    } finally {
      await pool.end();
    }
  });
}

test("two pinned pre-v2 installations cannot pair or publish against the updated backend", async ({
  fleet,
}) => {
  await withFleetResources(async (own) => {
    const { db } = own(testDb(), ({ pool }) => pool.end());
    const installations = own(createInstallations(), (item) => item.close());
    await resetDb(db);
    const ready = await reconcileFleetKeys(db);
    await transitionFleetSharingMode(db, {
      enabled: true,
      expectedRevision: ready.revision,
    });
    expect(BASE_URL).toMatch(/^https:\/\/localhost:/);
    for (const slot of ["a", "b"] as const) {
      const installation = own(await installations.start(slot), (item) => item.close());
      await installation.command("pair");
      await installation.command("on");
      await installation.command("local");
      await expect
        .poll(async () =>
          (await installation.command("status")).requests.some(
            (r) =>
              r.operation === "pairing-requests" &&
              r.status === 400 &&
              r.completed !== null,
          ),
        )
        .toBe(true);
      const status = await installation.command("status");
      expect(status.paired).toBe(false);
      expect(status.observed_on).toBe(false);
      expect(status.remote).toEqual([]);
      expect(status.denials).toBe(0);
      expect(status.requests.some((r) => r.operation === "snapshot")).toBe(false);
      expect(await installation.approval()).toBeNull();
    }
    expect(await db.select().from(fleetDevice)).toHaveLength(0);
    expect(await db.select().from(fleetDeviceSession)).toHaveLength(0);
    expect(await db.select().from(fleetPairingRequest)).toHaveLength(0);
    expect(await db.select().from(fleetSourceIntent)).toHaveLength(0);
    expect(await db.select().from(fleetSourceAuthority)).toHaveLength(0);
    expect(await db.select().from(fleetTelemetryRow)).toHaveLength(0);
    expect(await db.select().from(outbox)).toHaveLength(0);
    expect((await fleet.snapshot()).requests).toEqual([]);
  });
});
