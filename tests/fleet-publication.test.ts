import { createHash, sign } from "node:crypto";
import { readFileSync } from "node:fs";
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
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { canonicalFleetRequest } from "@/lib/fleet-signature";
import { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay";
import {
  readFleetSharingMode,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  at,
  NOW,
  participatingDevice,
  sharedAccounts,
} from "./helpers/fleet-shared-admission";
import { pairDevice, waitUntilBlockedBy } from "./helpers/fleet-sharing";

process.env.DATABASE_URL = TEST_URL;
const { GET, PUT } = await import("@/app/api/fleet/v1/snapshot/route");
const PATH = "/api/fleet/v1/snapshot";
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
    rows?: { character_id: number; dps: number; ewar: string[] }[];
    format?: string | null;
    issuedAt?: string;
  } = {},
) {
  const method = opts.rows ? "PUT" : "GET";
  const body = opts.rows
    ? Buffer.from(JSON.stringify({ protocol: 1, rows: opts.rows }))
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
  if (opts.format !== null && method === "GET")
    headers.set("X-Fleet-Snapshot-Format", opts.format ?? "publication-v1");
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
      .update("fleet-snapshot-publication-v1\n" + canonical)
      .digest("hex"),
  );
  expect(response.headers.get("x-fleet-snapshot-format")).toBe("publication-v1");
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
async function legacy() {
  const account = await seedAccount(ctx.db, { tier: "member" });
  const ch = await seedCharacter(ctx.db, testConfig(), {
    id: 90000001,
    accountId: account.id,
    scopes: [FLEET_READ_SCOPE],
  });
  // Legacy compatibility ONLY. Shared evidence below always runs realSource.
  await ctx.db.insert(fleetEligibility).values({
    characterId: ch.id,
    accountId: account.id,
    fleetId: 123,
    rosterCharacterIds: [ch.id],
    verifiedAt: NOW,
    expiresAt: at(60000),
    outcomeCode: "ok",
  });
  const device = await pairDevice(ctx.db, account.id, NOW);
  const rows = [{ character_id: ch.id, dps: 77, ewar: [] }];
  expect((await PUT(request(device, 1, { rows }))).status).toBe(200);
  return { device, ch, rows };
}

it("stamps the unchanged legacy PUT but preserves exact old JSON and read identity", async () => {
  const { device, ch, rows } = await legacy();
  const before = await retained();
  expect(before.rows[0].publicationId).toMatch(UUID4);
  const response = await GET(request(device, 2, { format: null }));
  expect(response.status).toBe(200);
  noExtension(response);
  expect(await response.json()).toEqual({
    protocol: 1,
    rows: [
      {
        character_id: ch.id,
        character_name: ch.name,
        dps: 77,
        ewar: [],
        state: "live",
        age_ms: 0,
      },
    ],
  });
  expect((await retained()).rows).toEqual(before.rows);
  vi.setSystemTime(at(3000));
  expect((await PUT(request(device, 3, { rows }))).status).toBe(200);
  expect((await retained()).rows[0].publicationId).not.toBe(before.rows[0].publicationId);
});

it("disabled opt-in refuses before legacy gate/pruning/cadence and leaves every retained value untouched", async () => {
  const { device } = await legacy();
  vi.setSystemTime(at(13000)); // An admitted legacy read would now prune this row.
  const before = await retained();
  const req = request(device, 2);
  const response = await GET(req);
  expect(response.status).toBe(503);
  noExtension(response);
  expect(await response.json()).toEqual({ protocol: 1, error: "feature_disabled" });
  expect(await retained()).toEqual(before);
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: device.sessionId,
      revision: 1,
      requireSharedMode: true,
      now: at(13000),
    }),
  ).toEqual({ ok: false, code: "feature_disabled" });
  expect(await retained()).toEqual(before);
});

it.each([
  ["publication-v2", "update_required"],
  ["PUBLICATION-V1", "update_required"],
  ["", "bad_headers"],
  ["publication-v1, publication-v1", "bad_headers"],
  ["publication v1", "bad_headers"],
  ["publication-v1;foo", "bad_headers"],
])("negotiation %j fails closed without consuming revision", async (format, code) => {
  const { device } = await legacy();
  const before = await retained();
  const response = await GET(request(device, 2, { format }));
  expect(response.status).toBe(400);
  noExtension(response);
  expect(await response.json()).toEqual({ protocol: 1, error: code });
  expect(await retained()).toEqual(before);
});

it("duplicate request header lines and unsigned selectors are rejected, authentication still precedes success", async () => {
  const { device } = await legacy();
  const before = await retained();
  const duplicate = request(device, 2);
  duplicate.headers.append("x-fleet-snapshot-format", "publication-v1");
  expect((await GET(duplicate)).status).toBe(400);
  const query = request(device, 2);
  const selected = new NextRequest(query.url + "?fleet_id=123", {
    headers: query.headers,
  });
  expect((await GET(selected)).status).toBe(400);
  const tampered = request(device, 2);
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
    const req = p
      ? request(p.a, 4)
      : request((await legacy()).device, 2, { format: null });
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
      expect(JSON.parse(response.body)).toEqual({ protocol: 1, error: "bad_headers" });
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
    const device = p ? p.a : (await legacy()).device;
    let revision = p ? 4 : 2;
    for (const framing of [[], ["Content-Length", "0"], ["Content-Length", "00"]]) {
      const req = request(device, revision++, {
        format: publication ? "publication-v1" : null,
      });
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
      if (publication)
        expectBinding(
          new Response(response.body, {
            headers: response.headers as Record<string, string>,
          }),
          req,
        );
      else {
        expect(response.headers["x-fleet-snapshot-format"]).toBeUndefined();
        expect(response.headers["x-fleet-request-binding"]).toBeUndefined();
        const payload = JSON.parse(response.body) as { rows: Record<string, unknown>[] };
        expect(Object.keys(payload.rows[0]).sort()).toEqual([
          "age_ms",
          "character_id",
          "character_name",
          "dps",
          "ewar",
          "state",
        ]);
      }
      vi.setSystemTime(new Date(Date.now() + 500));
    }
  },
);

it("real Node framing parser rejects malformed/duplicate length before invoking the adapter", async () => {
  const req = request((await legacy()).device, 2, { format: null });
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
  const req = request((await legacy()).device, 2, { format: null });
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
    expect(JSON.parse(response.body)).toEqual({ protocol: 1, error: "bad_headers" });
    expect(await retained()).toEqual(before);
  }
});

it("real source worker authority admits signed shared PUT/GET, rotates equal metrics independently, and never stamps on read", async () => {
  const p = await sharedAccounts(ctx.db);
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
  const rows = p.alts
    .slice(0, 2)
    .map((ch) => ({ character_id: ch.id, dps: 77, ewar: [] }));
  expect((await PUT(request(p.b, 3, { rows }))).status).toBe(200);
  const first = await retained();
  expect(first.rows).toHaveLength(2);
  for (const row of first.rows) expect(row.publicationId).toMatch(UUID4);
  expect(new Set(first.rows.map((r) => r.publicationId)).size).toBe(2);
  const req = request(p.a, 4, { issuedAt: "2026-09-07T12:00:02.500+00:00" });
  req.headers.set("X-Fleet-Request-Binding", "0".repeat(64)); // Not an authority input.
  const response = await GET(req);
  expect(response.status).toBe(200);
  expectBinding(response, req);
  const json = await response.json();
  expect(json).toEqual({
    protocol: 1,
    rows: first.rows.map((r, i) => ({
      character_id: r.characterId,
      character_name: p.alts[i].name,
      dps: 77,
      ewar: [],
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
  expect((await PUT(request(p.b, 4, { rows }))).status).toBe(200);
  const second = await retained();
  expect(new Set([...first.rows, ...second.rows].map((r) => r.publicationId)).size).toBe(
    4,
  );
  vi.setSystemTime(at(3500));
  expect((await PUT(request(p.b, 5, { rows: [] }))).status).toBe(200);
  const emptyReq = request(p.a, 6);
  const empty = await GET(emptyReq);
  expect(empty.status).toBe(200);
  expectBinding(empty, emptyReq);
  expect(await empty.json()).toEqual({ protocol: 1, rows: [] });
  vi.setSystemTime(at(4000));
  expect((await PUT(request(p.b, 6, { rows }))).status).toBe(200);
  const third = await retained();
  expect(
    new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.publicationId))
      .size,
  ).toBe(6);
});

it("nullable migration has no default/backfill/index and negotiated serialization alone withholds unstamped rows", async () => {
  const column = await ctx.pool.query(
    "select is_nullable, column_default, data_type from information_schema.columns where table_name = 'fleet_telemetry_row' and column_name = 'publication_id'",
  );
  expect(column.rows).toEqual([
    { is_nullable: "YES", column_default: null, data_type: "uuid" },
  ]);
  const indexes = await ctx.pool.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where tablename = 'fleet_telemetry_row'",
  );
  expect(indexes.rows.every((r) => !r.indexdef.includes("publication_id"))).toBe(true);
  const p = await sharedAccounts(ctx.db);
  expect(
    (
      await PUT(
        request(p.b, 3, { rows: [{ character_id: p.alts[0].id, dps: 77, ewar: [] }] }),
      )
    ).status,
  ).toBe(200);
  // Simulate retained pre-migration payload, not eligibility or a fabricated write ID.
  await ctx.db.update(fleetTelemetryRow).set({ publicationId: null });
  const before = await retained();
  const req = request(p.a, 4);
  const response = await GET(req);
  expect(response.status).toBe(200);
  expectBinding(response, req);
  expect(await response.json()).toEqual({ protocol: 1, rows: [] });
  vi.setSystemTime(at(3000));
  const legacyResponse = await GET(request(p.a, 5, { format: null }));
  noExtension(legacyResponse);
  const json = (await legacyResponse.json()) as { rows: Record<string, unknown>[] };
  expect(json.rows).toHaveLength(1);
  expect(Object.keys(json.rows[0]).sort()).toEqual([
    "age_ms",
    "character_id",
    "character_name",
    "dps",
    "ewar",
    "state",
  ]);
  expect((await retained()).rows).toEqual(before.rows);
  expect((await retained()).leases).toEqual(before.leases);
});

it("atomic ownership/eligibility/lease/cadence/replay refusals preserve prior IDs, leases and revisions", async () => {
  const p = await sharedAccounts(ctx.db);
  const rival = await participatingDevice(ctx.db, p.participant.id);
  const rows = p.alts
    .slice(0, 2)
    .map((ch) => ({ characterId: ch.id, dps: 77, ewar: [] as const }));
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      rows,
      now: at(2500),
    }),
  ).toEqual({ ok: true });
  const before = await retained();
  for (const args of [
    {
      sessionId: p.b.sessionId,
      revision: 4,
      rows: [...rows, { characterId: p.boss.id, dps: 0, ewar: [] as const }],
    },
    {
      sessionId: p.b.sessionId,
      revision: 4,
      rows: [...rows, { characterId: p.alts[2].id, dps: 0, ewar: [] as const }],
    },
    { sessionId: rival.sessionId, revision: 3, rows },
    { sessionId: p.b.sessionId, revision: 3, rows },
    { sessionId: p.b.sessionId, revision: 4, rows: [rows[0], rows[0]] },
  ]) {
    expect((await replaceDeviceProjection(ctx.db, { ...args, now: at(3000) })).ok).toBe(
      false,
    );
    expect(await retained()).toEqual(before);
  }
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      rows,
      now: at(2600),
    }),
  ).toEqual({ ok: false, code: "rate_limited" });
  expect(await retained()).toEqual(before);
});

it("outer retry rolls back private candidate IDs and retries the complete publication", async () => {
  const p = await sharedAccounts(ctx.db);
  const rows = p.alts
    .slice(0, 2)
    .map((ch) => ({ characterId: ch.id, dps: 77, ewar: [] as const }));
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      rows,
      now: at(2500),
    }),
  ).toEqual({ ok: true });
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
    }),
  ).toEqual({ ok: true });
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
          request(p.b, 3, { rows: [{ character_id: p.alts[0].id, dps: 77, ewar: [] }] }),
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
        requireSharedMode: true,
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
