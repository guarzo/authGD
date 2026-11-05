import { createHash, randomUUID, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fleetAutomaticConsent, fleetDeviceSession } from "@/db/schema";
import { canonicalFleetRequest } from "@/lib/fleet-signature";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import * as database from "@/db";
import * as sources from "@/app/api/fleet/v2/sources/route";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
import * as automatic from "@/app/api/fleet/v2/automatic-verification/route";
import * as receipt from "@/app/api/fleet/v2/automatic-verification/receipts/[request_id]/route";

process.env.DATABASE_URL = TEST_URL;
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
const PATH = "/api/fleet/v2/automatic-verification";
async function setup() {
  const ready = await reconcileFleetKeys(ctx.db);
  const base = new Date(Date.now() - 3000);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: base,
  });
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, base, ["shared-source-v1"]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: base,
    capabilities: ["shared-source-v1"],
  });
  const command = {
    protocol: 2,
    enabled: true,
    request_id: randomUUID(),
    intent_created_at: base.toISOString(),
    expected_generation: 0,
    expected_revision: 0,
  };
  return { ...p, owner, command };
}
function request(
  p: Awaited<ReturnType<typeof setup>>,
  method: "GET" | "PUT",
  path = PATH,
  body = "",
  revision = 2,
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
  return {
    req: new NextRequest(`http://localhost${path}`, {
      method,
      headers: {
        "X-Fleet-Session": p.sessionId,
        "X-Fleet-Issued-At": fields.issuedAt,
        "X-Fleet-Revision": String(revision),
        "X-Fleet-Body-Sha256": fields.bodySha256,
        "X-Fleet-Signature": sign(null, canonical, p.privateKey).toString("base64url"),
      },
      ...(method === "PUT" ? { body } : {}),
    }),
    binding: createHash("sha256")
      .update("fleet-api-v2\n")
      .update(canonical)
      .digest("hex"),
  };
}
it("actual signed On and receipt GET return one closed request-bound protocol2 envelope", async () => {
  const p = await setup();
  const on = request(p, "PUT", PATH, JSON.stringify(p.command));
  const result = await automatic.PUT(on.req);
  expect(result.status).toBe(200);
  expect(result.headers.get("x-fleet-request-binding")).toBe(on.binding);
  expect(result.headers.get("cache-control")).toBe("no-store");
  const value = await result.json();
  expect(value).toMatchObject({
    protocol: 2,
    request_id: p.command.request_id,
    result: "applied",
    receipt: { command: p.command },
    status: { consent: { generation: 1, enabled: true } },
  });
  await ctx.db.update(fleetDeviceSession).set({ lastReadAt: null });
  const path = PATH + "/receipts/" + p.command.request_id;
  const get = request(p, "GET", path, "", 3);
  const recovered = await receipt.GET(get.req, {
    params: Promise.resolve({ request_id: p.command.request_id }),
  });
  expect(recovered.status).toBe(200);
  expect(recovered.headers.get("x-fleet-request-binding")).toBe(get.binding);
  expect((await recovered.json()).receipt).toEqual(value.receipt);
});
it("GET remains read-only regarding absent consent", async () => {
  const p = await setup();
  const q = request(p, "GET");
  expect((await automatic.GET(q.req)).status).toBe(200);
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
});
it.each(["?", "?x=1", "/"])(
  "automatic raw path suffix %s refuses without cadence",
  async (suffix) => {
    const p = await setup();
    const q = request(p, "PUT", PATH + suffix, JSON.stringify(p.command));
    const response = await automatic.PUT(q.req);
    expect(response.status).toBe(400);
    expect(response.headers.has("x-fleet-request-binding")).toBe(false);
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
  },
);
it.each(["uppercase", "encoded", "extra", "trailing"])(
  "receipt selector %s is rejected before admission",
  async (kind) => {
    const p = await setup();
    const id = p.command.request_id;
    const spelling =
      kind === "uppercase"
        ? id.toUpperCase()
        : kind === "encoded"
          ? "%" + id.charCodeAt(0).toString(16) + id.slice(1)
          : kind === "extra"
            ? id + "/extra"
            : id + "/";
    const req = request(p, "GET", PATH + "/receipts/" + spelling);
    expect(
      (await receipt.GET(req.req, { params: Promise.resolve({ request_id: id }) }))
        .status,
    ).toBe(400);
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
  },
);
it("foreign and absent receipt GET are indistinguishable 404", async () => {
  const p = await setup();
  expect(
    (await automatic.PUT(request(p, "PUT", PATH, JSON.stringify(p.command)).req)).status,
  ).toBe(200);
  const other = await seedAccount(ctx.db, { tier: "member" });
  const q = await pairDevice(ctx.db, other.id, new Date(), ["shared-source-v1"]);
  for (const id of [randomUUID(), p.command.request_id]) {
    const req = request({ ...p, ...q }, "GET", PATH + "/receipts/" + id);
    const response = await receipt.GET(req.req, {
      params: Promise.resolve({ request_id: id }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ protocol: 2, error: "receipt_not_found" });
  }
});
it("actual v2 source Start/Stop/catalogue and inline receipt are singly enveloped and request-bound", async () => {
  const p = await setup();
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: p.owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const path = "/api/fleet/v2/sources";
  const sourceId = randomUUID();
  const start = {
    protocol: 2,
    operation: "start",
    source_id: sourceId,
    expected_generation: 0,
    character_id: boss.id,
    character_link_epoch: boss.fleetLinkEpoch,
    intent_created_at: new Date().toISOString(),
  };
  const put = request(p, "PUT", path, JSON.stringify(start));
  const started = await sources.PUT(put.req);
  expect(started.status).toBe(200);
  expect(started.headers.get("x-fleet-request-binding")).toBe(put.binding);
  expect(await started.json()).toMatchObject({
    protocol: 2,
    source: { source_id: sourceId, generation: 1, automatic: null },
  });
  await ctx.db.update(fleetDeviceSession).set({ lastReadAt: null });
  const get = request(p, "GET", path, "", 3);
  const catalogue = await sources.GET(get.req);
  expect(catalogue.status).toBe(200);
  expect(catalogue.headers.get("x-fleet-request-binding")).toBe(get.binding);
  expect(await catalogue.json()).toMatchObject({
    protocol: 2,
    sources: [{ source_id: sourceId }],
    characters: [{ character_id: boss.id }],
  });
  await ctx.db
    .update(fleetDeviceSession)
    .set({ lastReadAt: null, approvedCapabilities: [], acknowledgedCapabilities: [] });
  const stop = {
    protocol: 2,
    operation: "stop",
    request_id: randomUUID(),
    intent_created_at: new Date().toISOString(),
    source_id: sourceId,
    expected_generation: 1,
    expected_automatic: null,
  };
  const off = request(p, "PUT", path, JSON.stringify(stop), 4);
  const stopped = await sources.PUT(off.req);
  expect(stopped.status).toBe(200);
  expect(stopped.headers.get("x-fleet-request-binding")).toBe(off.binding);
  const value = await stopped.json();
  expect(value).toMatchObject({
    protocol: 2,
    result: "applied",
    receipt: { command: stop },
    automatic_effect: "manual_only",
  });
  await ctx.db.update(fleetDeviceSession).set({ lastReadAt: null });
  const recover = request(p, "GET", PATH + "/receipts/" + stop.request_id, "", 5);
  const recovered = await receipt.GET(recover.req, {
    params: Promise.resolve({ request_id: stop.request_id }),
  });
  expect(recovered.status).toBe(200);
  expect(recovered.headers.get("x-fleet-request-binding")).toBe(recover.binding);
  expect((await recovered.json()).receipt).toEqual(value.receipt);
});
it.each(["?", "/", "?x=1"])(
  "v2 source framing %s refuses before DB access",
  async (suffix) => {
    const spy = vi.spyOn(database, "getDb").mockImplementation(() => {
      throw new Error("private DB fault");
    });
    try {
      const response = await sources.GET(
        new NextRequest("http://localhost/api/fleet/v2/sources" + suffix),
      );
      expect(response.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
      expect(response.headers.has("x-fleet-request-binding")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  },
);
it("v2 source unexpected DB failure is a closed 503 with no binding", async () => {
  const p = await setup();
  const spy = vi.spyOn(database, "getDb").mockImplementation(() => {
    throw new Error("private DB fault");
  });
  try {
    const response = await sources.GET(request(p, "GET", "/api/fleet/v2/sources").req);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ protocol: 2, error: "service_unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("x-fleet-request-binding")).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
it("control unsupported methods are closed without automatic HEAD/OPTIONS admission", async () => {
  expect(sources.POST().headers.get("allow")).toBe("GET, PUT");
  expect(sources.OPTIONS().status).toBe(405);
  expect(await sources.HEAD().text()).toBe("");
  expect(automatic.POST().headers.get("allow")).toBe("GET, PUT");
  expect(automatic.HEAD().status).toBe(405);
  expect(await automatic.HEAD().text()).toBe("");
  expect(receipt.PUT().headers.get("allow")).toBe("GET");
  expect(receipt.OPTIONS().status).toBe(405);
});
