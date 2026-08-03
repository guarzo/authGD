import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createWandererClient, WandererError } from "@/lib/wanderer/client";
import { testConfig } from "./helpers/config";

const cfg = testConfig(); // base https://wanderer.example, aclId acl-1
const ACL = "https://wanderer.example/api/acls/acl-1";
const MEMBERS = `${ACL}/members`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const aclResponse = (members: unknown[]) =>
  HttpResponse.json({
    data: { id: "uuid", name: "My ACL", members },
  });

describe("createWandererClient", () => {
  it("reads the ACL with bearer auth; corp/alliance members become characterId null", async () => {
    server.use(
      http.get(ACL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer wkey");
        return aclResponse([
          { id: "m1", name: "Pilot A", eve_character_id: "90000001", role: "admin" },
          { id: "m2", name: "Pilot B", eve_character_id: "90000002", role: "viewer" },
          { id: "m3", name: "Some Corp", eve_corporation_id: "98000001", role: "viewer" },
          { id: "m4", name: "Some Alliance", eve_alliance_id: "99000009", role: "blocked" },
        ]);
      }),
    );
    const w = createWandererClient(cfg);
    expect(await w.getAclMembers()).toEqual([
      { characterId: 90000001, role: "admin" },
      { characterId: 90000002, role: "viewer" },
      { characterId: null, role: "viewer" },
      { characterId: null, role: "blocked" },
    ]);
  });

  it("fails closed on malformed member payloads", async () => {
    server.use(
      http.get(ACL, () =>
        aclResponse([{ eve_character_id: "not-digits", role: "viewer" }]),
      ),
    );
    await expect(createWandererClient(cfg).getAclMembers()).rejects.toThrow();
  });

  it("fails closed on an unknown role spelling (admin protection depends on it)", async () => {
    server.use(
      http.get(ACL, () =>
        aclResponse([{ eve_character_id: "90000001", role: "administrator" }]),
      ),
    );
    await expect(createWandererClient(cfg).getAclMembers()).rejects.toThrow();
  });

  it("fails closed on an id that overflows safe integer range", async () => {
    server.use(
      http.get(ACL, () =>
        aclResponse([{ eve_character_id: "12345678901234567890", role: "viewer" }]),
      ),
    );
    // assert the safe-integer validation itself fired, on the character-id path
    const err = await createWandererClient(cfg).getAclMembers().catch((e: unknown) => e);
    expect(String(err)).toMatch(/positive safe integer/);
    expect(String(err)).toMatch(/eve_character_id/);
  });

  it("fails closed on zero or multiple external ids", async () => {
    server.use(http.get(ACL, () => aclResponse([{ role: "viewer" }])));
    await expect(createWandererClient(cfg).getAclMembers()).rejects.toThrow();
    server.use(
      http.get(ACL, () =>
        aclResponse([
          { eve_character_id: "1", eve_corporation_id: "2", role: "viewer" },
        ]),
      ),
    );
    await expect(createWandererClient(cfg).getAclMembers()).rejects.toThrow();
  });

  it("updates a member's role via PUT keyed by EVE id", async () => {
    let putId = "";
    let putBody: unknown;
    server.use(
      http.put(`${MEMBERS}/:id`, async ({ params, request }) => {
        putId = params.id as string;
        putBody = await request.json();
        return HttpResponse.json({
          data: { id: "uuid", name: "Pilot", role: "viewer", eve_character_id: putId },
        });
      }),
    );
    await createWandererClient(cfg).updateAclMemberRole(90000006, "viewer");
    expect(putId).toBe("90000006");
    expect(putBody).toEqual({ member: { role: "viewer" } });
  });

  it("classifies 5xx as transient and 403 as permanent", async () => {
    server.use(http.get(ACL, () => HttpResponse.json({}, { status: 502 })));
    let err = await createWandererClient(cfg).getAclMembers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WandererError);
    expect((err as WandererError).transient).toBe(true);

    server.use(http.get(ACL, () => HttpResponse.json({}, { status: 403 })));
    err = await createWandererClient(cfg).getAclMembers().catch((e: unknown) => e);
    expect((err as WandererError).transient).toBe(false);
  });

  it("adds members as member without a name, and deletes by EVE id", async () => {
    const posts: unknown[] = [];
    let deleted = "";
    server.use(
      http.post(MEMBERS, async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({
          data: { id: "uuid", name: "Resolved Server-Side", role: "member", eve_character_id: "90000003" },
        });
      }),
      http.delete(`${MEMBERS}/:id`, ({ params }) => {
        deleted = params.id as string;
        return HttpResponse.json({ ok: true });
      }),
    );
    const w = createWandererClient(cfg);
    await w.addAclMember(90000003);
    await w.removeAclMember(90000004);
    expect(posts).toEqual([{ member: { eve_character_id: "90000003", role: "member" } }]);
    expect(deleted).toBe("90000004");
  });

  it("treats a 404 on delete as idempotent success", async () => {
    server.use(
      http.delete(`${MEMBERS}/:id`, () =>
        HttpResponse.json(
          { error: "Membership not found for given ACL and external id" },
          { status: 404 },
        ),
      ),
    );
    await expect(createWandererClient(cfg).removeAclMember(90000005)).resolves.toBeUndefined();
  });
});
