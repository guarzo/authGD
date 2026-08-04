import { expect, test } from "@playwright/test";
import { account } from "../src/db/schema";
import { clearOfPin, pinGeometry } from "./geometry";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

async function seedWorld() {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "green", status: "cryo" });
  await seedMember(db, { name: "Zed", tier: "flygd" });
  return admin;
}

/** Enough rows that the accounts table overflows the capped scroll region. */
async function seedDenseWorld() {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "flygd", isAdmin: true });
  for (let i = 0; i < 24; i++) {
    await seedMember(db, { name: `Member ${String(i).padStart(2, "0")}` });
  }
  return admin;
}

test("non-admins are redirected away from /admin", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pleb" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/login/);
});

test("admin list sorts by name and by tier, and filters cryo", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const mains = page.locator("tbody tr td:first-child summary");
  await expect(mains).toHaveText(["Azzy", "Boss", "Zed"]); // default name asc
  await page.getByRole("link", { name: "Tier", exact: true }).click();
  await expect(mains.first()).toHaveText(/Boss|Zed/); // flygd ranks first
  await page.goto("/admin/accounts?status=cryo");
  await expect(mains).toHaveText(["Azzy"]);
});

test("tier and cryo read as values; their controls live behind the row expander", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  // The tier and cryo columns carry a badge and nothing else, so a scan down
  // either column is a scan of state. This is the regression this test exists
  // for: a control in one of these cells is indistinguishable from the value
  // next to it, because both are mono-uppercase and say the same word.
  await expect(page.locator("tbody tr td:nth-child(2) button")).toHaveCount(0);
  await expect(page.locator("tbody tr td:nth-child(3) button")).toHaveCount(0);
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await expect(zedRow.locator("td:nth-child(2) .tier")).toHaveText(/flygd/);
  // The tier controls name their row in their accessible name, so match on that
  // rather than on the visible word alone — `name: "blue"` now matches nothing
  // at all, and toBeHidden() is satisfied by an element that does not exist.
  await expect(zedRow.getByRole("button", { name: "Set Zed to blue" })).toBeHidden();
});

test("the row expander is labelled and reports its state", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const toggle = page.locator("tbody tr", { hasText: "Zed" }).locator("summary");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The name has to survive into the accessible name (WCAG 2.5.3), and the
  // name alone has to say what the control does.
  await expect(toggle).toHaveAccessibleName(/^Zed .*controls/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("tier controls: manual set locks; return-to-auto unlocks", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.locator("summary").click();
  await zedRow.getByRole("button", { name: "Set Zed to blue" }).click();
  await expect(zedRow.getByText("🔒")).toBeVisible();
  await expect(zedRow.locator(".tier")).toHaveText(/blue/);
  // The drawer holds the controls, so it has to survive the revalidation the
  // server action triggers or the next click has nothing to land on.
  await expect(zedRow.locator("details")).toHaveJSProperty("open", true);
  await zedRow.getByRole("button", { name: "auto" }).click();
  await expect(zedRow.getByText("🔒")).not.toBeVisible();
});

// The drawer holds every control for the row, so a server action that collapsed
// it would make each edit cost a re-open. Its open state is React state in
// RowDisclosure rather than the DOM's own `open` attribute, precisely so this
// survives the revalidatePath re-render by design instead of by luck.
test("saving a note keeps the row drawer open and persists the note", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.locator("summary").click();
  await expect(zedRow.locator("details")).toHaveJSProperty("open", true);
  await zedRow.getByPlaceholder("notes").fill("watch this one");
  const save = zedRow.getByRole("button", { name: "save note" });
  await save.click();
  // Submit disables itself while the action is in flight; waiting for it to
  // come back is what tells us the write has landed.
  await expect(save).toBeEnabled();
  await expect(zedRow.locator("details")).toHaveJSProperty("open", true);
  // Re-read from the server. Asserting the value on the same input the test
  // just typed into would pass whether or not anything was persisted.
  await page.reload();
  const reloaded = page.locator("tbody tr", { hasText: "Zed" });
  await reloaded.locator("summary").click();
  await expect(reloaded.getByPlaceholder("notes")).toHaveValue("watch this one");
});

test("the skip link moves focus to the main landmark", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  await page.keyboard.press("Tab");
  await expect(page.locator("a.skip")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

/* --- Narrow-screen operability ------------------------------------------ */

/**
 * The measured problem: reaching a row's tier controls means scrolling the
 * region right, which takes the character's name off the left edge — so a 28px
 * control changes someone's tier with nothing on screen saying whose. Under
 * "derole, don't boot" a wrong-person-deroled press is the thing to prevent, so
 * the pinned column is a correctness device and these are correctness tests.
 */
for (const width of [320, 390, 768]) {
  test(`accounts at ${width}px: the name stays put while the controls are reached`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");
    await page.waitForSelector(".scroller tbody tr");

    const pinned = await pinGeometry(
      page,
      ".scroller",
      "tbody tr:first-child td:first-child",
      "right",
    );
    // There has to be something to scroll past, or the assertion is vacuous.
    expect(pinned.maxScrollLeft).toBeGreaterThan(0);
    expect(pinned.scrolledLeft).toBe(pinned.maxScrollLeft);
    // Fully on screen, not merely intersecting by a sliver.
    expect(pinned.overlapX).toBeCloseTo(pinned.cellWidth, 0);
    expect(pinned.overlapY).toBeGreaterThan(0);
    expect(pinned.text).toContain("Aaa Boss");

    // The corner cell rides with the column it heads. Left behind, the pinned
    // names sit under whichever heading the scroll happened to stop on — a
    // NAME column labelled ACTIONS is worse than no heading at all.
    const corner = await pinGeometry(page, ".scroller", "thead th:first-child", "right");
    expect(corner.overlapX, "the NAME heading stays over the pinned column").toBeCloseTo(
      corner.cellWidth,
      0,
    );
    expect(corner.text).toContain("Name");

    // ...and the controls at the far right of the row — the ones that made the
    // scroll necessary — are clear of the pinned cell at the same time as the
    // name. That pairing is the whole point of the pin.
    const clear = await clearOfPin(
      page,
      ".scroller",
      "tbody tr:first-child td:last-child form:last-child button",
    );
    expect(clear, "sync now is not under the pinned column").toBeCloseTo(1, 5);
  });

  test(`accounts at ${width}px: the header stays put while the rows are scrolled`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");
    await page.waitForSelector(".scroller tbody tr");

    const head = await pinGeometry(page, ".scroller", "thead th:first-child", "down");
    expect(head.maxScrollTop).toBeGreaterThan(0);
    expect(head.scrolledTop).toBe(head.maxScrollTop);
    expect(head.overlapY).toBeCloseTo(head.cellHeight, 0);
    expect(head.text).toContain("Name");
  });

  test(`no horizontal page scroll on any admin page at ${width}px`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    for (const path of ["/admin/accounts", "/admin/audit", "/admin/sync"]) {
      await page.goto(path);
      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(doc.scrollWidth, `page scroll on ${path}`).toBeLessThanOrEqual(
        doc.clientWidth,
      );
    }
  });
}

test("pinned cells keep the scroll region's tab stop and the row's focus order", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  // The control before the table is the last filter link; the scroll region
  // itself must still be the very next tab stop.
  await page.getByRole("link", { name: "active", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
  ).toBe("Accounts");

  // Ten stops covers the four header sort links plus the first two rows: the
  // tier, cryo and note controls all sit inside each row's closed disclosure,
  // so a collapsed row offers only its name disclosure and its Actions cell.
  const order: string[] = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() =>
        (document.activeElement?.textContent ?? "").trim().split("\n")[0].trim(),
      ),
    );
  }

  // Read from the live DOM rather than hard-coded, so a column added later
  // can't look like a focus-order regression: this fails only if keyboard Tab
  // stops disagree with source order, which is what sticky positioning must
  // never do.
  const expected = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    const els = [
      ...sc.querySelectorAll(
        "thead a, tbody tr:nth-child(-n+2) > td:first-child summary, " +
          "tbody tr:nth-child(-n+2) > td:last-child button",
      ),
    ] as HTMLElement[];
    return els.map((el) => (el.textContent ?? "").trim().split("\n")[0].trim());
  });
  expect(
    order,
    "keyboard focus order followed DOM order — sticky positioning must not reorder tab stops",
  ).toEqual(expected);

  // A relative check on top of the DOM-order one: within a row, the name
  // disclosure is reached before that row's own controls, not merely
  // "somewhere in the same DOM order" by coincidence.
  const nameIdx = order.indexOf("Aaa Boss");
  const controlIdx = order.findIndex((t) => t === "revoke" || t === "sync now");
  expect(nameIdx, "the first row's name disclosure is a tab stop").toBeGreaterThanOrEqual(
    0,
  );
  expect(
    controlIdx,
    "the first row's name disclosure is reached before its own controls",
  ).toBeGreaterThan(nameIdx);
});

test("an open row drawer unpins the first column at 320px", async ({ page, context }) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  const before = await page.evaluate(() => ({
    body: getComputedStyle(document.querySelector("tbody td:first-child")!).position,
    head: getComputedStyle(document.querySelector("thead th:first-child")!).position,
  }));
  // The pin is on to start with, or the assertions below prove nothing.
  expect(before, "the first column is pinned while every drawer is closed").toEqual({
    body: "sticky",
    head: "sticky",
  });

  await page.locator("tbody tr:first-child td:first-child summary").click();
  await expect(page.locator("tbody tr:first-child details")).toHaveJSProperty(
    "open",
    true,
  );

  const open = await pinGeometry(
    page,
    ".scroller",
    "tbody tr:first-child td:first-child",
    "right",
  );
  const head = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    const th = sc.querySelector("thead th:first-child") as HTMLElement;
    const h = th.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    return {
      position: getComputedStyle(th).position,
      overlapX: Math.min(h.right, s.right) - Math.max(h.left, s.left),
    };
  });

  // There has to be something to scroll past, or the geometry below is vacuous.
  expect(open.maxScrollLeft).toBeGreaterThan(0);

  // Table columns are shared, so an open drawer widens column 1 on every row —
  // wide enough that a pinned cell paints over the whole region instead of
  // leaving a strip of the other columns beside it.
  expect(open.position, "an open drawer unpins the body's first column").not.toBe(
    "sticky",
  );
  // The header's corner cell has to go with it. Left behind at `left: 0` it
  // parks an opaque ~280px NAME over every other column heading while the body
  // scrolls away underneath — scrolled fully right you get "sync now" buttons
  // under a header reading NAME. Measuring only the body cell is exactly how
  // that shipped on the first attempt.
  expect(head.position, "an open drawer unpins the header's corner cell").not.toBe(
    "sticky",
  );

  // Computed position is not the claim; the footprint is. Note the cell's
  // *width* is unchanged by unpinning — the drawer still forces column 1 to
  // ~98% of the region — what changes is that the cells scroll out with
  // everything else instead of parking on top of it. Half the region is the
  // threshold: it sits in the middle of a 98-point gap, so neither a few pixels
  // of layout drift nor a font change can flip it.
  expect(
    Math.max(0, open.overlapX),
    "the first cell leaves room for the columns beside it",
  ).toBeLessThan(open.regionWidth * 0.5);
  expect(
    Math.max(0, head.overlapX),
    "the header's corner cell leaves room for the headings beside it",
  ).toBeLessThan(open.regionWidth * 0.5);

  // The user-facing consequence: the far-right controls are actually reachable.
  const clear = await clearOfPin(
    page,
    ".scroller",
    "tbody tr:first-child td:last-child form:last-child button",
  );
  expect(clear, "sync now is clear of the first column").toBeCloseTo(1, 5);
});

test("the start fade never paints over the pinned column", async ({ page, context }) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  // Scrolled off the left edge but not yet at the right one: the only state in
  // which both fades claim to be needed, so the start fade's suppression can be
  // told apart from it simply being at rest. Driving fully right would hide the
  // end fade too, correctly, and prove nothing about the start.
  const read = async () => {
    await page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      sc.scrollLeft = Math.max(1, Math.floor((sc.scrollWidth - sc.clientWidth) / 2));
    });
    // The fade's `data-visible` comes from React state set in an onScroll
    // handler, so it is a render behind the scroll. Waiting on the attribute
    // rather than measuring in the same tick is what makes this deterministic;
    // it is not a proxy for the rule under test, whose effect is `display`.
    await page.waitForSelector(".scroller-fade--start[data-visible]", {
      state: "attached",
    });
    return page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      const q = (sel: string) => document.querySelector(sel) as HTMLElement;
      const start = q(".scroller-fade--start");
      const pin = sc.querySelector("tbody tr:first-child td:first-child")!;
      const p = pin.getBoundingClientRect();
      return {
        maxScrollLeft: sc.scrollWidth - sc.clientWidth,
        display: getComputedStyle(start).display,
        endShown: q(".scroller-fade--end").hasAttribute("data-visible"),
        // How far the first cell has slid past the region's left edge. This is
        // the fact the start fade is a cue *for*: zero means nothing is hidden
        // that way and the cue would be a lie.
        pinOffLeft: sc.getBoundingClientRect().left - p.left,
      };
    });
  };

  const pinned = await read();
  expect(pinned.maxScrollLeft, "there is something to scroll past").toBeGreaterThan(0);
  // With column 1 pinned, nothing is hidden past the left edge, and 1.5rem of
  // gradient would land on the name an admin is about to act on.
  expect(pinned.display, "the start fade is suppressed while the column is pinned").toBe(
    "none",
  );
  expect(pinned.endShown, "the end fade still says the table scrolls right").toBe(true);
  // ...and the reason it is a lie: the pinned cell has not moved off the edge.
  expect(
    pinned.pinOffLeft,
    "nothing is hidden past the left edge while the column is pinned",
  ).toBeLessThan(1);

  // The drawer unpins column 1 (see the test above), so the left edge hides
  // content again and the cue is true again. Without this the suppression
  // would be a permanent lie in the other direction.
  await page.locator("tbody tr:first-child td:first-child summary").click();
  await expect(page.locator("tbody tr:first-child details")).toHaveJSProperty(
    "open",
    true,
  );
  const unpinned = await read();
  expect(unpinned.display, "the start fade returns once nothing is pinned").not.toBe(
    "none",
  );
  expect(
    unpinned.pinOffLeft,
    "and content really is hidden that way now, so the cue is true",
  ).toBeGreaterThan(0);
});

test("the empty-state row does not inherit the pinned column", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts?status=cryo");

  const empty = page.locator("td.log__empty");
  await expect(empty).toHaveText("No accounts match this filter.");
  // It spans the whole table, so pinning it would give a full-width cell an
  // opaque ground and a hairline hanging off the table's right edge.
  const style = await empty.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, borderRight: cs.borderRightWidth };
  });
  expect(style.position).toBe("static");
  expect(style.borderRight).toBe("0px");
});

/* --- Row identity -------------------------------------------------------- */

test("an account with no main is still identified in the pinned column", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "flygd", isAdmin: true });
  // Characters linked, no main set: the row the fallback exists for. The row
  // data carries no link order, so the page picks the alphabetically first
  // name — "Sam Alt", not the seed's own first argument.
  await seedMember(db, { name: "Wandering Sam", mainless: true, alts: ["Sam Alt"] });
  // And an account with nothing linked at all, which only the id can name.
  const [orphan] = await db.insert(account).values({ tier: "green" }).returning();

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  await expect(page.locator("tbody tr td:first-child summary")).toHaveCount(3);
  // The service sorts main-less accounts last but leaves them tied with each
  // other, so assert per row rather than on an order the data does not fix.
  const samRow = page.locator("tbody tr", { hasText: "Sam Alt" });
  // Visible text: the character name plus a marker, not a bare "no main" that
  // every such row would share.
  await expect(samRow.locator("summary")).toHaveText(/^Sam Alt ·no main \(\+1\)$/);
  // Accessible name: RowDisclosure puts the label in aria-label, which
  // overrides the visible text for a screen reader, so the character name has
  // to survive there too rather than being spoken as a bare "no main".
  await expect(samRow.locator("summary")).toHaveAccessibleName(/^Sam Alt ·no main/);
  await expect(
    page.locator("tbody tr", { hasText: `acct ${orphan.id.slice(0, 8)}` }),
  ).toHaveCount(1);
  // The old fallback was a bare <em>no main</em>, identical on every such row.
  await expect(page.locator("tbody em")).toHaveCount(0);
  // Controls inside the row have to name it too — the note field announced as
  // "Note for account" on every main-less account.
  await expect(page.getByLabel("Note for Sam Alt")).toHaveCount(1);
  await expect(page.getByLabel(`Note for acct ${orphan.id.slice(0, 8)}`)).toHaveCount(1);

  // ...and the identity survives the scroll that made the pin necessary in the
  // first place: the tier controls are unreachable without it.
  const pinned = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    sc.scrollLeft = sc.scrollWidth;
    const row = [...sc.querySelectorAll("tbody tr")].find((tr) =>
      (tr.textContent ?? "").includes("Sam Alt"),
    ) as HTMLElement;
    const cell = row.querySelector("td:first-child") as HTMLElement;
    const c = cell.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    return {
      text: cell.textContent ?? "",
      cellWidth: c.width,
      overlapX: Math.min(c.right, s.right) - Math.max(c.left, s.left),
      maxScrollLeft: sc.scrollWidth - sc.clientWidth,
    };
  });
  expect(pinned.maxScrollLeft).toBeGreaterThan(0);
  expect(pinned.overlapX).toBeCloseTo(pinned.cellWidth, 0);
  expect(pinned.text).toContain("Sam Alt");
});

test("a blank character name never becomes a row's identity", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "flygd", isAdmin: true });
  // ESI has handed back an empty name before. `??` only falls through on
  // null/undefined, so an empty main produced `aria-label="Note for "` and a
  // row disclosure announced as " — crew and controls" — no identity at all, in
  // the column whose whole job is saying whose tier is about to change.
  const blank = await seedMember(db, { name: "" });
  // And one whose alphabetically-first character name is blank: "" sorts ahead
  // of everything, so an unfiltered pick would name the row nothing even though
  // a perfectly good name is sitting next to it.
  await seedMember(db, { name: "", mainless: true, alts: ["Real Name"] });
  // Whitespace is the shape that survived the first fix: `||` catches "" but
  // "   " is truthy, so a padded name took the identity slot and then rendered
  // as nothing — a pinned cell that is blank and an aria-label of "Note for   ".
  const spaces = await seedMember(db, { name: "   " });
  await seedMember(db, { name: " \t ", mainless: true, alts: ["Spaced Alt"] });

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // No row is announced as an empty string or as a bare separator.
  const summaries = page.locator("tbody tr td:first-child summary");
  const labels = await summaries.evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
  expect(labels).toHaveLength(5);
  for (const l of labels) expect(l).not.toMatch(/^\s*—/);

  // Falls through to the non-blank character, not to "". The "·no main" marker
  // still applies: the row is named by a character that is not its main.
  await expect(page.getByLabel("Note for Real Name")).toHaveCount(1);
  await expect(summaries.filter({ hasText: "Real Name" })).toHaveAccessibleName(
    /^Real Name ·no main —/,
  );

  // Nothing non-blank to borrow, so the account id has to be used, not skipped.
  const id = `acct ${blank.id.slice(0, 8)}`;
  await expect(page.getByLabel(`Note for ${id}`)).toHaveCount(1);
  await expect(summaries.filter({ hasText: id })).toHaveAccessibleName(
    new RegExp(`^${id} —`),
  );

  // The same two outcomes for the whitespace shape: a padded main is not a
  // name, so the row borrows its alt and is marked as having no main...
  await expect(page.getByLabel("Note for Spaced Alt")).toHaveCount(1);
  await expect(summaries.filter({ hasText: "Spaced Alt" })).toHaveAccessibleName(
    /^Spaced Alt ·no main —/,
  );
  // ...and with nothing to borrow it falls all the way to the account id rather
  // than pinning a cell that looks empty.
  const spacedId = `acct ${spaces.id.slice(0, 8)}`;
  await expect(page.getByLabel(`Note for ${spacedId}`)).toHaveCount(1);
  await expect(summaries.filter({ hasText: spacedId })).toHaveAccessibleName(
    new RegExp(`^${spacedId} —`),
  );
});

test("the tier and cryo controls name the row they act on", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // The pinned column exists so a 28px control is never pressed with nothing on
  // screen saying whose it is; a speech-input or screen-reader user never sees
  // that column, and reached these with only the tier word to go on. The
  // visible text stays the bare word, so the accessible name has to keep it
  // verbatim (WCAG 2.5.3) and add the row in front of it.
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.locator("summary").click();
  for (const tier of ["flygd", "blue", "green"]) {
    const btn = zedRow.getByRole("button", { name: `Set Zed to ${tier}`, exact: true });
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText(tier);
  }
  const cryo = zedRow.getByRole("button", { name: "freeze Zed", exact: true });
  await expect(cryo).toHaveText("freeze");

  // The lock-releasing control is in the same group and had the same gap.
  await zedRow.getByRole("button", { name: "Set Zed to blue", exact: true }).click();
  await expect(zedRow.getByText("🔒")).toBeVisible();
  await expect(
    zedRow.getByRole("button", { name: "return Zed to auto tier", exact: true }),
  ).toHaveText("auto");

  // Cryo's label follows the action, not the state.
  const azzyRow = page.locator("tbody tr", { hasText: "Azzy" });
  await azzyRow.locator("summary").click();
  await expect(
    azzyRow.getByRole("button", { name: "wake Azzy", exact: true }),
  ).toHaveText("wake");
});
