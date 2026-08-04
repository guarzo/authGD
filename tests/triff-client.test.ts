import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTriffClient, TriffError } from "@/lib/triff/client";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://triff.tools/api/market/quote";

describe("createTriffClient", () => {
  it("sends the correct query parameters for a station lookup", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(BASE, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ types: [] });
      }),
    );
    const triff = createTriffClient();
    await triff.quote([34], { stationId: 60003760 });
    expect(capturedUrl?.searchParams.get("type_ids")).toBe("34");
    expect(capturedUrl?.searchParams.get("include_aggregates")).toBe("true");
    expect(capturedUrl?.searchParams.get("include_orders")).toBe("false");
    expect(capturedUrl?.searchParams.get("station_id")).toBe("60003760");
    expect(capturedUrl?.searchParams.has("region_id")).toBe(false);
  });

  it("sends region_id instead of station_id for a region lookup", async () => {
    let capturedUrl: URL | undefined;
    server.use(
      http.get(BASE, ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json({ types: [] });
      }),
    );
    const triff = createTriffClient();
    await triff.quote([34], { regionId: 10000002 });
    expect(capturedUrl?.searchParams.get("region_id")).toBe("10000002");
    expect(capturedUrl?.searchParams.has("station_id")).toBe(false);
  });

  it("chunks type_ids at 900 per request", async () => {
    const requestSizes: number[] = [];
    server.use(
      http.get(BASE, ({ request }) => {
        const ids = new URL(request.url).searchParams.get("type_ids") ?? "";
        requestSizes.push(ids.split(",").length);
        return HttpResponse.json({ types: [] });
      }),
    );
    const triff = createTriffClient();
    const ids = Array.from({ length: 901 }, (_, i) => i + 1);
    await triff.quote(ids, { stationId: 60003760 });
    expect(requestSizes).toEqual([900, 1]);
  });

  it("maps the types array into a Map keyed by type id", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({
          types: [
            {
              type_id: 34,
              sell: { best: 5.1, p05: 5.44 },
              buy: { best: 4.9, p05: 4.61 },
            },
            { type_id: 35, sell: { best: 10, p05: 10.5 }, buy: { best: 9.5, p05: 9.1 } },
          ],
        }),
      ),
    );
    const triff = createTriffClient();
    const quotes = await triff.quote([34, 35], { stationId: 60003760 });
    expect(quotes.get(34)).toEqual({
      typeId: 34,
      sell: { best: 5.1, p05: 5.44 },
      buy: { best: 4.9, p05: 4.61 },
    });
    expect(quotes.get(35)?.typeId).toBe(35);
  });

  it("throws TriffError on a non-2xx response", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json({ error: "boom" }, { status: 500 })),
    );
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
    expect((err as TriffError).status).toBe(500);
  });

  it("throws TriffError on a malformed response body", async () => {
    server.use(http.get(BASE, () => HttpResponse.json({ nope: true })));
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
  });

  it("throws TriffError instead of crashing on an Infinity price", async () => {
    // JSON.parse("1e999") overflows to Infinity, which JSON.stringify (and so
    // HttpResponse.json) can't produce -- a raw body is needed to reproduce
    // what a malicious or buggy upstream could actually send. Without
    // .finite() this parses successfully and later blows up as an uncaught
    // RangeError at BigInt(Math.round(Infinity)) in appraisal.ts.
    server.use(
      http.get(
        BASE,
        () =>
          new HttpResponse(
            '{"types":[{"type_id":34,"sell":{"best":1e999,"p05":null},"buy":{}}]}',
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
  });

  it("throws TriffError instead of corrupting totals on a negative price", async () => {
    // Without .nonnegative() a negative price reaches iskToCents and would
    // otherwise produce a negative totalValue, dying on the raw
    // loot_item_price_ck constraint instead of this legible error.
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({
          types: [{ type_id: 34, sell: { best: -1, p05: null }, buy: {} }],
        }),
      ),
    );
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
  });

  it("throws TriffError instead of a bare Error on a nonsensical price of 1e21", async () => {
    // 1e21 is finite and non-negative, so it passes .finite().nonnegative()
    // alone; only .max(1e15) catches it. Without that bound this price would
    // pass the schema, survive BigInt(Math.round(...)), and then
    // price.toFixed(2) returns "1e+21" -- a string iskToCents rejects with a
    // plain Error that is neither TriffError nor EsiError and so escapes the
    // catch in actions.ts to the generic error boundary.
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({
          types: [{ type_id: 34, sell: { best: 1e21, p05: null }, buy: {} }],
        }),
      ),
    );
    const triff = createTriffClient();
    const err = await triff.quote([34], { stationId: 60003760 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TriffError);
  });

  it("throws TriffError when neither stationId nor regionId is given", async () => {
    const triff = createTriffClient();
    await expect(triff.quote([34], {})).rejects.toBeInstanceOf(TriffError);
  });

  it("throws TriffError when both stationId and regionId are given", async () => {
    const triff = createTriffClient();
    await expect(
      triff.quote([34], { stationId: 60003760, regionId: 10000002 }),
    ).rejects.toBeInstanceOf(TriffError);
  });

  it("leaves a type id out of the map when triff has no quote for it", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json({
          types: [{ type_id: 34, sell: { best: 5, p05: 5 }, buy: { best: 4, p05: 4 } }],
        }),
      ),
    );
    const triff = createTriffClient();
    const quotes = await triff.quote([34, 99], { stationId: 60003760 });
    expect(quotes.has(34)).toBe(true);
    expect(quotes.has(99)).toBe(false);
  });
});
