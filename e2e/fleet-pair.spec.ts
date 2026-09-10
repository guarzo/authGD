import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { fleetPairingRequest } from "../src/db/schema";
import { SHARED_CAPABILITY } from "../src/core/fleet-sharing";
import { transitionFleetSharingMode } from "../src/services/fleet-sharing-mode";
import {
  startFleetKeyIdentityReconciliation,
  reconcileFleetKeyIdentityBatch,
} from "../src/services/fleet-key-identity";

import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { BASE_URL } from "./env";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import {
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
} from "../src/services/fleet-pairing";

const { db, pool } = testDb();
async function reconcileKeys() {
  let state = await startFleetKeyIdentityReconciliation(db, {
    expectedRevision: 0,
    oldWritersDrained: true,
    deletionWritersQuiescent: true,
  });
  while (state.keyIdentityPhase !== "ready")
    state = await reconcileFleetKeyIdentityBatch(db, {
      expectedRevision: state.revision,
    });
  return state;
}
test.afterAll(() => pool.end());
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === BASE_URL ? route.continue() : route.abort(),
  );
  await resetDb(db);
});

/**
 * `/fleet/pair/[id]` — the one browser surface Task 6 adds. Everything else
 * about the fleet relay (pairing/catalogue/snapshot) is a signed device
 * request with no browser involved at all, and is covered by
 * tests/fleet-routes.test.ts instead; this file exists only because THIS one
 * page renders real session/tier gating through Next's router (redirect,
 * cookies) that a vitest-level call cannot exercise without mocking away the
 * exact behaviour being proven.
 *
 * Seeds a real pending pairing request via `beginPairing` (the same service
 * the POST /pairing-requests route calls) rather than a route round-trip:
 * the request under test is what the BROWSER does once that id exists, not
 * how the id was minted.
 */
async function seedPendingPairing(requestedCapabilities: string[] = []) {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const { pairingId } = await beginPairing(db, {
    publicKeySpki: spki,
    now: new Date(),
    requestedCapabilities,
  });
  return pairingId;
}

test("shared capability consent names roster management and keeps participation separate", async ({
  page,
  context,
}) => {
  const ready = await reconcileKeys();
  await transitionFleetSharingMode(db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const member = await seedMember(db, { name: "Shared Consent Crew", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  const pairingId = await seedPendingPairing([SHARED_CAPABILITY]);
  await page.goto(`/fleet/pair/${pairingId}`);
  await expect(
    page.getByText(/managing roster verification through an eligible fleet boss/),
  ).toBeVisible();
  await expect(
    page.getByText(/Participation is a separate, default-off choice in Wingman/),
  ).toBeVisible();
  await expect(page.getByText(/Wingman build with Fleet sharing controls/)).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByText("Approved. Waiting for the desktop app to finish pairing."),
  ).toBeVisible();
  const [request] = await db
    .select()
    .from(fleetPairingRequest)
    .where(eq(fleetPairingRequest.id, pairingId));
  expect(request.requestedCapabilities).toEqual([SHARED_CAPABILITY]);
  expect(request.approvedAccountId).toBe(member.id);
  expect(request.approvedDeviceId).toBeNull();
  expect(request.consumedAt).toBeNull();
});

test("disabling shared setup while approval is open refuses the action and removes Approve", async ({
  page,
  context,
}) => {
  const ready = await reconcileKeys();
  await transitionFleetSharingMode(db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const member = await seedMember(db, { name: "Paused Setup Crew", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  const pairingId = await seedPendingPairing([SHARED_CAPABILITY]);
  await page.goto(`/fleet/pair/${pairingId}`);
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await transitionFleetSharingMode(db, {
    enabled: false,
    expectedRevision: ready.revision + 1,
  });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByText(/Shared fleet setup is currently unavailable/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const [request] = await db
    .select()
    .from(fleetPairingRequest)
    .where(eq(fleetPairingRequest.id, pairingId));
  expect(request.approvedAt).toBeNull();
});

for (const approved of [false, true])
  test(`reconciliation removes approval controls and false approval copy (approved=${approved})`, async ({
    page,
    context,
  }) => {
    const member = await seedMember(db, { name: "Maintenance Crew", tier: "member" });
    await context.addCookies([await sessionCookieFor(db, member.id)]);
    const pairingId = await seedPendingPairing();
    if (approved) await approvePairing(db, pairingId, member.id);
    await page.goto(`/fleet/pair/${pairingId}`);
    await startFleetKeyIdentityReconciliation(db, {
      expectedRevision: 0,
      oldWritersDrained: true,
      deletionWritersQuiescent: true,
    });
    if (approved) await page.reload();
    else await page.getByRole("button", { name: "Approve" }).click();
    await expect(
      page.getByText(/Device setup is temporarily unavailable for maintenance/),
    ).toBeVisible();
    await expect(
      page.getByText(/Keep your existing key and try again shortly/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(
      page.getByText("Approved. Waiting for the desktop app to finish pairing."),
    ).toHaveCount(0);
    const [request] = await db
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, pairingId));
    expect(request.approvedAt !== null).toBe(approved);
  });

for (const conflict of [false, true])
  test(`ready page uses indexed legacy aliases (conflict=${conflict})`, async ({
    page,
    context,
  }) => {
    const owner = await seedMember(db, { name: "Alias Owner", tier: "member" });
    const viewer = await seedMember(db, { name: "Alias Viewer", tier: "member" });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const canonical = publicKey.export({ format: "der", type: "spki" });
    const alias = Buffer.concat([canonical, Buffer.from([0])]);
    for (const key of conflict ? [alias, canonical] : [alias]) {
      const p = await beginPairing(db, { publicKeySpki: key });
      await approvePairing(db, p.pairingId, owner.id);
      await completePairing(db, {
        pairingId: p.pairingId,
        completionSignature: ed25519Sign(
          null,
          pairingChallengePreimage(p.pairingId),
          privateKey,
        ).toString("base64url"),
      });
    }
    const pending = await beginPairing(db, { publicKeySpki: canonical });
    await reconcileKeys();
    await context.addCookies([await sessionCookieFor(db, viewer.id)]);
    await page.goto(`/fleet/pair/${pending.pairingId}`);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(
      page.getByText(
        conflict
          ? /This device key cannot be used for pairing/
          : /This device is already paired to a different authGD account/,
      ),
    ).toBeVisible();
  });

test("a non-Member account is refused the pairing page", async ({ page, context }) => {
  const associate = await seedMember(db, { name: "Not Yet Crew", tier: "associate" });
  await context.addCookies([await sessionCookieFor(db, associate.id)]);
  const pairingId = await seedPendingPairing();

  await page.goto(`/fleet/pair/${pairingId}`);

  // Refused by redirect, never rendered: no Approve control ever reaches
  // this account, whatever URL it lands on.
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  expect(new URL(page.url()).pathname).not.toBe(`/fleet/pair/${pairingId}`);
});

test("a cryo Member can approve a pending pairing request", async ({ page, context }) => {
  // Deliberately cryo, not active: approvePairing's own rule (and this page's
  // gate) is tier-only, so a cryo Member must see the identical page an
  // active one would.
  const cryoMember = await seedMember(db, {
    name: "Cryo Crew",
    tier: "member",
    status: "cryo",
  });
  await context.addCookies([await sessionCookieFor(db, cryoMember.id)]);
  const pairingId = await seedPendingPairing();

  await page.goto(`/fleet/pair/${pairingId}`);
  const approve = page.getByRole("button", { name: "Approve" });
  await expect(approve).toBeVisible();

  await approve.click();

  await expect(
    page.getByText("Approved. Waiting for the desktop app to finish pairing."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

// Final-review finding C1: a pairing request whose candidate key is ALREADY
// bound to an ACTIVE device on a DIFFERENT account can never be approved --
// `approvePairing` refuses it early (`DeviceBoundToAnotherAccountError`,
// fleet-pairing.ts) rather than deferring the news to completion. This page
// renders that as its own terminal state (`derivePairingState`, page.tsx)
// from the very first load, before the viewer ever presses Approve: the
// pairing request row's own columns never record this refusal, so without
// this check the page would keep showing "pending" (and an Approve control
// that can never succeed) forever.
test("a device already bound to a different account cannot be approved, and the page says so instead of offering Approve", async ({
  page,
  context,
}) => {
  const firstAccount = await seedMember(db, { name: "First Crew", tier: "member" });
  const viewer = await seedMember(db, { name: "Second Crew", tier: "member" });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const now = new Date();

  // Bind the key to firstAccount via a completed pairing.
  const first = await beginPairing(db, { publicKeySpki: spki, now });
  await approvePairing(db, first.pairingId, firstAccount.id, now);
  await completePairing(db, {
    pairingId: first.pairingId,
    completionSignature: ed25519Sign(
      null,
      pairingChallengePreimage(first.pairingId),
      privateKey,
    ).toString("base64url"),
    now,
  });

  // A fresh, still-open pairing request for the SAME key.
  const second = await beginPairing(db, { publicKeySpki: spki, now });

  await context.addCookies([await sessionCookieFor(db, viewer.id)]);
  await page.goto(`/fleet/pair/${second.pairingId}`);

  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(
    page.getByText("This device is already paired to a different authGD account"),
  ).toBeVisible();
  await expect(
    page.getByText(/Sign in to the account that owns this device/),
  ).toBeVisible();
  await expect(page.getByText(/Generate a new key pair/)).toHaveCount(0);
});
