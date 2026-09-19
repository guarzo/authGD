import { createHash, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { CombatRow } from "@/core/fleet-api-v2";
import {
  combatAccounts as sharedAccounts,
  combatDevice as participatingDevice,
  combatRow,
} from "./helpers/fleet-combat";
import { once } from "node:events";
import { createServer } from "node:http";
import { NodeNextRequest } from "next/dist/server/base-http/node";
import { NextRequestAdapter } from "next/dist/server/web/spec-extension/adapters/next-request";
import { getFleetHttp } from "./helpers/fleet-http";
import { FleetLifecycleRetry } from "@/services/fleet-lifecycle";
import * as keyIdentity from "@/services/fleet-key-identity";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  fleetDeviceSession,
  fleetEligibility,
  fleetSharingGate,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { canonicalFleetRequest } from "@/lib/fleet-signature";
import { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay";
import {
  readFleetSharingMode,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { at } from "./helpers/fleet-shared-admission";
import { pairDevice, waitUntilBlockedBy } from "./helpers/fleet-sharing";

process.env.DATABASE_URL = TEST_URL;
const { GET, PUT } = await import("@/app/api/fleet/v2/snapshot/route");
const PATH = "/api/fleet/v2/snapshot";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(2500));
  // Deterministic boundary ages. The separate source-routes/browser integration
  // exercises the actual PostgreSQL clock with real worker-generated evidence.
  vi.spyOn(keyIdentity, "fleetDatabaseNow").mockImplementation(
    async (_tx, now) => now ?? new Date(),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => ctx.cleanup());

function request(
  p: Awaited<ReturnType<typeof pairDevice>>,
  revision: number,
  opts: {
    format?: string | null;
    issuedAt?: string;
  } & (
    | { rows: CombatRow[]; sampledAtMs: number }
    | { rows?: undefined; sampledAtMs?: undefined }
  ) = {},
) {
  const method = opts.rows ? "PUT" : "GET";
  const body = opts.rows
    ? Buffer.from(
        JSON.stringify({ protocol: 2, sampled_at_ms: opts.sampledAtMs, rows: opts.rows }),
      )
    : Buffer.alloc(0);
  const issuedAt = opts.issuedAt ?? new Date().toISOString();
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const canonical = canonicalFleetRequest({
    protocol: 1,
    method,
    path: PATH,
    sessionId: p.sessionId,
    issuedAt,
    revision,
    bodySha256,
  });
  const headers = new Headers({
    "X-Fleet-Session": p.sessionId,
    "X-Fleet-Issued-At": issuedAt,
    "X-Fleet-Revision": String(revision),
    "X-Fleet-Body-SHA256": bodySha256,
    "X-Fleet-Signature": sign(null, canonical, p.privateKey).toString("base64url"),
  });
  if (opts.format !== undefined && opts.format !== null && method === "GET")
    headers.set("X-Fleet-Snapshot-Format", opts.format);
  return new NextRequest(`https://relay.test${PATH}`, {
    method,
    headers,
    ...(method === "PUT" ? { body } : {}),
  });
}

function expectBinding(response: Response, req: NextRequest) {
  const h = req.headers;
  // Independent transcription of the wire preimage, not the production helper.
  const canonical = [
    "fleet-v1",
    "GET",
    PATH,
    h.get("x-fleet-session"),
    h.get("x-fleet-issued-at"),
    h.get("x-fleet-revision"),
    h.get("x-fleet-body-sha256"),
  ].join("\n");
  expect(response.headers.get("x-fleet-request-binding")).toBe(
    createHash("sha256")
      .update("fleet-api-v2\n" + canonical)
      .digest("hex"),
  );
  expect(response.headers.has("x-fleet-snapshot-format")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
}
function noExtension(response: Response) {
  expect(response.headers.has("x-fleet-request-binding")).toBe(false);
  expect(response.headers.has("x-fleet-snapshot-format")).toBe(false);
}
async function retained() {
  return {
    rows: await ctx.db
      .select()
      .from(fleetTelemetryRow)
      .orderBy(fleetTelemetryRow.characterId),
    leases: await ctx.db
      .select()
      .from(fleetPublisherLease)
      .orderBy(fleetPublisherLease.characterId),
    sessions: await ctx.db
      .select()
      .from(fleetDeviceSession)
      .orderBy(fleetDeviceSession.id),
  };
}
const wireRow = (id: number): CombatRow => ({
  character_id: id,
  outgoing_dps: 77,
  incoming_dps: null,
  activity_age_ms: 0,
  effects: [],
});
async function publishedFixture() {
  const p = await sharedAccounts(ctx.db);
  const device = p.b;
  const ch = p.alts[0];
  const rows = [wireRow(ch.id)];
  expect(
    (await PUT(request(device, 3, { sampledAtMs: at(2500).getTime(), rows }))).status,
  ).toBe(200);
  return { device, ch, rows };
}

it("required v2 combat preserves exact closed JSON, original sample and read identity", async () => {
  const { device, ch, rows } = await publishedFixture();
  const before = await retained();
  expect(before.rows[0].publicationId).toMatch(UUID4);
  const req = request(device, 4);
  const response = await GET(req);
  expect(response.status).toBe(200);
  expectBinding(response, req);
  expect(await response.json()).toEqual({
    protocol: 2,
    server_time_ms: at(2500).getTime(),
    rows: [
      {
        character_id: ch.id,
        character_name: ch.name,
        outgoing_dps: 77,
        incoming_dps: null,
        activity_age_ms: 0,
        effects: [],
        state: "live",
        age_ms: 0,
        publication_id: before.rows[0].publicationId,
      },
    ],
  });
  expect((await retained()).rows).toEqual(before.rows);
  vi.setSystemTime(at(3000));
  expect(
    (await PUT(request(device, 5, { sampledAtMs: at(2500).getTime(), rows }))).status,
  ).toBe(200);
  expect((await retained()).rows[0].publicationId).not.toBe(before.rows[0].publicationId);
  expect((await retained()).rows[0].sampledAtMs).toBe(at(2500).getTime());
});

it("disabled shared gate refuses before pruning/cadence and leaves every retained value untouched", async () => {
  const { device } = await publishedFixture();
  // Negative retained-state fixture: disable admission without running cleanup.
  await ctx.db.update(fleetSharingGate).set({ enabled: false });
  vi.setSystemTime(at(13000)); // An admitted legacy read would now prune this row.
  const before = await retained();
  const req = request(device, 4);
  const response = await GET(req);
  expect(response.status).toBe(503);
  noExtension(response);
  expect(await response.json()).toEqual({ protocol: 2, error: "feature_disabled" });
  expect(await retained()).toEqual(before);
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: device.sessionId,
      revision: 1,
      now: at(13000),
    }),
  ).toEqual({ ok: false, code: "feature_disabled" });
  expect(await retained()).toEqual(before);
});

it.each([
  ["publication-v2", "bad_headers"],
  ["PUBLICATION-V1", "bad_headers"],
  ["", "bad_headers"],
  ["publication-v1, publication-v1", "bad_headers"],
  ["publication v1", "bad_headers"],
  ["publication-v1;foo", "bad_headers"],
])(
  "legacy format header %j fails closed without consuming revision",
  async (format, code) => {
    const { device } = await publishedFixture();
    const before = await retained();
    const response = await GET(request(device, 4, { format }));
    expect(response.status).toBe(400);
    noExtension(response);
    expect(await response.json()).toEqual({ protocol: 2, error: code });
    expect(await retained()).toEqual(before);
  },
);

it("duplicate request header lines and unsigned selectors are rejected, authentication still precedes success", async () => {
  const { device } = await publishedFixture();
  const before = await retained();
  const duplicate = request(device, 4);
  duplicate.headers.append("x-fleet-session", device.sessionId);
  expect((await GET(duplicate)).status).toBe(400);
  const query = request(device, 4);
  const selected = new NextRequest(query.url + "?fleet_id=123", {
    headers: query.headers,
  });
  expect((await GET(selected)).status).toBe(400);
  const tampered = request(device, 4);
  tampered.headers.set("x-fleet-signature", "A".repeat(86));
  const denied = await GET(tampered);
  expect(denied.status).toBe(401);
  noExtension(denied);
  expect(await retained()).toEqual(before);
});

/** The installed adapter deliberately makes GET.body null, even when Node has
 * received bytes. The previous overridden-body unit test bypassed this boundary.
 * Capture only public framing/body fixtures, not signed credentials. */
async function throughNodeAdapter(req: NextRequest, framing: string[], body = "") {
  const observations: {
    body: string;
    adaptedBody: ReadableStream | null;
    contentLength: string | null;
    transferEncoding: string | null;
  }[] = [];
  const active: Promise<void>[] = [];
  const server = createServer((incoming, outgoing) => {
    const work = (async () => {
      const adapted = NextRequestAdapter.fromNodeNextRequest(
        new NodeNextRequest(incoming),
        new AbortController().signal,
      );
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      await once(incoming, "end");
      observations.push({
        body: Buffer.concat(chunks).toString(),
        adaptedBody: adapted.body,
        contentLength: adapted.headers.get("content-length"),
        transferEncoding: adapted.headers.get("transfer-encoding"),
      });
      const response = await GET(adapted);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    })();
    active.push(work);
    void work.catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const response = await getFleetHttp(
      `http://127.0.0.1:${address.port}${PATH}`,
      req.headers,
      framing,
      body,
    );
    await Promise.all(active);
    return { response, observations };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all(active);
  }
}

it.each([false, true])(
  "real Node/installed Next adapter refuses body framing without read mutations (publication=%s)",
  async (publication) => {
    const p = publication ? await sharedAccounts(ctx.db) : null;
    const req = p ? request(p.a, 4) : request((await publishedFixture()).device, 4);
    // Intentionally EMPTY digest and valid EMPTY-body signature with wire bytes.
    expect(req.headers.get("x-fleet-body-sha256")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const before = await retained();
    for (const framing of [
      ["Content-Length", "2"],
      ["Transfer-Encoding", "chunked"],
    ]) {
      const { response, observations } = await throughNodeAdapter(req, framing, "{}");
      expect(observations).toEqual([
        {
          body: "{}",
          adaptedBody: null,
          contentLength: framing[0] === "Content-Length" ? "2" : null,
          transferEncoding: framing[0] === "Transfer-Encoding" ? "chunked" : null,
        },
      ]);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ protocol: 2, error: "bad_headers" });
      expect(response.headers["x-fleet-snapshot-format"]).toBeUndefined();
      expect(response.headers["x-fleet-request-binding"]).toBeUndefined();
      expect(await retained()).toEqual(before);
    }
  },
);

it.each([false, true])(
  "real Node/installed Next adapter preserves absent/zero-length framing (publication=%s)",
  async (publication) => {
    const p = publication ? await sharedAccounts(ctx.db) : null;
    const device = p ? p.a : (await publishedFixture()).device;
    let revision = 4;
    for (const framing of [[], ["Content-Length", "0"], ["Content-Length", "00"]]) {
      const req = request(device, revision++);
      const { response, observations } = await throughNodeAdapter(req, framing);
      expect(observations).toEqual([
        {
          body: "",
          adaptedBody: null,
          contentLength: framing[1] ?? null,
          transferEncoding: null,
        },
      ]);
      expect(response.status).toBe(200);
      expectBinding(
        new Response(response.body, {
          headers: response.headers as Record<string, string>,
        }),
        req,
      );
      const payload = JSON.parse(response.body) as {
        protocol: number;
        server_time_ms: number;
        rows: Record<string, unknown>[];
      };
      expect(payload.protocol).toBe(2);
      expect(payload.server_time_ms).toBe(Date.now());
      expect(payload.rows).toHaveLength(publication ? 0 : 1);
      if (!publication)
        expect(Object.keys(payload.rows[0]).sort()).toEqual([
          "activity_age_ms",
          "age_ms",
          "character_id",
          "character_name",
          "effects",
          "incoming_dps",
          "outgoing_dps",
          "publication_id",
          "state",
        ]);
      vi.setSystemTime(new Date(Date.now() + 500));
    }
  },
);

it("real Node framing parser rejects malformed/duplicate length before invoking the adapter", async () => {
  const req = request((await publishedFixture()).device, 4);
  const before = await retained();
  for (const framing of [
    ["Content-Length", "-1"],
    ["Content-Length", "garbage"],
    ["Content-Length", "0, 0"],
    ["Content-Length", "0", "Content-Length", "0"],
    ["Content-Length", "0", "Transfer-Encoding", "chunked"],
  ]) {
    const { response, observations } = await throughNodeAdapter(req, framing);
    expect(response.status).toBe(400);
    expect(observations).toEqual([]); // Node owns these refusals, not our JSON route.
    expect(response.headers["x-fleet-request-binding"]).toBeUndefined();
    expect(await retained()).toEqual(before);
  }
});

it("refuses transfer framing even for an empty chunk sequence or duplicate transfer lines", async () => {
  const req = request((await publishedFixture()).device, 4);
  const before = await retained();
  for (const framing of [
    ["Transfer-Encoding", "chunked"],
    ["Transfer-Encoding", "gzip", "Transfer-Encoding", "chunked"],
  ]) {
    const { response, observations } = await throughNodeAdapter(req, framing);
    expect(observations).toEqual([
      {
        body: "",
        adaptedBody: null,
        contentLength: null,
        transferEncoding: framing.length === 2 ? "chunked" : "gzip, chunked",
      },
    ]);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ protocol: 2, error: "bad_headers" });
    expect(await retained()).toEqual(before);
  }
});

it("real source worker authority admits signed shared PUT/GET, rotates equal metrics independently, and never stamps on read", async () => {
  const p = await sharedAccounts(ctx.db);
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
  const rows = p.alts.slice(0, 2).map((ch) => wireRow(ch.id));
  expect(
    (await PUT(request(p.b, 3, { rows, sampledAtMs: at(2500).getTime() }))).status,
  ).toBe(200);
  const first = await retained();
  expect(first.rows).toHaveLength(2);
  for (const row of first.rows) expect(row.publicationId).toMatch(UUID4);
  expect(new Set(first.rows.map((r) => r.publicationId)).size).toBe(2);
  const noncanonical = request(p.a, 4, { issuedAt: "2026-09-07T12:00:02.500+00:00" });
  expect((await GET(noncanonical)).status).toBe(400);
  const forged = request(p.a, 4);
  forged.headers.set("X-Fleet-Request-Binding", "0".repeat(64));
  expect((await GET(forged)).status).toBe(400);
  expect(await retained()).toEqual(first);
  const req = request(p.a, 4);
  const response = await GET(req);
  expect(response.status).toBe(200);
  expectBinding(response, req);
  const json = await response.json();
  expect(json).toEqual({
    protocol: 2,
    server_time_ms: at(2500).getTime(),
    rows: first.rows.map((r, i) => ({
      character_id: r.characterId,
      character_name: p.alts[i].name,
      outgoing_dps: 77,
      incoming_dps: null,
      activity_age_ms: 0,
      effects: [],
      state: "live",
      age_ms: 0,
      publication_id: r.publicationId,
    })),
  });
  expect((await retained()).rows).toEqual(first.rows);
  expect((await retained()).leases).toEqual(first.leases);
  // Same publication, later receipt: age grows and ID does NOT rotate.
  vi.setSystemTime(at(3000));
  const again = await GET(request(p.a, 5));
  expect(
    (
      (await again.json()) as { rows: { age_ms: number; publication_id: string }[] }
    ).rows.map((r) => [r.age_ms, r.publication_id]),
  ).toEqual(first.rows.map((r) => [500, r.publicationId]));
  expect(
    (await PUT(request(p.b, 4, { rows, sampledAtMs: at(2500).getTime() }))).status,
  ).toBe(200);
  const second = await retained();
  expect(new Set([...first.rows, ...second.rows].map((r) => r.publicationId)).size).toBe(
    4,
  );
  vi.setSystemTime(at(3500));
  expect((await PUT(request(p.b, 5, { rows: [], sampledAtMs: 0 }))).status).toBe(200);
  const emptyReq = request(p.a, 6);
  const empty = await GET(emptyReq);
  expect(empty.status).toBe(200);
  expectBinding(empty, emptyReq);
  expect(await empty.json()).toEqual({
    protocol: 2,
    server_time_ms: at(3500).getTime(),
    rows: [],
  });
  vi.setSystemTime(at(4000));
  expect(
    (await PUT(request(p.b, 6, { rows, sampledAtMs: at(2500).getTime() }))).status,
  ).toBe(200);
  const third = await retained();
  expect(
    new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.publicationId))
      .size,
  ).toBe(6);
});

it("required publication identity has no default/backfill/index and cannot admit unstamped rows", async () => {
  const column = await ctx.pool.query(
    "select is_nullable, column_default, data_type from information_schema.columns where table_name = 'fleet_telemetry_row' and column_name = 'publication_id'",
  );
  expect(column.rows).toEqual([
    { is_nullable: "NO", column_default: null, data_type: "uuid" },
  ]);
  const indexes = await ctx.pool.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where tablename = 'fleet_telemetry_row'",
  );
  expect(indexes.rows.every((r) => !r.indexdef.includes("publication_id"))).toBe(true);
  const p = await sharedAccounts(ctx.db);
  expect(
    (
      await PUT(
        request(p.b, 3, {
          sampledAtMs: at(2500).getTime(),
          rows: [wireRow(p.alts[0].id)],
        }),
      )
    ).status,
  ).toBe(200);
  const before = await retained();
  // The former nullable compatibility state is now rejected by the real DB.
  await expect(
    ctx.db.update(fleetTelemetryRow).set({ publicationId: sql`null` }),
  ).rejects.toMatchObject({ cause: { code: "23502" } });
  expect(await retained()).toEqual(before);
  const req = request(p.a, 4);
  const response = await GET(req);
  expect(response.status).toBe(200);
  expectBinding(response, req);
  expect(await response.json()).toMatchObject({
    protocol: 2,
    rows: [{ publication_id: before.rows[0].publicationId }],
  });
  vi.setSystemTime(at(3000));
  const secondReq = request(p.a, 5);
  const secondResponse = await GET(secondReq);
  expectBinding(secondResponse, secondReq);
  const json = (await secondResponse.json()) as { rows: Record<string, unknown>[] };
  expect(json.rows).toHaveLength(1);
  expect(Object.keys(json.rows[0]).sort()).toEqual([
    "activity_age_ms",
    "age_ms",
    "character_id",
    "character_name",
    "effects",
    "incoming_dps",
    "outgoing_dps",
    "publication_id",
    "state",
  ]);
  expect((await retained()).rows).toEqual(before.rows);
  expect((await retained()).leases).toEqual(before.leases);
});

it("atomic ownership/eligibility/lease/cadence/replay refusals preserve prior IDs, leases and revisions", async () => {
  const p = await sharedAccounts(ctx.db);
  const rival = await participatingDevice(ctx.db, p.participant.id);
  const rows = p.alts.slice(0, 2).map((ch) => combatRow(ch.id, 77));
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      rows,
      now: at(2500),
      sampledAtMs: at(2500).getTime(),
    }),
  ).toEqual({ ok: true, json: '{"protocol":2}' });
  const before = await retained();
  for (const args of [
    {
      sessionId: p.b.sessionId,
      revision: 4,
      rows: [...rows, combatRow(p.boss.id, 0)],
    },
    {
      sessionId: p.b.sessionId,
      revision: 4,
      rows: [...rows, combatRow(p.alts[2].id, 0)],
    },
    { sessionId: rival.sessionId, revision: 3, rows },
    { sessionId: p.b.sessionId, revision: 3, rows },
    { sessionId: p.b.sessionId, revision: 4, rows: [rows[0], rows[0]] },
  ]) {
    expect(
      (
        await replaceDeviceProjection(ctx.db, {
          ...args,
          now: at(3000),
          sampledAtMs: at(3000).getTime(),
        })
      ).ok,
    ).toBe(false);
    expect(await retained()).toEqual(before);
  }
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      rows,
      now: at(2600),
      sampledAtMs: at(2600).getTime(),
    }),
  ).toEqual({ ok: false, code: "rate_limited" });
  expect(await retained()).toEqual(before);
});

it("outer retry rolls back private candidate IDs and retries the complete publication", async () => {
  const p = await sharedAccounts(ctx.db);
  const rows = p.alts.slice(0, 2).map((ch) => combatRow(ch.id, 77));
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      rows,
      now: at(2500),
      sampledAtMs: at(2500).getTime(),
    }),
  ).toEqual({ ok: true, json: '{"protocol":2}' });
  const before = await retained();
  const original = ctx.db.transaction.bind(ctx.db);
  let candidates: (string | null)[] = [];
  vi.spyOn(ctx.db, "transaction")
    .mockImplementationOnce((work) =>
      original(async (tx) => {
        await work(tx);
        candidates = (await tx.select().from(fleetTelemetryRow)).map(
          (r) => r.publicationId,
        );
        // Exercise rollback AFTER candidate writes, at the actual outer boundary.
        throw new FleetLifecycleRetry();
      }),
    )
    .mockImplementationOnce(async (work) => {
      expect(await retained()).toEqual(before);
      return original(work);
    });
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      rows,
      now: at(3000),
      sampledAtMs: at(3000).getTime(),
    }),
  ).toEqual({ ok: true, json: '{"protocol":2}' });
  const after = await retained();
  expect(candidates).toHaveLength(2);
  expect(
    new Set([
      ...before.rows.map((r) => r.publicationId),
      ...candidates,
      ...after.rows.map((r) => r.publicationId),
    ]).size,
  ).toBe(6);
});

it("the actual additive SQL leaves a preexisting row and timestamp unstamped", async () => {
  const client = await ctx.pool.connect();
  try {
    await client.query("begin");
    // Session-local temporary table shadows the production table for this one
    // migration exercise; no applied migration or live table is rewound.
    await client.query(
      "create temporary table fleet_telemetry_row (character_id bigint, received_at timestamptz) on commit drop",
    );
    await client.query(
      "insert into fleet_telemetry_row values (1, '2026-01-01T00:00:00Z')",
    );
    await client.query(readFileSync("drizzle/0024_fleet_publication_id.sql", "utf8"));
    expect((await client.query("select * from fleet_telemetry_row")).rows).toEqual([
      {
        character_id: "1",
        received_at: new Date("2026-01-01T00:00:00Z"),
        publication_id: null,
      },
    ]);
  } finally {
    await client.query("rollback");
    client.release();
  }
});

it.each(["read first", "disable first"] as const)(
  "transactional mode-lock race: %s without legacy fallback",
  async (order) => {
    const p = await sharedAccounts(ctx.db);
    expect(
      (
        await PUT(
          request(p.b, 3, {
            sampledAtMs: at(2500).getTime(),
            rows: [wireRow(p.alts[0].id)],
          }),
        )
      ).status,
    ).toBe(200);
    const first = await retained();
    const mode = await readFleetSharingMode(ctx.db);
    const holder = await ctx.pool.connect();
    let read: ReturnType<typeof readFleetProjection> | undefined;
    let disable: ReturnType<typeof transitionFleetSharingMode> | undefined;
    const admit = () =>
      readFleetProjection(ctx.db, {
        sessionId: p.a.sessionId,
        revision: 4,
        now: at(2500),
      });
    const drain = () =>
      transitionFleetSharingMode(ctx.db, {
        enabled: false,
        expectedRevision: mode.revision,
        now: at(2500),
      });
    try {
      await holder.query("begin");
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await holder.query("select pg_advisory_xact_lock(2, hashint8(90000002))");
      if (order === "read first") read = admit();
      else disable = drain();
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      const waiting = (
        await ctx.pool.query<{ pid: number }>(
          "select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
          [pid],
        )
      ).rows;
      expect(waiting).toHaveLength(1);
      if (order === "read first") disable = drain();
      else read = admit();
      expect(await waitUntilBlockedBy(ctx.pool, waiting[0].pid)).toBe(true);
      await holder.query("commit");
      const result = await read;
      await disable;
      if (order === "read first")
        expect(result).toMatchObject({
          ok: true,
          rows: [{ publicationId: first.rows[0].publicationId }],
        });
      else expect(result).toEqual({ ok: false, code: "feature_disabled" });
      expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
      // Cryptographic preflight can return401 after the cutover has drained sessions.
      const after = await GET(request(p.a, 5));
      expect(after.status).toBe(401);
      noExtension(after);
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled([read, disable]);
    }
  },
  20000,
);
