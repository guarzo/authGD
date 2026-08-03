import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
          { id: "10", name: "FlyGD", position: 5, permissions: "0", extra: "ignored" },
        ]);
      }),
    );
    expect(await createDiscordClient(cfg).getGuildRoles()).toEqual([
      { id: "10", name: "FlyGD", position: 5, permissions: "0" },
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

  it("classifies 429 as transient", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({}, { status: 429 }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(true);
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
