import "./fleet-browser-guards";
import "./fleet-source-flow";
import "./fleet-pairing-flow";
import { eq } from "drizzle-orm";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fleet-browser";
import type { FleetClient, FleetScenario } from "./fleet-fixtures";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { SYNTHETIC_APP_ENV } from "./env";
import { character, fleetAccessCheckGate, fleetEligibility } from "../src/db/schema";
import { encryptToken } from "../src/lib/crypto";
import { FLEET_READ_SCOPE } from "../src/lib/esi/client";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

async function setup(fleet: FleetClient, granted = false) {
  const acc = await seedMember(db, {
    name: "Main Pilot",
    tier: "member",
    alts: ["Fleet Anchor", "Linked Fleet Alt", "Outside Alt"],
  });
  const other = await seedMember(db, { name: "Unrelated Pilot", tier: "member" });
  const own = await db.select().from(character).where(eq(character.accountId, acc.id));
  const anchor = own.find((ch) => ch.name === "Fleet Anchor")!;
  const alt = own.find((ch) => ch.name === "Linked Fleet Alt")!;
  const main = own.find((ch) => ch.name === "Main Pilot")!;
  const scopes = [...SYNTHETIC_APP_ENV.EVE_SSO_SCOPES.split(" "), FLEET_READ_SCOPE];
  const scenario: FleetScenario = {
    characters: own.map((ch) => ({
      id: ch.id,
      name: ch.name,
      ownerHash: ch.ownerHash,
      scopes,
    })),
    fleetId: 123456789,
    fleetBossId: anchor.id,
    rosterIds: [anchor.id, alt.id, other.mainCharacterId!],
  };
  await fleet.scenario(scenario);
  async function grant(id: number) {
    const tokens = await fleet.credentials(id);
    await db
      .update(character)
      .set({
        scopes,
        tokenStatus: "valid",
        refreshTokenEnc: encryptToken(
          tokens.refreshToken,
          Buffer.from(SYNTHETIC_APP_ENV.TOKEN_ENCRYPTION_KEY, "base64"),
        ),
      })
      .where(eq(character.id, id));
  }
  if (granted) await grant(anchor.id);
  return { acc, anchor, alt, main, scenario, grant };
}
async function keyboardTo(page: Page, target: Locator) {
  for (let n = 0; n < 30; n++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("Control was not reachable by keyboard");
}
async function visibleStatus(page: Page, text: string | RegExp) {
  const status = page.getByRole("status").filter({ hasText: text });
  await expect(status).toBeVisible();
  // toBeVisible alone also passes a clipped 1px .visually-hidden live region.
  const box = await status.boundingBox();
  expect(box!.height).toBeGreaterThan(20);
  expect(box!.width).toBeGreaterThan(150);
  await expect(status).not.toHaveClass(/visually-hidden/);
}
function result(page: Page) {
  return page.getByRole("region", { name: "Fleet check result" });
}
async function expireGate(accountId: string) {
  await db
    .update(fleetAccessCheckGate)
    .set({ nextAllowedAt: new Date(0) })
    .where(eq(fleetAccessCheckGate.accountId, accountId));
}

test("normal account keyboard journey authorizes a non-main fleet boss and automatically checks linked alts without their own grant", async ({
  page,
  context,
  fleet,
}) => {
  const f = await setup(fleet);
  await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
  await page.goto("/account");
  const link = page.getByRole("link", { name: "Fleet sharing", exact: true });
  await expect(link).toBeVisible();
  expect((await link.boundingBox())!.width).toBeGreaterThan(40);
  await keyboardTo(page, link);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Fleet sharing", exact: true }),
  ).toBeVisible();
  const selector = page.getByLabel("Fleet boss character");
  await expect(selector).toBeEnabled();
  await expect(selector).toHaveAccessibleDescription(
    /current fleet boss, not just any fleet member/,
  );
  await expect(page.locator(".page__lede")).toContainText(
    "The boss must be linked to this account",
  );
  for (const width of [840, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `tmp/boss-setup-${width}.png`, fullPage: true });
  }
  await keyboardTo(page, selector);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(selector).toHaveValue(String(f.anchor.id));
  await visibleStatus(
    page,
    "Not authorized. Authorize Fleet Read for this character before checking.",
  );
  await expect(
    page.getByRole("button", { name: "Check fleet", exact: true }),
  ).toBeDisabled();
  const authorize = page.getByRole("link", { name: "Authorize Fleet Read", exact: true });
  await expect(authorize).toHaveAttribute(
    "href",
    `/auth/eve/fleet-read?character=${f.anchor.id}`,
  );
  expect((await fleet.snapshot()).requests).toEqual([]);
  await keyboardTo(page, authorize);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Synthetic EVE picker" })).toBeVisible();
  await keyboardTo(
    page,
    page.getByRole("link", { name: "Use Fleet Anchor", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/account\/fleet-sharing\?notice=authorized$/);
  await visibleStatus(page, "Fleet Read authorized. Check fleet");
  await expect(selector).toHaveValue(String(f.anchor.id));
  expect((await fleet.snapshot()).requests.map((r) => r.stage)).not.toContain(
    "membership",
  );
  await fleet.scenario({ ...f.scenario, responses: { roster: { hold: "checked" } } });
  const check = page.getByRole("button", { name: "Check fleet", exact: true });
  await keyboardTo(page, check);
  const outline = await check.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  try {
    await expect.poll(async () => (await fleet.snapshot()).pending).toContain("checked");
    await visibleStatus(page, "Checking fleet");
    await expect(page.getByText(/Saving authorization can take longer/)).toBeVisible();
    await expect(page.getByText(/within 15|after 15/)).toHaveCount(0);
    await page.keyboard.press("Enter");
    expect(
      (await fleet.snapshot()).requests.filter((r) => r.stage === "membership"),
    ).toHaveLength(1);
  } finally {
    await fleet.release("checked");
  }
  await visibleStatus(page, "Checked at");
  await expect(result(page).getByRole("listitem")).toHaveText([
    "Fleet Anchor",
    "Linked Fleet Alt",
  ]);
  await expect(result(page)).not.toContainText("Outside Alt");
  await expect(result(page)).not.toContainText("Unrelated Pilot");
  await expect(page.locator("main")).not.toContainText("123456789");
  await expect(
    page.getByText(
      "This is a point-in-time fleet-access check, not running Wingman sharing.",
    ),
  ).toBeVisible();
  const [alt] = await db.select().from(character).where(eq(character.id, f.alt.id));
  expect(alt.refreshTokenEnc).toBeNull();
  expect(alt.scopes).not.toContain(FLEET_READ_SCOPE);
  expect(await db.select().from(fleetEligibility)).toEqual([]);
  for (const width of [840, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `tmp/fleet-ui-${width}.png`, fullPage: true });
  }
  // Exercise 200% layout zoom as well as the 320px viewport above. Chromium's
  // headless browser has no toolbar zoom, so use its CSS layout-zoom equivalent.
  await page.setViewportSize({ width: 840, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expect(check).toBeVisible();
  await page.screenshot({ path: "tmp/fleet-ui-200-percent.png", fullPage: true });
  const zoomed = await page.evaluate(() => {
    window.scrollTo({ left: 10_000, behavior: "instant" });
    const metrics = {
      scrollX,
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
    };
    window.scrollTo({ left: 0, behavior: "instant" });
    return metrics;
  });
  expect(zoomed.scrollX, JSON.stringify(zoomed)).toBe(0);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "1";
  });
  await page.getByRole("link", { name: "Manage paired devices" }).click();
  await expect(
    page.getByText(
      "No devices paired. In a Wingman build with Fleet sharing controls, open Settings › Previews and choose Connect.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
});

for (const choice of ["Cancel authorization", "Use Main Pilot"]) {
  test(`authorization refusal: ${choice}`, async ({ page, context, fleet }) => {
    const f = await setup(fleet);
    await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
    await page.goto("/account/fleet-sharing");
    await page.getByLabel("Fleet boss character").selectOption(String(f.anchor.id));
    await page.getByRole("link", { name: "Authorize Fleet Read", exact: true }).click();
    await page.getByRole("link", { name: choice, exact: true }).click();
    if (choice === "Cancel authorization") {
      await visibleStatus(
        page,
        "Fleet Read authorization was cancelled. Nothing changed.",
      );
      expect((await fleet.snapshot()).requests).toEqual([]);
    } else {
      await expect(page.getByRole("alert")).toContainText(
        "EVE returned a different character",
      );
    }
    const own = await db
      .select()
      .from(character)
      .where(eq(character.accountId, f.acc.id));
    expect(own.every((ch) => ch.refreshTokenEnc === null && ch.scopes.length === 0)).toBe(
      true,
    );
    await expect(
      page.getByRole("button", { name: "Check fleet", exact: true }),
    ).toBeDisabled();
  });
}

for (const [stage, status, message] of [
  ["membership", 401, "EVE rejected fleet access"],
  ["roster", 403, "EVE rejected fleet access"],
  ["roster", 404, "Fleet roster unavailable"],
  ["membership", 404, "Not in a fleet"],
  ["roster", 503, "Fleet service unavailable"],
] as const) {
  test(`honest ${stage} HTTP ${status} failure clears a successful roster`, async ({
    page,
    context,
    fleet,
  }) => {
    const f = await setup(fleet, true);
    await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
    await page.goto("/account/fleet-sharing");
    expect((await fleet.snapshot()).requests).toEqual([]);
    await page.getByRole("button", { name: "Check fleet", exact: true }).click();
    await visibleStatus(page, "Checked at");
    await expireGate(f.acc.id);
    await fleet.scenario({
      ...f.scenario,
      responses: { [stage]: { status, body: { error: "synthetic" } } },
    });
    await page.getByRole("button", { name: "Check fleet", exact: true }).click();
    await visibleStatus(page, message);
    await expect(result(page).getByRole("listitem")).toHaveCount(0);
    await expect(result(page)).not.toContainText("Checked at");
    if (status === 401 || status === 403) {
      await expect(result(page)).toContainText("current fleet boss");
      await expect(result(page)).toContainText("authorization may also be invalid");
    } else {
      await expect(result(page)).not.toContainText("fleet boss");
    }
    await expect(result(page)).not.toContainText("missing scope");
  });
}

test("an already-granted non-boss cannot verify a roster and is guided to the boss", async ({
  page,
  context,
  fleet,
}) => {
  const f = await setup(fleet, true);
  await fleet.scenario({ ...f.scenario, fleetBossId: f.alt.id });
  await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
  await page.goto("/account/fleet-sharing");
  await expect(
    page.locator(".st").filter({ hasText: "Fleet Read authorized" }),
  ).toBeVisible();
  const check = page.getByRole("button", { name: "Check fleet", exact: true });
  await expect(check).toBeEnabled();
  expect((await fleet.snapshot()).requests).toEqual([]);
  await check.click();
  await visibleStatus(page, "EVE rejected fleet access");
  await expect(result(page).getByRole("listitem")).toHaveCount(0);
  await expect(result(page)).toContainText("current fleet boss");
  await expect(result(page)).toContainText("linked to this account");
  await expect(result(page)).toContainText("authorization may also be invalid");
  await expect(result(page)).not.toContainText("Authorize Fleet Read again, then retry");
  expect((await fleet.snapshot()).requests.map((r) => r.stage)).toEqual([
    "token",
    "membership",
    "roster",
  ]);
});

test("external timeout is visible and never leaves a roster on screen", async ({
  page,
  context,
  fleet,
}) => {
  const f = await setup(fleet, true);
  await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
  await fleet.scenario({ ...f.scenario, responses: { membership: { hold: "timeout" } } });
  await page.goto("/account/fleet-sharing");
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  try {
    await expect.poll(async () => (await fleet.snapshot()).pending).toContain("timeout");
    await visibleStatus(page, "Checking fleet");
    await expect(result(page).getByRole("status")).toContainText(
      "Fleet check timed out",
      { timeout: 20_000 },
    );
    await visibleStatus(page, "Fleet check timed out");
    await expect(result(page).getByRole("listitem")).toHaveCount(0);
  } finally {
    await fleet.release("timeout");
  }
});

test("a new check clears old success immediately, then reports server cooldown", async ({
  page,
  context,
  fleet,
}) => {
  const f = await setup(fleet, true);
  await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
  await page.goto("/account/fleet-sharing");
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  await visibleStatus(page, "Checked at");
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  await visibleStatus(page, "Check cooldown");
  await expect(result(page)).toContainText("Try again at");
  await expect(result(page).getByRole("listitem")).toHaveCount(0);
  expect(
    (await fleet.snapshot()).requests.filter((r) => r.stage === "roster"),
  ).toHaveLength(1);
  await expireGate(f.acc.id);
  await fleet.scenario({ ...f.scenario, responses: { roster: { hold: "new-check" } } });
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  try {
    await expect
      .poll(async () => (await fleet.snapshot()).pending)
      .toContain("new-check");
    await visibleStatus(page, "Checking fleet");
    await expect(result(page)).not.toContainText("Check cooldown");
  } finally {
    await fleet.release("new-check");
  }
  await visibleStatus(page, "Checked at");
  await expireGate(f.acc.id);
  await fleet.scenario({
    ...f.scenario,
    responses: { roster: { hold: "clear-success" } },
  });
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  try {
    await expect
      .poll(async () => (await fleet.snapshot()).pending)
      .toContain("clear-success");
    await visibleStatus(page, "Checking fleet");
    await expect(result(page).getByRole("listitem")).toHaveCount(0);
    await expect(result(page)).not.toContainText("Checked at");
  } finally {
    await fleet.release("clear-success");
  }
  await visibleStatus(page, "Checked at");
});

test("a held old roster released after changing anchor cannot replace the new selection", async ({
  page,
  context,
  fleet,
}) => {
  const f = await setup(fleet, true);
  await f.grant(f.main.id);
  await context.addCookies([await sessionCookieFor(db, f.acc.id)]);
  await page.goto("/account/fleet-sharing");
  await page.getByLabel("Fleet boss character").selectOption(String(f.anchor.id));
  await fleet.scenario({ ...f.scenario, responses: { roster: { hold: "old-anchor" } } });
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && !!r.request().headers()["next-action"],
  );
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  try {
    await expect
      .poll(async () => (await fleet.snapshot()).pending)
      .toContain("old-anchor");
    await page.getByLabel("Fleet boss character").selectOption(String(f.main.id));
    await visibleStatus(page, "Not checked");
    await expect(result(page)).not.toContainText("Checking fleet");
  } finally {
    await fleet.release("old-anchor");
  }
  await (await response).finished();
  await expect(page.getByLabel("Fleet boss character")).toHaveValue(String(f.main.id));
  await visibleStatus(page, "Not checked");
  await expect(result(page).getByRole("listitem")).toHaveCount(0);
  await expireGate(f.acc.id);
  await fleet.scenario({
    ...f.scenario,
    fleetBossId: f.main.id,
    rosterIds: [f.main.id, f.alt.id],
  });
  await page.getByRole("button", { name: "Check fleet", exact: true }).click();
  await visibleStatus(page, "Checked at");
  await expect(result(page).getByRole("listitem")).toHaveText([
    "Main Pilot",
    "Linked Fleet Alt",
  ]);
  await page.getByLabel("Fleet boss character").selectOption(String(f.anchor.id));
  await visibleStatus(page, "Not checked");
  await expect(result(page).getByRole("listitem")).toHaveCount(0);
});
