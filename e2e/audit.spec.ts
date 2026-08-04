import { expect, test } from "@playwright/test";
import { auditLog, discordLink } from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("resolved names, distinguishable system actor, one-line details, filtered count", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });

  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: member.id,
      details: { from: "green", to: "flygd", cause: "admin" },
    },
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { to: "green", cause: "membership" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(2);

  // Actor and target render as resolved human names, not raw account ids.
  const adminRow = rows.filter({ hasText: "Boss" });
  await expect(adminRow).toHaveCount(1);
  await expect(adminRow.getByText("Zed", { exact: true })).toBeVisible();
  await expect(page.getByText(admin.id)).toHaveCount(0);
  await expect(page.getByText(member.id)).toHaveCount(0);

  // The system actor is distinguishable from a human actor by more than
  // colour: it renders the literal word "system" in the same mono/dimmed
  // treatment used for other machine-generated values on this page.
  const systemRow = rows.filter({ hasText: "system" });
  await expect(systemRow).toHaveCount(1);
  const systemActor = systemRow.locator("td").nth(1).locator(".mono.dim");
  await expect(systemActor).toHaveText("system");

  // Details render a one-line human summary collapsed, with the full JSON
  // still reachable behind the "+" disclosure.
  const adminDetails = adminRow.locator("details.json");
  await expect(adminDetails.locator(".json__peek")).toHaveText("green → flygd");
  await expect(adminDetails.locator(".json__full")).toBeHidden();
  await adminDetails.locator("summary").click();
  await expect(adminDetails.locator(".json__full")).toContainText('"cause": "admin"');

  const systemDetails = systemRow.locator("details.json");
  await expect(systemDetails.locator(".json__peek")).toHaveText("→ green");

  // The count states it is a filtered subset, not a total, once a filter is
  // applied.
  await expect(page.getByRole("heading", { name: "2 entries" })).toBeVisible();
  await page.goto("/admin/audit?action=tier.");
  await expect(page.getByRole("heading", { name: "2 matching entries" })).toBeVisible();

  // The example hint must not leak into the field's accessible name: it sits
  // outside the <label> and is wired up with aria-describedby instead.
  await expect(page.getByLabel("Action prefix", { exact: true })).toBeVisible();
});

/**
 * The table used to force a horizontal scrollbar at desktop width purely
 * because the actor column wrapped a raw id over ~5 lines -- not because of
 * real content. The worst case is an actor that does NOT resolve to a name,
 * since nothing shortens the cell; fixed layout + ellipsis has to hold there
 * too, or the fix only works for the happy path.
 */
test("no spurious horizontal overflow at desktop width, even with unresolved ids", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const orphan = "edfe996e-9497-4dc2-9afa-8e4bd0955daa"; // no such account: stays raw

  await db.insert(auditLog).values(
    Array.from({ length: 25 }, () => ({
      actor: orphan,
      action: "token.invalidated",
      target: "90000000000000000",
      details: { reason: "malformed_token_blob" },
    })),
  );

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/audit");

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(25);

  // The unresolved id is still shown verbatim -- truncation is visual only.
  await expect(rows.first().locator("td").nth(1).locator("span")).toHaveAttribute(
    "title",
    orphan,
  );

  const box = await page.locator(".scroller").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);

  // A row that wraps a UUID runs ~90px tall; one that ellipsises stays ~47px.
  const height = await rows.first().evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeLessThan(60);
});

/**
 * `table-layout: fixed` sizes a column but does not clip it: a `nowrap` value
 * wider than its column paints straight over the column to its right. Both
 * mono columns were undersized and doing exactly that -- the timestamp ran
 * into ACTOR ("22:19:24Gustav Oswaldo") and the action ran into TARGET. Widths
 * are therefore a correctness property here, not taste, and the longest value
 * each column can hold is the case that has to be measured.
 */
test("mono columns fit their widest value instead of painting over the next one", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });

  await db.insert(auditLog).values([
    // The longest action name in the vocabulary, next to the longest actor and
    // target a row can carry.
    {
      actor: "edfe996e-9497-4dc2-9afa-8e4bd0955daa",
      action: "character.affiliation_invalid",
      target: "90000000000000000",
      details: { reason: "not-in-alliance" },
    },
    { actor: "system", action: "discord.role_changed", target: admin.id, details: null },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/audit");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  // Cells inside an overflow-hidden box (the `.ellipsis-cell` spans) are
  // clipped by construction, so only the unclipped ones can collide. A Range
  // rect reports the untruncated width and would flag intended truncation.
  const overlaps = await page.evaluate(() => {
    const bad: string[] = [];
    const clipped = (td: Element) =>
      [...td.querySelectorAll("*")].some(
        (el) => getComputedStyle(el).overflowX !== "visible",
      );
    for (const tr of document.querySelectorAll("tbody tr")) {
      const cells = [...tr.querySelectorAll("td")];
      for (let i = 0; i < cells.length - 1; i++) {
        if (clipped(cells[i])) continue;
        const range = document.createRange();
        range.selectNodeContents(cells[i]);
        const ink = range.getBoundingClientRect();
        const next = cells[i + 1].getBoundingClientRect();
        if (ink.width > 0 && ink.right > next.left + 0.5) {
          bad.push(`col ${i}: "${cells[i].textContent?.trim()}"`);
        }
      }
    }
    return bad;
  });
  expect(overlaps).toEqual([]);

  // The action is the column an admin scans, so it must fit rather than
  // ellipsise: the truncation on that cell is a backstop for a longer name
  // added later, not the normal rendering of a name that exists today.
  const truncated = await page.evaluate(() =>
    [...document.querySelectorAll("tbody tr")]
      .map((tr) => tr.querySelectorAll("td")[2].querySelector("span"))
      .filter((s): s is HTMLElement => !!s && s.scrollWidth > s.clientWidth)
      .map((s) => s.textContent),
  );
  expect(truncated).toEqual([]);
});

/**
 * One filter cell carries a hint and its siblings do not. Bottom-aligning the
 * row made that cell's extra height push its own label and input a full row
 * above the others, so the three fields read as three different rows.
 */
test("filter labels, fields, and submit each sit on one line", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/audit");

  const tops = await page.evaluate(() => {
    const y = (sel: string) =>
      [...document.querySelectorAll(sel)].map((el) =>
        Math.round(el.getBoundingClientRect().top),
      );
    return {
      labels: y(".filter-form__label"),
      fields: y(".filter-form .field"),
      submit: y(".filter-form__actions .btn"),
    };
  });

  expect(tops.labels).toHaveLength(3);
  expect(new Set(tops.labels).size).toBe(1);
  expect(new Set(tops.fields).size).toBe(1);
  // The submit button belongs on the field line, not the label line.
  expect(Math.abs(tops.submit[0] - tops.fields[0])).toBeLessThanOrEqual(1);
});

test("names are clickable filters, and a name unions a person's identifier forms", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "555555555555555555",
  });

  // The same person, targeted three different ways plus one unrelated row.
  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: member.id,
      details: { from: "green", to: "flygd" },
    },
    {
      actor: "system",
      action: "character.linked",
      target: String(member.mainCharacterId),
    },
    {
      actor: "system",
      action: "discord.role_changed",
      target: "555555555555555555",
      details: { added: "10", removed: "", tier: "flygd" },
    },
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "flygd" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");
  await expect(page.locator("tbody tr")).toHaveCount(4);

  // Clicking the target name filters by the NAME, not by that row's raw id.
  await page.getByRole("link", { name: "Zed" }).first().click();
  await expect(page).toHaveURL(/[?&]target=Zed/);

  // All three of Zed's identifier forms come back; Boss's own row does not.
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "tier.changed" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "character.linked" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "discord.role_changed" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "3 matching entries" })).toBeVisible();

  // clear still works.
  await page.getByRole("link", { name: "clear" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(4);

  // Clicking an actor name filters the actor column.
  await page
    .locator("tbody tr td:nth-child(2)")
    .getByRole("link", { name: "Boss" })
    .first()
    .click();
  await expect(page).toHaveURL(/[?&]actor=Boss/);
  await expect(page.locator("tbody tr")).toHaveCount(2);
});

test("raw ids and the literal 'all' target stay filterable", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });

  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: member.id,
      details: { to: "flygd" },
    },
    { actor: admin.id, action: "sync.requested", target: "all" },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // A pasted account uuid still filters exactly, and the chip echoes it.
  await page.goto(`/admin/audit?target=${member.id}`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText(`target: ${member.id}`)).toBeVisible();

  // "all" is a real stored target, not a name -- it must not resolve to nothing.
  await page.goto("/admin/audit?target=all");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("sync.requested");

  // A name that matches nothing names the field that failed.
  await page.goto("/admin/audit?actor=Nobody");
  await expect(page.locator(".log__empty")).toHaveText(
    'No account or character named "Nobody" (actor).',
  );
});

test("an ambiguous name reports how many accounts it spans", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const zedA = await seedMember(db, { name: "Zed", tier: "green" });
  const zedB = await seedMember(db, { name: "Zed", tier: "blue" });

  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: zedA.id,
      details: { to: "green" },
    },
    { actor: admin.id, action: "tier.changed", target: zedB.id, details: { to: "blue" } },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit?target=Zed");

  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByText('target "Zed" matches 2 accounts')).toBeVisible();
});

test("linking the system actor does not un-dim it", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });

  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { to: "green" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  // `system` is a link (a clickable filter) but must keep the dim
  // machine-output treatment. `.cell-link` only sets `color: inherit`, so
  // `.dim` must still win the resting colour by coming later in globals.css.
  const systemLink = page.getByRole("link", { name: "system" }).first();
  await expect(systemLink).toBeVisible();

  const linkColor = await systemLink.evaluate((el) => getComputedStyle(el).color);
  // The action-namespace prefix in the same table is a plain `.dim` span.
  const dimSpanColor = await page
    .locator("tbody tr td:nth-child(3) .dim")
    .first()
    .evaluate((el) => getComputedStyle(el).color);

  expect(linkColor).toBe(dimSpanColor);
});
