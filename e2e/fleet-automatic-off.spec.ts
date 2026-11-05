import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import {
  account,
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetDevice,
  fleetDeviceSession,
} from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { BASE_URL } from "./env";
import { pairDevice } from "../tests/helpers/fleet-sharing";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === BASE_URL ? route.continue() : route.abort(),
  );
  await resetDb(db);
});
async function consent() {
  const owner = await seedMember(db, { name: "Automatic Off owner", tier: "alumni" });
  const now = new Date();
  // Terminal-control fixture: no session, Member tier, live approver or grant.
  // This seeds consent only, not positive verification/roster evidence.
  await db.insert(fleetAutomaticConsent).values({
    accountId: owner.id,
    generation: 1,
    revision: 1,
    enabled: true,
    approvingDeviceId: randomUUID(),
    approvedAt: now,
    nextReconcileAt: now,
  });
  return owner;
}
async function current(id: string) {
  return (
    await db
      .select()
      .from(fleetAutomaticConsent)
      .where(eq(fleetAutomaticConsent.accountId, id))
  )[0];
}

test("an own-account browser can turn automatic verification Off without revoking a device", async ({
  page,
  context,
}) => {
  const owner = await consent();
  await db.update(account).set({ tier: "member" }).where(eq(account.id, owner.id));
  const paired = await pairDevice(db, owner.id, new Date());
  await db.update(account).set({ tier: "alumni" }).where(eq(account.id, owner.id));
  await db
    .update(fleetAutomaticConsent)
    .set({ approvingDeviceId: paired.device.id })
    .where(eq(fleetAutomaticConsent.accountId, owner.id));
  const beforeDevices = await db.select().from(fleetDevice);
  const beforeSessions = await db.select().from(fleetDeviceSession);
  expect(beforeDevices).toHaveLength(1);
  expect(beforeSessions).toHaveLength(1);
  await context.addCookies([await sessionCookieFor(db, owner.id)]);
  await page.goto("/account");
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  const controls = page.getByRole("link", { name: "Fleet controls", exact: true });
  await expect(controls).toBeVisible();
  await controls.click();
  const off = page.getByRole("button", {
    name: "Turn off automatic verification",
    exact: true,
  });
  await expect(off).toBeEnabled();
  expect((await current(owner.id)).enabled).toBe(true); // GET never changes consent.
  for (const width of [840, 320]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expect(off).toBeVisible();
  }
  await off.click();
  await expect.poll(async () => (await current(owner.id)).enabled).toBe(false);
  await expect(
    page.getByText("Automatic boss verification: Off", { exact: true }),
  ).toBeVisible();
  expect(await db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
  expect(await db.select().from(fleetDevice)).toEqual(beforeDevices);
  expect(await db.select().from(fleetDeviceSession)).toEqual(beforeSessions);
});

test("a conflicting displayed choice requires another explicit Off click", async ({
  page,
  context,
}) => {
  const owner = await consent();
  await context.addCookies([await sessionCookieFor(db, owner.id)]);
  await page.goto("/account/fleet-devices");
  const off = page.getByRole("button", {
    name: "Turn off automatic verification",
    exact: true,
  });
  await expect(off).toBeEnabled();
  await db
    .update(fleetAutomaticConsent)
    .set({ generation: 2, revision: 3 })
    .where(eq(fleetAutomaticConsent.accountId, owner.id));
  await off.click();
  await expect(page.getByText(/The account choice changed/)).toBeVisible();
  expect(await current(owner.id)).toMatchObject({
    enabled: true,
    generation: 2,
    revision: 3,
  });
  expect(await db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
  await off.click();
  await expect.poll(async () => (await current(owner.id)).enabled).toBe(false);
  expect(await current(owner.id)).toMatchObject({ generation: 2, revision: 4 });
});

test("a stale account page cannot apply its Off after the browser signs into another account", async ({
  page,
  context,
}) => {
  const first = await consent();
  const second = await consent();
  await context.addCookies([await sessionCookieFor(db, first.id)]);
  await page.goto("/account/fleet-devices");
  const off = page.getByRole("button", {
    name: "Turn off automatic verification",
    exact: true,
  });
  await expect(off).toBeEnabled();
  await context.addCookies([await sessionCookieFor(db, second.id)]);
  await off.click();
  await expect(page.getByText(/Authentication changed/)).toBeVisible();
  expect((await current(first.id)).enabled).toBe(true);
  expect((await current(second.id)).enabled).toBe(true);
  expect(await db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
  await page.reload();
  await off.click();
  await expect.poll(async () => (await current(second.id)).enabled).toBe(false);
  expect((await current(first.id)).enabled).toBe(true);
});

// Exercise real lost Server Action responses, not mocked consent changes.
for (const reenabled of [false, true]) {
  test(`lost Off response retries its original identity, newer consent ${reenabled}`, async ({
    page,
    context,
  }) => {
    const owner = await consent();
    await context.addCookies([await sessionCookieFor(db, owner.id)]);
    await page.goto("/account/fleet-devices");
    let lost = false;
    await page.route("**/account/fleet-devices", async (route) => {
      if (
        !lost &&
        route.request().method() === "POST" &&
        route.request().headers()["next-action"]
      ) {
        lost = true;
        await route.fetch(); // Real action commits; discard only the response.
        await route.abort("failed");
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "Turn off automatic verification", exact: true })
      .click();
    await expect.poll(async () => (await current(owner.id)).enabled).toBe(false);
    await expect(page.getByText(/outcome is unconfirmed/i)).toBeVisible();
    const [original] = await db.select().from(fleetAutomaticReceipt);
    expect(original).toBeDefined();
    if (reenabled)
      await db
        .update(fleetAutomaticConsent)
        .set({
          generation: 2,
          revision: 3,
          enabled: true,
          disabledAt: null,
          closedReason: null,
        })
        .where(eq(fleetAutomaticConsent.accountId, owner.id));
    await page
      .getByRole("button", { name: "Refresh verification state", exact: true })
      .click();
    await expect(
      page.getByText(`Automatic boss verification: ${reenabled ? "On" : "Off"}`, {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Retry the same Off request", exact: true })
      .click();
    await expect(
      page.getByText(
        reenabled
          ? /earlier Off was acknowledged.*currently On/i
          : "Automatic boss verification: Off",
        { exact: !reenabled },
      ),
    ).toBeVisible();
    const receipts = await db.select().from(fleetAutomaticReceipt);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receipt.command).toEqual(original.receipt.command);
    expect(await current(owner.id)).toMatchObject(
      reenabled
        ? { enabled: true, generation: 2, revision: 3 }
        : { enabled: false, generation: 1, revision: 2 },
    );
  });
}
