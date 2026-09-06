import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  test,
  expect,
  installFleetBrowserBoundary,
  disposeFleetResources,
} from "./fleet-browser";
import { startFleetFixtures } from "./fleet-fixtures";
import { IS_CI, SYNTHETIC_APP_ENV, WORKTREE_ROOT } from "./env";

// Browser-dependent harness coverage belongs to the fleet E2E job, which owns
// Chromium. The unit job intentionally has no browser installation.
test("browser boundary preserves picker state/code/PKCE and denies unknown egress even without routing", async ({
  browser,
}) => {
  const disposers: Array<() => Promise<void>> = [];
  try {
    let startUrl = "";
    const callbackServer = createServer((req, res) => {
      if (req.url === "/begin") res.writeHead(302, { location: startUrl }).end();
      else if (req.url === "/bad-redirect")
        res.writeHead(302, { location: "https://unknown.invalid/redirect" }).end();
      else res.end("callback received");
    });
    callbackServer.listen(0, "127.0.0.1");
    await once(callbackServer, "listening");
    disposers.push(() => new Promise<void>((done) => callbackServer.close(() => done())));
    const address = callbackServer.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const localApp = `http://127.0.0.1:${address.port}`;
    // Direct callers accept a trailing slash; proxy, picker and browser routing
    // must all still recognize the same canonical app origin.
    const f = await startFleetFixtures({
      appUrl: `${localApp}/`,
      worktree: WORKTREE_ROOT,
    });
    disposers.push(() => f.close());
    await f.client.scenario({
      characters: [
        {
          id: 90000001,
          name: "Anchor",
          ownerHash: "oh-90000001",
          scopes: ["esi-fleets.read_fleet.v1"],
        },
      ],
      fleetId: 123456,
      rosterIds: [90000001],
    });
    const context = await browser.newContext({
      serviceWorkers: "block",
      proxy: { server: f.connection.url, bypass: "<-loopback>" },
    });
    const drain = await installFleetBrowserBoundary(context, f.client);
    disposers.push(async () => {
      try {
        await drain();
      } finally {
        await context.close();
      }
    });
    const page = await context.newPage();
    const verifier = "synthetic-pkce-verifier";
    const authorize = new URL("https://login.eveonline.com/v2/oauth/authorize");
    authorize.search = new URLSearchParams({
      client_id: "cid",
      response_type: "code",
      redirect_uri: `${localApp}/auth/eve/callback`,
      state: "bound-state",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    startUrl = authorize.href;
    await page.goto(`${localApp}/begin`);
    await page.getByRole("link", { name: "Use Anchor", exact: true }).click();
    const callback = new URL(page.url());
    expect(callback.origin).toBe(localApp);
    expect(callback.pathname).toBe("/auth/eve/callback");
    expect(callback.searchParams.get("state")).toBe("bound-state");
    const code = callback.searchParams.get("code")!;
    const exchange = () =>
      f.client.provider({
        url: "https://login.eveonline.com/v2/oauth/token",
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from("cid:sec").toString("base64")}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
        }).toString(),
      });
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(400);
    await f.client.assertClean();
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("socket not closed")), 3000);
          const socket = new WebSocket("wss://unknown.invalid/denied");
          socket.onclose = () => {
            clearTimeout(timeout);
            resolve();
          };
        }),
    );
    expect((await f.client.snapshot()).violations).toContainEqual({
      source: "browser-websocket",
      destination: "wss://unknown.invalid/denied",
    });
    await page.evaluate(async () => {
      await fetch("https://unknown.invalid/denied").catch(() => null);
    });
    await expect(f.client.assertClean()).rejects.toThrow(/egress/);
    await page.goto(`${localApp}/bad-redirect`).catch(() => null);
    expect((await f.client.snapshot()).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "browser-redirect" })]),
    );
    // This intentionally poisoned private fixture is separate from the profile's
    // automatic clean ledger. The proxy proves refusal with routing removed too.
    let connections = 0;
    const destination = createServer();
    destination.on("connection", (socket) => {
      connections++;
      socket.destroy();
    });
    destination.listen(0, "127.0.0.1");
    await once(destination, "listening");
    disposers.push(() => new Promise<void>((done) => destination.close(() => done())));
    const target = destination.address();
    if (!target || typeof target === "string") throw new Error("missing listener");
    await context.unrouteAll({ behavior: "wait" });
    // No routing fallback: exercise the proxy's own normalized-origin comparison.
    await page.goto(`${localApp}/callback`);
    await expect(page.locator("body")).toHaveText("callback received");
    await page.goto(`http://127.0.0.1:${target.port}/denied`).catch(() => null);
    expect(connections).toBe(0);
    expect((await f.client.snapshot()).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "browser-proxy" })]),
    );
  } finally {
    await disposeFleetResources(disposers);
  }
});

test("the owned intercepted Next server renders in Chromium", async ({ page, fleet }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle(`Sign in · ${SYNTHETIC_APP_ENV.BRAND_NAME}`);
  expect((await fleet.snapshot()).preloads.length).toBeGreaterThanOrEqual(IS_CI ? 1 : 2);
});
