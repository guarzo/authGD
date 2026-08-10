import { expect, test } from "@playwright/test";

/**
 * The consent-moment scope list on /login.
 *
 * No database fixture: this page renders entirely from `getConfig()`, and the
 * dev-server env `playwright.config.ts` sets `EVE_SSO_SCOPES` to the full
 * deployed set (see there) — no session, no seed, needed to see it.
 */

/**
 * In render order, which is `SCOPE_GROUPS`' order and NOT `EVE_SSO_SCOPES`'.
 * The page groups the scopes by what they let authGD do — see `SCOPE_GROUPS`
 * in `login/page.tsx` for why config order is deliberately not preserved.
 */
const SCOPES = [
  "esi-characters.read_contacts.v1",
  "esi-characters.write_contacts.v1",
  "esi-location.read_location.v1",
  "esi-universe.read_structures.v1",
  "esi-location.read_online.v1",
  "esi-ui.open_window.v1",
];

/** One distinctive fragment of each scope's own sentence, in the same order. */
const DESCRIPTIONS = [
  "Reads what is already there",
  "Adds, updates and removes contacts",
  "solar system",
  "structure's name",
  "logged in right now",
  "info window",
];

/** Each group's head, in render order. */
const GROUP_HEADS = [
  "the only thing authGD writes",
  "Where your characters are",
  "Your running EVE client",
];

test("each requested scope shows a plain-English description, not just the identifier", async ({
  page,
}) => {
  await page.goto("/login");

  const heading = page.locator(".launch__scopes-head");
  await expect(heading).toHaveText("Scopes requested");

  // The shared fact per group, said once above the rows it covers. This is the
  // half of the fix that the per-row assertions below cannot see: the
  // descriptions were trimmed on the assumption that the group head carries
  // what they dropped, so a head that stopped rendering would leave six
  // sentences that no longer say what they are for.
  const heads = page.locator(".launch__scope-group");
  await expect(heads).toHaveCount(GROUP_HEADS.length);
  for (const [i, head] of GROUP_HEADS.entries()) {
    await expect(heads.nth(i)).toContainText(head);
  }

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
  const headColor = await page
    .locator(".launch__scope-group")
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
  // And the group head — --ink, the shared fact, the answer to "does this
  // change my stuff" — outranks both. It is deliberately not a member of the
  // uppercase label register, so weight and colour are the only thing marking
  // it as the line to read first; this is the assertion that keeps that true.
  expect(luminance(headColor)).toBeGreaterThan(luminance(ddColor));
});

test("the sign-in control renders before the scope disclosure in document order", async ({
  page,
}) => {
  await page.goto("/login");

  // item 12 of the layout sweep: the control used to follow ~480px (computed
  // from tokens, not measured) of permission copy, putting it below the fold
  // on a short viewport. The fix reorders the DOM rather than chasing that
  // estimate — this asserts the order directly, which holds regardless of how
  // long the disclosure copy actually renders at any width or zoom.
  const order = await page.evaluate(() => {
    const action = document.querySelector(".launch__action")!;
    const disclosure = document.querySelector(".launch__disclosure")!;
    // Bitmask per Node.compareDocumentPosition: 4 = "action follows disclosure".
    return action.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeGreaterThan(0);

  // The disclosure is still fully present and reachable by scrolling — this
  // is not a case of "press the button to see it": it asserts the paragraph
  // and the scope list are both attached and visible, just later in the page.
  await expect(page.locator(".launch__disclosure-note")).toBeVisible();
  // `.first()`: the disclosure renders one <dl> per scope group now, so this
  // class matches three elements rather than one.
  await expect(page.locator(".launch__scopes").first()).toBeVisible();
});

test("the sign-in control is reachable without scrolling on a short viewport", async ({
  page,
}) => {
  // A member alt-tabbed on a phone: short viewport, no scroll performed yet.
  // This measures the actual rendered position rather than trusting a
  // computed estimate of the copy above it.
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/login");

  const box = await page.locator(".launch__action").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(700);
});

test("the scope list stays readable at a narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/login");

  const list = page.locator(".launch__scopes").first();
  await expect(list).toBeVisible();

  // No horizontal scroll: the panel's own overflow-wrap: anywhere on dt is
  // what keeps a long identifier from forcing the layout wider than the
  // viewport (see audit-login #4 for the same mechanism on .launch__title).
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});
