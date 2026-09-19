import { createHash, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as database from "@/db";
import { fleetDeviceSession, fleetTelemetryRow } from "@/db/schema";
import { canonicalFleetRequest } from "@/lib/fleet-signature";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { sharedAccounts } from "./helpers/fleet-shared-admission";
import { pairDevice } from "./helpers/fleet-sharing";
import * as snapshot from "@/app/api/fleet/v2/snapshot/route";
import * as device from "@/app/api/fleet/v2/device/route";

process.env.DATABASE_URL = TEST_URL;
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
async function prepared() {
  const { rows } = await ctx.pool.query<{ now: Date }>("select clock_timestamp() as now");
  const base = new Date(rows[0].now.getTime() - 3000);
  const p = await sharedAccounts(ctx.db, base);
  const b = await pairDevice(
    ctx.db,
    p.participant.id,
    base,
    ["shared-source-v1", "combat-v2"],
    {
      privateKey: p.b.privateKey,
      publicKeySpki: p.b.publicKeySpki,
    },
  );
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: b.sessionId,
        revision: 1,
        now: base,
        capabilities: ["shared-source-v1", "combat-v2"],
      })
    ).ok,
  ).toBe(true);
  return { ...p, b };
}
function request(
  p: Awaited<ReturnType<typeof pairDevice>>,
  method: "GET" | "PUT",
  path: string,
  body = Buffer.alloc(0),
  revision = 10,
  signPath = path,
) {
  const fields = {
    protocol: 1 as const,
    method,
    path: signPath,
    sessionId: p.sessionId,
    issuedAt: new Date().toISOString(),
    revision,
    bodySha256: createHash("sha256").update(body).digest("hex"),
  };
  const canonical = canonicalFleetRequest(fields);
  const headers = new Headers({
    "X-Fleet-Session": p.sessionId,
    "X-Fleet-Issued-At": fields.issuedAt,
    "X-Fleet-Revision": String(revision),
    "X-Fleet-Body-Sha256": fields.bodySha256,
    "X-Fleet-Signature": sign(null, canonical, p.privateKey).toString("base64url"),
  });
  return {
    req: new NextRequest(`http://localhost${path}`, {
      method,
      headers,
      ...(method === "PUT" ? { body: new Uint8Array(body) } : {}),
    }),
    // Independent literal domain, not the production binding helper.
    binding: createHash("sha256")
      .update("fleet-api-v2\n")
      .update(canonical)
      .digest("hex"),
  };
}
const bodyFor = (id: number) => ({
  protocol: 2,
  sampled_at_ms: Date.now() - 200,
  rows: [
    {
      character_id: id,
      outgoing_dps: null,
      incoming_dps: 19,
      activity_age_ms: 500,
      effects: [{ kind: "POINT", observations: [{ name: "é", age_ms: 700 }] }],
    },
  ],
});
const path = "/api/fleet/v2/snapshot";

it("literal v2 signed PUT/GET exchanges complete combat with exactly bound compact JSON and DB anchors", async () => {
  const p = await prepared();
  const input = Buffer.from(
    JSON.stringify(bodyFor(p.alts[0].id)).replace('"protocol":2', '"protocol":2.0'),
  );
  const put = request(p.b, "PUT", path, input);
  const written = await snapshot.PUT(put.req);
  expect(written.status).toBe(200);
  expect(await written.text()).toBe('{"protocol":2}');
  expect(written.headers.get("x-fleet-request-binding")).toBe(put.binding);
  const get = request(p.a, "GET", path);
  const read = await snapshot.GET(get.req);
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(read.headers.get("content-encoding")).toBe("identity");
  expect(read.headers.get("x-fleet-request-binding")).toBe(get.binding);
  expect(read.headers.has("x-fleet-snapshot-format")).toBe(false);
  const raw = await read.text();
  const json = JSON.parse(raw);
  expect(raw).toBe(JSON.stringify(json));
  expect(json).toMatchObject({
    protocol: 2,
    rows: [
      {
        character_id: p.alts[0].id,
        outgoing_dps: null,
        incoming_dps: 19,
        effects: [{ kind: "POINT", observations: [{ name: "é" }] }],
      },
    ],
  });
  const [stored] = await ctx.db.select().from(fleetTelemetryRow);
  expect(json.rows[0].age_ms).toBe(json.server_time_ms - stored.sampledAtMs);
  expect(json.rows[0].activity_age_ms).toBe(
    json.server_time_ms - stored.activityOriginMs,
  );
});

it.each(["row", "effect", "observation"])(
  "v2 snapshot rejects nested prototype key on %s before admission",
  async (level) => {
    const p = await prepared();
    const value = bodyFor(p.alts[0].id);
    const row = value.rows[0];
    const target =
      level === "row"
        ? row
        : level === "effect"
          ? row.effects[0]
          : row.effects[0].observations[0];
    Object.defineProperty(target, "__proto__", { value: null, enumerable: true });
    const raw = Buffer.from(
      JSON.stringify(value).replace('"__proto__"', '"\\u005f_proto__"'),
    );
    const before = await ctx.db.select().from(fleetDeviceSession);
    const response = await snapshot.PUT(request(p.b, "PUT", path, raw).req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ protocol: 2, error: "bad_request" });
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
  },
);

it("v2 device returns independent arrays and exactly its committed DB sample, for GET and ack", async () => {
  const p = await prepared();
  const call = request(
    p.b,
    "PUT",
    "/api/fleet/v2/device",
    Buffer.from('{"protocol":2,"capabilities":["shared-source-v1","combat-v2"]}'),
  );
  const response = await device.PUT(call.req);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-fleet-request-binding")).toBe(call.binding);
  const json = await response.json();
  const sessions = await ctx.db.select().from(fleetDeviceSession);
  const s = sessions.find((s) => s.lastRevision === 10)!;
  expect(json.server_time_ms).toBe(s.lastReadAt!.getTime());
  expect(json.approved_capabilities).toEqual(["shared-source-v1", "combat-v2"]);
  expect(json.session_approved_capabilities).toEqual(["shared-source-v1", "combat-v2"]);
  expect(json.acknowledged_capabilities).toEqual(["shared-source-v1", "combat-v2"]);
  const receiver = request(p.a, "GET", "/api/fleet/v2/device");
  const read = await device.GET(receiver.req);
  expect(read.status).toBe(200);
  expect(read.headers.get("x-fleet-request-binding")).toBe(receiver.binding);
  expect((await read.json()).approved_capabilities).toEqual(["shared-source-v1"]);
});

it.each([
  [
    "duplicate",
    Buffer.from('{"protocol":2,"protocol":2,"sampled_at_ms":0,"rows":[]}'),
    "bad_request",
  ],
  [
    "escaped duplicate",
    Buffer.from('{"protocol":2,"sampled_at_ms":0,"rows":[],"r\\u006fws":[]}'),
    "bad_request",
  ],
  ["UTF8", Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]), "bad_request"],
  [
    "rounded fraction",
    Buffer.from('{"protocol":2.0000000000000001,"sampled_at_ms":0,"rows":[]}'),
    "bad_request",
  ],
  [
    "underflow",
    Buffer.from('{"protocol":2,"sampled_at_ms":1e-999999,"rows":[]}'),
    "bad_request",
  ],
  [
    "overflow",
    Buffer.from('{"protocol":2,"sampled_at_ms":1e999999,"rows":[]}'),
    "bad_request",
  ],
  ["old version", Buffer.from('{"protocol":1.0}'), "update_required"],
  ["next version", Buffer.from('{"protocol":3e0}'), "update_required"],
  ["invalid version", Buffer.from('{"protocol":true}'), "bad_request"],
  ["missing version", Buffer.from('{"sampled_at_ms":0,"rows":[]}'), "bad_request"],
  [
    "raw bound",
    Buffer.from('{"protocol":2,"sampled_at_ms":0,"rows":[]}'.padEnd(524289, " ")),
    "bad_request",
  ],
  [
    "withdrawal sentinel",
    Buffer.from('{"protocol":2,"sampled_at_ms":1,"rows":[]}'),
    "bad_request",
  ],
] as const)(
  "v2 snapshot refuses %s as a closed whole operation without cadence",
  async (_name, raw, error) => {
    const p = await prepared();
    const before = await ctx.db.select().from(fleetDeviceSession);
    const response = await snapshot.PUT(request(p.b, "PUT", path, raw).req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ protocol: 2, error });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("x-fleet-request-binding")).toBe(false);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
  },
);

it("the exact 512KiB decoded entity boundary accepts a valid padded signed withdrawal", async () => {
  const p = await prepared();
  const raw = Buffer.from(
    '{"protocol":2,"sampled_at_ms":0,"rows":[]}'.padEnd(524288, " "),
  );
  const call = request(p.b, "PUT", path, raw);
  expect((await snapshot.PUT(call.req)).status).toBe(200);
});
it("invalid UTF8 in an otherwise valid observed name is fatal rather than replaced with an allowed scalar", async () => {
  const p = await prepared();
  const raw = Buffer.from(JSON.stringify(bodyFor(p.alts[0].id)).replace("é", "\ufffd"));
  const index = raw.indexOf(Buffer.from("\ufffd"));
  const invalid = Buffer.concat([
    raw.subarray(0, index),
    Buffer.from([0xff]),
    raw.subarray(index + 3),
  ]);
  const before = await ctx.db.select().from(fleetDeviceSession);
  const response = await snapshot.PUT(request(p.b, "PUT", path, invalid).req);
  expect(await response.json()).toEqual({ protocol: 2, error: "bad_request" });
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

it("signature over the retired path cannot authenticate on v2, nor can reserialization hide exact-body tampering", async () => {
  const p = await prepared();
  for (const signPath of ["/api/fleet/v1/snapshot", "/api/fleet/v2/device"]) {
    const response = await snapshot.PUT(
      request(
        p.b,
        "PUT",
        path,
        Buffer.from('{"protocol":2,"sampled_at_ms":0,"rows":[]}'),
        10,
        signPath,
      ).req,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ protocol: 2, error: "unauthorized" });
  }
  const call = request(
    p.b,
    "PUT",
    path,
    Buffer.from('{"protocol":2,"sampled_at_ms":0,"rows":[]}'),
  );
  const tampered = new NextRequest(`http://localhost${path}`, {
    method: "PUT",
    headers: call.req.headers,
    body: ' {"protocol":2,"sampled_at_ms":0,"rows":[]}',
  });
  expect((await snapshot.PUT(tampered)).status).toBe(401);
});

it.each(["snapshot", "device"] as const)(
  "v2 %s rejects compressed entities, GET framing, query and extra fleet headers",
  async (name) => {
    const p = await prepared();
    const routes = name === "snapshot" ? snapshot : device;
    const url = `/api/fleet/v2/${name}`;
    const before = await ctx.db.select().from(fleetDeviceSession);
    for (const [method, header, value] of [
      ["PUT", "content-encoding", "gzip"],
      ["GET", "content-encoding", "br"],
      ["GET", "content-length", "1"],
      ["GET", "transfer-encoding", "chunked"],
      ["GET", "x-fleet-attempt", "A".repeat(43)],
      ["GET", "x-fleet-snapshot-format", "publication-v1"],
      ["GET", "x-fleet-request-binding", "0".repeat(64)],
      ["GET", "x-fleet-revision", "2147483648"],
      ["GET", "x-fleet-issued-at", "0000-01-01T00:00:00.000Z"],
      ["GET", "x-fleet-session", "A".repeat(42) + "B"],
    ] as const) {
      const putBody =
        name === "snapshot"
          ? '{"protocol":2,"sampled_at_ms":0,"rows":[]}'
          : '{"protocol":2,"capabilities":["shared-source-v1","combat-v2"]}';
      const call = request(
        p.b,
        method,
        url,
        method === "PUT" ? Buffer.from(putBody) : Buffer.alloc(0),
      );
      call.req.headers.set(header, value);
      expect((await routes[method](call.req)).status, `${method} ${header}`).toBe(400);
    }
    for (const suffix of ["?", "?format=publication-v1"]) {
      const call = request(p.b, "GET", url);
      const query = new NextRequest(`http://localhost${url}${suffix}`, {
        headers: call.req.headers,
      });
      expect((await routes.GET(query)).status, suffix).toBe(400);
    }
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  },
);

for (const [name, routes] of [
  ["snapshot", snapshot],
  ["device", device],
] as const) {
  for (const method of ["GET", "PUT"] as const) {
    it.each(["getDb", "auth pool", "service transaction"] as const)(
      `v2 ${name} ${method} closes unexpected %s failures as 503`,
      async (stage) => {
        const p = await prepared();
        const before = await ctx.db.select().from(fleetDeviceSession);
        const raw =
          method === "GET"
            ? Buffer.alloc(0)
            : Buffer.from(
                name === "snapshot"
                  ? '{"protocol":2,"sampled_at_ms":0,"rows":[]}'
                  : '{"protocol":2,"capabilities":["shared-source-v1","combat-v2"]}',
              );
        const call = request(p.b, method, `/api/fleet/v2/${name}`, raw);
        const fault = new Error(`private ${stage} failure must not leak`);
        const db = vi.spyOn(database, "getDb").mockReturnValue(ctx.db);
        const query = vi.spyOn(ctx.pool, "query");
        const transaction = vi.spyOn(ctx.db, "transaction");
        if (stage === "getDb")
          db.mockImplementation(() => {
            throw fault;
          });
        if (stage === "auth pool")
          query.mockImplementation(() => {
            throw fault;
          });
        if (stage === "service transaction") transaction.mockRejectedValue(fault);
        try {
          // Real framing, authentication and service code; inject only the
          // failing database boundary, never a canned auth or service result.
          const response = await routes[method](call.req);
          expect(response.status).toBe(503);
          expect(await response.text()).toBe(
            '{"protocol":2,"error":"service_unavailable"}',
          );
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("content-type")).toBe("application/json");
          expect(response.headers.has("x-fleet-request-binding")).toBe(false);
          expect(db).toHaveBeenCalledTimes(1);
          if (stage !== "getDb") expect(query).toHaveBeenCalled();
          expect(transaction).toHaveBeenCalledTimes(
            stage === "service transaction" ? 1 : 0,
          );
        } finally {
          transaction.mockRestore();
          query.mockRestore();
          db.mockRestore();
        }
        expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
        expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
      },
    );
    it.each(["malformed headers", "body refusal"] as const)(
      `v2 ${name} ${method} retains %s before even a failing getDb`,
      async (kind) => {
        const p = await prepared();
        const raw =
          method === "GET"
            ? Buffer.alloc(0)
            : Buffer.from(kind === "body refusal" ? "{" : '{"protocol":2}');
        const call = request(p.b, method, `/api/fleet/v2/${name}`, raw);
        if (kind === "malformed headers") call.req.headers.delete("x-fleet-signature");
        else if (method === "GET") call.req.headers.set("content-length", "1");
        const db = vi.spyOn(database, "getDb").mockImplementation(() => {
          throw new Error("malformed request reached DB");
        });
        try {
          const response = await routes[method](call.req);
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            protocol: 2,
            error:
              kind === "malformed headers" || method === "GET"
                ? "bad_headers"
                : "bad_request",
          });
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(db).not.toHaveBeenCalled();
        } finally {
          db.mockRestore();
        }
      },
    );
  }
  it.each(["POST", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const)(
    `installed Next method dispatch: v2 ${name} %s is closed 405 with exact Allow and no admission`,
    async (method) => {
      const dispatch = autoImplementMethods(routes);
      const req = new NextRequest(`http://localhost/api/fleet/v2/${name}`, { method });
      Object.defineProperty(req, "body", {
        get() {
          throw new Error("unsupported method read body");
        },
      });
      const response = await dispatch[method](req, { params: Promise.resolve({}) });
      if (!(response instanceof Response))
        throw new Error("Next handler did not return Response");
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, PUT");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : '{"protocol":2,"error":"method_not_allowed"}',
      );
    },
  );
}
