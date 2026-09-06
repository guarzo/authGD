import { setTimeout as pause } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb } from "@/db";
import {
  account,
  auditLog,
  character,
  fleetEligibility,
  fleetAccessCheckGate,
} from "@/db/schema";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { checkFleetAccess } from "@/services/fleet-access";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const SSO = "https://login.eveonline.com/v2/oauth/token";
const BASE = "https://esi.evetech.net/latest";
const membershipUrl = `${BASE}/characters/90000001/fleet/`;
const rosterUrl = `${BASE}/fleets/123456789/members/`;
const server = setupServer();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let calls: string[];
const member = (id: number) => ({
  character_id: id,
  role: "fleet_member",
  ship_type_id: 587,
  solar_system_id: 30000142,
  squad_id: 1,
  wing_id: 1,
  join_time: "2026-09-06T00:00:00Z",
  takes_fleet_warp: true,
});
const roster = [member(90000001), member(90000002), member(90000099)];
const fleet = {
  fleet_id: 123456789,
  fleet_boss_id: 90000099,
  role: "fleet_member",
  squad_id: 1,
  wing_id: 1,
};
const matched = [
  { characterId: 90000001, characterName: "Anchor" },
  { characterId: 90000002, characterName: "Linked Alt" },
];

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  ctx = await setupTestDb();
});
afterAll(async () => {
  server.close();
  await ctx.cleanup();
});
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  calls = [];
  server.use(
    http.post(SSO, async ({ request }) => {
      calls.push("refresh");
      expect(await request.text()).toContain("grant_type=refresh_token");
      return HttpResponse.json({
        access_token: "synthetic-at",
        refresh_token: "rotated-rt",
      });
    }),
    http.get(`${BASE}/characters/:id/fleet/`, ({ request }) => {
      calls.push("membership");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-at");
      return HttpResponse.json(fleet);
    }),
    http.get(rosterUrl, ({ request }) => {
      calls.push("roster");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-at");
      return HttpResponse.json(roster);
    }),
  );
});

async function fixture(opts: Parameters<typeof seedAccount>[1] = { tier: "member" }) {
  const acc = await seedAccount(ctx.db, opts);
  const other = await seedAccount(ctx.db, { tier: "member" });
  const anchor = await seedCharacter(ctx.db, cfg, {
    id: 90000001,
    name: "Anchor",
    accountId: acc.id,
    scopes: [FLEET_READ_SCOPE],
    refreshToken: "original-rt",
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000002,
    name: "Linked Alt",
    accountId: acc.id,
    main: true,
    scopes: [],
    refreshToken: null,
    tokenStatus: "missing",
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000003,
    name: "Outside",
    accountId: acc.id,
    scopes: [],
  });
  await seedCharacter(ctx.db, cfg, {
    id: 90000099,
    name: "Unrelated",
    accountId: other.id,
    scopes: [FLEET_READ_SCOPE],
  });
  return {
    acc,
    other,
    anchor,
    input: { accountId: acc.id, anchorCharacterId: anchor.id },
  };
}
async function getAnchor() {
  const [ch] = await ctx.db.select().from(character).where(eq(character.id, 90000001));
  return ch;
}
function deferred() {
  return Promise.withResolvers<void>();
}
async function untilBlocked(blockerPid: number) {
  for (let n = 0; n < 200; n++) {
    const r = await ctx.pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
      [blockerPid],
    );
    if (r.rowCount) return;
    await pause(10);
  }
  throw new Error("Expected real database lock wait was not observed");
}

it("refreshes one anchor and returns only its currently linked in-fleet alts without grants", async () => {
  const { input } = await fixture();
  const result = await checkFleetAccess(ctx.db, cfg, input);
  expect(result).toEqual({
    code: "checked",
    checkedAt: expect.any(String),
    retryAt: expect.any(String),
    characters: matched,
  });
  expect(calls).toEqual(["refresh", "membership", "roster"]);
  expect(decryptToken((await getAnchor()).refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
    "rotated-rt",
  );
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
  expect(await ctx.db.select().from(fleetAccessCheckGate)).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(
    /123456789|90000099|synthetic-at|rotated|fleetId|ownerHash/,
  );
});

it("allows a cryo Member and needs_reauth when the actual Fleet Read grant remains", async () => {
  const { input } = await fixture({ tier: "member", status: "cryo" });
  await ctx.db
    .update(character)
    .set({ tokenStatus: "needs_reauth" })
    .where(eq(character.id, 90000001));
  expect((await checkFleetAccess(ctx.db, cfg, input)).characters).toEqual(matched);
});

it.each(["pending", "associate", "alumni"] as const)(
  "rejects %s even with admin status before upstream work",
  async (tier) => {
    const { input } = await fixture({ tier, isAdmin: true });
    expect(await checkFleetAccess(ctx.db, cfg, input)).toEqual({
      code: "not_eligible",
      checkedAt: null,
      retryAt: null,
      characters: [],
    });
    expect(calls).toEqual([]);
  },
);
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
  "rejects invalid anchor %s before HTTP",
  async (anchorCharacterId) => {
    const { input } = await fixture();
    expect(
      (await checkFleetAccess(ctx.db, cfg, { ...input, anchorCharacterId })).code,
    ).toBe("not_authorized");
    expect(calls).toEqual([]);
  },
);
it("rejects malformed or missing account identity and an unowned anchor", async () => {
  const { input } = await fixture();
  for (const accountId of ["bad", "00000000-0000-4000-8000-000000000000"]) {
    expect((await checkFleetAccess(ctx.db, cfg, { ...input, accountId })).code).toBe(
      "not_eligible",
    );
  }
  expect(
    (await checkFleetAccess(ctx.db, cfg, { ...input, anchorCharacterId: 90000099 })).code,
  ).toBe("not_authorized");
  expect(calls).toEqual([]);
});
it.each([
  { scopes: [] },
  { refreshTokenEnc: null },
  { tokenStatus: "invalid" as const },
  { tokenStatus: "missing" as const },
])("rejects absent authorization %j before token work", async (change) => {
  const { input } = await fixture();
  await ctx.db.update(character).set(change).where(eq(character.id, 90000001));
  expect((await checkFleetAccess(ctx.db, cfg, input)).code).toBe("not_authorized");
  expect(calls).toEqual([]);
});
it("settles invalid stored tokens through the real token service", async () => {
  const { input } = await fixture();
  await ctx.db
    .update(character)
    .set({ refreshTokenEnc: "malformed" })
    .where(eq(character.id, 90000001));
  expect((await checkFleetAccess(ctx.db, cfg, input)).code).toBe(
    "authorization_rejected",
  );
  expect((await getAnchor()).tokenStatus).toBe("invalid");
  expect(calls).toEqual([]);
});
it("dry-run does not refresh, read ESI, or change credentials", async () => {
  const { input, anchor } = await fixture();
  expect(
    (await checkFleetAccess(ctx.db, { ...cfg, syncMode: "dry-run" }, input)).code,
  ).toBe("service_unavailable");
  expect((await getAnchor()).refreshTokenEnc).toBe(anchor.refreshTokenEnc);
  expect(calls).toEqual([]);
});

it.each([
  [404, "not_in_fleet"],
  [401, "authorization_rejected"],
  [403, "authorization_rejected"],
  [429, "service_unavailable"],
  [500, "service_unavailable"],
])(
  "membership HTTP %s is safely %s and never starts roster work",
  async (status, code) => {
    const { input } = await fixture();
    server.use(
      http.get(membershipUrl, () =>
        HttpResponse.json({ error: "private path and body" }, { status: Number(status) }),
      ),
    );
    expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
      code,
      checkedAt: null,
      characters: [],
    });
    expect(calls).toEqual(["refresh"]);
  },
);
it.each([
  [404, "roster_unavailable"],
  [401, "authorization_rejected"],
  [403, "authorization_rejected"],
  [429, "service_unavailable"],
  [503, "service_unavailable"],
])("roster HTTP %s is safely %s", async (status, code) => {
  const { input } = await fixture();
  server.use(
    http.get(rosterUrl, () =>
      HttpResponse.json({ error: "private role hint" }, { status: Number(status) }),
    ),
  );
  expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
    code,
    checkedAt: null,
    characters: [],
  });
});
it.each([
  { body: [] },
  { body: [member(90000002)] },
  { body: [{ character_id: "bad" }] },
])("refuses absent anchor or malformed roster $body", async ({ body }) => {
  const { input } = await fixture();
  server.use(http.get(rosterUrl, () => HttpResponse.json(body)));
  expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
    code: "roster_unavailable",
    characters: [],
    checkedAt: null,
  });
});
it.each(["bad", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "malformed fleet ID %s skips roster, with no invented empty-fleet evidence",
  async (fleetId) => {
    const { input } = await fixture();
    server.use(
      http.get(membershipUrl, () => HttpResponse.json({ ...fleet, fleet_id: fleetId })),
    );
    expect((await checkFleetAccess(ctx.db, cfg, input)).code).toBe("roster_unavailable");
    expect(calls).toEqual(["refresh"]);
  },
);
it.each([
  [400, "invalid_grant", "authorization_rejected"],
  [503, "temporarily_unavailable", "service_unavailable"],
])("SSO %s fails safely and skips both ESI calls", async (status, error, code) => {
  const { input } = await fixture();
  server.use(
    http.post(SSO, () => HttpResponse.json({ error }, { status: Number(status) })),
  );
  expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
    code,
    characters: [],
    checkedAt: null,
  });
  expect(calls).toEqual([]);
});

it("uses one atomic account slot across pools and different anchors, then permits a database-time retry", async () => {
  const { input } = await fixture();
  await ctx.db
    .update(character)
    .set({
      scopes: [FLEET_READ_SCOPE],
      refreshTokenEnc: encryptToken("alt-rt", cfg.tokenEncryptionKey),
      tokenStatus: "valid",
    })
    .where(eq(character.id, 90000002));
  const peer = createDb(TEST_URL);
  try {
    const results = await Promise.all([
      checkFleetAccess(ctx.db, cfg, input),
      checkFleetAccess(peer.db, cfg, { ...input, anchorCharacterId: 90000002 }),
    ]);
    expect(results.map((r) => r.code).sort()).toEqual(["checked", "cooldown"]);
    expect(calls.filter((x) => x === "refresh")).toHaveLength(1);
    const [gate] = await ctx.db.select().from(fleetAccessCheckGate);
    expect(results.map((r) => r.retryAt)).toEqual([
      gate.nextAllowedAt.toISOString(),
      gate.nextAllowedAt.toISOString(),
    ]);
    const remaining = await ctx.pool.query(
      "SELECT next_allowed_at >= clock_timestamp() + interval '55 seconds' AS safe FROM fleet_access_check_gate",
    );
    expect(remaining.rows[0].safe).toBe(true);
    await ctx.db
      .update(fleetAccessCheckGate)
      .set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` });
    server.use(http.get(membershipUrl, () => HttpResponse.json({}, { status: 404 })));
    expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
      code: "not_in_fleet",
      characters: [],
      checkedAt: null,
    });
  } finally {
    await peer.pool.end();
  }
});
it("does not admit another check when a web host clock jumps past the stored cooldown", async () => {
  const { input } = await fixture();
  await checkFleetAccess(ctx.db, cfg, input);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 3_600_000);
  expect((await checkFleetAccess(ctx.db, cfg, input)).code).toBe("cooldown");
  expect(calls).toEqual(["refresh", "membership", "roster"]);
});

it.each(["refresh", "membership", "roster"])(
  "honors a longer safe retry header on failed %s work",
  async (stage) => {
    const { input } = await fixture();
    const response = () =>
      HttpResponse.json(
        { error: "private provider body" },
        { status: 429, headers: { "retry-after": "180" } },
      );
    server.use(
      stage === "refresh"
        ? http.post(SSO, response)
        : http.get(stage === "membership" ? membershipUrl : rosterUrl, response),
    );
    const result = await checkFleetAccess(ctx.db, cfg, input);
    expect(result).toMatchObject({
      code: "service_unavailable",
      checkedAt: null,
      characters: [],
    });
    const retry = await checkFleetAccess(ctx.db, cfg, input);
    expect(retry).toMatchObject({ code: "cooldown", retryAt: result.retryAt });
    const r = await ctx.pool.query(
      "SELECT extract(epoch FROM next_allowed_at - clock_timestamp())::float AS seconds FROM fleet_access_check_gate",
    );
    expect(r.rows[0].seconds).toBeGreaterThan(175);
    expect(r.rows[0].seconds).toBeLessThan(185);
  },
);

it("cascades only the operational gate on account deletion", async () => {
  const { input } = await fixture();
  await checkFleetAccess(ctx.db, cfg, input);
  await ctx.db
    .update(account)
    .set({ mainCharacterId: null })
    .where(eq(account.id, input.accountId));
  await ctx.db.delete(character).where(eq(character.accountId, input.accountId));
  await ctx.db.delete(account).where(eq(account.id, input.accountId));
  expect(await ctx.db.select().from(fleetAccessCheckGate)).toEqual([]);
});
it.each(["scope", "owner", "link", "tier", "generation", "token-status"])(
  "rejects %s changes while roster is in flight",
  async (change) => {
    const { input, other } = await fixture();
    const entered = deferred(),
      release = deferred();
    server.use(
      http.get(rosterUrl, async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json(roster);
      }),
    );
    const pending = checkFleetAccess(ctx.db, cfg, input);
    await entered.promise;
    try {
      if (change === "tier")
        await ctx.db
          .update(account)
          .set({ tier: "alumni" })
          .where(eq(account.id, input.accountId));
      else
        await ctx.db
          .update(character)
          .set(
            change === "scope"
              ? { scopes: [] }
              : change === "owner"
                ? { ownerHash: "new-owner" }
                : change === "link"
                  ? { accountId: other.id }
                  : change === "token-status"
                    ? { tokenStatus: "invalid" }
                    : {
                        refreshTokenEnc: encryptToken(
                          "reauth-winner",
                          cfg.tokenEncryptionKey,
                        ),
                      },
          )
          .where(eq(character.id, 90000001));
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({
      code: "identity_changed",
      characters: [],
      checkedAt: null,
    });
  },
);
it("intersects current links, not the preflight list", async () => {
  const { input, other } = await fixture();
  server.use(
    http.get(rosterUrl, async () => {
      await ctx.db
        .update(account)
        .set({ mainCharacterId: null })
        .where(eq(account.id, input.accountId));
      await ctx.db
        .update(character)
        .set({ accountId: other.id })
        .where(eq(character.id, 90000002));
      return HttpResponse.json(roster);
    }),
  );
  expect((await checkFleetAccess(ctx.db, cfg, input)).characters).toEqual([matched[0]]);
});
it("keeps a concurrent reauth winner when credential CAS loses", async () => {
  const { input } = await fixture();
  server.use(
    http.post(SSO, async () => {
      await ctx.db
        .update(character)
        .set({ refreshTokenEnc: encryptToken("reauth-winner", cfg.tokenEncryptionKey) })
        .where(eq(character.id, 90000001));
      return HttpResponse.json({ access_token: "lost-at", refresh_token: "lost-rt" });
    }),
  );
  expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
    code: "identity_changed",
    characters: [],
  });
  expect(decryptToken((await getAnchor()).refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
    "reauth-winner",
  );
  expect(calls).toEqual([]);
});

it.each(["refresh", "membership", "roster", "budget-wait"])(
  "aborts %s external work at the budget without starting another request",
  async (stage) => {
    const { input } = await fixture();
    const entered = deferred();
    if (stage === "budget-wait")
      server.use(
        http.get(membershipUrl, () =>
          HttpResponse.json(fleet, {
            headers: {
              "x-esi-error-limit-remain": "0",
              "x-esi-error-limit-reset": "120",
            },
          }),
        ),
      );
    const fetchImpl: typeof fetch = async (url, init) => {
      if (stage === "budget-wait") {
        const response = await fetch(url, init);
        if (String(url) === membershipUrl) entered.resolve();
        return response;
      }
      const target =
        stage === "refresh" ? SSO : stage === "membership" ? membershipUrl : rosterUrl;
      if (String(url) !== target) return fetch(url, init);
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = checkFleetAccess(ctx.db, cfg, input, { fetchImpl });
    await entered.promise;
    await pause(10);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toMatchObject({
      code: "timed_out",
      characters: [],
      checkedAt: null,
    });
    expect(calls).not.toContain("roster");
  },
);

it("times out while reading the SSO response body without confusing it with failed credential persistence", async () => {
  const { input, anchor } = await fixture();
  const entered = deferred();
  const fetchImpl: typeof fetch = async (_url, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"access_token":'));
        init!.signal!.addEventListener(
          "abort",
          () => controller.error(init!.signal!.reason),
          { once: true },
        );
      },
    });
    entered.resolve();
    return new Response(stream, { headers: { "content-type": "application/json" } });
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const pending = checkFleetAccess(ctx.db, cfg, input, { fetchImpl });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(15_001);
  expect(await pending).toMatchObject({
    code: "timed_out",
    characters: [],
    checkedAt: null,
  });
  expect((await getAnchor()).refreshTokenEnc).toBe(anchor.refreshTokenEnc);
});

it.each(["rotation", "invalidation", "CAS loss", "write failure"])(
  "owns real DB-blocked %s settlement past the budget and starts no ESI",
  async (mode) => {
    const { input, anchor } = await fixture();
    if (mode === "invalidation")
      server.use(
        http.post(SSO, () => {
          calls.push("refresh");
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }),
      );
    const lock = await ctx.pool.connect();
    let pending: ReturnType<typeof checkFleetAccess> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query('SELECT 1 FROM "character" WHERE id = 90000001 FOR UPDATE');
      const pid = (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let settled = false;
      pending = checkFleetAccess(ctx.db, cfg, input).then((r) => {
        settled = true;
        return r;
      });
      await untilBlocked(pid);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(settled).toBe(false);
      expect(calls).toEqual(["refresh"]);
      if (mode === "CAS loss")
        await lock.query(
          'UPDATE "character" SET refresh_token_enc = $1 WHERE id = 90000001',
          [encryptToken("reauth-winner", cfg.tokenEncryptionKey)],
        );
      if (mode === "write failure") {
        // Cancel only this observed blocked statement, never the global pool.
        await ctx.pool.query(
          "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
      }
      await lock.query("COMMIT");
      expect(await pending).toMatchObject({
        code:
          mode === "write failure"
            ? "service_unavailable"
            : mode === "CAS loss"
              ? "identity_changed"
              : "timed_out",
        characters: [],
        checkedAt: null,
      });
      const after = await getAnchor();
      if (mode === "rotation" || mode === "CAS loss") {
        expect(decryptToken(after.refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
          mode === "rotation" ? "rotated-rt" : "reauth-winner",
        );
      } else {
        expect(after.refreshTokenEnc).toBe(anchor.refreshTokenEnc);
        expect(after.tokenStatus).toBe(mode === "invalidation" ? "invalid" : "valid");
      }
      expect(calls).toEqual(["refresh"]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      vi.useRealTimers();
      await pending;
    }
  },
);

it.each(["invalidation", "audit"])(
  "reports failed DB-blocked %s settlement as a service failure after the external budget",
  async (stage) => {
    const { input, anchor } = await fixture();
    server.use(
      http.post(SSO, () => {
        calls.push("refresh");
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );
    const lock = await ctx.pool.connect();
    let pending: ReturnType<typeof checkFleetAccess> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query(
        stage === "invalidation"
          ? 'SELECT 1 FROM "character" WHERE id = 90000001 FOR UPDATE'
          : "LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE",
      );
      const pid = (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let settled = false;
      pending = checkFleetAccess(ctx.db, cfg, input).then((result) => {
        settled = true;
        return result;
      });
      await untilBlocked(pid);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(settled).toBe(false);
      expect(calls).toEqual(["refresh"]);
      // Fail the observed credential statement, not an unrelated pool query.
      const cancelled = await ctx.pool.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
        [pid],
      );
      expect(cancelled.rows).toEqual([{ cancelled: true }]);
      await lock.query("COMMIT");
      expect(await pending).toEqual({
        code: "service_unavailable",
        checkedAt: null,
        retryAt: expect.any(String),
        characters: [],
      });
      const after = await getAnchor();
      expect(after.refreshTokenEnc).toBe(anchor.refreshTokenEnc);
      expect(after.tokenStatus).toBe("valid");
      expect(await ctx.db.select().from(auditLog)).toEqual([]);
      expect(calls).toEqual(["refresh"]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      vi.useRealTimers();
      await pending;
    }
  },
);

it("reports credential persistence failure without token material or a claimed save", async () => {
  const { input, anchor } = await fixture();
  // A test-owned database constraint, not a mocked token/DB service or a production flag.
  await ctx.pool.query(
    'ALTER TABLE "character" ADD CONSTRAINT fleet_test_reject_rotation CHECK (id <> 90000001) NOT VALID',
  );
  try {
    expect(await checkFleetAccess(ctx.db, cfg, input)).toMatchObject({
      code: "service_unavailable",
      characters: [],
      checkedAt: null,
    });
    expect((await getAnchor()).refreshTokenEnc).toBe(anchor.refreshTokenEnc);
    expect(calls).toEqual(["refresh"]);
  } finally {
    await ctx.pool.query(
      'ALTER TABLE "character" DROP CONSTRAINT fleet_test_reject_rotation',
    );
  }
});

it.each(["preflight", "gate", "final"])(
  "limits noncredential %s lock waits at the call site",
  async (stage) => {
    const { input } = await fixture();
    const lock = await ctx.pool.connect();
    const entered = deferred(),
      release = deferred();
    let pending: ReturnType<typeof checkFleetAccess> | undefined;
    try {
      await lock.query("BEGIN");
      if (stage === "final") {
        server.use(
          http.get(rosterUrl, async () => {
            entered.resolve();
            await release.promise;
            return HttpResponse.json(roster);
          }),
        );
        pending = checkFleetAccess(ctx.db, cfg, input);
        await entered.promise;
      }
      await lock.query(
        stage === "gate"
          ? "LOCK TABLE fleet_access_check_gate IN ACCESS EXCLUSIVE MODE"
          : 'LOCK TABLE "character" IN ACCESS EXCLUSIVE MODE',
      );
      const started = Date.now();
      pending ??= checkFleetAccess(ctx.db, cfg, input);
      release.resolve();
      expect(await pending).toMatchObject({
        code: "service_unavailable",
        characters: [],
      });
      expect(Date.now() - started).toBeLessThan(4000);
      if (stage !== "final") expect(calls).toEqual([]);
    } finally {
      release.resolve();
      await lock.query("ROLLBACK");
      lock.release();
      await pending;
    }
  },
);
it("bounds a noncredential statement independently of its lock timeout", async () => {
  const { input } = await fixture();
  await ctx.pool.query(
    "CREATE FUNCTION fleet_test_slow_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$",
  );
  await ctx.pool.query(
    "CREATE TRIGGER fleet_test_slow_gate BEFORE INSERT ON fleet_access_check_gate FOR EACH ROW EXECUTE FUNCTION fleet_test_slow_gate()",
  );
  try {
    const started = Date.now();
    expect((await checkFleetAccess(ctx.db, cfg, input)).code).toBe("service_unavailable");
    expect(Date.now() - started).toBeLessThan(8000);
    expect(calls).toEqual([]);
    expect(await ctx.db.select().from(fleetAccessCheckGate)).toEqual([]);
  } finally {
    await ctx.pool.query("DROP TRIGGER fleet_test_slow_gate ON fleet_access_check_gate");
    await ctx.pool.query("DROP FUNCTION fleet_test_slow_gate()");
  }
}, 15_000);

it.each([
  ["retry-after", "180", 175],
  ["cache-control", "private, max-age=240", 235],
  ["retry-after", "broken", 55],
  ["cache-control", "max-age=999999999999999999999999999999999999", 55],
])("persists a safe cooldown from %s: %s", async (header, value, minimum) => {
  const { input } = await fixture();
  server.use(
    http.get(membershipUrl, () =>
      HttpResponse.json(fleet, { headers: { [header]: value } }),
    ),
  );
  const result = await checkFleetAccess(ctx.db, cfg, input);
  expect(result.code).toBe("checked");
  const r = await ctx.pool.query(
    "SELECT extract(epoch FROM next_allowed_at - clock_timestamp())::float AS seconds FROM fleet_access_check_gate",
  );
  expect(r.rows[0].seconds).toBeGreaterThan(Number(minimum));
  expect(r.rows[0].seconds).toBeLessThan(Number(minimum) + 10);
  expect((await checkFleetAccess(ctx.db, cfg, input)).retryAt).toBe(result.retryAt);
});
