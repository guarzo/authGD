import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEsiClient, EsiError } from "@/lib/esi/client";
import { chunk } from "@/core/chunk";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://esi.evetech.net/latest";
const ROOT = "https://esi.evetech.net";

describe("chunk", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("throws when size is not a positive integer", () => {
    expect(() => chunk([1, 2], 0)).toThrow(/positive integer/);
    expect(() => chunk([1, 2], -1)).toThrow(/positive integer/);
    expect(() => chunk([1, 2], 1.5)).toThrow(/positive integer/);
  });
});

describe("postAffiliation", () => {
  it("maps fields and defaults missing alliance to null", async () => {
    server.use(
      http.post(`${BASE}/characters/affiliation/`, async ({ request }) => {
        expect(await request.json()).toEqual([1, 2]);
        return HttpResponse.json([
          { character_id: 1, corporation_id: 100, alliance_id: 99000001 },
          { character_id: 2, corporation_id: 200 },
        ]);
      }),
    );
    const esi = createEsiClient();
    expect(await esi.postAffiliation([1, 2])).toEqual([
      { characterId: 1, corporationId: 100, allianceId: 99000001 },
      { characterId: 2, corporationId: 200, allianceId: null },
    ]);
  });

  it("rejects more than 500 ids", async () => {
    const esi = createEsiClient();
    await expect(
      esi.postAffiliation(Array.from({ length: 501 }, (_, i) => i + 1)),
    ).rejects.toThrow(/500/);
  });

  it("throws a classified EsiError on failure", async () => {
    server.use(
      http.post(`${BASE}/characters/affiliation/`, () =>
        HttpResponse.json({ error: "rate limited" }, { status: 420 }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.postAffiliation([1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(420);
    expect((err as EsiError).kind).toBe("transient");
  });

  it("fails closed on a malformed body", async () => {
    server.use(
      http.post(`${BASE}/characters/affiliation/`, () =>
        HttpResponse.json([{ character_id: "not-a-number" }]),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.postAffiliation([1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });
});

describe("error-limit throttling", () => {
  it("pauses until reset when the error budget is low", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/characters/affiliation/`, () => {
        calls++;
        return HttpResponse.json([], {
          headers: {
            "X-ESI-Error-Limit-Remain": "3",
            "X-ESI-Error-Limit-Reset": "42",
          },
        });
      }),
    );
    const sleeps: number[] = [];
    let nowMs = 1_000_000;
    const esi = createEsiClient({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    await esi.postAffiliation([1]); // response says remain=3 (≤ floor of 5)
    await esi.postAffiliation([2]); // must pause until reset first
    expect(calls).toBe(2);
    expect(sleeps).toEqual([42_000]);
  });
});

describe("contacts", () => {
  it("reads all pages before returning", async () => {
    const pages: Record<string, unknown[]> = {
      "1": [{ contact_id: 11, contact_type: "character", standing: 5, label_ids: [7] }],
      "2": [{ contact_id: 12, contact_type: "character", standing: 0 }],
    };
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        return HttpResponse.json(pages[page], { headers: { "X-Pages": "2" } });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getAllContacts(90000001, "at")).toEqual([
      { contactId: 11, contactType: "character", standing: 5, labelIds: [7] },
      { contactId: 12, contactType: "character", standing: 0, labelIds: [] },
    ]);
  });

  it("fails closed on a missing or malformed X-Pages header", async () => {
    server.use(
      http.get(
        `${BASE}/characters/90000001/contacts/`,
        () => HttpResponse.json([]), // no X-Pages header at all
      ),
    );
    const esi = createEsiClient();
    await expect(esi.getAllContacts(90000001, "at")).rejects.toThrow(/X-Pages/);
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([], { headers: { "X-Pages": "abc" } }),
      ),
    );
    await expect(esi.getAllContacts(90000001, "at")).rejects.toThrow(/X-Pages/);
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([], { headers: { "X-Pages": "0" } }),
      ),
    );
    await expect(esi.getAllContacts(90000001, "at")).rejects.toThrow(/X-Pages/);
  });

  it("rejects the whole read when any page fails", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        if (page === "2") return HttpResponse.json({ error: "boom" }, { status: 500 });
        return HttpResponse.json(
          [{ contact_id: 11, contact_type: "character", standing: 5 }],
          { headers: { "X-Pages": "2" } },
        );
      }),
    );
    const esi = createEsiClient();
    await expect(esi.getAllContacts(90000001, "at")).rejects.toBeInstanceOf(EsiError);
  });

  it("fails closed on malformed contact data", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([{ contact_id: "not-a-number", contact_type: "character" }], {
          headers: { "X-Pages": "1" },
        }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getAllContacts(90000001, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });

  it("sends the bearer token and label/standing params on writes, chunked at 100", async () => {
    const bodies: number[][] = [];
    server.use(
      http.post(`${BASE}/characters/90000001/contacts/`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer at");
        const url = new URL(request.url);
        expect(url.searchParams.get("standing")).toBe("5");
        expect(url.searchParams.getAll("label_ids")).toEqual(["7"]);
        bodies.push((await request.json()) as number[]);
        return HttpResponse.json([], { status: 201 });
      }),
    );
    const esi = createEsiClient();
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    await esi.addContacts(90000001, "at", ids, 5, [7]);
    expect(bodies.map((b) => b.length)).toEqual([100, 50]);
  });

  it("chunks deletes at 20 via query params", async () => {
    const deletes: string[] = [];
    server.use(
      http.delete(`${BASE}/characters/90000001/contacts/`, ({ request }) => {
        deletes.push(new URL(request.url).searchParams.get("contact_ids") ?? "");
        return HttpResponse.json([]);
      }),
    );
    const esi = createEsiClient();
    await esi.deleteContacts(
      90000001,
      "at",
      Array.from({ length: 45 }, (_, i) => i + 1),
    );
    expect(deletes).toHaveLength(3);
    expect(deletes[0].split(",")).toHaveLength(20);
    expect(deletes[2].split(",")).toHaveLength(5);
  });

  it("parses contact labels", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/labels/`, () =>
        HttpResponse.json([{ label_id: 7, label_name: "authgd" }]),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getContactLabels(90000001, "at")).toEqual([
      { labelId: 7, labelName: "authgd" },
    ]);
  });
});

describe("resolveIds", () => {
  it("maps lowercased names to their inventory type id", async () => {
    let requestBody: unknown;
    server.use(
      http.post(`${BASE}/universe/ids/`, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          inventory_types: [
            { id: 34, name: "Tritanium" },
            { id: 35, name: "Pyerite" },
          ],
        });
      }),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["Tritanium", "Pyerite"]);
    // Asserted out here, not inside the resolver: a failed `expect` in there
    // rejects the handler, which MSW surfaces as a transport error on the
    // client call rather than as this test's own assertion failure.
    expect(requestBody).toEqual(["Tritanium", "Pyerite"]);
    expect(map.get("tritanium")).toBe(34);
    expect(map.get("pyerite")).toBe(35);
  });

  it("omits names ESI does not know", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, () =>
        HttpResponse.json({ inventory_types: [{ id: 34, name: "Tritanium" }] }),
      ),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["Tritanium", "Not A Real Item"]);
    expect(map.has("tritanium")).toBe(true);
    expect(map.has("not a real item")).toBe(false);
  });

  it("chunks names at 500 per request", async () => {
    const requestSizes: number[] = [];
    server.use(
      http.post(`${BASE}/universe/ids/`, async ({ request }) => {
        const body = (await request.json()) as string[];
        requestSizes.push(body.length);
        return HttpResponse.json({ inventory_types: [] });
      }),
    );
    const esi = createEsiClient();
    const names = Array.from({ length: 501 }, (_, i) => `Item ${i}`);
    await esi.resolveIds(names);
    expect(requestSizes).toEqual([500, 1]);
  });

  it("returns an empty map when the response has no inventory_types key", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, () => HttpResponse.json({ ships: [] })),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["Tritanium"]);
    expect(map.size).toBe(0);
  });

  it("keys the map case-insensitively", async () => {
    server.use(
      http.post(`${BASE}/universe/ids/`, () =>
        HttpResponse.json({ inventory_types: [{ id: 34, name: "TRITANIUM" }] }),
      ),
    );
    const esi = createEsiClient();
    const map = await esi.resolveIds(["tritanium"]);
    expect(map.get("tritanium")).toBe(34);
  });
});

describe("User-Agent", () => {
  it("sends the configured User-Agent on every request", async () => {
    let ua: string | null = null;
    server.use(
      http.post(`${BASE}/characters/affiliation/`, ({ request }) => {
        ua = request.headers.get("user-agent");
        return HttpResponse.json([]);
      }),
    );
    const esi = createEsiClient({ userAgent: "authgd/0.1.0 (ops@example.com)" });
    await esi.postAffiliation([1]);
    expect(ua).toBe("authgd/0.1.0 (ops@example.com)");
  });
});

describe("openInformationWindow", () => {
  it("POSTs the target id with the operator's bearer token", async () => {
    let seen: { auth: string | null; target: string | null } | null = null;
    server.use(
      http.post(`${BASE}/ui/openwindow/information/`, ({ request }) => {
        seen = {
          auth: request.headers.get("authorization"),
          target: new URL(request.url).searchParams.get("target_id"),
        };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const esi = createEsiClient();
    await esi.openInformationWindow(90000001, "operator-at", 90000002);
    expect(seen).toEqual({ auth: "Bearer operator-at", target: "90000002" });
  });

  it("throws a classified EsiError when the character is not logged in", async () => {
    server.use(
      http.post(`${BASE}/ui/openwindow/information/`, () =>
        HttpResponse.json({ error: "Character not online" }, { status: 403 }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi
      .openInformationWindow(90000001, "at", 90000002)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(403);
  });

  it("suppresses the call entirely in dry-run", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/ui/openwindow/information/`, () => {
        calls++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const esi = createEsiClient({ syncMode: "dry-run" });
    await esi.openInformationWindow(90000001, "at", 90000002);
    expect(calls).toBe(0);
  });
});

describe("location reads", () => {
  it("maps a docked-in-structure reading", async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/characters/90000001/location/`, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({
          solar_system_id: 31000123,
          structure_id: 1035466617946,
        });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getLocation(90000001, "at")).toEqual({
      systemId: 31000123,
      stationId: null,
      structureId: 1035466617946,
    });
    expect(auth).toBe("Bearer at");
  });

  it("maps a docked-in-station reading", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/location/`, () =>
        HttpResponse.json({ solar_system_id: 30000142, station_id: 60003760 }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getLocation(90000001, "at")).toEqual({
      systemId: 30000142,
      stationId: 60003760,
      structureId: null,
    });
  });

  it("maps a character in space to null on both dock ids", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/location/`, () =>
        HttpResponse.json({ solar_system_id: 31000123 }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getLocation(90000001, "at")).toEqual({
      systemId: 31000123,
      stationId: null,
      structureId: null,
    });
  });

  it("still reads in dry-run — dryRun gates writes only", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/characters/90000001/location/`, () => {
        calls++;
        return HttpResponse.json({ solar_system_id: 31000123 });
      }),
    );
    const esi = createEsiClient({ syncMode: "dry-run" });
    expect((await esi.getLocation(90000001, "at")).systemId).toBe(31000123);
    expect(calls).toBe(1);
  });

  it("unwraps the online flag both ways", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/online/`, () =>
        HttpResponse.json({ online: true }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getOnline(90000001, "at")).toBe(true);
    server.use(
      http.get(`${BASE}/characters/90000001/online/`, () =>
        HttpResponse.json({ online: false, last_login: "2026-08-06T12:00:00Z" }),
      ),
    );
    expect(await esi.getOnline(90000001, "at")).toBe(false);
  });

  it("fails closed on a malformed location body", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/location/`, () =>
        HttpResponse.json({ solar_system_id: "Jita" }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getLocation(90000001, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });
});

describe("universe name reads", () => {
  it("reads a system name without a token", async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/universe/systems/31000123/`, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ name: "J123456" });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getSystemName(31000123)).toBe("J123456");
    expect(auth).toBeNull();
  });

  it("reads a station name", async () => {
    server.use(
      http.get(`${BASE}/universe/stations/60003760/`, () =>
        HttpResponse.json({ name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant" }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getStationName(60003760)).toBe(
      "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    );
  });

  it("sends the token on a structure name, and throws 403 when access is denied", async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/universe/structures/1035466617946/`, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ name: "Home Astrahus" });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getStructureName(1035466617946, "at")).toBe("Home Astrahus");
    expect(auth).toBe("Bearer at");

    server.use(
      http.get(`${BASE}/universe/structures/1035466617946/`, () =>
        HttpResponse.json({ error: "Forbidden" }, { status: 403 }),
      ),
    );
    const err = await esi.getStructureName(1035466617946, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(403);
  });
});

describe("access lists", () => {
  it("reads list ids from the versionless base with a compatibility date", async () => {
    let seen: { url: string; auth: string | null; compat: string | null } | null = null;
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists`, ({ request }) => {
        seen = {
          url: request.url,
          auth: request.headers.get("authorization"),
          compat: request.headers.get("x-compatibility-date"),
        };
        return HttpResponse.json({ access_lists: [{ id: 101 }, { id: 202 }] });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getAccessLists(90000001, "at")).toEqual([101, 202]);
    expect(seen).toEqual({
      url: "https://esi.evetech.net/characters/90000001/access-lists",
      auth: "Bearer at",
      compat: "2026-08-04",
    });
  });

  it("flattens nested membership and defaults absent arrays to empty", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({
          id: 101,
          name: "Home ACL",
          description: "the good one",
          membership: {
            allow_everyone: false,
            characters: [{ access: "member", character_id: 90000002 }],
            corporations: [{ access: "viewer", corporation_id: 98000001 }],
          },
        }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getAccessList(90000001, 101, "at")).toEqual({
      id: 101,
      name: "Home ACL",
      description: "the good one",
      allowEveryone: false,
      characters: [{ access: "member", id: 90000002 }],
      corporations: [{ access: "viewer", id: 98000001 }],
      alliances: [],
    });
  });

  it("treats an absent membership object as an empty list, not a read failure", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({ id: 101, name: "Empty ACL", description: null }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getAccessList(90000001, 101, "at")).toEqual({
      id: 101,
      name: "Empty ACL",
      description: "",
      allowEveryone: false,
      characters: [],
      corporations: [],
      alliances: [],
    });
  });

  it("keeps an unrecognized access value verbatim rather than failing", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({
          id: 101,
          name: "Home ACL",
          description: null,
          membership: {
            allow_everyone: true,
            characters: [
              { access: "some-value-ccp-added-last-tuesday", character_id: 90000002 },
            ],
            corporations: [],
            alliances: [],
          },
        }),
      ),
    );
    const esi = createEsiClient();
    const list = await esi.getAccessList(90000001, 101, "at");
    expect(list.characters[0].access).toBe("some-value-ccp-added-last-tuesday");
    expect(list.allowEveryone).toBe(true);
    expect(list.description).toBe("");
  });

  it("fails closed on a malformed list envelope", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({ id: "not-a-number", name: "Home ACL" }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getAccessList(90000001, 101, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });

  it("throws a classified EsiError when the holder cannot see the list", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({ error: "Forbidden" }, { status: 403 }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getAccessList(90000001, 101, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(403);
  });
});

describe("getUniverseNames", () => {
  it("posts unauthenticated and returns id, name and category", async () => {
    let auth: string | null = null;
    let body: unknown;
    server.use(
      http.post(`${BASE}/universe/names/`, async ({ request }) => {
        auth = request.headers.get("authorization");
        body = await request.json();
        return HttpResponse.json([
          { id: 90000002, name: "Some Pilot", category: "character" },
          { id: 98000001, name: "Some Corp", category: "corporation" },
        ]);
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getUniverseNames([90000002, 98000001])).toEqual([
      { id: 90000002, name: "Some Pilot", category: "character" },
      { id: 98000001, name: "Some Corp", category: "corporation" },
    ]);
    expect(body).toEqual([90000002, 98000001]);
    expect(auth).toBeNull();
  });

  it("chunks ids at 1000 per request and concatenates the results", async () => {
    const sizes: number[] = [];
    server.use(
      http.post(`${BASE}/universe/names/`, async ({ request }) => {
        const ids = (await request.json()) as number[];
        sizes.push(ids.length);
        return HttpResponse.json(
          ids.map((id) => ({ id, name: `N${id}`, category: "character" })),
        );
      }),
    );
    const esi = createEsiClient();
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const out = await esi.getUniverseNames(ids);
    expect(sizes).toEqual([1000, 1]);
    expect(out).toHaveLength(1001);
  });

  it("makes no request at all for an empty id list", async () => {
    // No MSW handler registered: onUnhandledRequest "error" turns any call into
    // a failure, so this asserts the early exit rather than trusting a counter.
    const esi = createEsiClient();
    expect(await esi.getUniverseNames([])).toEqual([]);
  });

  it("fails closed on a malformed names body", async () => {
    server.use(
      http.post(`${BASE}/universe/names/`, () =>
        HttpResponse.json([{ id: 1, name: 2, category: "character" }]),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getUniverseNames([1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });
});
