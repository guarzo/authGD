import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fleet-browser";
import { BASE_URL } from "./env";
import { seedMember, sessionCookieFor, testDb } from "./helpers";
import { fleetDevice, fleetDeviceSession, fleetPairingRequest } from "../src/db/schema";
import { SHARED_CAPABILITY } from "../src/core/fleet-sharing";
import {
  pairingChallengePreimage,
  revokeFleetDevice,
} from "../src/services/fleet-pairing";
import {
  readFleetKeyIdentityState,
  transitionFleetSharingMode,
} from "../src/services/fleet-sharing-mode";
import { reconcileFleetKeys } from "../tests/helpers/fleet-sharing";

const approvedCopy = "Approved. Waiting for the desktop app to finish pairing.";
const unavailableCopy = /This device key cannot be used for pairing/;

// Pairing itself uses actual HTTP registration/completion and browser approval.
// Account/session, revocation, mode and expiry fixtures control the surrounding state.
async function pairedDevice(
  db: ReturnType<typeof testDb>["db"],
  context: BrowserContext,
  page: Page,
) {
  const member = await seedMember(db, { name: "Pairing Crew", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  async function begin(requestedCapabilities: string[] = []) {
    const response = await context.request.post(
      `${BASE_URL}/api/fleet/v1/pairing-requests`,
      {
        data: {
          protocol: 1,
          public_key_spki_b64url: spki.toString("base64url"),
          requested_capabilities: requestedCapabilities,
        },
      },
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.approval_url).toBe(`/fleet/pair/${body.pairing_id}`);
    return body.pairing_id as string;
  }
  async function complete(id: string) {
    return context.request.post(
      `${BASE_URL}/api/fleet/v1/pairing-requests/${id}/complete`,
      {
        data: {
          protocol: 1,
          completion_signature: sign(
            null,
            pairingChallengePreimage(id),
            privateKey,
          ).toString("base64url"),
        },
      },
    );
  }
  async function approve(id: string) {
    await page.goto(`/fleet/pair/${id}`);
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(approvedCopy, { exact: true })).toBeVisible();
  }
  const first = await begin();
  await approve(first);
  const completed = await complete(first);
  expect(completed.status()).toBe(200);
  expect((await completed.json()).session_id).toEqual(expect.any(String));
  const devices = await db
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.accountId, member.id));
  expect(devices).toHaveLength(1);
  const device = devices[0];
  expect(device.revokedAt).toBeNull();
  expect(
    await db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id)),
  ).toHaveLength(1);
  return { member, device, begin, complete, approve };
}

for (const approval of ["unapproved", "approved", "stale approval"] as const) {
  test(`legacy revoked pairing page is honest: ${approval}`, async ({
    page,
    context,
    fleet,
  }, testInfo) => {
    const { db, pool } = testDb();
    try {
      const f = await pairedDevice(db, context, page);
      expect(await readFleetKeyIdentityState(db)).toMatchObject({
        enabled: false,
        keyIdentityPhase: "pending",
      });
      // The request must really exist while its device is live; beginning a
      // request after revocation is already refused and cannot expose this bug.
      const id = await f.begin();
      await page.goto(`/fleet/pair/${id}`);
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toBeVisible();
      if (approval === "approved") await f.approve(id);
      const revokedAt = new Date();
      await revokeFleetDevice(db, f.device.id, f.member.id, revokedAt);
      if (approval === "stale approval") {
        // Pending-mode approval may still be written from an old tab. The
        // re-render must not claim it can finish; completion remains the fence.
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url() === `${BASE_URL}/fleet/pair/${id}` &&
              response.request().method() === "POST" &&
              !!response.request().headers()["next-action"],
          ),
          page.getByRole("button", { name: "Approve", exact: true }).click(),
        ]);
        // The action's RSC update can render despite a canceled fetch, for which
        // Playwright 1.62's response.finished() never resolves. Wait for the real
        // page, and prove the approval write below, not transport completion.
        await expect(page.getByText(unavailableCopy)).toBeVisible();
      } else {
        await page.goto(`/fleet/pair/${id}`);
      }
      const [request] = await db
        .select()
        .from(fleetPairingRequest)
        .where(eq(fleetPairingRequest.id, id));
      expect(request.approvedAt !== null).toBe(approval !== "unapproved");
      expect(request.requestedCapabilities).toEqual([]);
      const refused = await f.complete(id);
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toEqual({ protocol: 1, error: "not_completable" });
      const [unchanged] = await db
        .select()
        .from(fleetPairingRequest)
        .where(eq(fleetPairingRequest.id, id));
      expect(unchanged).toEqual(request);
      expect(
        await db.select().from(fleetDevice).where(eq(fleetDevice.accountId, f.member.id)),
      ).toEqual([{ ...f.device, revokedAt }]);
      expect(
        await db
          .select()
          .from(fleetDeviceSession)
          .where(eq(fleetDeviceSession.deviceId, f.device.id)),
      ).toEqual([]);
      // Soft assertions retain both forms of the original lie in RED evidence,
      // without skipping the service/DB no-resurrection assertions above.
      await expect.soft(page.getByText(unavailableCopy)).toBeVisible();
      await expect
        .soft(page.getByRole("button", { name: "Approve", exact: true }))
        .toHaveCount(0);
      await expect.soft(page.getByText(approvedCopy, { exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("revoked.png"), fullPage: true });
      for (const width of [840, 320]) {
        await page.setViewportSize({ width, height: 800 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      }
      await db
        .update(fleetPairingRequest)
        .set({ expiresAt: new Date(0) })
        .where(eq(fleetPairingRequest.id, id));
      await page.reload();
      await expect(
        page.getByText(/This pairing request is no longer available/),
      ).toBeVisible();
      await expect(page.getByText(unavailableCopy)).toHaveCount(0);
      expect((await fleet.snapshot()).requests).toEqual([]);
    } finally {
      await pool.end();
    }
  });
}

for (const approved of [false, true]) {
  test(`pairing page keeps disabled ahead of unavailable: approved=${approved}`, async ({
    page,
    context,
    fleet,
  }) => {
    const { db, pool } = testDb();
    try {
      const f = await pairedDevice(db, context, page);
      const ready = await reconcileFleetKeys(db);
      const enabled = await transitionFleetSharingMode(db, {
        enabled: true,
        expectedRevision: ready.revision,
      });
      const id = await f.begin([SHARED_CAPABILITY]);
      if (approved) await f.approve(id);
      await revokeFleetDevice(db, f.device.id, f.member.id, new Date());
      await page.goto(`/fleet/pair/${id}`);
      await expect(page.getByText(unavailableCopy)).toBeVisible();
      await transitionFleetSharingMode(db, {
        enabled: false,
        expectedRevision: enabled.revision,
      });
      await page.reload();
      await expect(
        page.getByText(/Shared fleet setup is currently unavailable/),
      ).toBeVisible();
      await expect(page.getByText(unavailableCopy)).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText(approvedCopy, { exact: true })).toHaveCount(0);
      await db
        .update(fleetPairingRequest)
        .set({ expiresAt: new Date(0) })
        .where(eq(fleetPairingRequest.id, id));
      await page.reload();
      await expect(
        page.getByText(/This pairing request is no longer available/),
      ).toBeVisible();
      await expect(
        page.getByText(/Shared fleet setup is currently unavailable/),
      ).toHaveCount(0);
      expect((await fleet.snapshot()).requests).toEqual([]);
    } finally {
      await pool.end();
    }
  });
}
