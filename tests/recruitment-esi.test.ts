import { describe, expect, it } from "vitest";
import { createRecruitmentCollector } from "@/lib/esi/recruitment";
import { RECRUITMENT_SCOPES } from "@/core/recruitment-evidence";

const date = "2026-09-01T00:00:00Z";
const journal = (id = "9007199254740993") =>
  `{"id":${id},"date":"${date}","ref_type":"player_donation","description":"Player text","amount":9007199254740993.01,"balance":-0.0100}`;
const transaction = (id = "9007199254740995") =>
  `{"transaction_id":${id},"date":"${date}","location_id":60000001,"type_id":34,"unit_price":1.2300,"quantity":2,"client_id":90000002,"is_buy":true,"is_personal":true,"journal_ref_id":9007199254740993}`;
const contract = {
  contract_id: 42,
  issuer_id: 90000001,
  issuer_corporation_id: 1000001,
  assignee_id: 0,
  acceptor_id: 0,
  type: "auction",
  status: "outstanding",
  for_corporation: false,
  availability: "public",
  date_issued: date,
  date_expired: date,
};
const asset = {
  item_id: 1000000000001,
  type_id: 34,
  quantity: 2,
  location_id: 60000001,
  location_type: "station",
  location_flag: "Hangar",
  is_singleton: false,
};
const skills = {
  skills: [
    {
      skill_id: 3300,
      active_skill_level: 3,
      trained_skill_level: 3,
      skillpoints_in_skill: 8000,
    },
  ],
  total_sp: 8000,
  unallocated_sp: 100,
};
const subject = {
  characterId: 90000001,
  name: "Current Name",
  accessToken: "secret-token",
  scopes: [...RECRUITMENT_SCOPES],
};
const response = (body: string, headers: Record<string, string> = {}, status = 200) =>
  new Response(body, { status, headers: { "x-pages": "1", ...headers } });
function liveResponses(url: URL): Response {
  if (url.pathname.endsWith("/corporationhistory"))
    return response(
      JSON.stringify([{ record_id: 1, corporation_id: 1000001, start_date: date }]),
    );
  if (url.pathname.endsWith("/journal")) return response(`[${journal()}]`);
  if (url.pathname.endsWith("/transactions"))
    return response(url.searchParams.has("from_id") ? "[]" : `[${transaction()}]`);
  if (url.pathname.endsWith("/contracts")) return response(JSON.stringify([contract]));
  if (url.pathname.endsWith("/items"))
    return response(
      '[{"record_id":77,"type_id":34,"quantity":2,"is_singleton":false,"is_included":true,"raw_quantity":-1}]',
    );
  if (url.pathname.endsWith("/bids"))
    return response(
      `[{"bid_id":8,"bidder_id":90000002,"date_bid":"${date}","amount":9007199254740993.01}]`,
    );
  if (url.pathname.endsWith("/assets")) return response(JSON.stringify([asset]));
  if (url.pathname.endsWith("/skills")) return response(JSON.stringify(skills));
  if (url.pathname.endsWith("/skillqueue"))
    return response('[{"queue_position":0,"skill_id":3300,"finished_level":4}]');
  throw new Error("Unexpected endpoint");
}
function collector(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response> = liveResponses,
  limits = {},
) {
  const calls: URL[] = [];
  const client = createRecruitmentCollector({
    limits,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      expect(url.origin).toBe("https://esi.evetech.net");
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).get("x-compatibility-date")).toBe("2020-01-01");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        url.pathname.endsWith("/corporationhistory") ? null : "Bearer secret-token",
      );
      return handler(url, init ?? {});
    },
  });
  return { client, calls };
}

describe("real ESI recruitment collection", () => {
  it("collects all six categories with endpoint provenance and unrounded source payloads", async () => {
    const { client, calls } = collector();
    const out = await client.collectCharacter(subject);
    expect(out.datasets.map((d) => [d.category, d.status])).toEqual([
      ["corporation-history", "complete"],
      ["wallet", "complete"],
      ["contracts", "complete"],
      ["assets", "complete"],
      ["skills", "complete"],
      ["skill-queue", "complete"],
    ]);
    expect(out.records).toHaveLength(9);
    const j = out.records.find((r) => r.data.ref_type === "player_donation")!;
    expect(j.data.amount).toBe("9007199254740993.01");
    expect(j.data.balance).toBe("-0.0100");
    expect(j.sourceRecordId).toBe("9007199254740993");
    expect(out.provenance.find((p) => p.id === j.provenanceId)).toMatchObject({
      sourceKind: "authenticated-esi",
      method: "GET /characters/90000001/wallet/journal",
    });
    expect(
      out.provenance.find((p) => p.id === out.records[0].provenanceId)?.sourceKind,
    ).toBe("public-esi");
    expect(out.records.find((r) => r.category === "skills")?.data).toEqual({
      skills: [
        {
          skill_id: "3300",
          active_skill_level: "3",
          trained_skill_level: "3",
          skillpoints_in_skill: "8000",
        },
      ],
      total_sp: "8000",
      unallocated_sp: "100",
    });
    expect(out.records.find((r) => r.data.bid_id)?.data.amount).toBe(
      "9007199254740993.01",
    );
    expect(out.records.find((r) => r.data.record_id === "77")?.data.raw_quantity).toBe(
      "-1",
    );
    expect(
      calls.find((u) => u.searchParams.has("from_id"))?.searchParams.get("from_id"),
    ).toBe("9007199254740995");
    expect(out.datasets.find((d) => d.category === "wallet")?.history).toEqual({
      knownLimit: expect.stringContaining("30 days"),
      earliestReturnedAt: date,
    });
    expect(out.datasets[0].note).toContain("Current Name");
    expect(out.datasets[0].note).toContain("linked");
    expect(JSON.stringify(out)).not.toContain("secret-token");
  });

  it("reads all X-Pages and retains journal evidence when a later page fails", async () => {
    const { client, calls } = collector((url) => {
      if (url.pathname.endsWith("/journal"))
        return url.searchParams.get("page") === "1"
          ? response(`[${journal()}]`, { "x-pages": "2" })
          : response('{"error":"SECRET upstream body"}', {}, 503);
      return liveResponses(url);
    });
    const out = await client.collectCharacter(subject);
    expect(
      calls.filter((u) => u.pathname.endsWith("/journal")).map((u) => u.search),
    ).toEqual(["?page=1", "?page=2"]);
    expect(out.datasets.find((d) => d.category === "wallet")).toMatchObject({
      status: "partial",
      note: expect.stringContaining("wallet/journal: partial"),
    });
    expect(out.records.some((r) => r.data.id === "9007199254740993")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it.each([null, "0", "1.5", "bad"])(
    "never claims complete on invalid X-Pages %s",
    async (header) => {
      const { client } = collector((url) => {
        if (!url.pathname.endsWith("/assets")) return liveResponses(url);
        return new Response(JSON.stringify([asset]), {
          headers: header === null ? {} : { "x-pages": header },
        });
      });
      const out = await client.collectCharacter(subject);
      expect(out.datasets.find((d) => d.category === "assets")?.status).toBe("partial");
      expect(out.records.filter((r) => r.category === "assets")).toHaveLength(1);
    },
  );

  it("rejects changed pagination and repeated records instead of duplicating evidence", async () => {
    const { client } = collector((url) =>
      url.pathname.endsWith("/assets")
        ? response(JSON.stringify([asset]), {
            "x-pages": url.searchParams.get("page") === "1" ? "2" : "3",
          })
        : liveResponses(url),
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "assets")?.status).toBe("partial");
    expect(out.records.filter((r) => r.category === "assets")).toHaveLength(1);
  });

  it("detects non-progressing transaction cursors and preserves the first page only", async () => {
    const { client, calls } = collector((url) =>
      url.pathname.endsWith("/transactions")
        ? response(`[${transaction()}]`)
        : liveResponses(url),
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "wallet")?.status).toBe("partial");
    expect(out.records.filter((r) => r.data.transaction_id)).toHaveLength(1);
    expect(calls.filter((u) => u.pathname.endsWith("/transactions"))).toHaveLength(2);
  });

  it("keeps contract lists but marks missing items/bids as partial", async () => {
    const { client } = collector((url) =>
      url.pathname.endsWith("/items") || url.pathname.endsWith("/bids")
        ? response("{}", {}, 403)
        : liveResponses(url),
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "contracts")).toMatchObject({
      status: "partial",
      note: expect.stringContaining("contracts/42/items: unauthorised"),
    });
    expect(out.records.filter((r) => r.category === "contracts")).toHaveLength(1);
  });

  it("distinguishes empty, denied and malformed endpoint responses", async () => {
    const { client } = collector((url) => {
      if (url.pathname.endsWith("/assets")) return response("[]");
      if (url.pathname.endsWith("/skills")) return response("{}", {}, 403);
      if (url.pathname.endsWith("/skillqueue")) return response('[{"skill_id":3300}]');
      return liveResponses(url);
    });
    const out = await client.collectCharacter(subject);
    expect(
      out.datasets
        .filter((d) => ["assets", "skills", "skill-queue"].includes(d.category))
        .map((d) => d.status),
    ).toEqual(["empty", "unauthorised", "failed"]);
  });

  it("rejects nested credential fields rather than exporting or logging them", async () => {
    const { client } = collector((url) =>
      url.pathname.endsWith("/assets")
        ? response(JSON.stringify([{ ...asset, nested: { AUTHORIZATION: "secret" } }]))
        : liveResponses(url),
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "assets")?.status).toBe("failed");
    expect(out.records.filter((r) => r.category === "assets")).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("AUTHORIZATION");
  });

  it("collects every list page and chooses the oldest exact transaction ID as the cursor", async () => {
    const { client, calls } = collector((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (url.pathname.endsWith("/journal"))
        return response(`[${journal(String(100 + page))}]`, { "x-pages": "3" });
      if (url.pathname.endsWith("/assets"))
        return response(JSON.stringify([{ ...asset, item_id: 1000000000000 + page }]), {
          "x-pages": "2",
        });
      if (url.pathname.endsWith("/contracts"))
        return response(
          JSON.stringify([
            { ...contract, contract_id: 40 + page, type: "item_exchange" },
          ]),
          { "x-pages": "2" },
        );
      if (url.pathname.endsWith("/transactions"))
        return response(
          url.searchParams.has("from_id")
            ? "[]"
            : `[${transaction("9007199254740994")},${transaction("9007199254740995")}]`,
        );
      return liveResponses(url);
    });
    const out = await client.collectCharacter(subject);
    expect(out.datasets.map((d) => d.status)).toEqual(Array(6).fill("complete"));
    expect(
      out.records.filter((r) => r.data.ref_type).map((r) => r.sourceRecordId),
    ).toEqual(["101", "102", "103"]);
    expect(out.records.filter((r) => r.category === "assets")).toHaveLength(2);
    expect(
      out.records.filter((r) => r.data.contract_id).map((r) => r.sourceRecordId),
    ).toEqual(["41", "42"]);
    expect(calls.some((url) => url.pathname.endsWith("/bids"))).toBe(false);
    expect(
      calls.find((url) => url.searchParams.has("from_id"))?.searchParams.get("from_id"),
    ).toBe("9007199254740994");
  });

  it("does not require optional journal amounts, and retains new payload fields", async () => {
    const { client } = collector((url) =>
      url.pathname.endsWith("/journal")
        ? response(
            `[{"id":1,"date":"${date}","ref_type":"new_esi_ref_type","description":"raw","future_field":{"amount":1.234567890123456789e+20}}]`,
          )
        : liveResponses(url),
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "wallet")?.status).toBe("complete");
    const record = out.records.find((r) => r.data.ref_type === "new_esi_ref_type");
    expect(record?.data).not.toHaveProperty("amount");
    expect(record?.data.future_field).toEqual({ amount: "1.234567890123456789e+20" });
  });

  it("rejects repeated pages even when the page count remains stable", async () => {
    const { client, calls } = collector((url) =>
      url.pathname.endsWith("/assets")
        ? response(JSON.stringify([asset]), { "x-pages": "2" })
        : liveResponses(url),
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "assets")).toMatchObject({
      status: "partial",
      note: expect.stringContaining("invalid_pagination"),
    });
    expect(out.records.filter((r) => r.category === "assets")).toHaveLength(1);
    expect(calls.filter((url) => url.pathname.endsWith("/assets"))).toHaveLength(2);
  });

  it("cannot be redirected into another endpoint and distinguishes all-failed wallet constituents", async () => {
    const { client } = collector((url) => {
      if (url.pathname.includes("/wallet/"))
        return response('{"error":"untrusted secret"}', {}, 503);
      if (url.pathname.endsWith("/assets"))
        return response("", { location: "https://evil.invalid/" }, 302);
      return liveResponses(url);
    });
    const out = await client.collectCharacter(subject);
    expect(out.datasets.find((d) => d.category === "wallet")?.status).toBe("failed");
    expect(out.datasets.find((d) => d.category === "assets")?.status).toBe("failed");
    expect(
      out.records.filter((r) => r.category === "wallet" || r.category === "assets"),
    ).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("untrusted secret");
  });

  it("retains preceding records when the aggregate byte limit is exhausted", async () => {
    const { client, calls } = collector(liveResponses, { maxTotalBytes: 150 });
    const out = await client.collectCharacter(subject);
    expect(out.datasets.map((d) => d.status)).toEqual([
      "complete",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(out.records).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(out.datasets[1].note).toContain("aggregate_limit");
  });

  it("shares the request limit across characters and keeps globally unique envelope IDs", async () => {
    const { client, calls } = collector(liveResponses, { maxRequests: 11 });
    const first = await client.collectCharacter(subject);
    const second = await client.collectCharacter({ ...subject, characterId: 90000002 });
    expect(first.datasets.map((d) => d.status)).toEqual(Array(6).fill("complete"));
    expect(second.datasets.map((d) => d.status)).toEqual([
      "complete",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    const ids = [...first.records, ...second.records].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(calls).toHaveLength(11);
  });

  it("bounds connection setup even if a fetch implementation ignores abort", async () => {
    const { client, calls } = collector(() => new Promise<Response>(() => {}), {
      timeoutMs: 25,
    });
    const out = await client.collectCharacter(subject);
    expect(out.datasets.map((d) => d.status)).toEqual(Array(6).fill("failed"));
    expect(calls).toHaveLength(1);
    expect(out.datasets[0].note).toContain("deadline");
  });

  it("stops at the evidence request bound without silently completing unvisited categories", async () => {
    const { client, calls } = collector(liveResponses, { maxRequests: 2 });
    const out = await client.collectCharacter(subject);
    expect(calls).toHaveLength(2);
    expect(out.datasets.map((d) => d.status)).toEqual([
      "complete",
      "partial",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(out.datasets[1].note).toContain("request_limit");
  });

  it.each(["maxResponseBytes", "maxTotalBytes"])(
    "bounds streaming reads using %s",
    async (limit) => {
      const { client } = collector(liveResponses, { [limit]: 10 });
      const out = await client.collectCharacter(subject);
      expect(out.datasets.map((d) => d.status)).toEqual(Array(6).fill("failed"));
      expect(out.records).toEqual([]);
    },
  );

  it("aborts a stalled response body at the total deadline", async () => {
    const { client, calls } = collector(
      () => new Response(new ReadableStream({ start() {} })),
      { timeoutMs: 25 },
    );
    const out = await client.collectCharacter(subject);
    expect(out.datasets.every((d) => d.status === "failed")).toBe(true);
    expect(out.datasets[0].note).toContain("deadline");
    expect(calls).toHaveLength(1);
  });

  it.each<{ status: number; headers: Record<string, string> }>([
    {
      status: 200,
      headers: {
        "x-ratelimit-remaining": "5",
        "x-ratelimit-limit": "150/15m",
        "x-ratelimit-group": "char-wallet",
      },
    },
    {
      status: 429,
      headers: { "retry-after": "900", "x-ratelimit-group": "char-wallet" },
    },
    { status: 429, headers: { "retry-after": "900" } },
  ])(
    "scopes depleted wallet and Retry-After to one character and group: %j",
    async ({ status, headers }) => {
      const { client, calls } = collector((url) =>
        url.pathname === "/characters/90000001/wallet/journal"
          ? response(`[${journal()}]`, headers, status)
          : liveResponses(url),
      );
      const first = await client.collectCharacter(subject);
      const second = await client.collectCharacter({ ...subject, characterId: 90000002 });
      expect(
        first.datasets.filter((d) => d.category !== "wallet").map((d) => d.status),
      ).toEqual(Array(5).fill("complete"));
      expect(first.datasets.find((d) => d.category === "wallet")?.note).toContain(
        "rate_limited",
      );
      expect(second.datasets.map((d) => d.status)).toEqual(Array(6).fill("complete"));
      expect(
        calls.filter((url) => url.pathname.startsWith("/characters/90000001/wallet/")),
      ).toHaveLength(1);
    },
  );

  it("shares the documented char-detail budget between skills and queue only", async () => {
    const { client } = collector((url) => {
      const res = liveResponses(url);
      if (url.pathname.endsWith("/skills")) {
        res.headers.set("x-ratelimit-group", "char-detail");
        res.headers.set("x-ratelimit-remaining", "0");
      }
      return res;
    });
    const out = await client.collectCharacter(subject);
    expect(out.datasets.map((d) => d.status)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
      "failed",
    ]);
    expect(out.datasets[5].note).toContain("rate_limited");
    const second = await client.collectCharacter({ ...subject, characterId: 90000002 });
    expect(second.datasets[0].status).toBe("complete");
    expect(second.datasets[4].status).toBe("complete");
  });

  it.each(["modern", "legacy", "legacy420"])(
    "does not apply %s ESI pacing to SSO or JWKS",
    async (mode) => {
      const client = createRecruitmentCollector({
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          return url.origin === "https://esi.evetech.net"
            ? response(
                "[]",
                mode === "modern"
                  ? { "x-ratelimit-group": "char-wallet", "retry-after": "900" }
                  : { "x-esi-error-limit-remain": "0" },
                mode === "legacy420" ? 420 : 429,
              )
            : response('{"ok":true}');
        },
      });
      await client.boundedFetch(
        "https://esi.evetech.net/characters/90000001/wallet/journal",
        { headers: { authorization: "Bearer secret-token" } },
      );
      for (const path of ["/v2/oauth/token", "/oauth/jwks"]) {
        await expect(
          client
            .boundedFetch(`https://login.eveonline.com${path}`)
            .then((res) => res.json()),
        ).resolves.toEqual({ ok: true });
      }
    },
  );

  it.each<Record<string, string>>([
    { "x-esi-error-limit-remain": "0", "x-esi-error-limit-reset": "900" },
    { "x-esi-error-limit-remain": "0" },
    { "retry-after": "900" },
  ])("honours upstream backoff without retry loops: %j", async (headers) => {
    const { client, calls } = collector(() => response("[]", headers), {
      timeoutMs: 100,
    });
    const out = await client.collectCharacter(subject);
    expect(calls).toHaveLength(1);
    expect(out.datasets.slice(1).every((d) => d.status === "failed")).toBe(true);
    expect(out.datasets[1].note).toContain("rate_limited");
  });
});
