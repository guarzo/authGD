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

describe("chunk", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
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
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([]), // no X-Pages header at all
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
    await esi.deleteContacts(90000001, "at", Array.from({ length: 45 }, (_, i) => i + 1));
    expect(deletes).toHaveLength(3);
    expect(deletes[0].split(",")).toHaveLength(20);
    expect(deletes[2].split(",")).toHaveLength(5);
  });

  it("parses contact labels", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/labels/`, () =>
        HttpResponse.json([{ label_id: 7, label_name: "flygd" }]),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getContactLabels(90000001, "at")).toEqual([
      { labelId: 7, labelName: "flygd" },
    ]);
  });
});
