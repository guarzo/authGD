import { createHash, sign, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as database from "@/db";
import * as config from "@/config";
import { sharedAccounts } from "./helpers/fleet-shared-admission";
import { fleetDeviceSession, fleetPairingRequest } from "@/db/schema";
import { canonicalFleetRequest } from "@/lib/fleet-signature";
import { approvePairing, pairingChallengePreimage } from "@/services/fleet-pairing";
import { pairDevice, fleetKeyPair } from "./helpers/fleet-sharing";
import { seedAccount } from "./helpers/seed";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import * as catalogue from "@/app/api/fleet/v2/catalogue/route";
import * as session from "@/app/api/fleet/v2/session/route";
import * as participation from "@/app/api/fleet/v2/participation/route";
import * as eligibility from "@/app/api/fleet/v2/eligibility/route";
import * as pairing from "@/app/api/fleet/v2/pairing-requests/route";
import * as complete from "@/app/api/fleet/v2/pairing-requests/[id]/complete/route";
import * as recovery from "@/app/api/fleet/v2/recovery-challenges/route";
import * as recovered from "@/app/api/fleet/v2/recovery-challenges/[id]/complete/route";
process.env.DATABASE_URL = TEST_URL;
process.env.APP_BASE_URL = "https://auth.example";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
const root = "/api/fleet/v2/";
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const attempt = () => randomBytes(32).toString("base64url");
function post(path: string, value: unknown, token = attempt()) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    req: new NextRequest(`https://attacker.example${path}`, {
      method: "POST",
      headers: { "X-Fleet-Attempt": token },
      body: text,
    }),
    binding: digest(
      [
        "fleet-api-v2-pre-session",
        "https://auth.example",
        "POST",
        path,
        token,
        digest(text),
      ].join("\n"),
    ),
  };
}
function signed(
  p: Awaited<ReturnType<typeof pairDevice>>,
  method: "GET" | "PUT",
  path: string,
  text = "",
  signPath = path,
) {
  const fields = {
    protocol: 1 as const,
    method,
    path: signPath,
    sessionId: p.sessionId,
    issuedAt: new Date().toISOString(),
    revision: 10,
    bodySha256: digest(text),
  };
  const canonical = canonicalFleetRequest(fields);
  return {
    req: new NextRequest(`https://auth.example${path}`, {
      method,
      ...(method === "PUT" ? { body: text } : {}),
      headers: {
        "X-Fleet-Session": p.sessionId,
        "X-Fleet-Issued-At": fields.issuedAt,
        "X-Fleet-Revision": "10",
        "X-Fleet-Body-Sha256": fields.bodySha256,
        "X-Fleet-Signature": sign(null, canonical, p.privateKey).toString("base64url"),
      },
    }),
    binding: digest(Buffer.concat([Buffer.from("fleet-api-v2\n"), canonical])),
  };
}
it.each([
  ["catalogue", "GET", catalogue.GET, ""],
  ["session", "PUT", session.PUT, '{"protocol":2.0}'],
] as const)(
  "real signed %s uses API2 bytes, signing1 and no clock anchor",
  async (name, method, route, text) => {
    const p = await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      new Date(),
    );
    const call = signed(p, method, root + name, text);
    const response = await route(call.req);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fleet-request-binding")).toBe(call.binding);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.protocol).toBe(2);
    expect(body).not.toHaveProperty("server_time_ms");
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(10);
  },
);
it("pre-session attempt binds the exact body and path without altering the immutable pairing proof; lost completion is one-use", async () => {
  const keys = fleetKeyPair();
  const call = post(root + "pairing-requests", {
    protocol: 2,
    public_key_spki_b64url: Buffer.from(keys.publicKeySpki).toString("base64url"),
    requested_capabilities: [],
  });
  const response = await pairing.POST(call.req);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-fleet-request-binding")).toBe(call.binding);
  const begun = (await response.json()) as { pairing_id: string };
  await approvePairing(
    ctx.db,
    begun.pairing_id,
    (await seedAccount(ctx.db, { tier: "member" })).id,
  );
  const path = root + `pairing-requests/${begun.pairing_id}/complete`;
  const body = {
    protocol: 2,
    completion_signature: sign(
      null,
      pairingChallengePreimage(begun.pairing_id),
      keys.privateKey,
    ).toString("base64url"),
  };
  const done = post(path, body);
  const result = await complete.POST(done.req, {
    params: Promise.resolve({ id: begun.pairing_id }),
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("x-fleet-request-binding")).toBe(done.binding);
  expect(Object.keys((await result.json()) as object).sort()).toEqual([
    "catalogue",
    "protocol",
    "session_id",
  ]);
  expect(
    (
      await complete.POST(post(path, body).req, {
        params: Promise.resolve({ id: begun.pairing_id }),
      })
    ).status,
  ).toBe(409);
  expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
});
it.each(["", "A".repeat(42) + "B", "A".repeat(43) + ", " + "A".repeat(43)])(
  "invalid attempt %s refuses pairing before allocation",
  async (token) => {
    const keys = fleetKeyPair();
    const call = post(
      root + "pairing-requests",
      {
        protocol: 2,
        public_key_spki_b64url: Buffer.from(keys.publicKeySpki).toString("base64url"),
        requested_capabilities: [],
      },
      token,
    );
    const response = await pairing.POST(call.req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ protocol: 2, error: "bad_request" });
    expect(await ctx.db.select().from(fleetPairingRequest)).toEqual([]);
  },
);
it("real participation and eligibility share the signed lane without exposing a clock or roster", async () => {
  const p = await sharedAccounts(ctx.db, new Date(Date.now() - 3000));
  const call = signed(
    p.b,
    "PUT",
    root + "participation",
    '{"protocol":2,"enabled":false,"expected_generation":1}',
  );
  const response = await participation.PUT(call.req);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-fleet-request-binding")).toBe(call.binding);
  expect(await response.json()).toEqual({
    protocol: 2,
    participation: { enabled: false, generation: 2 },
  });
  const read = signed(p.a, "GET", root + "eligibility");
  const result = await eligibility.GET(read.req);
  expect(result.status).toBe(200);
  expect(result.headers.get("x-fleet-request-binding")).toBe(read.binding);
  const body = await result.json();
  expect(body.protocol).toBe(2);
  expect(body).not.toHaveProperty("server_time_ms");
  expect(JSON.stringify(body)).not.toMatch(/character_name|fleet_id|roster/);
  expect((await catalogue.GET(signed(p.b, "GET", root + "catalogue").req)).status).toBe(
    409,
  );
});

it.each(["/", "/extra"])(
  "signed fleet path suffix %s cannot use the canonical route signature",
  async (suffix) => {
    const p = await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      new Date(),
    );
    const before = await ctx.db.select().from(fleetDeviceSession);
    const response = await session.PUT(
      signed(p, "PUT", root + "session" + suffix, '{"protocol":2}', root + "session").req,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ protocol: 2, error: "bad_request" });
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  },
);

it("a valid signature over another literal path cannot renew or read a catalogue", async () => {
  const p = await pairDevice(
    ctx.db,
    (await seedAccount(ctx.db, { tier: "member" })).id,
    new Date(),
  );
  const before = await ctx.db.select().from(fleetDeviceSession);
  expect(
    (await catalogue.GET(signed(p, "GET", root + "catalogue", "", root + "device").req))
      .status,
  ).toBe(401);
  expect(
    (
      await session.PUT(
        signed(p, "PUT", root + "session", '{"protocol":2}', root + "device").req,
      )
    ).status,
  ).toBe(401);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

const id = "11111111-1111-4111-8111-111111111111";
const postCases = [
  {
    path: root + "pairing-requests",
    route: (req: NextRequest) => pairing.POST(req),
    value: {
      protocol: 2,
      public_key_spki_b64url: Buffer.from(fleetKeyPair().publicKeySpki).toString(
        "base64url",
      ),
      requested_capabilities: [],
    },
  },
  {
    path: root + `pairing-requests/${id}/complete`,
    route: (req: NextRequest) => complete.POST(req, { params: Promise.resolve({ id }) }),
    value: { protocol: 2, completion_signature: "A".repeat(86) },
  },
  {
    path: root + "recovery-challenges",
    route: (req: NextRequest) => recovery.POST(req),
    value: {
      protocol: 2,
      public_key_spki_b64url: Buffer.from(fleetKeyPair().publicKeySpki).toString(
        "base64url",
      ),
      request_id: "A".repeat(43),
      issued_at: new Date().toISOString(),
      initiation_signature: "A".repeat(86),
    },
  },
  {
    path: root + `recovery-challenges/${id}/complete`,
    route: (req: NextRequest) => recovered.POST(req, { params: Promise.resolve({ id }) }),
    value: { protocol: 2, nonce: "A".repeat(43), recovery_signature: "A".repeat(86) },
  },
];
for (const entry of postCases)
  it.each(['"__proto__":null', '"\\u005f_proto__":{}'])(
    `${entry.path} rejects single prototype key %s before DB admission`,
    async (extra) => {
      const text = JSON.stringify(entry.value).replace(/}$/, `,${extra}}`);
      const spy = vi.spyOn(database, "getDb").mockImplementation(() => {
        throw new Error("unexpected DB admission");
      });
      try {
        const result = await entry.route(post(entry.path, text).req);
        expect(result.status).toBe(400);
        expect(await result.json()).toEqual({ protocol: 2, error: "bad_request" });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );
it.each(['"__proto__":null', '"\\u005f_proto__":{}'])(
  "single prototype key %s cannot allocate pairing",
  async (extra) => {
    const keys = fleetKeyPair();
    const text = JSON.stringify({
      protocol: 2,
      public_key_spki_b64url: Buffer.from(keys.publicKeySpki).toString("base64url"),
      requested_capabilities: [],
    }).replace(/}$/, `,${extra}}`);
    const before = await ctx.db.select().from(fleetPairingRequest);
    const res = await pairing.POST(post(root + "pairing-requests", text).req);
    expect(await ctx.db.select().from(fleetPairingRequest)).toEqual(before);
    expect(res.status).toBe(400);
  },
);
it.each(['"__proto__":null', '"\\u005f_proto__":{}'])(
  "single prototype key %s cannot renew a signed session",
  async (extra) => {
    const p = await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      new Date(),
    );
    const sessions = await ctx.db.select().from(fleetDeviceSession);
    const renewed = await session.PUT(
      signed(p, "PUT", root + "session", `{"protocol":2,${extra}}`).req,
    );
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessions);
    expect(renewed.status).toBe(400);
  },
);
for (const entry of postCases)
  it(`${entry.path} keeps configuration failures closed before admission`, async () => {
    const spy = vi.spyOn(config, "getConfig").mockImplementation(() => {
      throw new Error("private configuration failure");
    });
    try {
      const res = await entry.route(post(entry.path, entry.value).req);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ protocol: 2, error: "service_unavailable" });
    } finally {
      spy.mockRestore();
    }
  });
for (const entry of postCases)
  it.each([
    ["old integral", '{"protocol":1.0}', "update_required"],
    ["future integral", '{"protocol":3e0}', "update_required"],
    ["missing", "{}", "bad_request"],
    ["boolean", '{"protocol":true}', "bad_request"],
    ["rounded fraction", '{"protocol":2.0000000000000001}', "bad_request"],
    ["duplicate", '{"protocol":2,"protocol":2}', "bad_request"],
    ["raw bound", " ".repeat(2049), "bad_request"],
  ] as const)(
    `${entry.path} rejects %s before DB admission`,
    async (_name, text, code) => {
      const spy = vi.spyOn(database, "getDb").mockImplementation(() => {
        throw new Error("unexpected DB admission");
      });
      try {
        const result = await entry.route(post(entry.path, text).req);
        expect(result.status).toBe(400);
        expect(await result.json()).toEqual({ protocol: 2, error: code });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );
for (const entry of postCases)
  it.each([
    "missing attempt",
    "duplicate attempt",
    "caller binding",
    "signed headers",
    "compressed",
    "bare query",
    "query",
    "trailing slash",
    "encoded path",
    "extra segment",
  ])(`${entry.path} rejects %s before DB admission`, async (kind) => {
    let path = entry.path;
    if (kind === "bare query") path += "?";
    if (kind === "query") path += "?selector=1";
    if (kind === "trailing slash") path += "/";
    if (kind === "encoded path")
      path = path.replace("requests", "%72equests").replace("challenges", "%63hallenges");
    if (kind === "extra segment") path += "/other";
    const { req } = post(path, entry.value);
    if (kind === "missing attempt") req.headers.delete("x-fleet-attempt");
    if (kind === "duplicate attempt") req.headers.append("x-fleet-attempt", attempt());
    if (kind === "caller binding")
      req.headers.set("x-fleet-request-binding", "A".repeat(43));
    if (kind === "signed headers") req.headers.set("x-fleet-session", "A".repeat(43));
    if (kind === "compressed") req.headers.set("content-encoding", "gzip");
    const spy = vi.spyOn(database, "getDb").mockImplementation(() => {
      throw new Error("unexpected DB admission");
    });
    try {
      const result = await entry.route(req);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ protocol: 2, error: "bad_request" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

const routeCases = [
  ["catalogue", catalogue, "GET"],
  ["session", session, "PUT"],
  ["participation", participation, "PUT"],
  ["eligibility", eligibility, "GET"],
  ["pairing-requests", pairing, "POST"],
  ["pairing-requests/id/complete", complete, "POST"],
  ["recovery-challenges", recovery, "POST"],
  ["recovery-challenges/id/complete", recovered, "POST"],
] as const;
for (const [name, routes, allowed] of routeCases)
  for (const method of [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ] as const)
    if (method !== allowed)
      it(`${name} rejects unsupported ${method} before admission`, async () => {
        const response = (routes[method] as () => Response)();
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe(allowed);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe(
          method === "HEAD" ? "" : '{"protocol":2,"error":"method_not_allowed"}',
        );
      });
