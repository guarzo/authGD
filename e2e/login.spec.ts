import { expect, test } from "@playwright/test";

/**
 * The consent-moment scope list on /login.
 *
 * No database fixture: this page renders entirely from `getConfig()`, and the
 * dev-server env `playwright.config.ts` sets `EVE_SSO_SCOPES` to the two
 * contact scopes (see there) — no session, no seed, needed to see it.
 */

test("each requested scope shows a plain-English description, not just the identifier", async ({
  page,
}) => {
  await page.goto("/login");

  const heading = page.locator(".launch__scopes-head");
  await expect(heading).toHaveText("Scopes requested");

  const rows = page.locator(".launch__scopes dt");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText("esi-characters.read_contacts.v1");
  await expect(rows.nth(1)).toHaveText("esi-characters.write_contacts.v1");

  // Every configured scope resolves to a real description in this deployment.
  // The count no longer proves that on its own — `describeScope`'s default now
  // returns a fallback sentence, so a scope falling through still renders a
  // `<dd>` (a `<dt>` without one is invalid in a `<dl>`, and AT would read the
  // undescribed scope as meaning whatever the next definition says). The two
  // text assertions below are what catches a fall-through now.
  const descriptions = page.locator(".launch__scopes dd");
  await expect(descriptions).toHaveCount(2);
  await expect(descriptions.nth(0)).toContainText("Reads the contacts");
  await expect(descriptions.nth(1)).toContainText("Adds, updates, and removes contacts");
});

test("the description outranks the identifier in the reading order that matters: colour", async ({
  page,
}) => {
  await page.goto("/login");

  // Finding 4 of critique-login: the old structure set the load-bearing
  // content (then: the identifiers) *fainter* than the prose above it. This
  // asserts the inverted structure's contrast relationship directly rather
  // than trusting the class names: the sentence a member has to read to
  // decide must not be quieter than the identifier next to it.
  const dtColor = await page
    .locator(".launch__scopes dt")
    .first()
    .evaluate((el) => {
      return getComputedStyle(el).color;
    });
  const ddColor = await page
    .locator(".launch__scopes dd")
    .first()
    .evaluate((el) => {
      return getComputedStyle(el).color;
    });

  const luminance = (rgb: string) => {
    const [r, g, b] = rgb.match(/[\d.]+/g)!.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  // --ink-dim (the description) renders lighter than --ink-faint (the
  // identifier) in this system's dark theme — see DESIGN.md's colour table.
  expect(luminance(ddColor)).toBeGreaterThan(luminance(dtColor));
});

test("the scope list stays readable at a narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/login");

  const list = page.locator(".launch__scopes");
  await expect(list).toBeVisible();

  // No horizontal scroll: the panel's own overflow-wrap: anywhere on dt is
  // what keeps a long identifier from forcing the layout wider than the
  // viewport (see audit-login #4 for the same mechanism on .launch__title).
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});
