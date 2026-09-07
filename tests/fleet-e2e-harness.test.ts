import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, Server } from "node:net";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDb, TEST_URL } from "./helpers/db";
import { WORKTREE_ROOT } from "../e2e/env";
import {
  assertFleetEnvironment,
  assertFreePort,
  FLEET_CONNECTION_FILE,
  fleetEnvironment,
  startFleetServer,
} from "../e2e/fleet-server";
import {
  fleetClient,
  startFleetFixtures,
  type FixtureConnection,
} from "../e2e/fleet-fixtures";

const databaseUrl = TEST_URL;
let dbContext: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  dbContext = await setupTestDb();
});
afterAll(async () => {
  await dbContext.cleanup();
});
const appUrl = "http://localhost:3987";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function fixture() {
  const f = await startFleetFixtures({ appUrl, worktree: WORKTREE_ROOT });
  disposers.push(() => f.close());
  return f;
}

async function child(env: NodeJS.ProcessEnv, mode = "providers") {
  const script = join(WORKTREE_ROOT, "tmp/e2e/fleet-harness-child.mjs");
  buildSync({
    entryPoints: [join(WORKTREE_ROOT, "tests/helpers/fleet-harness-child.mjs")],
    outfile: script,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    define: { __dirname: JSON.stringify(join(WORKTREE_ROOT, "e2e")) },
  });
  const p = spawn(process.execPath, [script, mode], {
    cwd: WORKTREE_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  p.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  p.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const timeout = setTimeout(() => p.kill("SIGKILL"), 15_000);
  const [code] = await once(p, "exit");
  clearTimeout(timeout);
  return { code, output };
}

const scenario = {
  characters: [
    {
      id: 90000001,
      name: "Anchor",
      ownerHash: "oh-90000001",
      scopes: ["esi-fleets.read_fleet.v1"],
      refreshToken: "fleet-test-refresh",
    },
  ],
  fleetId: 123456,
  fleetBossId: 90000001,
  rosterIds: [90000001, 90000002, 90000099],
};

describe("fleet browser harness isolation", () => {
  it("keeps the ordinary profile dry-run and gives live integration a distinct non-reusable port", async () => {
    vi.stubEnv("TEST_WORKER_INDEX", "0");
    vi.stubEnv("E2E_FLEET_INTEGRATIONS", "");
    // env.ts is also statically imported above. Re-evaluate after the worker
    // marker, otherwise cached SHOULD_PROVISION can launch a different DB.
    vi.resetModules();
    const normal = (await import("../playwright.config")).default;
    expect(normal.webServer).toMatchObject({
      env: { SYNC_MODE: "dry-run" },
      reuseExistingServer: true,
    });
    expect(normal.testIgnore).toEqual(["**/fleet-access.spec.ts"]);
    vi.resetModules();
    vi.stubEnv("E2E_FLEET_INTEGRATIONS", "1");
    const fleet = (await import("../playwright.config")).default;
    expect(fleet.webServer).toMatchObject({
      env: { SYNC_MODE: "live" },
      reuseExistingServer: false,
    });
    expect(fleet.use?.baseURL).not.toBe(normal.use?.baseURL);
    expect(fleet.testMatch).toBe("**/fleet-access.spec.ts");
  });

  it.each([
    ["E2E_FLEET_INTEGRATIONS", ""],
    ["DATABASE_URL", "postgres://authgd:authgd@db.example:5639/authgd_test"],
    ["DATABASE_URL", "postgres://authgd:authgd@localhost:5639/authgd"],
    [
      "DATABASE_URL",
      "postgres://authgd:authgd@localhost:5639/authgd_test?host=remote.example",
    ],
    ["EVE_SSO_CLIENT_SECRET", "not-the-fixture-secret"],
    ["DISCORD_BOT_TOKEN", "not-the-fixture-token"],
    ["SYNC_MODE", "dry-run"],
    ["E2E_MANAGED_WORKTREE", "/some/other/worktree"],
    ["NODE_OPTIONS", ""],
    ["NEXT_FONT_GOOGLE_MOCKED_RESPONSES", ""],
    ["NEXT_FONT_GOOGLE_MOCKED_RESPONSES", "/tmp/uncontrolled-fonts.json"],
    ["APP_BASE_URL", "https://app.example"],
  ])("refuses unsafe bootstrap %s without starting an app", async (key, value) => {
    const f = await fixture();
    const env = fleetEnvironment({ databaseUrl, appUrl, fixture: f.connection });
    expect(() => assertFleetEnvironment({ ...env, [key]: value })).toThrow();
    expect((await f.client.snapshot()).preloads).toEqual([]);
  });

  it("refuses a trailing-slash launcher origin even when its descriptor agrees", async () => {
    const f = await fixture();
    const slashUrl = `${appUrl}/`;
    expect(() =>
      fleetEnvironment({
        databaseUrl,
        appUrl: slashUrl,
        fixture: { ...f.connection, appUrl: slashUrl },
      }),
    ).toThrow(/canonical.*origin/i);
    await expect(startFleetServer({ databaseUrl, appUrl: slashUrl })).rejects.toThrow(
      /canonical.*origin/i,
    );
  });

  it("normalizes a direct fixture's trailing slash for health, environment and inherited preload identity", async () => {
    const f = await startFleetFixtures({
      appUrl: `${appUrl}/`,
      worktree: WORKTREE_ROOT,
    });
    disposers.push(() => f.close());
    expect(f.connection.appUrl).toBe(appUrl);
    expect(await f.client.health()).toEqual({ appUrl, worktree: WORKTREE_ROOT });
    const env = fleetEnvironment({ databaseUrl, appUrl, fixture: f.connection });
    expect(assertFleetEnvironment(env).appUrl).toBe(env.APP_BASE_URL);
    const result = await child(env, "bootstrap");
    expect(result, result.output).toMatchObject({ code: 0 });
    expect((await f.client.snapshot()).preloads.length).toBeGreaterThanOrEqual(1);
    await f.client.assertClean();
  });

  it("preloads real Node children before imports and uses actual SSO JWT and ESI parsers", async () => {
    const f = await fixture();
    await f.client.scenario(scenario);
    const env = fleetEnvironment({ databaseUrl, appUrl, fixture: f.connection });
    const result = await child(env);
    expect(result, result.output).toMatchObject({ code: 0 });
    expect(result.output).toContain('"characterId":90000001');
    expect(result.output).toContain('"characterId":90000002');
    const state = await f.client.snapshot();
    expect(state.preloads.length).toBeGreaterThanOrEqual(2);
    expect(state.requests.map((r) => r.stage)).toEqual(
      expect.arrayContaining(["token", "jwks", "membership", "roster"]),
    );
    await f.client.assertClean();
  }, 30_000);

  it("records denied fetch, HTTP and raw socket attempts even when the child catches each error; no connection reaches the destination", async () => {
    let connections = 0;
    const destination = createServer();
    destination.on("connection", (socket) => {
      connections++;
      socket.destroy();
    });
    destination.listen(0, "127.0.0.1");
    await once(destination, "listening");
    disposers.push(
      () => new Promise<void>((resolve) => destination.close(() => resolve())),
    );
    const address = destination.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const f = await fixture();
    const env = fleetEnvironment({ databaseUrl, appUrl, fixture: f.connection });
    const result = await child(
      {
        ...env,
        FLEET_HARNESS_TARGET: `http://127.0.0.1:${address.port}/must-not-connect?secret=omitted`,
      },
      "denied",
    );
    expect(result, result.output).toMatchObject({ code: 0 });
    expect(connections).toBe(0);
    await expect(f.client.assertClean()).rejects.toThrow(/egress/i);
    const state = await f.client.snapshot();
    expect(state.violations.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(state.violations)).not.toContain("secret=omitted");
    // Reset must not erase a failure before teardown has asserted it.
    await expect(f.client.reset()).rejects.toThrow();
  }, 30_000);

  it("rotates refresh credentials and refuses replay of the original seed", async () => {
    const f = await fixture();
    await f.client.scenario(scenario);
    const refresh = (refreshToken: string) =>
      f.client.provider({
        url: "https://login.eveonline.com/v2/oauth/token",
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from("cid:sec").toString("base64")}` },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
    const first = await refresh("fleet-test-refresh");
    expect(first.status).toBe(200);
    expect((await refresh("fleet-test-refresh")).status).toBe(400);
    const rotated = (first.body as { refresh_token: string }).refresh_token;
    expect((await refresh(rotated)).status).toBe(200);
    await f.client.assertClean();
  });

  it("does not let missing or wrong bearer credentials become successful fleet evidence", async () => {
    const f = await fixture();
    await f.client.scenario(scenario);
    const request = {
      url: "https://esi.evetech.net/latest/characters/90000001/fleet/",
      method: "GET",
    };
    expect((await f.client.provider(request)).status).toBe(401);
    expect(
      (
        await f.client.provider({
          ...request,
          headers: { authorization: "Bearer not-issued" },
        })
      ).status,
    ).toBe(401);
    const credentials = await f.client.credentials(90000001);
    expect(
      (
        await f.client.provider({
          ...request,
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        })
      ).status,
    ).toBe(200);
    await f.client.assertClean();
  });

  it.each([false, true])(
    "only the fleet boss can read the roster, even with a synthetic success override: %s",
    async (override) => {
      const f = await fixture();
      await f.client.scenario({
        ...scenario,
        characters: [
          ...scenario.characters,
          {
            id: 90000002,
            name: "Ordinary Member",
            ownerHash: "oh-90000002",
            scopes: ["esi-fleets.read_fleet.v1"],
          },
        ],
        // Boss need not be first in the roster or occupy a command position.
        rosterIds: [90000002, 90000001, 90000099],
        ...(override
          ? { responses: { roster: { status: 200, body: [{ character_id: 90000002 }] } } }
          : {}),
      });
      const ordinary = await f.client.credentials(90000002);
      const headers = { authorization: `Bearer ${ordinary.accessToken}` };
      const membership = await f.client.provider({
        url: "https://esi.evetech.net/latest/characters/90000002/fleet/",
        method: "GET",
        headers,
      });
      expect(membership).toMatchObject({
        status: 200,
        body: { fleet_boss_id: 90000001 },
      });
      expect(
        await f.client.provider({
          url: "https://esi.evetech.net/latest/fleets/123456/members/",
          method: "GET",
          headers,
        }),
      ).toEqual({ status: 403, body: { error: "forbidden" } });
      const boss = await f.client.credentials(90000001);
      expect(
        await f.client.provider({
          url: "https://esi.evetech.net/latest/characters/90000001/fleet/",
          method: "GET",
          headers: { authorization: `Bearer ${boss.accessToken}` },
        }),
      ).toMatchObject({
        status: 200,
        body: { fleet_boss_id: 90000001, fleet_job: "fleet_member" },
      });
      expect(
        (
          await f.client.provider({
            url: "https://esi.evetech.net/latest/fleets/123456/members/",
            method: "GET",
            headers: { authorization: `Bearer ${boss.accessToken}` },
          })
        ).status,
      ).toBe(200);
      await f.client.assertClean();
    },
  );

  it("holds a real provider response until release, snapshots the old scenario, and closes pending work", async () => {
    const f = await fixture();
    await f.client.scenario({
      ...scenario,
      responses: { roster: { hold: "old-anchor" } },
    });
    const credentials = await f.client.credentials(90000001);
    const pending = f.client.provider({
      url: "https://esi.evetech.net/latest/fleets/123456/members/",
      method: "GET",
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    await vi.waitFor(async () =>
      expect((await f.client.snapshot()).pending).toEqual(["old-anchor"]),
    );
    await f.client.scenario({ ...scenario, rosterIds: [90000003] });
    await f.client.release("old-anchor");
    expect((await pending).body).toEqual([
      { character_id: 90000001 },
      { character_id: 90000002 },
      { character_id: 90000099 },
    ]);
    await f.close();
    await expect(
      fetch(`${f.connection.url}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  });

  it("refuses missing interception before provider imports", async () => {
    const f = await fixture();
    const env = fleetEnvironment({ databaseUrl, appUrl, fixture: f.connection });
    const result = await child({ ...env, NODE_OPTIONS: "" }, "bootstrap");
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/interception|preload/i);
    expect((await f.client.snapshot()).requests).toEqual([]);
  });

  it("refuses an unproven fixture channel before application import and keeps controls authenticated", async () => {
    const f = await fixture();
    const response = await fetch(`${f.connection.url}/scenario`, {
      method: "POST",
      body: JSON.stringify(scenario),
    });
    expect(response.status).toBe(403);
    await response.text();
    const env = fleetEnvironment({ databaseUrl, appUrl, fixture: f.connection });
    const result = await child(
      {
        ...env,
        E2E_FLEET_FIXTURE: JSON.stringify({ ...f.connection, token: "0".repeat(64) }),
      },
      "bootstrap",
    );
    expect(result, result.output).toMatchObject({ code: 1 });
    expect(result.output).toContain("fixture authentication required");
    expect((await f.client.snapshot()).preloads).toEqual([]);
    await expect(
      startFleetFixtures({
        appUrl: "http://remote.example:3000",
        worktree: WORKTREE_ROOT,
      }),
    ).rejects.toThrow(/loopback/);
  }, 30_000);

  it("closes an unreleased provider response without retaining a listening fixture", async () => {
    const f = await fixture();
    await f.client.scenario({ ...scenario, responses: { roster: { hold: "cleanup" } } });
    const credentials = await f.client.credentials(90000001);
    const pending = f.client
      .provider({
        url: "https://esi.evetech.net/latest/fleets/123456/members/",
        method: "GET",
        headers: { authorization: `Bearer ${credentials.accessToken}` },
      })
      .catch(() => null);
    await vi.waitFor(async () =>
      expect((await f.client.snapshot()).pending).toEqual(["cleanup"]),
    );
    await f.close();
    expect(await pending).toBeNull();
    await expect(
      fetch(`${f.connection.url}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  });

  it.each([
    ["::1", "EADDRNOTAVAIL", true],
    ["::1", "EAFNOSUPPORT", true],
    ["::1", "EADDRINUSE", false],
    ["::1", "EACCES", false],
    ["127.0.0.1", "EADDRNOTAVAIL", false],
    ["127.0.0.1", "EAFNOSUPPORT", false],
    ["127.0.0.1", "EADDRINUSE", false],
    ["127.0.0.1", "EACCES", false],
  ])(
    "handles %s bind error %s without weakening port ownership",
    async (host, code, allowed) => {
      const error = Object.assign(new Error(`synthetic bind: ${code}`), { code });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply below retains the actual server as receiver.
      const listen = Server.prototype.listen;
      // Substitute only the OS bind error; other addresses really bind and close.
      vi.spyOn(Server.prototype, "listen").mockImplementation(function (
        this: Server,
        ...args: unknown[]
      ) {
        if (args[1] === host) {
          queueMicrotask(() => this.emit("error", error));
          return this;
        }
        Reflect.apply(listen, this, args);
        return this;
      });
      if (allowed) await expect(assertFreePort(appUrl)).resolves.toBeUndefined();
      else
        await expect(assertFreePort(appUrl)).rejects.toMatchObject({
          message: expect.stringContaining("unavailable; refusing reuse"),
          cause: error,
        });
    },
  );

  it("refuses an occupied app port without reusing or stopping its owner", async () => {
    const occupied = createServer((_req, res) => res.end("dry-run"));
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    disposers.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const addr = occupied.address();
    if (!addr || typeof addr === "string") throw new Error("missing listener");
    const url = `http://127.0.0.1:${addr.port}`;
    await expect(startFleetServer({ databaseUrl, appUrl: url })).rejects.toThrow(
      /port|use|occupied/i,
    );
    expect(await (await fetch(url)).text()).toBe("dry-run");
  });

  it("cleans up a Next child cancelled while startup is still pending", async () => {
    const controller = new AbortController();
    const pending = startFleetServer({
      databaseUrl,
      appUrl,
      signal: controller.signal,
    }).then((owned) => {
      disposers.push(() => owned.close());
      return owned;
    });
    // Observe the owned TCP listener, without warming /login ourselves.
    const connected = () =>
      new Promise<boolean>((done) => {
        const socket = connect({ host: "127.0.0.1", port: 3987 });
        socket.on("connect", () => {
          socket.destroy();
          done(true);
        });
        socket.on("error", () => done(false));
      });
    await vi.waitFor(async () => expect(await connected()).toBe(true), {
      timeout: 20_000,
    });
    controller.abort(new Error("cancelled harness startup"));
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(await connected()).toBe(false);
  }, 30_000);

  it("the CLI publishes readiness only with a usable fixture and removes its descriptor on SIGTERM", async () => {
    const cli = spawn(process.execPath, ["--import", "tsx", "e2e/fleet-server.ts"], {
      cwd: WORKTREE_ROOT,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        TEST_DATABASE_URL: databaseUrl,
        E2E_FLEET_INTEGRATIONS: "1",
        E2E_FLEET_PORT: "3987",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    cli.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    cli.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = once(cli, "exit");
    disposers.push(async () => {
      if (cli.exitCode === null && cli.signalCode === null) {
        cli.kill("SIGTERM");
        await exited;
      }
    });
    await vi.waitFor(
      () => {
        if (cli.exitCode !== null) throw new Error(output);
        expect(output).toContain("[fleet-e2e] intercepted Next ready");
      },
      { timeout: 50_000 },
    );
    const connection = JSON.parse(
      readFileSync(FLEET_CONNECTION_FILE, "utf8"),
    ) as FixtureConnection;
    expect(await fleetClient(connection).health()).toEqual({
      appUrl,
      worktree: WORKTREE_ROOT,
    });
    cli.kill("SIGTERM");
    expect((await exited)[0], output).toBe(0);
    expect(existsSync(FLEET_CONNECTION_FILE)).toBe(false);
    await expect(
      fetch(`${connection.url}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
    await expect(
      fetch(`${appUrl}/login`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  }, 60_000);

  it("cold-boots Next with offline font CSS, inherited interception and owned-listener cleanup", async () => {
    // Preserve the caller's useful dev cache; remove only this test's cold output.
    // Profiles already run sequentially against this worktree and database.
    mkdirSync(join(WORKTREE_ROOT, "tmp"), { recursive: true });
    const saved = mkdtempSync(join(WORKTREE_ROOT, "tmp/fleet-cold-cache-"));
    const devCache = join(WORKTREE_ROOT, ".next/dev");
    const hadCache = existsSync(devCache);
    if (hadCache) renameSync(devCache, join(saved, "dev"));
    let owned: Awaited<ReturnType<typeof startFleetServer>> | undefined;
    try {
      expect(existsSync(devCache)).toBe(false);
      owned = await startFleetServer({ databaseUrl, appUrl, mode: "dev" });
      const res = await fetch(`${appUrl}/login`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const stylesheets = [...html.matchAll(/href="([^"]+\.css(?:\?[^"]*)?)"/g)];
      expect(stylesheets.length).toBeGreaterThan(0);
      let css = "";
      for (const [, href] of stylesheets) {
        const url = new URL(href.replaceAll("&amp;", "&"), appUrl);
        expect(url.origin).toBe(appUrl);
        const stylesheet = await fetch(url);
        expect(stylesheet.status).toBe(200);
        css += await stylesheet.text();
      }
      // Assert compiled/served CSS, not fixture source or a warmed page fallback.
      const faces = css.match(/@font-face\s*\{[^}]+\}/g) ?? [];
      expect(faces).toContainEqual(
        expect.stringMatching(
          /font-family:\s*["']?Archivo["']?;[^}]*src:\s*local\(["']?Arial["']?\)/,
        ),
      );
      expect(faces).toContainEqual(
        expect.stringMatching(
          /font-family:\s*["']?IBM Plex Mono["']?;[^}]*src:\s*local\(["']?Courier New["']?\)/,
        ),
      );
      expect(css).not.toMatch(/url\(["']?https?:\/\/fonts\./);
      expect(owned.output()).not.toMatch(/Failed to (?:fetch|download).*font/i);
      const state = await owned.fixtures.client.snapshot();
      // CLI, server, and native-launched font evaluator all retain interception.
      expect(state.preloads.length).toBeGreaterThanOrEqual(3);
      await owned.fixtures.client.assertClean();
      await owned.close();
      await expect(
        fetch(`${appUrl}/login`, { signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
      await expect(
        fetch(`${owned.fixtures.connection.url}/health`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
    } finally {
      try {
        await owned?.close();
      } finally {
        rmSync(devCache, { recursive: true, force: true });
        if (hadCache) renameSync(join(saved, "dev"), devCache);
        rmSync(saved, { recursive: true });
      }
    }
  }, 90_000);
});
