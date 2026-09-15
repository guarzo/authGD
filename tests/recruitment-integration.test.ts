import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { session } from "@/db/schema";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { RECRUITMENT_SCOPES, type RecruitmentExport } from "@/core/recruitment-evidence";
import { getConfig } from "@/config";
import { createSession } from "@/services/session";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { BASE_ENV } from "./helpers/env";

Object.assign(process.env, BASE_ENV, {
  DATABASE_URL: TEST_URL,
  APP_BASE_URL: "https://auth.example",
  SYNC_MODE: "live",
  EVE_SSO_SCOPES: RECRUITMENT_SCOPES.join(" "),
});
const { POST } = await import("@/app/admin/accounts/[id]/recruitment/route");
const server = setupServer();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let sign: (id: number) => Promise<string>;
let jwk: Record<string, unknown>;
const date = "2026-09-01T00:00:00Z";

beforeAll(async () => {
  ctx = await setupTestDb();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(publicKey)), alg: "RS256" };
  sign = (id) =>
    new SignJWT({ name: `Pilot ${id}`, owner: `oh-${id}`, scp: [...RECRUITMENT_SCOPES] })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject(`CHARACTER:EVE:${id}`)
      .setExpirationTime("5m")
      .sign(privateKey);
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await ctx.cleanup();
});

it("bounds the initial admin session-touch lock wait before collection", async () => {
  const admin = await seedAccount(ctx.db, { isAdmin: true });
  const applicant = await seedAccount(ctx.db, { tier: "pending" });
  const sid = await createSession(ctx.db, admin.id);
  await ctx.db
    .update(session)
    .set({ lastSeenAt: new Date(0) })
    .where(eq(session.accountId, admin.id));
  const held = await ctx.pool.connect();
  await held.query("begin");
  await held.query("select id from session where account_id = $1 for update", [admin.id]);
  let watchdogReleased = false;
  const watchdog = setTimeout(() => {
    watchdogReleased = true;
    void held.query("rollback");
  }, 7000);
  try {
    const req = new NextRequest(
      `https://auth.example/admin/accounts/${applicant.id}/recruitment`,
      { method: "POST", headers: { origin: "https://auth.example" } },
    );
    req.cookies.set(getConfig().sessionCookieName, sid);
    const response = await POST(req, { params: Promise.resolve({ id: applicant.id }) });
    expect(response.status).toBe(503);
    expect(
      watchdogReleased,
      "the route should time out without needing the blocking transaction released",
    ).toBe(false);
  } finally {
    clearTimeout(watchdog);
    await held.query("rollback");
    held.release();
  }
}, 15000);

it("collects two linked characters through the real admin route and imports their evidence for review", async () => {
  const cfg = getConfig();
  const admin = await seedAccount(ctx.db, { isAdmin: true });
  const applicant = await seedAccount(ctx.db, { tier: "pending" });
  const ids = [90000001, 90000002];
  const refreshSecret = (id: number) => `test-refresh-secret-${id}`;
  for (const id of ids)
    await seedCharacter(ctx.db, cfg, {
      id,
      accountId: applicant.id,
      refreshToken: refreshSecret(id),
      scopes: [...RECRUITMENT_SCOPES],
    });
  const sid = await createSession(ctx.db, admin.id);
  const called: string[] = [];
  const userAgents: (string | null)[] = [];
  server.use(
    http.get("https://login.eveonline.com/oauth/jwks", () =>
      HttpResponse.json({ keys: [jwk] }),
    ),
    http.post("https://login.eveonline.com/v2/oauth/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      return HttpResponse.json({
        access_token: await sign(
          ids.find((id) => refreshSecret(id) === body.get("refresh_token"))!,
        ),
        refresh_token: "rotated-test-token",
      });
    }),
    http.get("https://esi.evetech.net/characters/:id/*", ({ request, params }) => {
      const url = new URL(request.url);
      called.push(url.pathname);
      userAgents.push(request.headers.get("user-agent"));
      if (!url.pathname.endsWith("/corporationhistory"))
        expect(request.headers.get("authorization")).toMatch(/^Bearer ey/);
      const headers = { "x-pages": "1", "content-type": "application/json" };
      if (url.pathname.endsWith("/corporationhistory"))
        return HttpResponse.json(
          [{ record_id: 1, corporation_id: 1000001, start_date: date }],
          { headers },
        );
      if (url.pathname.endsWith("/wallet/journal"))
        return new HttpResponse(
          `[{"id":9007199254740993,"date":"${date}","ref_type":"player_donation","description":"transfer","amount":9007199254740993.01}]`,
          { headers },
        );
      if (url.pathname.endsWith("/wallet/transactions"))
        return HttpResponse.json([], { headers });
      if (url.pathname.endsWith("/contracts"))
        return HttpResponse.json(
          [
            {
              contract_id: 42,
              issuer_id: Number(params.id),
              issuer_corporation_id: 1000001,
              assignee_id: 0,
              acceptor_id: 0,
              type: "item_exchange",
              status: "outstanding",
              for_corporation: false,
              availability: "public",
              date_issued: date,
              date_expired: date,
            },
          ],
          { headers },
        );
      if (url.pathname.endsWith("/items"))
        return HttpResponse.json(
          [
            {
              record_id: 77,
              type_id: 34,
              quantity: 2,
              is_singleton: false,
              is_included: true,
            },
          ],
          { headers },
        );
      if (url.pathname.endsWith("/assets"))
        return HttpResponse.json(
          [
            {
              item_id: 1000000000001,
              type_id: 34,
              quantity: 2,
              location_id: 60000001,
              location_type: "station",
              location_flag: "Hangar",
              is_singleton: false,
            },
          ],
          { headers },
        );
      if (url.pathname.endsWith("/skills"))
        return HttpResponse.json(
          {
            skills: [
              {
                skill_id: 3300,
                active_skill_level: 3,
                trained_skill_level: 3,
                skillpoints_in_skill: 8000,
              },
            ],
            total_sp: 8000,
          },
          { headers },
        );
      if (url.pathname.endsWith("/skillqueue"))
        return HttpResponse.json(
          [{ queue_position: 0, skill_id: 3300, finished_level: 4 }],
          { headers },
        );
      throw new Error("Unexpected ESI path in integration test");
    }),
  );
  const req = new NextRequest(
    `https://auth.example/admin/accounts/${applicant.id}/recruitment`,
    { method: "POST", headers: { origin: "https://auth.example" } },
  );
  req.cookies.set(cfg.sessionCookieName, sid);
  const response = await POST(req, { params: Promise.resolve({ id: applicant.id }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  const text = await response.text();
  const snapshot = JSON.parse(text) as RecruitmentExport;
  for (const userAgent of userAgents) expect(userAgent).toContain(cfg.esiContact);
  expect(snapshot.manifest.includedCharacterIds).toEqual(ids.map(String));
  expect(snapshot.manifest.datasets).toHaveLength(12);
  expect(
    snapshot.manifest.datasets.every((d: { status: string }) => d.status === "complete"),
  ).toBe(true);
  expect(called).toHaveLength(16);
  expect(text).not.toContain("rotated-test-token");
  for (const id of ids) {
    expect(text).not.toContain(`oh-${id}`);
    expect(text).not.toContain(refreshSecret(id));
  }

  const root = await mkdtemp(join(tmpdir(), "authgd-collection-integration-"));
  try {
    const source = join(root, "export.json");
    const interview = join(root, "interview.txt");
    const out = join(root, "bundle");
    await writeFile(source, text);
    await writeFile(
      interview,
      "Recruiter: What was that transfer?\nApplicant: A disclosed gift.\n",
    );
    const imported = spawnSync(
      process.execPath,
      [
        resolve(".pi/skills/recruitment-review/scripts/import-export.mjs"),
        source,
        "--interview",
        interview,
        "--prepared-by",
        "Recruiter",
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    expect(imported.status, imported.stderr).toBe(0);
    const packet = JSON.parse(imported.stdout) as {
      coverage: { datasets: RecruitmentExport["manifest"]["datasets"] };
      records: (RecruitmentExport["records"][number] & { verification: string })[];
    };
    expect(packet.coverage.datasets).toHaveLength(12);
    expect(
      packet.records.filter((r: { category: string }) => r.category === "wallet"),
    ).toHaveLength(2);
    expect(packet.records.find((r) => r.category === "wallet")?.data.amount).toBe(
      "9007199254740993.01",
    );
    expect(
      packet.records.every(
        (r: { verification: string }) => r.verification === "unverified",
      ),
    ).toBe(true);
    expect(JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))).toEqual(
      snapshot.manifest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
