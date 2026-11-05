import { execFileSync } from "node:child_process";
import { startCurrentDriver } from "./fleet-current-driver";
import * as configModule from "@/config";
import { once } from "node:events";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { chromium, type Page } from "@playwright/test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as database from "@/db";
import { fleetSourceIntent, fleetAutomaticConsent } from "@/db/schema";
import { createEsiClient, FLEET_READ_SCOPE } from "@/lib/esi/client";
import { createFleetSourceMemory } from "@/jobs/fleet-source";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { approvePairing } from "@/services/fleet-pairing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { dispatchOutbox } from "@/worker/dispatcher";
import { createQueues, QUEUES } from "@/worker/queues";
import { buildJobHandlers } from "@/worker/handlers";
import {
  createFleetSourceOwner,
  startFleetAutomaticWork,
  startFleetSourceScheduler,
  runFleetSourceTick,
} from "@/worker/fleet-source-scheduler";
import { setupTestDb, TEST_URL, truncateAll } from "../tests/helpers/db";
import { seedAccount, seedCharacter } from "../tests/helpers/seed";
import { testConfig } from "../tests/helpers/config";
import { pairDevice, reconcileFleetKeys } from "../tests/helpers/fleet-sharing";
import { withFleetResources } from "./fleet-resources";

type RouteModule = Record<
  string,
  (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>
>;
const modules = import.meta.glob("../src/app/api/fleet/v2/**/route.ts") as Record<
  string,
  () => Promise<RouteModule>
>;
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  const target = new URL(TEST_URL);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55463" ||
    target.pathname !== "/authgd_joint"
  )
    throw new Error("Explicit owned joint database on 55463 required");
  ctx = await setupTestDb();
  await truncateAll(ctx.db);
  vi.spyOn(database, "getDb").mockReturnValue(ctx.db);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
});

type Report = {
  ready?: boolean;
  page_ids: string[];
  result: unknown;
  pushes: string[][];
  bars: unknown[];
  states: Array<{
    metadata: { approved_capabilities: string[] };
    automatic: { enabled: boolean; readiness: string };
    enabled: boolean;
    [key: string]: unknown;
  }>;
  opened: string[][];
  rows: Array<
    Array<{ character_id: number; outgoing_dps: number; incoming_dps: number }>
  >;
  local: unknown;
};

it("current Api/client -> TLS -> v2 routes/DB/retained jobs: approve combat, automatic boss, remote DPS, restart and Off", async () =>
  withFleetResources(async (own) => {
    const checkout = process.env.E2E_WINGMAN_ROOT;
    const python = process.env.E2E_WINGMAN_PYTHON;
    if (!checkout || !python)
      throw new Error("Explicit current Wingman checkout and Python required");
    expect(resolve(checkout)).toBe(checkout);
    const expected = process.env.E2E_WINGMAN_COMMIT;
    if (!expected) throw new Error("Pin E2E_WINGMAN_COMMIT");
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim(),
    ).toBe(expected);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    const root = own(mkdtempSync(join(tmpdir(), "fleet-v2-current-")), (dir) =>
      rmSync(dir, { recursive: true, force: true }),
    );
    const cert = join(root, "cert.pem"),
      key = join(root, "key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    const errors: unknown[] = [],
      requests: string[] = [];
    const routes = await Promise.all(
      Object.entries(modules).map(async ([file, load]) => ({
        pattern: file.replace("../src/app", "").replace("/route.ts", ""),
        handlers: await load(),
      })),
    );
    const server = createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        void (async () => {
          if (req.url === "/favicon.ico") {
            res.writeHead(204).end();
            return;
          }
          if (req.url?.startsWith("/__wingman__/")) {
            const web = resolve(checkout, "wingman/web");
            const file = resolve(
              web,
              req.url.slice("/__wingman__/".length).split("?")[0],
            );
            if (!file.startsWith(web + "/")) throw new Error("Invalid owned UI path");
            const content = readFileSync(file);
            const mime = file.endsWith(".html")
              ? "text/html"
              : file.endsWith(".js")
                ? "text/javascript"
                : file.endsWith(".css")
                  ? "text/css"
                  : "application/octet-stream";
            res.writeHead(200, { "content-type": mime }).end(content);
            return;
          }
          requests.push(`${req.method} ${req.url}`);
          const parts = req.url!.split("/");
          const match = routes.find((r) => {
            const p = r.pattern.split("/");
            return (
              p.length === parts.length &&
              p.every((s, i) => s.startsWith("[") || s === parts[i])
            );
          });
          if (!match || !match.handlers[req.method!])
            throw new Error("Unexpected current route " + req.url);
          const params: Record<string, string> = {};
          match.pattern.split("/").forEach((s, i) => {
            if (s.startsWith("[")) params[s.slice(1, -1)] = parts[i];
          });
          const chunks: Uint8Array[] = [];
          for await (const chunk of req) {
            if (!(chunk instanceof Uint8Array)) throw new Error("Expected request bytes");
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks),
            headers = new Headers();
          for (let i = 0; i < req.rawHeaders.length; i += 2)
            headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
          const request = new NextRequest(`${origin}${req.url}`, {
            method: req.method,
            headers,
            ...(body.length ? { body: new Uint8Array(body) } : {}),
          });
          const response = await match.handlers[req.method!](request, {
            params: Promise.resolve(params),
          });
          const responseBody = Buffer.from(await response.arrayBuffer());
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(responseBody);
        })().catch((e) => {
          errors.push(e);
          res.writeHead(500).end();
        });
      },
    );
    own(
      server,
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const origin = `https://127.0.0.1:${port}`;
    const now = () => new Date();
    const cfg = { ...testConfig(), appBaseUrl: origin };
    vi.spyOn(configModule, "getConfig").mockReturnValue(cfg);
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: now(),
    });
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const pilot = await seedCharacter(ctx.db, cfg, {
      id: 991001,
      accountId: owner.id,
      scopes: [FLEET_READ_SCOPE],
      refreshToken: "owned-synthetic-refresh",
    });
    const alt = await seedCharacter(ctx.db, cfg, {
      id: 991002,
      accountId: member.id,
      scopes: [],
      refreshToken: null,
      tokenStatus: "missing",
    });
    const a = await pairDevice(ctx.db, owner.id, now(), ["shared-source-v1"]);
    const b = await pairDevice(ctx.db, member.id, now(), ["shared-source-v1"]);
    for (const d of [a, b])
      expect(
        (
          await acknowledgeFleetCapabilities(ctx.db, {
            sessionId: d.sessionId,
            revision: 1,
            now: now(),
            capabilities: ["shared-source-v1"],
          })
        ).ok,
      ).toBe(true);
    const jwtKeys = await generateKeyPair("RS256");
    const getKey = createLocalJWKSet({
      keys: [{ ...(await exportJWK(jwtKeys.publicKey)), alg: "RS256" }],
    });
    let fleet = 777;
    const providerCalls: string[] = [];
    const fetchImpl: typeof fetch = async (raw, init) => {
      const url = String(raw);
      providerCalls.push(url);
      if (url === "https://login.eveonline.com/v2/oauth/token") {
        const token = await new SignJWT({
          owner: pilot.ownerHash,
          name: pilot.name,
          scp: [FLEET_READ_SCOPE],
        })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer("https://login.eveonline.com")
          .setAudience("EVE Online")
          .setSubject(`CHARACTER:EVE:${pilot.id}`)
          .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
          .sign(jwtKeys.privateKey);
        return Response.json({ access_token: token, refresh_token: "owned-rotated" });
      }
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
      let body;
      if (url === `https://esi.evetech.net/latest/characters/${pilot.id}/fleet/`)
        body = { fleet_id: fleet, fleet_boss_id: pilot.id };
      else if (url === `https://esi.evetech.net/latest/fleets/${fleet}/members/`)
        body = [{ character_id: pilot.id }, { character_id: alt.id }];
      else throw new Error("Unexpected provider URL " + url);
      const response = Response.json(body, {
        headers: {
          Date: now().toUTCString(),
          "cache-control": "max-age=5",
          "x-esi-error-limit-remain": "100",
          "x-esi-error-limit-reset": "60",
        },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const queue = new PgBoss({ connectionString: TEST_URL, max: 5 });
    queue.on("error", (e) => errors.push(e));
    const runtime = createFleetSourceOwner();
    let stopTick: undefined | (() => Promise<void>),
      queueStarted = false;
    own(queue, async () => {
      runtime.stopAdmission();
      await stopTick?.();
      stopTick = undefined;
      try {
        if (queueStarted) {
          await queue.offWork(QUEUES.fleetAutomatic);
          await queue.offWork(QUEUES.fleetSource);
        }
        await runtime.drain();
      } finally {
        await queue.stop({ graceful: true, wait: true });
      }
    });
    const deps = {
      db: ctx.db,
      cfg,
      fetchImpl,
      getKey,
      now,
      esi: createEsiClient({ now: Date.now }),
      memory: createFleetSourceMemory(),
      signal: runtime.signal,
    };
    const handlers = buildJobHandlers({
      db: ctx.db,
      cfg,
      fetchImpl,
      fleetSource: deps,
      esi: {} as Parameters<typeof buildJobHandlers>[0]["esi"],
      wanderer: {} as Parameters<typeof buildJobHandlers>[0]["wanderer"],
      discord: {} as Parameters<typeof buildJobHandlers>[0]["discord"],
    });
    await queue.start();
    queueStarted = true;
    await createQueues(queue);
    await startFleetAutomaticWork(queue, runtime, handlers[QUEUES.fleetAutomatic]);
    const active = runtime.wrap(handlers[QUEUES.fleetSource]);
    await queue.work(
      QUEUES.fleetSource,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await active(job.data);
      },
    );
    stopTick = startFleetSourceScheduler(async () => {
      await runFleetSourceTick(deps, runtime.canDiscover);
      await dispatchOutbox(
        ctx.db,
        (q, data, opts) => queue.send(q, data, opts),
        "fleet-source",
      );
    });
    // Prepare the owned browser before admitting client timing. The harness
    // never rebases or clears a clock fence.
    const browser = own(
      await chromium.launch({
        executablePath: process.env.E2E_CHROME || "/usr/bin/google-chrome",
        headless: true,
      }),
      (browser) => browser.close(),
    );
    const browserContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 840, height: 625 },
    });
    await browserContext.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        errors.push(new Error("External browser request"));
        return route.abort();
      }
      return route.continue();
    });
    const clientConfigs = [a, b].map((d, i) => ({
      root: mkdtempSync(join(root, "desktop-")),
      origin,
      ca: cert,
      devices: [
        {
          key: d.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
          session: d.sessionId,
          name: [pilot.name, alt.name][i],
        },
      ],
    }));
    let drivers = clientConfigs.map((config) =>
      startCurrentDriver<Report>(python, checkout, config),
    );
    own(null, async () => {
      await Promise.all(drivers.map((d) => d.close()));
    });
    let latest: Report[] = [];
    const pages: Page[] = [],
      bars: Page[] = [];
    const call = async (
      action: string,
      seconds = 3,
      extra: Record<string, unknown> = {},
      original = drivers,
    ) => {
      const indexes = action === "api" ? [Number(extra.device)] : [0, 1];
      const replies = await Promise.all(
        indexes.map(async (i) => ({
          i,
          report: await original[i].call({
            action: action === "damage" && i === 1 ? "pump" : action,
            seconds,
            ...extra,
            device: 0,
          }),
        })),
      );
      if (original !== drivers) return replies[0].report;
      for (const { i, report } of replies) {
        latest[i] = report;
        if (pages[i] && !pages[i].isClosed())
          for (const script of report.pushes?.[0] || []) await pages[i].evaluate(script);
        if (bars[i] && !bars[i].isClosed())
          await bars[i].evaluate((payload) => {
            (
              window as unknown as { onFleetSnapshot: (payload: unknown) => void }
            ).onFleetSnapshot(payload);
          }, report.bars[0]);
      }
      return {
        ...replies[0].report,
        states: latest.map((r) => r.states[0]),
        rows: latest.map((r) => r.rows[0]),
        opened: latest.map((r) => r.opened[0]),
        bars: latest.map((r) => r.bars[0]),
        diagnostics: latest,
      };
    };
    {
      let ready = await Promise.all(drivers.map((d) => d.ready));
      expect(ready.every((r) => r.ready)).toBe(true);
      function pumpClient() {
        let pumping = true;
        const task = (async () => {
          while (pumping) {
            await call("pump", 0.1);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })().catch((e) => errors.push(e));
        return async () => {
          pumping = false;
          await task;
        };
      }
      let stopClientPump = pumpClient();
      own(null, () => stopClientPump());
      const bridgeCalls: Array<{ device: number; method: string; result: unknown }> = [];
      async function pageFor(device: number, bar = false) {
        const original = drivers;
        const page = await browserContext.newPage();
        page.on("pageerror", (e) => errors.push(e));
        await page.exposeFunction(
          "__currentApi",
          async (method: string, args: unknown[]) => {
            const result = (await call("api", 0, { device, method, args }, original))
              .result;
            bridgeCalls.push({ device, method, result });
            return result;
          },
        );
        await page.goto(
          origin +
            "/__wingman__/" +
            (bar
              ? "fleetbar.html#fleet-page=" + ready[device].page_ids[0]
              : "index.html"),
        );
        await page.evaluate(() => {
          const w = window as unknown as {
            pywebview: unknown;
            __currentApi: (name: string, args: unknown[]) => Promise<unknown>;
          };
          w.pywebview = {
            api: new Proxy(
              {},
              {
                get:
                  (_, name) =>
                  (...args: unknown[]) =>
                    w.__currentApi(String(name), args),
              },
            ),
          };
          window.dispatchEvent(new Event("pywebviewready"));
        });
        if (!bar)
          await page.evaluate(() => {
            const w = window as unknown as {
              WM: { route: (s: string) => void; section: (s: string) => void };
            };
            w.WM.route("settings");
            w.WM.section("fleet");
          });
        return page;
      }
      for (let i = 0; i < 2; i++) pages.push(await pageFor(i));
      await call("pump", 4);
      for (const [device, page] of pages.entries()) {
        await page.bringToFront();
        await page.waitForFunction(() => !document.hidden);
        await page.locator("#sharing-combat").click();
        await page.locator("#dlg-ok").click();
        await expect
          .poll(
            () =>
              bridgeCalls.find(
                (c) => c.device === device && c.method === "fleet_sharing_setup",
              ),
            { timeout: 10000 },
          )
          .toMatchObject({ result: { queued: true } });
      }
      const approval = await call("pump", 2);
      for (let i = 0; i < 2; i++) {
        expect(
          approval.opened[i],
          JSON.stringify({ states: approval.states, requests, errors }),
        ).toHaveLength(1);
        const id = new URL(approval.opened[i][0]).pathname.split("/").pop()!;
        await approvePairing(ctx.db, id, [owner.id, member.id][i], now());
      }
      const upgraded = await call("pump", 4);
      for (const state of upgraded.states)
        expect(state.metadata.approved_capabilities).toContain("combat-v2");
      for (const [device, page] of pages.entries()) {
        await page.bringToFront();
        await page.waitForFunction(() => !document.hidden);
        await page.locator("#sharing-enabled + .box").click();
        await page.locator("#dlg-ok").click();
        await expect
          .poll(
            () =>
              bridgeCalls.find(
                (c) => c.device === device && c.method === "fleet_sharing_set_enabled",
              ),
            { timeout: 10000 },
          )
          .toMatchObject({ result: { queued: true } });
      }
      await pages[0].bringToFront();
      await pages[0].waitForFunction(() => !document.hidden);
      await pages[0].locator("#sharing-automatic + .box").click();
      await pages[0].locator("#dlg-ok").click();
      await expect
        .poll(
          () =>
            bridgeCalls.find(
              (c) => c.device === 0 && c.method === "fleet_sharing_automatic",
            ),
          { timeout: 10000 },
        )
        .toMatchObject({ result: { queued: true } });
      await call("pump", 6);
      bars.push(await pageFor(0, true));
      bars.push(await pageFor(1, true));
      const sources = await ctx.db.select().from(fleetSourceIntent);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({
        state: "active",
        automaticConsentAccountId: owner.id,
      });
      let data = await call("damage", 0.1);
      // A fresh sample may wait one publication turn and one receiver-read turn.
      await expect
        .poll(
          async () => {
            data = await call("pump", 0.1);
            return data.rows[1];
          },
          { timeout: 8000, interval: 100 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              character_id: pilot.id,
              outgoing_dps: 32,
              incoming_dps: 14,
            }),
          ]),
        )
        .catch((error) => {
          console.error("[fleet-current] failed exchange", JSON.stringify(data));
          throw error;
        });
      await bars[1].getByText(pilot.name, { exact: true }).waitFor({ state: "visible" });
      expect(
        await bars[1].locator('.fleet-ewar[title*="Carol Vex"]').count(),
        JSON.stringify(data),
      ).toBe(1);
      const consentBefore = (await ctx.db.select().from(fleetAutomaticConsent))[0];
      expect(consentBefore.enabled).toBe(true);
      await stopClientPump();
      for (const page of [...pages, ...bars]) await page.close();
      pages.length = 0;
      bars.length = 0;
      const originalPids = drivers.map((d) => d.pid);
      await Promise.all(drivers.map((d) => d.close()));
      drivers = clientConfigs.map((config) =>
        startCurrentDriver<Report>(python, checkout, config),
      );
      ready = await Promise.all(drivers.map((d) => d.ready));
      latest = [];
      expect(drivers.map((d) => d.pid)).not.toEqual(originalPids);
      expect(ready.every((r) => r.ready)).toBe(true);
      stopClientPump = pumpClient();
      for (let i = 0; i < 2; i++) pages.push(await pageFor(i));
      bars.push(await pageFor(0, true));
      bars.push(await pageFor(1, true));
      const restarted = await call("pump", 3);
      expect(restarted.states.map((s) => s.enabled)).toEqual([true, true]);
      // The running scheduler advances its cursor/deadline, not consent authority.
      expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject(
        Object.fromEntries(
          Object.entries(consentBefore).filter(
            ([key]) => !["nextReconcileAt", "candidateCursor"].includes(key),
          ),
        ),
      );
      fleet = 778;
      // Real reservation pacing is 30s + at most 3s jitter; do not rewrite due
      // times or fabricate a replacement source to accelerate the future fleet.
      await expect
        .poll(
          async () =>
            (await ctx.db.select().from(fleetSourceIntent)).some(
              (s) =>
                s.state === "active" &&
                s.fleetId === 778 &&
                s.automaticConsentAccountId === owner.id,
            ),
          { timeout: 45000, interval: 250 },
        )
        .toBe(true);
      let futureData = await call("damage", 0.1);
      await expect
        .poll(
          async () => {
            futureData = await call("pump", 0.1);
            return futureData.rows[1];
          },
          { timeout: 8000, interval: 100 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              character_id: pilot.id,
              outgoing_dps: 32,
              incoming_dps: 14,
            }),
          ]),
        )
        .catch((error) => {
          console.error("[fleet-current] failed exchange", JSON.stringify(futureData));
          throw error;
        });
      await bars[1].getByText(pilot.name, { exact: true }).waitFor({ state: "visible" });
      await pages[0].bringToFront();
      await pages[0].waitForFunction(() => !document.hidden);
      await pages[0].locator("#sharing-automatic + .box").click();
      await expect
        .poll(
          () =>
            bridgeCalls.filter(
              (c) => c.device === 0 && c.method === "fleet_sharing_automatic",
            ).length,
          { timeout: 10000 },
        )
        .toBe(2);
      await call("pump", 3);
      expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(false);
      expect(
        (await ctx.db.select().from(fleetSourceIntent)).every((s) => s.state === "ended"),
      ).toBe(true);
      expect(providerCalls.length).toBeGreaterThan(2);
      expect(requests.some((s) => s === "PUT /api/fleet/v2/snapshot")).toBe(true);
      expect(errors).toEqual([]);
    }
  }));
