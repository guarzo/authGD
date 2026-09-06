import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { account, character, fleetEligibility, session } from "@/db/schema";
import { createSession } from "@/services/session";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

process.env.DATABASE_URL = TEST_URL;
let cookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected:${url}`);
  },
}));
// Only Next request plumbing is replaced. Session, action, DB, rotation and ESI
// parsing stay real; the fake HTTP handlers are the provider boundary.
const cfg = testConfig();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
const server = setupServer();
let calls: string[];
beforeAll(async () => {
  ctx = await setupTestDb();
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(async () => {
  server.close();
  await ctx.cleanup();
});
afterEach(() => server.resetHandlers());
beforeEach(async () => {
  await truncateAll(ctx.db);
  cookie = undefined;
  calls = [];
  server.use(
    http.post("https://login.eveonline.com/v2/oauth/token", () => {
      calls.push("refresh");
      return HttpResponse.json({
        access_token: "synthetic-at",
        refresh_token: "rotated",
      });
    }),
    http.get("https://esi.evetech.net/latest/characters/:id/fleet/", () => {
      calls.push("membership");
      return HttpResponse.json({
        fleet_id: 123,
        fleet_boss_id: 90000099,
        role: "fleet_member",
        squad_id: 1,
        wing_id: 1,
      });
    }),
    http.get("https://esi.evetech.net/latest/fleets/123/members/", () => {
      calls.push("roster");
      return HttpResponse.json(
        [90000001, 90000002, 90000099].map((character_id) => ({
          character_id,
          role: "fleet_member",
          ship_type_id: 587,
          solar_system_id: 30000142,
          squad_id: 1,
          wing_id: 1,
          join_time: "2026-09-06T00:00:00Z",
          takes_fleet_warp: true,
        })),
      );
    }),
  );
});
async function fixture(anchorId = 90000001) {
  const acc = await seedAccount(ctx.db, { tier: "member" });
  await seedCharacter(ctx.db, cfg, {
    id: anchorId,
    accountId: acc.id,
    name: "Anchor",
    scopes: [FLEET_READ_SCOPE],
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000002,
    accountId: acc.id,
    name: "Linked Alt",
    scopes: [],
    refreshToken: null,
    tokenStatus: "missing",
    main: true,
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000003,
    accountId: acc.id,
    name: "Outside",
    scopes: [],
  });
  const other = await seedAccount(ctx.db, { tier: "member" });
  await seedCharacter(ctx.db, cfg, {
    id: 90000099,
    accountId: other.id,
    name: "Unrelated",
    scopes: [FLEET_READ_SCOPE],
  });
  cookie = await createSession(ctx.db, acc.id);
  return { acc, other };
}
function form(anchor: string | Blob = "90000001") {
  const data = new FormData();
  data.set("anchorCharacterId", anchor);
  return data;
}
const forged = {
  code: "checked" as const,
  checkedAt: "forged",
  retryAt: null,
  characters: [{ characterId: 90000099, characterName: "Unrelated" }],
};
async function check(previous = forged, data = form()) {
  const { checkFleetAccessAction } = await import("@/app/account/fleet-sharing/actions");
  return checkFleetAccessAction(previous, data);
}

it("uses the session account, ignores forged previous/account fields, and includes an ungranted linked alt", async () => {
  const { other } = await fixture();
  const data = form();
  data.set("accountId", other.id);
  const result = await check(forged, data);
  expect(result).toEqual({
    code: "checked",
    checkedAt: expect.any(String),
    retryAt: expect.any(String),
    characters: [
      { characterId: 90000001, characterName: "Anchor" },
      { characterId: 90000002, characterName: "Linked Alt" },
    ],
  });
  expect(calls).toEqual(["refresh", "membership", "roster"]);
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
});
it.each(["", "0", "-1", "1.5", "90000001x", "9007199254740992", "90000099"])(
  "refuses invalid/unowned anchor %s without provider work or previous success",
  async (anchor) => {
    await fixture();
    expect(await check(forged, form(anchor))).toEqual({
      code: "not_authorized",
      checkedAt: null,
      retryAt: null,
      characters: [],
    });
    expect(calls).toEqual([]);
  },
);
it("refuses a file-valued anchor", async () => {
  await fixture();
  expect((await check(forged, form(new Blob(["90000001"])))).code).toBe("not_authorized");
  expect(calls).toEqual([]);
});
it.each(["absent", "expired"])(
  "authenticates before inspecting a malformed form for an %s session",
  async (state) => {
    await fixture();
    if (state === "absent") cookie = undefined;
    else await ctx.db.update(session).set({ expiresAt: new Date(0) });
    const data = form();
    const get = vi.spyOn(data, "get").mockImplementation(() => {
      throw new Error("validation ran before auth");
    });
    await expect(check(forged, data)).rejects.toThrow(
      "redirected:/login?error=session_expired",
    );
    expect(get).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  },
);
it.each(["pending", "associate", "alumni"] as const)(
  "rechecks current %s tier despite admin status",
  async (tier) => {
    const { acc } = await fixture();
    await ctx.db
      .update(account)
      .set({ tier, isAdmin: true })
      .where(eq(account.id, acc.id));
    expect((await check()).code).toBe("not_eligible");
    expect(calls).toEqual([]);
  },
);
it("allows a cryo Member", async () => {
  const { acc } = await fixture();
  await ctx.db.update(account).set({ status: "cryo" }).where(eq(account.id, acc.id));
  expect((await check()).code).toBe("checked");
});
it("returns account-wide cooldown without carrying a previous roster", async () => {
  await fixture();
  expect((await check()).code).toBe("checked");
  expect(await check()).toEqual({
    code: "cooldown",
    checkedAt: null,
    retryAt: expect.any(String),
    characters: [],
  });
  expect(calls).toEqual(["refresh", "membership", "roster"]);
});
it("reads only safe owned setup state, prefers an authorized non-main, and never calls providers", async () => {
  // Ascending IDs alone would put the ungranted main first.
  const { acc } = await fixture(90000004);
  const { getFleetSharingSetup } = await import("@/services/fleet-sharing-view");
  expect(await getFleetSharingSetup(ctx.db, acc.id)).toEqual({
    eligible: true,
    isAdmin: false,
    characters: [
      {
        characterId: 90000004,
        characterName: "Anchor",
        hasFleetRead: true,
        tokenUsable: true,
      },
      {
        characterId: 90000002,
        characterName: "Linked Alt",
        hasFleetRead: false,
        tokenUsable: false,
      },
      {
        characterId: 90000003,
        characterName: "Outside",
        hasFleetRead: false,
        tokenUsable: true,
      },
    ],
  });
  const { default: Page } = await import("@/app/account/fleet-sharing/page");
  const html = renderToStaticMarkup(
    await Page({ searchParams: Promise.resolve({ notice: "authorized" }) }),
  );
  expect(html).toContain("Fleet Read authorized. Check fleet");
  expect(html).toContain('href="/account/fleet-devices"');
  expect(html).toContain('value="90000004" selected=""');
  // A native change before hydration must not leave the displayed selection
  // disagreeing with the authorization URL and action's anchor.
  expect(html).toMatch(/<select[^>]*disabled=""/);
  expect(html).toContain("Loading character controls");
  expect(html).not.toMatch(/refreshToken|ownerHash|Unrelated|rotated/);
  expect(calls).toEqual([]);
});
it("renders a Member gate rather than a check form for admin-only accounts", async () => {
  const { acc } = await fixture();
  await ctx.db
    .update(account)
    .set({ tier: "alumni", isAdmin: true })
    .where(eq(account.id, acc.id));
  const { default: Page } = await import("@/app/account/fleet-sharing/page");
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("current Member-tier account");
  expect(html).not.toContain('name="anchorCharacterId"');
  expect(calls).toEqual([]);
});
it("keeps setup token availability aligned with the check, including unrelated needs_reauth", async () => {
  const { acc } = await fixture();
  const { getFleetSharingSetup } = await import("@/services/fleet-sharing-view");
  for (const status of ["invalid", "missing", "needs_reauth"] as const) {
    await ctx.db
      .update(character)
      .set({ tokenStatus: status })
      .where(eq(character.id, 90000001));
    const setup = await getFleetSharingSetup(ctx.db, acc.id);
    expect(setup.characters.find((ch) => ch.characterId === 90000001)?.tokenUsable).toBe(
      status === "needs_reauth",
    );
  }
});
it("renders an empty setup without manufacturing a character or token", async () => {
  const acc = await seedAccount(ctx.db, { tier: "member" });
  cookie = await createSession(ctx.db, acc.id);
  const { getFleetSharingSetup } = await import("@/services/fleet-sharing-view");
  expect(await getFleetSharingSetup(ctx.db, acc.id)).toEqual({
    eligible: true,
    isAdmin: false,
    characters: [],
  });
  const { default: Page } = await import("@/app/account/fleet-sharing/page");
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("No linked characters");
  expect(html).not.toContain("<select");
  expect(calls).toEqual([]);
});
it.each(["absent", "expired"])(
  "page refuses an %s session before setup",
  async (state) => {
    await fixture();
    if (state === "absent") cookie = undefined;
    else await ctx.db.update(session).set({ expiresAt: new Date(0) });
    const { default: Page } = await import("@/app/account/fleet-sharing/page");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      state === "absent"
        ? "redirected:/login"
        : "redirected:/login?error=session_expired",
    );
    expect(calls).toEqual([]);
  },
);
it("renders a normal account link without changing the manifest", async () => {
  await fixture();
  const { default: Page } = await import("@/app/account/page");
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('href="/account/fleet-sharing"');
  expect(html).toContain("Fleet sharing");
  expect(html).toContain("Crew manifest");
  expect(calls).toEqual([]);
});
