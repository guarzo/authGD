import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.beforeEach(() => resetDb(db));
test.afterAll(() => pool.end());

test("an admin downloads evidence without closing the applicant drawer", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Recruiter", isAdmin: true });
  const applicant = await seedMember(db, {
    name: "Applicant",
    tier: "pending",
    alts: ["Applicant Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  // Browser boundary test only. The real route/ESI/import pipeline is exercised
  // by recruitment-integration.test.ts with signed test identities and local ESI responses.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = JSON.stringify({
    format: "authgd-recruitment-evidence",
    marker: "download-content",
  });
  let requests = 0;
  await page.route(`**/admin/accounts/${applicant.id}/recruitment`, async (route) => {
    requests++;
    expect(route.request().method()).toBe("POST");
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body });
  });
  await page.goto("/admin/accounts?tier=pending");
  const row = page.locator(".log--dense > tbody > tr:not(.drawer-row)", {
    hasText: "Applicant",
  });
  await row.locator(".row-toggle").click();
  const button = page.getByRole("button", {
    name: "Collect recruitment evidence for Applicant",
    exact: true,
  });
  await expect(button).toBeVisible();
  const download = page.waitForEvent("download");
  await button.click();
  await expect(button).toBeDisabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Collecting all linked characters" }),
  ).toBeVisible();
  release();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`recruitment-${applicant.id}.json`);
  expect(await readFile(await file.path(), "utf8")).toBe(body);
  await expect(button).toBeEnabled();
  await expect(row.locator(".row-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("status").filter({ hasText: "Evidence download started" }),
  ).toBeVisible();
  expect(requests).toBe(1);
});

test("a failed collection is visible and can be attempted again", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Recruiter", isAdmin: true });
  const applicant = await seedMember(db, { name: "Applicant", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  let attempts = 0;
  await page.route(`**/admin/accounts/${applicant.id}/recruitment`, async (route) => {
    attempts++;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"error":"identity_changed"}',
    });
  });
  await page.goto("/admin/accounts?tier=pending");
  await page
    .locator(".log--dense > tbody > tr:not(.drawer-row)", { hasText: "Applicant" })
    .locator(".row-toggle")
    .click();
  const button = page.getByRole("button", {
    name: "Collect recruitment evidence for Applicant",
    exact: true,
  });
  await button.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Character links or ownership changed" }),
  ).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => attempts).toBe(2);
});
