import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { fleetDevice } from "../src/db/schema";
import {
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
} from "../src/services/fleet-pairing";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { BASE_URL } from "./env";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === BASE_URL ? route.continue() : route.abort(),
  );
  await resetDb(db);
});

/**
 * `/account/fleet-devices` — final-review finding I5's authenticated
 * account-facing device list/revoke surface. Seeds a real, fully completed
 * pairing (the same signed device-key proof `fleet-pair.spec.ts` uses)
 * rather than a bare row: this page's own list reads `fleet_device_session`
 * too, which only a real `completePairing` call ever populates.
 */
async function pairRealDevice(accountId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const { pairingId } = await beginPairing(db, { publicKeySpki: spki, now: new Date() });
  await approvePairing(db, pairingId, accountId, new Date());
  const signature = Buffer.from(
    ed25519Sign(null, pairingChallengePreimage(pairingId), privateKey),
  ).toString("base64url");
  await completePairing(db, {
    pairingId,
    completionSignature: signature,
    now: new Date(),
  });
}

test("a member sees their paired device and can revoke it", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pilot", tier: "member" });
  await pairRealDevice(member.id);
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account/fleet-devices");

  await expect(
    page.getByRole("heading", { name: "Fleet-sharing devices" }),
  ).toBeVisible();
  const revoke = page.getByRole("button", { name: /^revoke device paired/ });
  await expect(revoke).toBeVisible();

  // Two clicks by design: ConfirmSubmit arms first, submits second — same
  // contract account.spec.ts's own unlink/Discord-unlink tests exercise.
  await revoke.click();
  await page.getByRole("button", { name: /^confirm revoke device paired/ }).click();

  await expect(
    page.getByText("Device revoked. It can no longer read or publish fleet data."),
  ).toBeVisible();
  await expect(page.getByText("No devices paired.")).toBeVisible();

  const [device] = await db
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.accountId, member.id));
  expect(device.revokedAt).not.toBeNull();
});

test("a member with no paired devices sees the empty state, not a broken table", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, { name: "Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account/fleet-devices");

  await expect(
    page.getByText(
      "No devices paired. In a Wingman build with Fleet sharing controls, open Settings › Previews and choose Connect.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^revoke/ })).toHaveCount(0);
});
