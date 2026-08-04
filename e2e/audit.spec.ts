import { expect, test } from "@playwright/test";
import { auditLog, discordLink } from "../src/db/schema";
import { pinGeometry } from "./geometry";
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
  await expect(adminDetails.locator(".json__peek")).toHaveText("green → flygd, admin");
  await expect(adminDetails.locator(".json__full")).toBeHidden();
  await adminDetails.locator("summary").click();
  await expect(adminDetails.locator(".json__full")).toContainText('"cause": "admin"');

  const systemDetails = systemRow.locator("details.json");
  await expect(systemDetails.locator(".json__peek")).toHaveText("→ green, membership");

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
    // `.visually-hidden` is overflow-hidden too, and the timestamp cell now
    // carries one. Counting it would mark column 0 "clipped" and skip the very
    // column this test was written for. It is in a `display: none` subtree at
    // this width, so it contributes no rects to the Range either way.
    const clipped = (td: Element) =>
      [...td.querySelectorAll("*")].some(
        (el) =>
          !el.classList.contains("visually-hidden") &&
          getComputedStyle(el).overflowX !== "visible",
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

  // A trailing space off a copy-paste is trimmed before matching, not treated
  // as part of the id -- an untrimmed value falls through to the empty state,
  // which is also exactly one <tr>, so the assertion has to rule that out by
  // content rather than just count.
  await page.goto(`/admin/audit?target=${member.id}%20`);
  await expect(page.locator(".log__empty")).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("tier.changed");

  // Same for a typed name with a trailing space -- it must still resolve
  // rather than falling through to the "no such name" empty state.
  await page.goto("/admin/audit?target=Zed%20");
  await expect(page.locator(".log__empty")).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("tier.changed");

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

/* --- Pinned edges --------------------------------------------------------- */

/** Enough entries that the table overflows the capped scroll region. */
async function seedDenseLog() {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await db.insert(auditLog).values(
    Array.from({ length: 40 }, (_, i) => ({
      actor: "system",
      action: "tier.changed",
      target: `char:${i}`,
      details: { from: "green", to: "blue" },
    })),
  );
  return admin;
}

for (const width of [320, 390, 768]) {
  // 40rem is the breakpoint the narrow rules hang off. 768px sits above it and
  // is in this loop as the control: it must keep the full stamp.
  const narrow = width < 640;

  test(`audit at ${width}px: the timestamp column and the header stay put`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseLog();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/audit");
    await page.waitForSelector(".scroller tbody tr");

    // Two renderings of the instant, one shown per width. The exact stamp is
    // 19ch of a 286px region and the pinned column is where it lands, so below
    // 40rem it reads as elapsed time instead.
    const cell = page.locator("tbody tr:first-child td:first-child");
    const exact = cell.locator("span.only-wide");
    const relative = cell.locator("span.only-narrow time");
    await expect(exact).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect(relative).toHaveText(/^\d+[smhd] ago$/);
    if (narrow) {
      await expect(exact).toBeHidden();
      await expect(relative).toBeVisible();
    } else {
      await expect(exact).toBeVisible();
      await expect(relative).toBeHidden();
    }

    // The stamp is the only thing identifying a row once the region is scrolled
    // to the details column; five columns of fixed width guarantee it has to be.
    const pinned = await pinGeometry(
      page,
      ".scroller",
      "tbody tr:first-child td:first-child",
      "right",
    );
    expect(pinned.maxScrollLeft).toBeGreaterThan(0);
    expect(pinned.scrolledLeft).toBe(pinned.maxScrollLeft);
    expect(pinned.overlapX).toBeCloseTo(pinned.cellWidth, 0);

    // The corner cell rides with the column it heads, or the pinned stamps end
    // up under whichever heading the horizontal scroll stopped on.
    const corner = await pinGeometry(page, ".scroller", "thead th:first-child", "right");
    expect(corner.overlapX, "the At heading stays over the pinned column").toBeCloseTo(
      corner.cellWidth,
      0,
    );

    const head = await pinGeometry(page, ".scroller", "thead th:first-child", "down");
    expect(head.maxScrollTop).toBeGreaterThan(0);
    expect(head.scrolledTop).toBe(head.maxScrollTop);
    expect(head.overlapY).toBeCloseTo(head.cellHeight, 0);
    expect(head.text).toContain("At");

    // The Details column is the colgroup's one unsized column, and a
    // fixed-layout table is at least the sum of its columns — so without a
    // width floor on the table it was handed 0px inside any region narrower
    // than the four sized columns, i.e. at every width in this loop, with its
    // payload disclosure unclickable at all of them. Measured 120px at 320 and
    // 390, 228px at 768.
    const detailsWidth = await page
      .locator("tbody tr:first-child td:nth-child(5)")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(detailsWidth, "the Details column has room to open into").toBeGreaterThan(100);
  });
}

/**
 * The exact instant is what an audit log is for, and the narrow rendering
 * cannot be allowed to cost it. `title` would not do: VoiceOver and TalkBack do
 * not announce it and touch cannot reach it, so the stamp is restated in text
 * that is clipped rather than hidden.
 */
test("the exact UTC stamp is still in the accessibility tree at 320px", async ({
  page,
  context,
}) => {
  const admin = await seedDenseLog();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/audit");
  await page.waitForSelector(".scroller tbody tr");

  const stamp = await page
    .locator("tbody tr:first-child td:first-child span.visually-hidden")
    .evaluate((el) => ({
      text: el.textContent ?? "",
      display: getComputedStyle(el).display,
      visibility: getComputedStyle(el).visibility,
      ariaHidden: el.closest("[aria-hidden='true']") !== null,
      // Clipped, not laid out: a stamp that took real width here would put the
      // 19ch column straight back.
      width: el.getBoundingClientRect().width,
    }));

  expect(stamp.text).toMatch(/^at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  expect(stamp.display).not.toBe("none");
  expect(stamp.visibility).toBe("visible");
  expect(stamp.ariaHidden).toBe(false);
  expect(stamp.width).toBeLessThan(2);
});

/**
 * The two numbers the narrow treatment exists to move. Before it, the 62rem
 * floor that gave Details its width made audit the worst table on the site at
 * 320px: 992px wide inside a 286px region — 706px of forced horizontal scroll,
 * against the 764px/478px the table had before Details was fixed at all — with
 * the pinned At column taking 196px of the region, 69%, so the pin covered most
 * of whatever the scroll had brought alongside it.
 */
test("at 320px the pin is a minority of the region and the scroll is short", async ({
  page,
  context,
}) => {
  const admin = await seedDenseLog();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/audit");
  await page.waitForSelector(".scroller tbody tr");

  const pinned = await pinGeometry(
    page,
    ".scroller",
    "tbody tr:first-child td:first-child",
    "right",
  );

  // Measured 80px of 286px, 28%.
  expect(
    pinned.cellWidth / pinned.regionWidth,
    "the pinned column is a minority of the scroll region",
  ).toBeLessThan(0.5);
  // Measured 258px, against 478px for the pre-fix 764px table.
  expect(
    pinned.maxScrollLeft,
    "forced horizontal scroll is shorter than the table had before Details was sized",
  ).toBeLessThan(400);
});

/**
 * The accounts table unpins its first column while a row drawer is open, and
 * audit carries the same `.log--sticky-col` class with a `<details>` of its own
 * in column 5. An unscoped `:has(details[open])` therefore dropped audit's
 * timestamp pin the moment a payload was expanded — losing the row's anchor
 * exactly when the row had got taller and needed it most.
 */
test("expanding an audit payload keeps the timestamp column pinned at 320px", async ({
  page,
  context,
}) => {
  const admin = await seedDenseLog();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/audit");

  const details = page.locator("tbody tr:first-child td:nth-child(5) details");
  // A real click, not a keyboard press. This used to have to be `focus()` +
  // Enter: with the At column at a fixed 12.25rem the pin was 196px of a 286px
  // region, so scrolling the Details control into view parked it under the pin
  // and the synthetic click landed on the timestamp cell. At 5rem the pin is
  // 80px and the control is reachable by pointer, which is the interaction this
  // page is actually used with.
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);

  const open = await pinGeometry(
    page,
    ".scroller",
    "tbody tr:first-child td:first-child",
    "right",
  );
  const headPosition = await page.evaluate(
    () => getComputedStyle(document.querySelector("thead th:first-child")!).position,
  );

  expect(
    open.maxScrollLeft,
    "the open payload gives the region something to scroll",
  ).toBeGreaterThan(0);
  expect(open.position, "audit's timestamp column stays pinned").toBe("sticky");
  expect(headPosition, "audit's corner cell stays pinned").toBe("sticky");
  // Computed position is not the claim; the row's anchor still being on screen
  // at the far right of the scroll is. At this width that anchor is the
  // elapsed-time rendering — the exact stamp is in the same cell, clipped.
  expect(open.overlapX).toBeCloseTo(open.cellWidth, 0);
  expect(open.text).toMatch(/\d+[smhd] ago/);
});

test("a repeated filter param does not break the page", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  const res = await page.goto("/admin/audit?actor=alpha&actor=beta");
  expect(res?.status()).toBe(200);

  // Last value wins: appending &actor=beta to a URL that already has an actor
  // is how a duplicate arises, so the appended one is the intent. Active
  // filters render as a dim aside on the Filter `RuleHead` (its `aside` prop),
  // not chips.
  await expect(page.getByText("actor: beta")).toBeVisible();
});

test("the empty state is readable at 320px", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/admin/audit?actor=nobody-by-this-name");

  const geometry = await page.evaluate(() => {
    const cell = document.querySelector(".log__empty");
    const scroller = document.querySelector(".scroller");
    if (!cell || !scroller) return null;
    const inner = cell.firstElementChild ?? cell;
    return {
      innerRight: Math.round(inner.getBoundingClientRect().right),
      scrollerRight: Math.round(scroller.getBoundingClientRect().right),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry!.innerRight).toBeLessThanOrEqual(geometry!.scrollerRight);
});

test("the empty state does not pick up the row hover tint", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await db
    .insert(auditLog)
    .values([{ actor: admin.id, action: "sync.requested", target: "all" }]);

  // One matching row plus a filter that yields none, so both a real row and
  // the empty row are on screen and can be compared under the same hover
  // rule. Colour assertions are brittle (a token rename would break this
  // without changing behavior), but it is the only way to automate "hovering
  // this row must not look like hovering a real one", which is the actual
  // regression this task fixes, so it is worth keeping.
  //
  // Background-color transitions over --dur-color (140ms). Reading
  // getComputedStyle right after a hover can catch that mid-transition value
  // instead of the settled one. globals.css already collapses all
  // transitions to 0.01ms under prefers-reduced-motion (an accessibility
  // feature, not a test-only mechanism), so emulating it here makes the
  // hover-driven background deterministic without a sleep.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto("/admin/audit?actor=nobody-by-this-name");
  const emptyRow = page.locator("tbody tr").filter({ has: page.locator(".log__empty") });
  const restBackground = await emptyRow.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await emptyRow.hover();
  const hoveredEmptyBackground = await emptyRow.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );

  await page.goto("/admin/audit");
  const dataRow = page.locator("tbody tr").first();
  await dataRow.hover();
  const hoveredDataBackground = await dataRow.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );

  expect(hoveredEmptyBackground).toBe(restBackground);
  expect(hoveredEmptyBackground).not.toBe(hoveredDataBackground);
});

test("paging past the end says so instead of claiming an empty log", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: admin.id,
      details: { to: "green" },
    },
    {
      actor: "system",
      action: "tier.changed",
      target: admin.id,
      details: { to: "blue" },
    },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // Serial ids restart at 1 per resetDb, so `before=1` is guaranteed to be at
  // or past the oldest row while the log itself is not empty.
  await page.goto("/admin/audit?before=1");

  await expect(page.locator(".log__empty")).toContainText("older");
  await expect(page.locator(".log__empty").getByRole("link")).toHaveAttribute(
    "href",
    "/admin/audit",
  );

  // The count heading must not contradict the row's own "still has entries,
  // just past the cursor" message by claiming the log is empty.
  await expect(page.getByRole("heading", { name: "No older entries" })).toBeVisible();
});

test("paging past the end with an active filter keeps that filter on the exit link", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "green" },
    },
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "blue" },
    },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // Same guaranteed-past-the-oldest cursor as above, but with a filter active:
  // the exit link this state offers is the page's only way out, and it must
  // not silently drop the filter that got the admin here.
  await page.goto("/admin/audit?actor=Boss&before=1");

  await expect(page.locator(".log__empty")).toContainText("older");
  const exitLink = page.locator(".log__empty").getByRole("link");
  await expect(exitLink).toHaveAttribute("href", "/admin/audit?actor=Boss");

  await exitLink.click();
  await expect(page).toHaveURL(/[?&]actor=Boss/);
  await expect(page.locator("tbody tr")).toHaveCount(2);
});

test("a demotion row shows why it happened without opening the payload", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "green" });

  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { from: "flygd", to: "green", cause: "main left alliance" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  // The product question, answered from the collapsed line: an admin reads why
  // the tier moved without opening the disclosure.
  const row = page.locator("tbody tr").filter({ hasText: "Zed" });
  await expect(row).toHaveCount(1);
  await expect(row.locator("details.json .json__peek")).toHaveText(
    "flygd → green, main left alliance",
  );
  await expect(row.locator("details.json .json__full")).toBeHidden();
});
