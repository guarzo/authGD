/**
 * SEED TIMES HERE MUST BE RELATIVE TO `Date.now()`, NEVER A LITERAL DATE.
 *
 * Same discipline `sync.spec.ts` states at the top of itself, for the same
 * reason: this page renders every observation with its age, so a snapshot
 * pinned to a fixed instant reads as fresh on the day the test is written and
 * as months-stale forever after — and it fails as a stale assertion in an
 * unrelated run long after the line that caused it. Use `ago()`.
 *
 * Every row here is seeded DIRECTLY. Dry-run forbids live reads and the job
 * refuses to run without a token, so the job cannot produce fixtures; the
 * tables are the contract this page reads and the tests write them.
 */
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
  auditLog,
  character,
  outbox,
} from "../src/db/schema";
import { ACCESS_LISTS_SCOPE } from "../src/lib/esi/client";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();

test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const LIST_ID = 4001;

/**
 * An admin whose main character carries whatever scope the test needs, signed
 * in. Returns the character id so the holder row can point at it.
 */
async function asAdmin(
  context: import("@playwright/test").BrowserContext,
  opts: {
    scopes?: string[];
    tokenStatus?: "valid" | "invalid" | "needs_reauth" | "missing";
  } = {},
) {
  const acc = await seedMember(db, { name: "Vela Kaine", tier: "member", isAdmin: true });
  const [c] = await db
    .update(character)
    .set({
      scopes: opts.scopes ?? [ACCESS_LISTS_SCOPE],
      tokenStatus: opts.tokenStatus ?? "valid",
    })
    .where(eq(character.accountId, acc.id))
    .returning({ id: character.id });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  return { accountId: acc.id, characterId: c.id };
}

async function seedHolder(characterId: number) {
  await db.insert(accessListHolder).values({ id: 1, characterId, designatedBy: "e2e" });
}

async function seedCatalog(
  characterId: number,
  opts: { accessListId?: number; name?: string } = {},
) {
  await db.insert(accessListCatalog).values({
    accessListId: opts.accessListId ?? LIST_ID,
    name: opts.name ?? "Fleet staging",
    discoveredAt: ago(10 * MIN),
    observedByCharacterId: characterId,
  });
}

/** A watched list with a successful read and the membership rows behind it. */
async function seedWatched(
  characterId: number,
  opts: {
    accessListId?: number;
    name?: string;
    readStatus?: "ok" | "not_visible" | "failed";
    allowEveryone?: boolean;
    entries?: Array<{ kind: "character" | "corporation" | "alliance"; entityId: number }>;
    detail?: string | null;
  } = {},
) {
  const accessListId = opts.accessListId ?? LIST_ID;
  const name = opts.name ?? "Fleet staging";
  await db.insert(accessListWatch).values({ accessListId, addedBy: "e2e" });
  await db.insert(accessListSnapshot).values({
    accessListId,
    observedAt: ago(3 * MIN),
    lastAttemptAt: ago(3 * MIN),
    readStatus: opts.readStatus ?? "ok",
    observedByCharacterId: characterId,
    name,
    description: "",
    allowEveryone: opts.allowEveryone ?? false,
    detail: opts.detail ?? null,
  });
  for (const e of opts.entries ?? []) {
    await db.insert(accessListEntry).values({
      accessListId,
      kind: e.kind,
      entityId: e.entityId,
      access: "member",
    });
  }
}

test("state 1: no holder and no scope asks for the grant, and shows no table", async ({
  page,
  context,
}) => {
  await asAdmin(context, { scopes: [] });
  await page.goto("/admin/access-lists");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Access lists");
  await expect(page.locator(".page__lede")).toContainText("Nobody has granted");
  await expect(page.getByRole("link", { name: "Grant access" })).toHaveAttribute(
    "href",
    "/auth/eve/link?grant=access-lists",
  );
  // Nothing to be stale about, so no watched-list section at all — an empty
  // table here would read as "no drift".
  await expect(page.getByRole("heading", { name: "Watched lists" })).toHaveCount(0);
});

test("state 2: a granted character with no holder gets the designate button", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".page__lede")).toContainText("Designate it as the holder");
  await expect(page.getByRole("button", { name: "Designate as holder" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grant access" })).toHaveCount(0);
});

test("state 3: a holder whose scope was dropped is offered the GRANTING link, not a plain re-auth", async ({
  page,
  context,
}) => {
  // The distinction is the whole point: the plain /auth/eve/link is what drops
  // the scope, so offering it here would send the admin round the loop that
  // caused the outage.
  const { characterId } = await asAdmin(context, { scopes: [] });
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".page__lede")).toContainText(
    "no longer carries the access-list",
  );
  // Lowercase mid-sentence ("...it, so no reads are happening.") — this state's
  // sentence is one clause, unlike holder-needs-reauth/holder-no-token's
  // separate "No reads are happening." sentence — so the case must match the
  // actual copy rather than the brief's shorthand.
  await expect(page.locator(".page__lede")).toContainText("no reads are happening");
  await expect(page.getByRole("link", { name: "Re-grant access" })).toHaveAttribute(
    "href",
    "/auth/eve/link?grant=access-lists",
  );
  // The last successful observation still renders beneath the problem.
  await expect(page.getByRole("heading", { name: "Watched lists" })).toBeVisible();
  await expect(page.locator(".acl-list__row")).toContainText("Fleet staging");
});

test("states 4 and 5: a stale authorization and a dead token are different sentences", async ({
  page,
  context,
}) => {
  const reauth = await asAdmin(context, { tokenStatus: "needs_reauth" });
  await seedHolder(reauth.characterId);
  await seedCatalog(reauth.characterId);
  await page.goto("/admin/access-lists");
  await expect(page.locator(".page__lede")).toContainText("authorization has gone stale");
  await expect(page.getByRole("link", { name: "Re-authenticate" })).toBeVisible();

  await resetDb(db);
  const dead = await asAdmin(context, { tokenStatus: "missing" });
  await seedHolder(dead.characterId);
  await seedCatalog(dead.characterId);
  await page.goto("/admin/access-lists");
  await expect(page.locator(".page__lede")).toContainText("no stored token");
  await expect(
    page.getByRole("link", { name: "Add this character again" }),
  ).toBeVisible();
});

test("state 6: a healthy holder with an empty catalog offers Check now as the primary", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".page__lede")).toContainText(
    "No lists have been discovered",
  );
  await expect(page.getByRole("button", { name: "Check now" })).toHaveClass(
    /btn--primary/,
  );
});

test("state 7: a clean list is one line with nothing to open", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // The one member character is listed explicitly, so nothing is missing and
  // nobody unexpected has access.
  const [member] = await db
    .select({ id: character.id })
    .from(character)
    .where(eq(character.name, "Vela Kaine"));
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: member.id }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("in sync");
  // No disclosure control at all — not a closed one. A toggle over an empty
  // box is a promise the row cannot keep.
  await expect(row.locator("summary")).toHaveCount(0);

  // …but it is still removable. The row with no drawer is exactly the row an
  // admin most wants off the page, and for one revision of this design its
  // only "Stop watching" lived inside a drawer this row never renders — which
  // made a clean list permanently unwatchable. Asserted here, on the row that
  // has no `summary`, because that is the shape the bug hid in.
  await expect(row.getByRole("button", { name: "Stop watching" })).toBeVisible();
  await row.getByRole("button", { name: "Stop watching" }).click();
  // `.last()`: the empty-state `Notice` ("No lists are being watched yet.")
  // sits INSIDE the same region-wide `ConfirmingForm` (ahead of it in the
  // DOM), and both it and the group's own confirmation render at once once
  // the last row is gone — `.first()` would catch the wrong one here.
  await expect(page.locator(".notice").last()).toContainText(
    "removed from the watchlist",
  );
  await expect(page.locator(".acl-list__row")).toHaveCount(0);
  await expect(page.getByText("No lists are being watched yet.")).toBeVisible();
});

test("a drifted row opens to names, reads warn not bad, and its drawer survives Stop watching", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  // Two drifted rows, not one: with a single watched list, the row whose
  // drawer this test asserts on IS the row "Stop watching" deletes, so
  // `summary` is gone by construction and the assertion below is
  // unsatisfiable no matter how correct the page is. A second row gives the
  // test a `summary` that presses on THIS row cannot touch, which is the
  // only shape that can actually catch a `Disclosure` reset.
  const SECOND_LIST_ID = 4002;
  await seedCatalog(characterId);
  await seedCatalog(characterId, { accessListId: SECOND_LIST_ID, name: "Home defense" });
  // Nobody from the roster is listed, and one stranger is: both buckets at once.
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: 99_000_123 }],
  });
  await seedWatched(characterId, {
    accessListId: SECOND_LIST_ID,
    name: "Home defense",
    entries: [{ kind: "character", entityId: 99_000_124 }],
  });
  await page.goto("/admin/access-lists");

  const rowA = page.locator(".acl-list__row").filter({ hasText: "Fleet staging" });
  const rowB = page.locator(".acl-list__row").filter({ hasText: "Home defense" });
  await expect(rowA).toContainText("1 missing access");
  await expect(rowA).toContainText("1 has access, not a member");
  // Drift is warn. `bad` is reserved for destructive acts and nothing this
  // page reports is one.
  await expect(rowA.locator(".st--warn")).toBeVisible();
  await expect(rowA.locator(".st--bad")).toHaveCount(0);

  const summaryA = rowA.locator("summary");
  await expect(summaryA).toHaveAttribute("aria-expanded", "false");
  await summaryA.click();
  await expect(summaryA).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: /Missing access \(1\)/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /not a member \(1\)/ })).toBeVisible();
  // Scoped to row A: `Disclosure` renders both rows' `.acl-detail` into the
  // DOM regardless of which is open (visibility is CSS, not conditional
  // render), so an unscoped `.acl-detail` locator is ambiguous the moment a
  // second drifted row exists.
  await expect(rowA.locator(".acl-detail")).toContainText("Vela Kaine");

  const summaryB = rowB.locator("summary");
  await summaryB.click();
  await expect(summaryB).toHaveAttribute("aria-expanded", "true");

  // The reason `removeWatchAction` returns an `ActionOutcome` instead of
  // redirecting: a redirect replaces the route tree and resets `Disclosure`'s
  // `useState`, closing every open drawer on the press that used it. Pressing
  // "Stop watching" on row A's own drawer, then reading row B's `summary`, is
  // what would catch that regression — row A's own drawer cannot be asked
  // this question, because row A is the row that just left the DOM.
  await rowA.getByRole("button", { name: "Stop watching" }).click();
  await expect(page.locator(".notice")).toContainText("removed from the watchlist");
  await expect(summaryB).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".acl-list__row")).toHaveCount(1);
  await expect(rowA).toHaveCount(0);
});

test("a corporation grant states our count AND that it is partial", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, {
    entries: [{ kind: "corporation", entityId: 98_000_555 }],
  });
  await page.goto("/admin/access-lists");

  await page.locator(".acl-list__row summary").click();
  // We store a corporation per character and hold no corp roster, so the page
  // must never imply the second bucket is complete for a broad grant.
  await expect(page.locator(".acl-detail")).toContainText(
    "plus an unknown number of others",
  );
});

test("a failed read keeps the last good observation and dates it", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, {
    readStatus: "not_visible",
    entries: [{ kind: "character", entityId: 99_000_123 }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("not visible to holder");
  await expect(row.locator(".st--warn")).toBeVisible();
  await row.locator("summary").click();
  await expect(page.locator(".acl-detail .notice--warn")).toContainText(
    "last successful read",
  );
});

test("allow_everyone is stated in its own words, never as zero discrepancies", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, { allowEveryone: true });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("open to everyone");
  await expect(row).not.toContainText("in sync");
  await expect(row.locator(".st--warn")).toBeVisible();
});

test("Check now enqueues a read and audits nothing", async ({ page, context }) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await page.goto("/admin/access-lists");

  await page.getByRole("button", { name: "Check now" }).click();
  // `.first()`: the catalog is seeded but the watchlist is empty, so the page
  // also renders its own "No lists are being watched yet." notice below the
  // controls — `ConfirmNotice`'s redirect-carried confirmation is the one
  // that renders first, right under the `h1`.
  await expect(page.locator(".notice").first()).toContainText("Check queued");

  const queued = await db.select().from(outbox);
  expect(queued).toHaveLength(1);
  // Enqueuing a READ changes no state, and `runJob` already records the run in
  // `sync_run`. An audit row here would be a state change that never happened.
  const audits = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "access_list.check_requested"));
  expect(audits).toHaveLength(0);
});

/**
 * The never-read row is the ONLY row whose name cannot come from a snapshot,
 * because it has no snapshot — `seedWatched` always writes one, so this test
 * inserts the watch row bare. It is also the row an admin sees at the moment
 * they care most: the seconds between adding a list and the job first reading
 * it. `getWatchedListViews` used to select the name from the snapshot alone,
 * so this row rendered as `#4001` — a number chosen by CCP, shown to a person
 * who picked that list BY NAME out of the dropdown one click earlier. The
 * catalog knew the name the entire time.
 */
test("a list added but never read is still named, not reduced to its id", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId, { name: "Fleet staging" });
  // No snapshot row: watched, never read.
  await db.insert(accessListWatch).values({ accessListId: LIST_ID, addedBy: "e2e" });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("Fleet staging");
  // The assertion that would have failed before the catalog join, kept
  // separate from the positive one: a row can contain both, and "the name is
  // present" is not the same claim as "the id is not standing in for it".
  await expect(row).not.toContainText(`#${LIST_ID}`);

  // The confirmation names it too, which takes `removeWatch`'s return value
  // rather than the id the action already had in hand: the row said "Fleet
  // staging" a moment ago, and a notice answering "#4001 removed" would leave
  // the admin matching a number against a name they never saw here.
  await row.getByRole("button", { name: "Stop watching" }).click();
  await expect(page.locator(".notice").last()).toContainText(
    "Fleet staging removed from the watchlist",
  );
});

/**
 * The dropdown's default is a real option rather than an absent one, and the
 * select is `required`. Without the placeholder, `defaultValue=""` matched
 * nothing rendered, so the browser selected the first list in the catalog and
 * an untouched submit added a list the admin never chose. Without `required`,
 * the placeholder alone only stopped the browser re-selecting it: a disabled
 * selected option contributes no entry at all, so the submit still went, with
 * no `accessListId` in it, and `parseId` threw `invalid_id` — an ordinary
 * mis-click landing on the error boundary. Both halves are asserted below,
 * because either one alone leaves a bad outcome.
 */
test("the add control cannot submit a list the admin never chose", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId, { accessListId: 4001, name: "Fleet staging" });
  await seedCatalog(characterId, { accessListId: 4002, name: "Home defence" });
  await page.goto("/admin/access-lists");

  const select = page.locator("#add-list");
  await expect(select).toHaveValue("");
  await expect(select.locator("option[value='']")).toBeDisabled();

  // Count the POSTs rather than inspecting the page afterwards. "Nothing was
  // added" is the weaker claim — a server action that throws adds nothing
  // either, and the admin is then looking at "Something broke". The claim
  // worth pinning is that the mis-click never leaves the browser.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  await page.getByRole("button", { name: "Add to watchlist" }).click();

  // Read the validity state before asserting on `posts`: it is a round trip to
  // the browser, so a submit that DID fire has been observed by the time the
  // count is read.
  expect(await select.evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(
    true,
  );
  expect(posts).toEqual([]);
  expect(await db.select().from(accessListWatch)).toHaveLength(0);
});

/**
 * The two stale-page presses. Neither is reachable by clicking alone — the
 * `<select>` never offers a watched list, and a removed row takes its button
 * with it — so both are reached the only way a real admin reaches them: the
 * page renders, the table changes underneath it (another admin, another tab),
 * and the press lands against a world that has moved. The seeds below make
 * that change directly, between the render and the click.
 *
 * The copy is what is asserted, because the copy is the whole of the fix: both
 * presses used to answer with the ordinary success sentence, crediting this
 * admin with an act that had already happened without them.
 */
test("a removal whose row is already gone says so, and does not claim a removal", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId, { name: "Fleet staging" });
  await seedWatched(characterId);
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("Fleet staging");
  // Seeded with no entries against a one-member roster, so this row drifts and
  // therefore expands: its "Stop watching" lives inside the drawer, and the
  // drawer has to be open for the press to reach it.
  await row.locator("summary").click();
  // The other tab's removal, after this page has rendered its button.
  await db.delete(accessListWatch).where(eq(accessListWatch.accessListId, LIST_ID));

  await row.getByRole("button", { name: "Stop watching" }).click();
  const notice = page.locator(".notice").last();
  // Named, not numbered: the catalog row outlives the watch row, so the
  // sentence about the press that did nothing can still say which list.
  await expect(notice).toContainText("Fleet staging was already off the watchlist");
  await expect(notice).not.toContainText("removed from the watchlist");
  // `warn`, not the untoned success rendering — this action returns an
  // `ActionOutcome`, so unlike the redirecting controls it has a tone channel
  // and uses it.
  await expect(notice).toHaveClass(/notice--warn/);
  // No audit row: nothing was removed, so nothing in the history says it was.
  // The audit table is why the boolean lives at the service layer rather than
  // only in the copy.
  expect(await db.select().from(auditLog)).toHaveLength(0);
});

test("an add of a list someone else already watched says nothing was added", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId, { name: "Fleet staging" });
  await page.goto("/admin/access-lists");

  await page.locator("#add-list").selectOption(String(LIST_ID));
  // The other tab's add, after this page built its `<select>` from a catalog
  // with nothing watched in it.
  await db.insert(accessListWatch).values({ accessListId: LIST_ID, addedBy: "other" });

  await page.getByRole("button", { name: "Add to watchlist" }).click();
  const notice = page.locator(".notice").last();
  await expect(notice).toContainText("already on the watchlist");
  // The assertion that fails without the split marker: `doneNotice("watch")`
  // is a perfectly good sentence to render here, and a wrong one.
  await expect(notice).not.toContainText("List added to the watchlist");
  // One watch row, and no audit row — the other tab wrote the row without
  // going through `addWatch`, and this press wrote nothing at all.
  expect(await db.select().from(accessListWatch)).toHaveLength(1);
  expect(await db.select().from(auditLog)).toHaveLength(0);
});
