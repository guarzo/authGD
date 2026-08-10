import { expect, test } from "@playwright/test";
import { auditLog, discordLink, payoutOperation, syncRun } from "../src/db/schema";
import { AUDIT_PAGE_SIZE } from "../src/services/audit";
import { pinGeometry } from "./geometry";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("resolved names, distinguishable system actor, one-line details, filtered count", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });

  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: member.id,
      details: { from: "alumni", to: "member", cause: "admin" },
    },
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { to: "alumni", cause: "membership" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(2);

  // Actor and target render as resolved human names, not raw account ids.
  const adminRow = rows.filter({ hasText: "Boss" });
  await expect(adminRow).toHaveCount(1);
  await expect(adminRow.getByRole("link", { name: /^Zed\b/ })).toBeVisible();

  // The raw id rides along inside the link for assistive tech -- it is the
  // only place it is stated, since `title` is hover-only -- but it must never
  // reach the paint. Strip the clipped spans and the ids are gone.
  const painted = await page.locator("tbody").evaluate((tb) => {
    const clone = tb.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".visually-hidden").forEach((n) => n.remove());
    return clone.textContent ?? "";
  });
  expect(painted).not.toContain(admin.id);
  expect(painted).not.toContain(member.id);
  await expect(adminRow.locator("td").nth(3).locator("a")).toHaveText(
    `Zed (id ${member.id})`,
  );

  // The system actor is distinguishable from a human actor by more than
  // colour: it renders the literal word "system" in the same mono/dimmed
  // treatment used for other machine-generated values on this page.
  const systemRow = rows.filter({ hasText: "system" });
  await expect(systemRow).toHaveCount(1);
  const systemActor = systemRow.locator("td").nth(1).locator(".mono.dim-ink");
  await expect(systemActor).toHaveText("system");

  // Details render a one-line human summary collapsed, with the full JSON
  // still reachable behind the "+" disclosure.
  const adminDetails = adminRow.locator("details.json");
  await expect(adminDetails.locator(".json__peek")).toHaveText(
    "Veterans → Testers, admin",
  );
  await expect(adminDetails.locator(".json__full")).toBeHidden();
  await adminDetails.locator("summary").click();
  await expect(adminDetails.locator(".json__full")).toContainText('"cause": "admin"');

  const systemDetails = systemRow.locator("details.json");
  await expect(systemDetails.locator(".json__peek")).toHaveText("→ Veterans, membership");

  // The count states it is a filtered subset, not a total, once a filter is
  // applied.
  await expect(page.getByRole("heading", { name: "2 entries" })).toBeVisible();
  await page.goto("/admin/audit?action=tier.");
  await expect(page.getByRole("heading", { name: "2 matching entries" })).toBeVisible();

  // The hint must not leak into the field's accessible name: it sits outside
  // the <label> and is wired up with aria-describedby instead.
  await expect(page.getByLabel("Action", { exact: true })).toBeVisible();
});

/**
 * The datalist is inert HTML, not a type-ahead: it ships with the page, the
 * browser filters it, and the form submits without JavaScript. This asserts
 * the field is wired to it and that the vocabulary offered is the real one,
 * not that a browser popup shows them -- see `payouts.spec.ts`'s
 * identical-purpose test on `AddParticipantForm`.
 *
 * The expected list is spelled out here rather than imported from
 * `ACTION_NAMESPACES`, deliberately. Importing it would make this test read
 * its expectation off the same object the page renders from, so it could only
 * ever prove "the page renders whatever that constant holds" -- true even if a
 * namespace were dropped or misspelled inside `NAMESPACE_TARGET_KIND`. Written
 * out independently, it is the guard the type system cannot give: there is no
 * compile-time vocabulary of real action strings anywhere in the repo, so
 * `"tie."` for `"tier."` type-checks (the `${string}.` constraint on that map
 * catches a dropped dot, and nothing catches a misspelling). Equality on the
 * whole array, not membership, is what makes this bite -- it pins the set,
 * the order the admin reads them in, and the count, so a namespace added on
 * purpose is meant to fail here once and be added here on purpose too.
 */
const EXPECTED_ACTION_NAMESPACES = [
  "access_list.",
  "account.",
  "admin.",
  "character.",
  "discord.",
  "payout.",
  "status.",
  "sync.",
  "tier.",
  "token.",
  "wanderer.",
];

test("the action filter offers the namespace vocabulary via a datalist", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  const input = page.getByLabel("Action", { exact: true });
  const listId = await input.getAttribute("list");
  expect(listId).toBeTruthy();
  await expect(page.locator(`datalist#${listId}`)).toHaveCount(1);

  const options = page.locator(`datalist#${listId} option`);
  expect(
    await options.evaluateAll((els) => els.map((e) => e.getAttribute("value"))),
  ).toEqual(EXPECTED_ACTION_NAMESPACES);
});

/**
 * `character.reclaimed`'s `fromAccount` used to render as a raw, unshortened
 * uuid (`labelled()`) -- pure recitation, since unlike `account.merged`'s
 * `sourceAccountId` the account it names is not deleted by the write that
 * logs it, and stays resolvable (`services/audit.ts`'s `DETAIL_ACCOUNT_KEYS`).
 * A screen reader has no reason to spell out a uuid character by character
 * when the name it resolves to is sitting in the same database row.
 */
test("a reclaim's origin account resolves to a name instead of a raw uuid", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const oldOwner = await seedMember(db, { name: "Old Owner", tier: "alumni" });
  const newOwner = await seedMember(db, { name: "New Owner", tier: "member" });

  await db.insert(auditLog).values({
    actor: "system",
    action: "character.reclaimed",
    target: String(newOwner.mainCharacterId),
    details: { fromAccount: oldOwner.id },
  });

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  const row = page.locator("tbody tr").filter({ hasText: "reclaimed" });
  await expect(row).toHaveCount(1);
  const details = row.locator("details.json");
  await expect(details.locator(".json__peek")).toHaveText("from Old Owner");
  // The full JSON (behind the disclosure) still carries the raw uuid --
  // that's the escape hatch, not the regression. What must not happen is the
  // collapsed one-line summary reciting it, which `.json__peek` above already
  // rules out.
  await expect(details.locator(".json__full")).toBeHidden();
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });

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
  const action = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("tbody tr")]
      .map((tr) => tr.querySelectorAll("td")[2].querySelector(".ellipsis-cell"))
      .filter((s): s is HTMLElement => !!s);
    return {
      found: cells.length,
      truncated: cells
        .filter((s) => s.scrollWidth > s.clientWidth)
        .map((s) => s.textContent),
    };
  });
  // The probe has to have found something: `.ellipsis-cell` is a class, and a
  // rename would otherwise leave an empty list that reads exactly like "nothing
  // truncated".
  expect(action.found).toBe(await page.locator("tbody tr").count());
  expect(action.truncated).toEqual([]);
});

/**
 * One filter cell carries a hint and its siblings do not. Bottom-aligning the
 * row made that cell's extra height push its own label and input a full row
 * above the others, so the three fields read as three different rows.
 *
 * The width half of this guards the other way the hint can distort its cell.
 * A grid item contributes its max-content width to the track, so once the
 * Action hint became a sentence ("what happened, like tier.changed") rather
 * than `e.g. tier.`, it was wider than the input and sized the cell — the
 * Action field rendered 257px against its siblings' 199px. `.filter-form__hint`
 * zeroes its inline-size to opt out of that; this is what would catch the opt-out
 * being dropped, or a future hint long enough to need a different remedy.
 */
test("filter labels, fields, and submit each sit on one line", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/audit");

  const box = await page.evaluate(() => {
    const rects = (sel: string) =>
      [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect());
    const y = (sel: string) => rects(sel).map((r) => Math.round(r.top));
    return {
      labels: y(".filter-form__label"),
      fields: y(".filter-form .field"),
      submit: y(".filter-form__actions .btn"),
      fieldWidths: rects(".filter-form .field").map((r) => Math.round(r.width)),
    };
  });

  expect(box.labels).toHaveLength(3);
  expect(new Set(box.labels).size).toBe(1);
  expect(new Set(box.fields).size).toBe(1);
  // The submit button belongs on the field line, not the label line.
  expect(Math.abs(box.submit[0] - box.fields[0])).toBeLessThanOrEqual(1);

  // No cell is sized by its hint: all three fields share one width.
  expect(box.fieldWidths).toHaveLength(3);
  expect(new Set(box.fieldWidths).size).toBe(1);
});

test("names are clickable filters, and a name unions a person's identifier forms", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });
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
      details: { from: "alumni", to: "member" },
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
      details: { added: "10", removed: "", tier: "member" },
    },
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "member" },
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });

  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: member.id,
      details: { to: "member" },
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

/**
 * TargetCell links a payout operation's name the same way it links a
 * person's (src/app/admin/audit/page.tsx, TargetCell) -- resolveFilterIdentity
 * has to invert that link back to the operation's id, or every such click
 * lands on the unmatched-filter empty state instead of the operation's rows.
 */
test("clicking a payout operation's name filters to that operation's rows", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const [op] = await db
    .insert(payoutOperation)
    .values({ name: "Thursday roam", occurredAt: new Date("2026-07-31T00:00:00Z") })
    .returning();

  await db.insert(auditLog).values([
    { actor: admin.id, action: "payout.created", target: op.id },
    // An unrelated row, so the click-through has to actually narrow the
    // result rather than the assertion below passing on the full log.
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "member" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  await page.getByRole("link", { name: "Thursday roam" }).first().click();
  await expect(page).toHaveURL(/[?&]target=Thursday\+roam/);

  await expect(page.locator(".log__empty")).toHaveCount(0);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("payout.created");
  await expect(page.getByRole("heading", { name: "1 matching entries" })).toBeVisible();
});

test("an ambiguous name reports how many accounts it spans", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const zedA = await seedMember(db, { name: "Zed", tier: "alumni" });
  const zedB = await seedMember(db, { name: "Zed", tier: "associate" });

  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: zedA.id,
      details: { to: "alumni" },
    },
    {
      actor: admin.id,
      action: "tier.changed",
      target: zedB.id,
      details: { to: "associate" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit?target=Zed");

  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByText('target "Zed" matches 2 accounts')).toBeVisible();

  // Not dimmed on the rule beside the render stamp, where it read as another
  // freshness note. It is a warning: these rows are a union of two people's
  // histories, which is the one way this page answers the question wrongly
  // while looking right.
  const notice = page.locator(".notice--warn");
  await expect(notice).toHaveText('target "Zed" matches 2 accounts');

  // Above the table, not below it and not inside it.
  const order = await page.evaluate(() => {
    const n = document.querySelector(".notice--warn");
    const t = document.querySelector("table.log--audit");
    if (!n || !t) return "missing";
    return n.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING
      ? "before"
      : "after";
  });
  expect(order).toBe("before");

  // The rule's aside keeps the render stamp and nothing else.
  await expect(page.locator(".rule-head").last().locator(".dim")).toHaveText(
    /^as of \d{2}:\d{2} UTC$/,
  );
});

/**
 * The pager used to render only on a full page, so the page after a full one
 * was a dead end: no Older, no way back to the newest entries, and a heading
 * that read the same on every page. AUDIT_PAGE_SIZE is 100, so this is the one
 * test that has to seed past it.
 */
test("a paged view offers a way back to the newest entries", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values(
    Array.from({ length: AUDIT_PAGE_SIZE + 5 }, (_, i) => ({
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: i % 2 ? "alumni" : "associate" },
    })),
  );
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  // Page one: a full page, an Older control, and no way "back" to offer.
  await expect(page.locator("tbody tr")).toHaveCount(AUDIT_PAGE_SIZE);
  await expect(page.getByRole("link", { name: "Older entries" })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Latest entries" })).toHaveCount(0);

  // Reachable from a keyboard without traversing 100 rows of links: there is a
  // pager above the table as well as below it.
  const aboveTable = await page.evaluate(() => {
    const p = document.querySelector(".pager--top");
    const t = document.querySelector("table.log--audit");
    return Boolean(
      p && t && p.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(aboveTable).toBe(true);

  await page.getByRole("link", { name: "Older entries" }).first().click();

  // Page two: five rows, so the old condition rendered nothing at all here.
  await expect(page.locator("tbody tr")).toHaveCount(5);
  const latest = page.getByRole("link", { name: "Latest entries" });
  await expect(latest).toHaveCount(2);
  await expect(latest.first()).toHaveAttribute("href", "/admin/audit");

  // And the heading no longer claims to be the same page it was.
  await expect(page.getByRole("heading", { name: "5 older entries" })).toBeVisible();

  await latest.first().click();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.locator("tbody tr")).toHaveCount(AUDIT_PAGE_SIZE);
});

/**
 * Every control on this page that changes the result set is a document load —
 * the filter is a `<form method="get">` and both pagers are plain `<a href>` —
 * so a screen reader's entire response to "Filter" or "Older entries" is to
 * announce the new document by its title. With a constant "Audit log" that
 * announcement was byte-identical whether the press had done something or
 * nothing, and the only text distinguishing page one from page seven was an
 * `<h2>` the admin then had to go and find.
 *
 * Note what cannot fix this: `aria-live`. A live region announces *mutations*
 * to a region that was already present, and a region arriving with its
 * document is not a mutation — so the obvious remedy would test green under
 * any assertion that checks the attribute exists, and announce nothing.
 *
 * Deliberately coarse. The exact filter values belong to the `<h2>` and the
 * chips; a title reciting them is read out in full, ahead of the thing the
 * admin actually asked for, on every single load.
 */
test("the page title says which slice of the log this is", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values(
    Array.from({ length: AUDIT_PAGE_SIZE + 5 }, () => ({
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "alumni" },
    })),
  );
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/audit");
  await expect(page).toHaveTitle("Audit log · Test Corp");

  // Paging: the announcement now differs from the one before it.
  await page.getByRole("link", { name: "Older entries" }).first().click();
  await expect(page).toHaveTitle("Audit log — older · Test Corp");

  // Filtering, from the newest page, is its own distinct announcement.
  await page.goto("/admin/audit?actor=Boss");
  await expect(page).toHaveTitle("Audit log — filtered · Test Corp");

  // Both at once, and in that order.
  await page.getByRole("link", { name: "Older entries" }).first().click();
  await expect(page).toHaveTitle("Audit log — filtered, older · Test Corp");

  // A cursor the page itself discards must not make the title claim a page the
  // admin is not on — the same rule the `<h2>` follows for `?before=abc`.
  await page.goto("/admin/audit?before=abc");
  await expect(page).toHaveTitle("Audit log · Test Corp");
});

test("a filtered paged view keeps its filter on the way back", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values(
    Array.from({ length: AUDIT_PAGE_SIZE + 2 }, () => ({
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "alumni" },
    })),
  );
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit?actor=Boss");

  await page.getByRole("link", { name: "Older entries" }).first().click();
  await expect(
    page.getByRole("link", { name: "Latest entries" }).first(),
  ).toHaveAttribute("href", "/admin/audit?actor=Boss");
});

/**
 * A cursor that does not parse is discarded by the query, so the rows are the
 * newest ones. Everything describing them has to agree with that: `?before=abc`
 * is truthy, and reading the raw param rather than the parsed cursor labelled
 * the newest page "older" and offered a way "back" to the page already on
 * screen.
 */
test("a malformed cursor is not described as an older page", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values(
    Array.from({ length: 3 }, () => ({
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "alumni" },
    })),
  );
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit?before=abc");

  // The rows really are the newest ones -- the same three the unfiltered page
  // shows -- so this is about what the page SAYS, not about what it queried.
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator(".log__empty")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "3 entries" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /older/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Latest entries" })).toHaveCount(0);
});

/**
 * The full payload was `white-space: pre` in an `overflow-x: auto` box: a
 * scroll container with no way into it from a keyboard (WCAG 2.1.1). Adding a
 * tab stop was the wrong fix -- a full page carries AUDIT_PAGE_SIZE of these.
 * It wraps instead, so there is no scroll to reach.
 */
test("an expanded payload is not a keyboard-unreachable scroll container", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "token.needs_reauth",
      target: admin.id,
      details: {
        missingScopes: [
          "esi-characters.read_corporation_roles.v1",
          "esi-alliances.read_contacts.v1",
          "esi-characters.read_notifications.v1",
        ],
      },
    },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/audit");

  const full = page.locator("details.json .json__full");
  await page.locator("details.json summary").click();
  await expect(full).toBeVisible();

  const metrics = await full.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
    tabIndex: el.tabIndex,
  }));
  // Content that only a pointer could reach would need scrollWidth > clientWidth.
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  // `auto` as well as `scroll`: the rule this replaced was `overflow-x: auto`,
  // which computes to "auto", so excluding only "scroll" would stay alumni if
  // someone restored it.
  expect(metrics.overflowX).not.toMatch(/^(auto|scroll)$/);
  expect(metrics.tabIndex).toBeLessThan(0);

  // Long unbroken scope strings still wrap rather than spilling.
  await expect(full).toContainText("esi-characters.read_corporation_roles.v1");
});

/**
 * The collapsed summary is where the product question gets answered, and its
 * `max-width: min(34ch, 100%)` was written for the sync page's auto-layout
 * table, where a cap is what stops one long payload from setting the column
 * width for every row. This table is fixed-layout with a `<colgroup>`, so the
 * cell is already a bound and the 34ch stopped the peek short inside it.
 *
 * Two rows, because "uses the column" only means something for a line long
 * enough to need it: the peek shrink-wraps its content, so a short line proves
 * nothing about the cap.
 */
test("the details peek uses the whole column it was given", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });
  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { from: "member", to: "alumni", cause: "alliance_left" },
    },
    {
      actor: "system",
      action: "token.needs_reauth",
      target: member.id,
      details: {
        missingScopes: [
          "esi-characters.read_corporation_roles.v1",
          "esi-alliances.read_contacts.v1",
        ],
      },
    },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/audit");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  const fit = await page.evaluate(() => {
    const peeks = [...document.querySelectorAll(".json__peek")] as HTMLElement[];
    // Newest first: the long token row, then the short tier row.
    const [long, short] = peeks;
    if (!long || !short) return null;

    // 34ch in the peek's own inherited font, rather than a guessed pixel count.
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:34ch";
    long.appendChild(probe);
    const ch34 = probe.getBoundingClientRect().width;
    probe.remove();

    const summary = long.closest("summary") as HTMLElement;
    const sRect = summary.getBoundingClientRect();
    const sPad = getComputedStyle(summary);
    return {
      ch34,
      longWidth: long.getBoundingClientRect().width,
      // The right edges, not the widths: the summary is a flex row and the
      // +/- marker takes the first slot, so the peek is legitimately narrower
      // than the summary. What matters is that it runs out to the same edge.
      peekRight: long.getBoundingClientRect().right,
      roomRight: sRect.right - parseFloat(sPad.paddingRight),
      shortClipped: short.scrollWidth > short.clientWidth + 1,
      longClipped: long.scrollWidth > long.clientWidth + 1,
    };
  });
  expect(fit).not.toBeNull();

  // Past the old cap, and out to the room the summary actually has.
  expect(fit!.longWidth).toBeGreaterThan(fit!.ch34);
  expect(fit!.peekRight).toBeGreaterThan(fit!.roomRight - 1);
  // Still bounded by the cell -- widening the peek must not spill it.
  expect(fit!.longClipped).toBe(true);

  // And the line that answers "why is this person's role wrong?" now fits
  // whole. Under the 34ch cap it was cut mid-answer.
  expect(fit!.shortClipped).toBe(false);
  await expect(page.locator(".json__peek").nth(1)).toHaveText(
    "Testers → Veterans, alliance_left",
  );
});

/**
 * The flip side of the same change: the sync log is auto-layout, where the cell
 * has no width of its own and the 34ch cap is the only thing stopping one long
 * payload from setting the column width for every row. Re-scoping the cap has
 * to leave that table alone.
 */
test("the sync log keeps its 34ch peek cap", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(syncRun).values({
    jobType: "membership",
    startedAt: new Date(Date.now() - 120_000),
    finishedAt: new Date(Date.now() - 60_000),
    status: "ok",
    counts: { scanned: 42, changed: 3, deroled: 1, skipped: 0 },
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/sync");

  const peek = page.locator(".log--runs .json__peek");
  await expect(peek).toHaveCount(1);

  const fit = await peek.evaluate((el) => {
    const ruler = (css: string) => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;${css}`;
      el.appendChild(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    // A sibling peek carrying more text than the column could ever hold. The
    // computed `max-width` reads back as an unresolved `min()` expression, so
    // this measures what the rule DOES rather than what it says.
    const long = document.createElement("span");
    long.className = "json__peek";
    long.textContent = "x".repeat(400);
    el.after(long);
    const longWidth = long.getBoundingClientRect().width;
    long.remove();
    return { longWidth, ch34: ruler("width:34ch") };
  });
  expect(fit.longWidth).toBeLessThanOrEqual(fit.ch34 + 1);
});

/**
 * Action is one of the three filterable fields and was the only one you could
 * not click, on a page that already splits it at the dot and dims the prefix.
 */
test("the action is a filter link like actor and target", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "alumni" },
    },
    {
      actor: admin.id,
      action: "status.changed",
      target: admin.id,
      details: { to: "active" },
    },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  const action = page.locator("tbody tr").first().locator("td").nth(2).locator("a");
  await expect(action).toHaveAttribute("href", "/admin/audit?action=status.changed");
  await action.click();

  await expect(page.locator("tbody tr")).toHaveCount(1);
  // Content, not just the count: the empty state is also exactly one <tr>, so
  // a filter that matched nothing would satisfy the count above. The form
  // value alone proves nothing either -- it is `defaultValue` echoed back off
  // the URL and reads the same whether or not the query used it.
  await expect(page.locator(".log__empty")).toHaveCount(0);
  await expect(page.locator("tbody tr").first().locator("td").nth(2)).toHaveText(
    "status.changed",
  );
  await expect(page.getByLabel("Action", { exact: true })).toHaveValue("status.changed");
});

/**
 * A member reaches `actor` only for what they did to their own account; every
 * tier change, derole and token event puts them in `target` with `system` or an
 * admin acting. Filtering the wrong column returns "no results", which is true
 * and says nothing about the log actually being silent on that person.
 *
 * The nudge sits above the results rather than inside the empty state, and the
 * second half of this test is why: an actor filter that returns the member's
 * own self-service entries is the dangerous outcome, because it reads as a
 * complete history and is not one. An empty result at least announces itself.
 */
test("an actor filter points at the target column, full or empty", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });
  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { to: "alumni" },
    },
  ]);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // The columns say which is which before anyone guesses.
  await page.goto("/admin/audit");
  await expect(page.getByLabel("Actor", { exact: true })).toBeVisible();
  await expect(page.locator("#filter-actor-hint")).toHaveText("who did it");
  await expect(page.locator("#filter-target-hint")).toHaveText("who it happened to");
  // Nothing to re-point when no filter is set.
  await expect(page.getByText("target of an entry, not the actor")).toHaveCount(0);

  await page.goto("/admin/audit?actor=Zed");
  const nudge = page.locator("p.lede", { hasText: "target of an entry, not the actor" });
  await expect(nudge).toBeVisible();
  await expect(page.locator(".log__empty")).toContainText("Nothing matches this filter.");

  // Now give Zed something they did themselves, so the actor filter returns a
  // row. The filter now looks answered, which is exactly when the sentence has
  // to still be on screen.
  await db.insert(auditLog).values([
    {
      actor: member.id,
      action: "character.linked",
      target: member.id,
      details: {},
    },
  ]);
  await page.goto("/admin/audit?actor=Zed");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator(".log__empty")).toHaveCount(0);
  await expect(nudge).toBeVisible();

  const retry = nudge.getByRole("link");
  await expect(retry).toHaveAttribute("href", "/admin/audit?target=Zed");
  await retry.click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  // Both columns crossed: there is nothing left to suggest.
  await expect(page.getByText("target of an entry, not the actor")).toHaveCount(0);
});

test("linking the system actor does not un-dim it", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });

  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      details: { to: "alumni" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/audit");

  // `system` is a link (a clickable filter) but must keep the dim
  // machine-output treatment. `.cell-link` only sets `color: inherit`, so
  // `.dim-ink` must still win the resting colour by coming later in globals.css.
  const systemLink = page.getByRole("link", { name: "system" }).first();
  await expect(systemLink).toBeVisible();

  const linkColor = await systemLink.evaluate((el) => getComputedStyle(el).color);
  // The action-namespace prefix in the same table is a `.dim-ink` span — colour
  // only, no size step, because it sits inside a mono cell whose advance width
  // has to hold. It shares `--ink-faint` with `.dim`, so it is still the right
  // thing to compare the link's resting colour against.
  const dimSpanColor = await page
    .locator("tbody tr td:nth-child(3) .dim-ink")
    .first()
    .evaluate((el) => getComputedStyle(el).color);

  expect(linkColor).toBe(dimSpanColor);
});

/* --- Pinned edges --------------------------------------------------------- */

/**
 * The wide cell's own text: a bare clock when the page's rows all fall on one
 * calendar day and the date has been hoisted above the table, or the full
 * stamp when they span more than one and every row has to carry its own.
 */
const INSTANT = /^(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}$/;

/** Enough entries that the table overflows the capped scroll region. */
async function seedDenseLog() {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values(
    Array.from({ length: 40 }, (_, i) => ({
      actor: "system",
      action: "tier.changed",
      target: `char:${i}`,
      details: { from: "alumni", to: "associate" },
    })),
  );
  return admin;
}

for (const width of [320, 390]) {
  // Every width in this loop is one where the table cannot fit its column and
  // the pinned first column is therefore load-bearing. 768px used to be in here
  // as the control that kept the full stamp; it is now in the loop below
  // instead, because at 768px this table forces no horizontal scroll at all and
  // there is nothing left for a pin to do. 66rem, not 40rem, is the breakpoint
  // the elapsed-time rendering hangs off.
  const narrow = width <= 1056;

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
    //
    // `INSTANT` and not the full stamp: when every row on the page falls on one
    // calendar day the date is hoisted out of the column and stated once above
    // the table, so the wide cell is a bare clock. `seedDenseLog` writes all 40
    // rows at once, so that is the branch these take — the hoist itself is
    // pinned by its own test below, and here the point is only which of the two
    // renderings is shown.
    const cell = page.locator("tbody tr:first-child td:first-child");
    const exact = cell.locator("span.only-wide");
    const relative = cell.locator("span.only-narrow time");
    await expect(exact).toHaveText(INSTANT);
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
    // `.scroller--tall` reserves a vertical-scrollbar gutter unconditionally
    // (globals.css, `scrollbar-gutter: stable`); `gutterWidth` measures it
    // directly (see geometry.ts), so the rightmost scrollLeft only has to
    // clear the naive figure less that measured reservation, not an assumed
    // one.
    expect(pinned.scrolledLeft).toBeGreaterThanOrEqual(
      pinned.maxScrollLeft - pinned.gutterWidth,
    );
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
    // 390.
    const detailsWidth = await page
      .locator("tbody tr:first-child td:nth-child(5)")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(detailsWidth, "the Details column has room to open into").toBeGreaterThan(100);
  });
}

/**
 * The band this table used to fail hardest in. There were two width stops in
 * the stylesheet — 46rem and 40rem — so every viewport from 641px up got the
 * desktop setting and its 62rem floor: 0px of forced horizontal scroll at
 * 639px, 399px at 641px, 272px at 768px, 17px at 1025px, none from 1050px up.
 * A tablet was the worst place to read the audit log and it got better as the
 * screen grew, which is the reverse of what a reader would predict.
 *
 * A 66rem stop carrying a middle column setting closes it. These widths are
 * the ones that were broken and the one that never was, asserted the same way,
 * so a future change that reintroduces a floor above the viewport fails here
 * rather than in a screenshot nobody takes at 768px.
 *
 * Deliberately not folded into the loop above: that loop's assertions are all
 * about a pinned column inside a region that scrolls, and the entire point of
 * these widths is that nothing scrolls.
 */
for (const width of [768, 1025, 1056, 1057, 1280]) {
  // The same 66rem boundary the stylesheet uses. 768 is inside the middle band
  // and takes the elapsed rendering; 1280 is above it and keeps the stamp the
  // At column exists for. 1056 and 1057 straddle the stop itself: `max-width:
  // 66rem` is inclusive, so 1056 must still be narrow and 1057 must not. Both
  // sides are asserted because the two ways to get this wrong — writing the
  // wrong rem figure, or writing `min-width` — each leave one side right, and
  // a single sample anywhere in the band passes through either mistake.
  //
  // 1025 is here because it is where this test earned its keep. The stop was
  // first written at 64rem, which reads like the obvious round number and
  // closes 641–1024 — leaving 1025–1049 forcing up to 17px of scroll, the
  // exact defect the block exists to remove, in a 25px window that neither 768
  // nor 1280 goes anywhere near. Keep this width even though 1056 now covers
  // the boundary: it is the regression case, not the boundary case.
  const narrow = width <= 1056;

  test(`audit at ${width}px: the table fits its column and the header still sticks`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseLog();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/audit");
    await page.waitForSelector(".scroller tbody tr");

    const cell = page.locator("tbody tr:first-child td:first-child");
    const exact = cell.locator("span.only-wide");
    const relative = cell.locator("span.only-narrow time");
    // Both renderings are in the markup at every width; only one is shown.
    await expect(exact).toHaveText(INSTANT);
    await expect(relative).toHaveText(/^\d+[smhd] ago$/);
    await expect(narrow ? relative : exact).toBeVisible();
    await expect(narrow ? exact : relative).toBeHidden();

    const maxScrollLeft = await page
      .locator(".scroller")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(maxScrollLeft, "no forced horizontal scroll at this width").toBe(0);

    // The vertical pin is unaffected by any of this and must stay: the region
    // is still height-capped, so the header still has to ride the scroll.
    const head = await pinGeometry(page, ".scroller", "thead th:first-child", "down");
    expect(head.maxScrollTop).toBeGreaterThan(0);
    expect(head.scrolledTop).toBe(head.maxScrollTop);
    expect(head.overlapY).toBeCloseTo(head.cellHeight, 0);
    expect(head.text).toContain("At");

    // The colgroup's one unsized column. A fixed-layout table is at least the
    // sum of its columns, so lowering the floor for this band without lowering
    // the four sized columns with it starves Details — measured 72px on the
    // first attempt at 768px, against 158px once all five moved together.
    const detailsWidth = await page
      .locator("tbody tr:first-child td:nth-child(5)")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(detailsWidth, "the Details column has room to open into").toBeGreaterThan(100);
  });
}

/**
 * Pattern 2 of the design sweep: a value repeated identically on every row when
 * it is one fact about the whole set. Both branches, because the interesting
 * failure is not the hoist — it is the hoist firing on a page whose rows do NOT
 * agree, which would delete a date the admin needs and state a false one above.
 */
test("the shared calendar day is stated once, and only when every row agrees", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // Two rows, one day. Explicit instants rather than seedDenseLog's defaults:
  // a test about which day the rows fall on cannot let the clock decide, and
  // "now" straddles midnight once a day.
  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: "char:1",
      at: new Date("2026-03-04T09:15:00Z"),
      details: {},
    },
    {
      actor: "system",
      action: "tier.changed",
      target: "char:2",
      at: new Date("2026-03-04T21:40:30Z"),
      details: {},
    },
  ]);

  await page.goto("/admin/audit");
  await page.waitForSelector(".scroller tbody tr");
  await expect(page.getByText("All 2 entries on 2026-03-04 (UTC).")).toBeVisible();
  // Said once above the table and dropped from both channels in the rows —
  // `.only-wide` is a display toggle, so this span is what AT reads at this
  // width too. R4: neither channel keeps what the other lost.
  const wide = page.locator("tbody tr td:first-child span.only-wide");
  await expect(wide.first()).toHaveText("21:40:30");
  await expect(wide.nth(1)).toHaveText("09:15:00");

  // One more row, one day earlier. Now nothing is shared, the line goes away,
  // and every row carries its own date again. It sorts to the top because the
  // log is keyset-ordered by id — insertion order — not by `at`; a backdated
  // entry lands where it was written, which is what makes the multi-day case
  // reachable at all.
  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: "char:3",
      at: new Date("2026-03-03T11:00:00Z"),
      details: {},
    },
  ]);
  await page.reload();
  await page.waitForSelector(".scroller tbody tr");
  await expect(page.getByText(/^All \d+ entries on /)).toHaveCount(0);
  await expect(wide.first()).toHaveText("2026-03-03 11:00:00");
  await expect(wide.nth(1)).toHaveText("2026-03-04 21:40:30");
});

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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: admin.id,
      details: { to: "alumni" },
    },
    {
      actor: "system",
      action: "tier.changed",
      target: admin.id,
      details: { to: "associate" },
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "alumni" },
    },
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "associate" },
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

test("a tier demotion row shows why it happened without opening the payload", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Zed", tier: "alumni" });

  await db.insert(auditLog).values([
    {
      actor: "system",
      action: "tier.changed",
      target: member.id,
      // Deliberately NOT renamed: this row stands in for audit history written
      // before migration 0007, and must still render its stored values.
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

/**
 * WCAG 2.2 2.4.11, Focus Not Obscured, on this table. The accounts page has the
 * same shape and its own version of this test; the shared rule
 * (`.log--sticky-head :is(a, button, summary, ...) { scroll-margin-top }`) is
 * declared once and applies here, but a declaration is not proof the engine
 * applies it to this markup. The audit table is the harder case: every row
 * carries three links and a disclosure, so it is the page where sequential
 * focus navigation actually walks a hundred targets under a pinned header.
 *
 * Rects, not the CSS property, and `scrollIntoView({block: "nearest"})` as the
 * trigger rather than `focus()` -- Chromium's programmatic focus scroll centres
 * an off-screen element, which makes the alignment this rule governs a no-op.
 * See the longer note on the accounts-page version in admin.spec.ts.
 */
test("an audit row's control stays clear of the sticky header when focused", async ({
  page,
  context,
}) => {
  const admin = await seedDenseLog();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/admin/audit");
  await page.waitForSelector(".scroller tbody tr");

  const ROW = 12;
  const geom = await page.evaluate((row) => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    const tr = sc.querySelectorAll(".log--audit > tbody > tr")[row] as
      HTMLElement | undefined;
    const control = tr?.querySelector("summary") as HTMLElement | null;
    const th = sc.querySelector<HTMLElement>(".log--audit > thead th");
    if (!tr || !control || !th) return null;

    // One short scroll past the row: from the very bottom the browser runs the
    // region back to 0 instead, landing the row below the header for a reason
    // that has nothing to do with scroll-margin.
    sc.scrollTop = tr.offsetTop + tr.offsetHeight + 40;
    const scrolled = sc.scrollTop > 0 && sc.scrollTop >= tr.offsetTop;
    const before = control.getBoundingClientRect().top;
    const headTop = th.getBoundingClientRect().top;

    control.scrollIntoView({ block: "nearest" });
    control.focus();

    return {
      scrolled,
      startedAbove: before < headTop,
      focused: document.activeElement === control,
      controlTop: control.getBoundingClientRect().top,
      headBottom: th.getBoundingClientRect().bottom,
    };
  }, ROW);

  expect(geom, "the audit table, its header and row 12's summary all resolved").not.toBe(
    null,
  );
  // The same three guards as the accounts version: without them this passes
  // when the region never scrolled, when the target was on screen all along, or
  // when it was never focusable.
  expect(
    geom!.scrolled,
    "the region scrolled far enough to put the target above it",
  ).toBe(true);
  expect(geom!.startedAbove, "the target starts above the sticky header").toBe(true);
  expect(geom!.focused, "the disclosure actually took focus").toBe(true);

  expect(
    geom!.controlTop,
    "the focused control's top edge is below the sticky header's bottom edge",
  ).toBeGreaterThanOrEqual(geom!.headBottom);
});

test("the filter row's clear link matches the height of the Filter button beside it", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await db.insert(auditLog).values([
    {
      actor: admin.id,
      action: "tier.changed",
      target: admin.id,
      details: { to: "member" },
    },
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  // `clear` only renders on a filtered view.
  await page.goto("/admin/audit?action=tier.changed");

  const clear = page.getByRole("link", { name: "clear" });
  const filter = page.getByRole("button", { name: "Filter" });
  await expect(clear).toBeVisible();

  const [clearBox, filterBox] = await Promise.all([
    clear.boundingBox(),
    filter.boundingBox(),
  ]);
  // Both assertions matter: equality alone would pass if a later change shrank
  // them together, and 36 alone would not catch the pair drifting apart.
  expect(Math.round(clearBox!.height)).toBe(36);
  expect(Math.round(clearBox!.height)).toBe(Math.round(filterBox!.height));
});
