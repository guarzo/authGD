import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiscordClient, DiscordApiError } from "@/lib/discord/rest";
import { testConfig } from "./helpers/config";

const cfg = testConfig(); // guild 9000, bot token "bot-token"
const API = "https://discord.com/api/v10";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createDiscordClient", () => {
  it("sends bot auth and parses guild roles", async () => {
    server.use(
      http.get(`${API}/guilds/9000/roles`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bot bot-token");
        return HttpResponse.json([
          { id: "10", name: "Member", position: 5, permissions: "0", extra: "ignored" },
        ]);
      }),
    );
    expect(await createDiscordClient(cfg).getGuildRoles()).toEqual([
      { id: "10", name: "Member", position: 5, permissions: "0" },
    ]);
  });

  it("throws a permanent DiscordApiError on a malformed roles body", async () => {
    server.use(
      http.get(`${API}/guilds/9000/roles`, () =>
        HttpResponse.json([{ id: "10", position: "not-a-number" }]),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildRoles()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });

  it("classifies a non-JSON body as a permanent DiscordApiError too", async () => {
    server.use(
      http.get(
        `${API}/guilds/9000/roles`,
        () =>
          new HttpResponse("<html>gateway</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildRoles()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });

  it("returns null for a 404 guild member (user not in guild)", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ message: "Unknown Member", code: 10007 }, { status: 404 }),
      ),
    );
    expect(await createDiscordClient(cfg).getGuildMember("u1")).toBeNull();
  });

  it("treats 404 Unknown Guild (10004) as a permanent error, not 'left the guild'", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ message: "Unknown Guild", code: 10004 }, { status: 404 }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });

  it("treats a malformed 404 body as a permanent error", async () => {
    server.use(
      http.get(
        `${API}/guilds/9000/members/u1`,
        () => new HttpResponse("<html>gateway</html>", { status: 404 }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });

  it("does not read a non-numeric 404 code as 'left the guild'", async () => {
    // The 10007 branch is the ONE path that turns a 404 into a recoverable
    // null instead of a throw, so what reaches that comparison is validated,
    // not cast. A string "10007" is a malformed envelope: it must throw,
    // rather than silently deroling a member who is still in the guild.
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ message: "Unknown Member", code: "10007" }, { status: 404 }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
    expect((err as DiscordApiError).message).toContain("malformed body");
  });

  it("carries the member's names through, and survives a payload without them", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({
          roles: ["10"],
          nick: "Wardec Wally",
          user: { username: "guarzo", global_name: "Guarzo" },
        }),
      ),
    );
    expect(await createDiscordClient(cfg).getGuildMember("u1")).toMatchObject({
      roles: ["10"],
      nick: "Wardec Wally",
      user: { username: "guarzo", global_name: "Guarzo" },
    });

    // A member who set no nickname: `nick` is absent, not null-valued.
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ roles: ["10"], user: { username: "guarzo" } }),
      ),
    );
    const bare = await createDiscordClient(cfg).getGuildMember("u1");
    expect(bare?.roles).toEqual(["10"]);
    expect(bare?.nick ?? null).toBeNull();
  });

  // The names are decoration; the roles are the job. `parseBody` classifies a
  // schema failure as PERMANENT, so a strict name field would turn a shape
  // change in Discord's member payload into every member's role sync failing
  // to protect a caption. Asserted here because the laxness is deliberate and
  // reads like an oversight.
  it("a malformed name field degrades to no name rather than failing the roles read", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({
          roles: ["10", "11"],
          nick: { localized: "nope" },
          user: "not-an-object",
        }),
      ),
    );
    const member = await createDiscordClient(cfg).getGuildMember("u1");
    expect(member?.roles).toEqual(["10", "11"]);
    expect(member?.nick ?? null).toBeNull();
    expect(member?.user ?? null).toBeNull();
  });

  // ...but only the names are lax. A body that cannot yield roles is still a
  // permanent failure, which is what stops the rule above from being a hole.
  it("still fails permanently when the roles themselves are malformed", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ nick: "Wardec Wally" }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });

  // No `retry-after` header here, so every attempt falls back to the client's
  // 1s default — three retries under `MAX_429_RETRIES` add up to real seconds
  // of sleeping. Fake timers keep this test instant instead of slow.
  it("classifies 429 as transient, after exhausting its bounded retries", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      server.use(
        http.get(`${API}/guilds/9000/members/u1`, () => {
          calls++;
          return HttpResponse.json({}, { status: 429 });
        }),
      );
      const pending = createDiscordClient(cfg)
        .getGuildMember("u1")
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const err = await pending;
      expect(err).toBeInstanceOf(DiscordApiError);
      expect((err as DiscordApiError).transient).toBe(true);
      // Pins the bound explicitly: one initial attempt plus MAX_429_RETRIES.
      // Without this, an unbounded retry loop is only caught incidentally, by
      // `await pending` never resolving inside vitest's wall-clock timeout.
      expect(calls).toBe(4);
      // Same message shape production log lines and this suite depend on —
      // the retry/backoff logic must not change what a caller sees on
      // permanent (retry-exhausted) failure.
      expect((err as DiscordApiError).message).toBe(
        "discord GET /guilds/9000/members/u1 failed (429)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors retry-after on a single 429 and succeeds on the retried request", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      server.use(
        http.get(`${API}/guilds/9000/members/u1`, () => {
          calls++;
          if (calls === 1) {
            return new HttpResponse(JSON.stringify({ message: "rate limited" }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "0.5" },
            });
          }
          return HttpResponse.json({ roles: ["10"] });
        }),
      );
      const pending = createDiscordClient(cfg).getGuildMember("u1");
      // Advance exactly the header's 0.5s and no further. Advancing a full
      // second here (as this test originally did) would also pass for a
      // client that ignored `retry-after` entirely and always slept its 1s
      // fallback — the two are only distinguishable in between.
      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      const member = await pending;
      expect(member?.roles).toEqual(["10"]);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off ALL routes on a global-scoped 429, not just the one that received it", async () => {
    vi.useFakeTimers();
    try {
      let memberCalls = 0;
      let rolesCalls = 0;
      const state: { rolesCallTime: number | null } = { rolesCallTime: null };
      server.use(
        http.get(`${API}/guilds/9000/members/u1`, () => {
          memberCalls++;
          if (memberCalls === 1) {
            return new HttpResponse(JSON.stringify({ message: "rate limited" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "0.5",
                "x-ratelimit-scope": "global",
              },
            });
          }
          return HttpResponse.json({ roles: [] });
        }),
        http.get(`${API}/guilds/9000/roles`, () => {
          rolesCalls++;
          state.rolesCallTime = Date.now();
          return HttpResponse.json([
            { id: "10", name: "Member", position: 5, permissions: "0" },
          ]);
        }),
      );
      const client = createDiscordClient(cfg);
      const memberPromise = client.getGuildMember("u1");
      // Let the member call's first request actually land BEFORE the roles
      // call is even issued below. This is the fix for the mutation gap:
      // firing both concurrently at t=0 let both clear `waitForCapacity`
      // (different bucket keys) before either 429 was received, so the old
      // version of this test passed even with global backoff disabled.
      // `advanceTimersByTimeAsync` flushes the pending microtasks from the
      // mocked fetch even though nothing here is timer-based yet, so this
      // resolves the member call's first attempt (setting `globalResetAt`
      // synchronously) without letting its subsequent `sleep(500)` elapse.
      await vi.advanceTimersByTimeAsync(0);
      expect(memberCalls).toBe(1);
      const expectedResetAt = Date.now() + 500;
      const rolesPromise = client.getGuildRoles();
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([memberPromise, rolesPromise]);
      expect(memberCalls).toBe(2);
      // Sanity check only, NOT proof of waiting: the roles handler never
      // returns 429, so this is 1 whether or not `globalResetAt` gated it.
      // The timing assertion below is what carries the proof.
      expect(rolesCalls).toBe(1);
      // The load-bearing assertion: not just "eventually called", but never
      // dispatched before the global window elapsed. Disabling the
      // `globalResetAt = ...` assignment makes `getGuildRoles` dispatch
      // immediately (at the time just after `advanceTimersByTimeAsync(0)`
      // above), which is well before `expectedResetAt` and fails this.
      expect(state.rolesCallTime).not.toBeNull();
      expect(state.rolesCallTime as number).toBeGreaterThanOrEqual(expectedResetAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an empty retry-after as the 1s default, not a 0s immediate retry", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      server.use(
        http.get(`${API}/guilds/9000/members/u1`, () => {
          calls++;
          if (calls === 1) {
            return new HttpResponse(JSON.stringify({ message: "rate limited" }), {
              status: 429,
              // `Number("")` is 0, not NaN — a `>= 0` guard would accept it and
              // sleep 0ms, re-hammering the route Discord just throttled.
              headers: { "content-type": "application/json", "retry-after": "" },
            });
          }
          return HttpResponse.json({ roles: [] });
        }),
      );
      const pending = createDiscordClient(cfg).getGuildMember("u1");
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a global window from the retry-EXHAUSTING 429, not only from retried ones", async () => {
    vi.useFakeTimers();
    try {
      const state: { rolesCallTime: number | null } = { rolesCallTime: null };
      server.use(
        http.get(
          `${API}/guilds/9000/members/u1`,
          () =>
            new HttpResponse(JSON.stringify({ message: "rate limited" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "0.5",
                "x-ratelimit-scope": "global",
              },
            }),
        ),
        http.get(`${API}/guilds/9000/roles`, () => {
          state.rolesCallTime = Date.now();
          return HttpResponse.json([]);
        }),
      );
      const client = createDiscordClient(cfg);
      const memberPromise = client.getGuildMember("u1").catch((e: unknown) => e);
      // Burn all three retries (3 × 500ms) so the FOURTH 429 — the one that
      // exhausts the bound and surfaces the error — is the most recent one.
      await vi.advanceTimersByTimeAsync(1500);
      expect(await memberPromise).toBeInstanceOf(DiscordApiError);
      const expectedResetAt = Date.now() + 500;
      const rolesPromise = client.getGuildRoles();
      await vi.advanceTimersByTimeAsync(1000);
      await rolesPromise;
      // Handling `scope` only inside the `attempt < MAX_429_RETRIES` branch
      // leaves the final 429 setting no global window at all, and this
      // dispatches immediately — which is the case an operator investigating a
      // surfaced `failed (429)` is actually living through.
      expect(state.rolesCallTime).not.toBeNull();
      expect(state.rolesCallTime as number).toBeGreaterThanOrEqual(expectedResetAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives the 429 wait from retry-after alone, not retry-after plus x-ratelimit-reset-after", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      server.use(
        http.get(`${API}/guilds/9000/members/u1`, () => {
          calls++;
          if (calls === 1) {
            return new HttpResponse(JSON.stringify({ message: "rate limited" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "0.5",
                // Deliberately larger than, and inconsistent with,
                // retry-after — pins that the 429 path does not ALSO honor
                // this header and wait its difference on top of retry-after.
                "x-ratelimit-reset-after": "5",
                "x-ratelimit-remaining": "0",
              },
            });
          }
          return HttpResponse.json({ roles: [] });
        }),
      );
      const pending = createDiscordClient(cfg).getGuildMember("u1");
      // Advance by just over the retry-after amount. If the larger
      // reset-after header were also honored (the two-source bug), the
      // request would still be asleep here and `calls` would still be 1.
      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toBe(2);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("paces a burst of member fetches so it never exceeds the bucket's remaining count", async () => {
    vi.useFakeTimers();
    try {
      const BUCKET_MAX = 5;
      let remaining = BUCKET_MAX;
      let windowResetAt = 0;
      let exceeded = false;
      server.use(
        http.get(`${API}/guilds/9000/members/:id`, () => {
          if (Date.now() >= windowResetAt) {
            remaining = BUCKET_MAX;
            windowResetAt = Date.now() + 1000;
          }
          if (remaining <= 0) {
            exceeded = true;
            return new HttpResponse(JSON.stringify({ message: "rate limited" }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": String(Math.max(0, windowResetAt - Date.now()) / 1000),
              },
            });
          }
          remaining--;
          return HttpResponse.json(
            { roles: [] },
            {
              headers: {
                "x-ratelimit-remaining": String(remaining),
                "x-ratelimit-reset-after": String(
                  Math.max(0, windowResetAt - Date.now()) / 1000,
                ),
              },
            },
          );
        }),
      );
      const client = createDiscordClient(cfg);
      const ids = Array.from({ length: 7 }, (_, i) => `u${i}`);
      const pending = Promise.all(ids.map((id) => client.getGuildMember(id)));
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      expect(exceeded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches the preamble (roles, bot id, bot member) instead of re-fetching every run", async () => {
    let rolesCalls = 0;
    let meCalls = 0;
    let memberCalls = 0;
    server.use(
      http.get(`${API}/guilds/9000/roles`, () => {
        rolesCalls++;
        return HttpResponse.json([
          { id: "10", name: "Member", position: 5, permissions: "0" },
        ]);
      }),
      http.get(`${API}/users/@me`, () => {
        meCalls++;
        return HttpResponse.json({ id: "bot-user" });
      }),
      http.get(`${API}/guilds/9000/members/bot-user`, () => {
        memberCalls++;
        return HttpResponse.json({ roles: ["10"] });
      }),
    );
    const client = createDiscordClient(cfg);
    for (let i = 0; i < 3; i++) {
      await client.getGuildRoles();
      const botId = await client.getBotUserId();
      await client.getGuildMember(botId);
    }
    expect(rolesCalls).toBe(1);
    expect(meCalls).toBe(1);
    expect(memberCalls).toBe(1);
  });

  it("does not cache a REAL member's lookup under the bot-member cache", async () => {
    let meCalls = 0;
    let memberCalls = 0;
    server.use(
      http.get(`${API}/users/@me`, () => {
        meCalls++;
        return HttpResponse.json({ id: "bot-user" });
      }),
      http.get(`${API}/guilds/9000/members/real-user`, () => {
        memberCalls++;
        return HttpResponse.json({ roles: [String(memberCalls)] });
      }),
    );
    const client = createDiscordClient(cfg);
    await client.getBotUserId();
    const first = await client.getGuildMember("real-user");
    const second = await client.getGuildMember("real-user");
    expect(meCalls).toBe(1);
    expect(memberCalls).toBe(2);
    expect(first?.roles).toEqual(["1"]);
    expect(second?.roles).toEqual(["2"]);
  });

  it("adds and removes member roles via PUT/DELETE", async () => {
    const calls: string[] = [];
    server.use(
      http.put(`${API}/guilds/9000/members/u1/roles/10`, () => {
        calls.push("put");
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${API}/guilds/9000/members/u1/roles/11`, () => {
        calls.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const d = createDiscordClient(cfg);
    await d.addMemberRole("u1", "10");
    await d.removeMemberRole("u1", "11");
    expect(calls).toEqual(["put", "delete"]);
  });

  it("resolves the bot user id", async () => {
    server.use(http.get(`${API}/users/@me`, () => HttpResponse.json({ id: "bot-user" })));
    expect(await createDiscordClient(cfg).getBotUserId()).toBe("bot-user");
  });
});
