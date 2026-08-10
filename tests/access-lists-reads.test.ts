import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
} from "@/db/schema";
import {
  getCatalog,
  getHolderView,
  getOwnCharacters,
  getWatchedListViews,
} from "@/services/access-lists";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const HOLDER = 90000001;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedHolder(
  opts: { scopes?: string[]; tokenStatus?: "valid" | "needs_reauth" } = {},
) {
  const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
  await seedCharacter(ctx.db, cfg, {
    id: HOLDER,
    accountId: acc.id,
    main: true,
    name: "Vela Kaine",
    scopes: opts.scopes ?? [...cfg.eveSso.scopes, "esi-access.read_lists.v1"],
    tokenStatus: opts.tokenStatus ?? "valid",
  });
  await ctx.db
    .insert(accessListHolder)
    .values({ id: 1, characterId: HOLDER, designatedBy: acc.id });
  return acc;
}

describe("getHolderView", () => {
  it("returns null when nothing is designated", async () => {
    expect(await getHolderView(ctx.db)).toBeNull();
  });

  it("joins the character's name, scopes and token status onto the designation", async () => {
    // These four fields ARE the page's first three states: no holder, holder
    // without the scope, holder whose token went bad. A join that dropped any
    // of them would make those states unrenderable.
    await seedHolder({ scopes: ["esi-characters.read_contacts.v1"] });
    const view = await getHolderView(ctx.db);
    expect(view).toMatchObject({
      characterId: HOLDER,
      name: "Vela Kaine",
      scopes: ["esi-characters.read_contacts.v1"],
      tokenStatus: "valid",
    });
    expect(view?.designatedAt).toBeInstanceOf(Date);
  });
});

describe("getCatalog", () => {
  it("returns the discovered lists in id order", async () => {
    await seedHolder();
    await ctx.db.insert(accessListCatalog).values([
      { accessListId: 9, name: "Staging", observedByCharacterId: HOLDER },
      { accessListId: 3, name: "Home", observedByCharacterId: HOLDER },
    ]);
    expect(await getCatalog(ctx.db)).toEqual([
      { accessListId: 3, name: "Home" },
      { accessListId: 9, name: "Staging" },
    ]);
  });

  it("is empty before the job has ever run", async () => {
    expect(await getCatalog(ctx.db)).toEqual([]);
  });
});

describe("getWatchedListViews", () => {
  it("returns a watched list that has never been read, rather than dropping it", async () => {
    // A list watched a minute ago has no snapshot row. "Never read" is a state
    // the page renders; an inner join would silently lose the row instead.
    const acc = await seedHolder();
    await ctx.db.insert(accessListWatch).values({ accessListId: 42, addedBy: acc.id });
    const views = await getWatchedListViews(ctx.db);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      accessListId: 42,
      name: null,
      readStatus: null,
      observedAt: null,
      lastAttemptAt: null,
      allowEveryone: null,
      entries: [],
    });
  });

  it("attaches each list's entries and nothing else's", async () => {
    const acc = await seedHolder();
    await ctx.db.insert(accessListWatch).values([
      { accessListId: 42, addedBy: acc.id },
      { accessListId: 7, addedBy: acc.id },
    ]);
    await ctx.db.insert(accessListSnapshot).values([
      {
        accessListId: 42,
        observedByCharacterId: HOLDER,
        name: "Home Structures",
        readStatus: "ok",
        observedAt: new Date(),
        lastAttemptAt: new Date(),
        allowEveryone: false,
      },
      {
        accessListId: 7,
        observedByCharacterId: HOLDER,
        name: "Staging",
        readStatus: "not_visible",
        lastAttemptAt: new Date(),
        detail: "403",
      },
    ]);
    await ctx.db.insert(accessListEntry).values([
      { accessListId: 42, kind: "character", entityId: 1, access: "member" },
      { accessListId: 42, kind: "corporation", entityId: 500, access: "member" },
      { accessListId: 7, kind: "alliance", entityId: 900, access: "blocked" },
    ]);

    const views = await getWatchedListViews(ctx.db);
    // Ordered by list id, so 7 comes first.
    expect(views.map((v) => v.accessListId)).toEqual([7, 42]);
    expect(views[0]).toMatchObject({
      name: "Staging",
      readStatus: "not_visible",
      observedAt: null,
      detail: "403",
    });
    expect(views[0].entries).toEqual([
      { kind: "alliance", entityId: 900, access: "blocked" },
    ]);
    expect(views[1].entries).toHaveLength(2);
    expect(views[1].entries.map((e) => e.entityId).sort()).toEqual([1, 500]);
  });

  it("ignores entries for lists nobody is watching", async () => {
    // The job writes entries for every list it reads; the page shows only the
    // watched ones. A missing WHERE here would leak unwatched lists onto it.
    await seedHolder();
    await ctx.db
      .insert(accessListEntry)
      .values({ accessListId: 999, kind: "character", entityId: 1, access: "member" });
    expect(await getWatchedListViews(ctx.db)).toEqual([]);
  });
});

describe("getOwnCharacters", () => {
  it("returns an alumni admin's own characters", async () => {
    // The regression this exists for: `getMemberCharacters` joins
    // `account.tier = 'member'`, and an admin's default tier is `alumni`. Off
    // that read, this admin has no characters and can never designate a holder.
    const acc = await seedAccount(ctx.db, { tier: "alumni", isAdmin: true });
    await seedCharacter(ctx.db, cfg, {
      id: HOLDER,
      accountId: acc.id,
      main: true,
      name: "Vela Kaine",
      scopes: [...cfg.eveSso.scopes, "esi-access.read_lists.v1"],
    });
    expect(await getOwnCharacters(ctx.db, acc.id)).toEqual([
      {
        characterId: HOLDER,
        name: "Vela Kaine",
        scopes: [...cfg.eveSso.scopes, "esi-access.read_lists.v1"],
      },
    ]);
  });

  it("does not return another account's characters", async () => {
    const mine = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    const theirs = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: theirs.id,
      main: true,
      name: "Someone Else",
    });
    expect(await getOwnCharacters(ctx.db, mine.id)).toEqual([]);
  });
});
