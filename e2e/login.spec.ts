import { expect, test } from "@playwright/test";

/**
 * The consent-moment scope list on /login.
 *
 * No database fixture: this page renders entirely from `getConfig()`, and the
 * dev-server env `playwright.config.ts` sets `EVE_SSO_SCOPES` to the full
 * deployed set (see there) — no session, no seed, needed to see it.
 */

/** In `EVE_SSO_SCOPES` order — the page renders `cfg.eveSso.scopes` as given. */
const SCOPES = [
  "esi-characters.read_contacts.v1",
  "esi-characters.write_contacts.v1",
  "esi-ui.open_window.v1",
  "esi-location.read_location.v1",
  "esi-universe.read_structures.v1",
  "esi-location.read_online.v1",
];

/** One distinctive fragment of each scope's own sentence, in the same order. */
const DESCRIPTIONS = [
  "Reads the contacts",
  "Adds, updates, and removes contacts",
  "open a character's info window",
  "which solar system",
  "name of the structure",
  "logged in right now",
];

test("each requested scope shows a plain-English description, not just the identifier", async ({
  page,
}) => {
  await page.goto("/login");

  const heading = page.locator(".launch__scopes-head");
  await expect(heading).toHaveText("Scopes requested");

  const rows = page.locator(".launch__scopes dt");
  await expect(rows).toHaveCount(SCOPES.length);
  for (const [i, scope] of SCOPES.entries()) {
    await expect(rows.nth(i)).toHaveText(scope);
  }

  // Every configured scope resolves to a real description in this deployment.
  // The count no longer proves that on its own — `describeScope`'s default now
  // returns a fallback sentence, so a scope falling through still renders a
  // `<dd>` (a `<dt>` without one is invalid in a `<dl>`, and AT would read the
  // undescribed scope as meaning whatever the next definition says). The text
  // assertions below are what catches a fall-through now, and pairing each
  // fragment with its own index is what catches two scopes swapping places.
  const descriptions = page.locator(".launch__scopes dd");
  await expect(descriptions).toHaveCount(DESCRIPTIONS.length);
  for (const [i, fragment] of DESCRIPTIONS.entries()) {
    await expect(descriptions.nth(i)).toContainText(fragment);
  }
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
