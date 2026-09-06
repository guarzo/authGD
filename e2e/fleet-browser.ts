import { readFileSync } from "node:fs";
import { test as base, expect, type BrowserContext, type Route } from "@playwright/test";
import { BASE_URL, FLEET_INTEGRATIONS, WORKTREE_ROOT } from "./env";
import { fleetClient, type FixtureConnection, type FleetClient } from "./fleet-fixtures";
import { FLEET_CONNECTION_FILE } from "./fleet-server";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Install before creating pages. The context must also use the fixture proxy. */
export async function installFleetBrowserBoundary(
  context: BrowserContext,
  client: FleetClient,
) {
  const appUrl = client.connection.appUrl;
  const active = new Set<Promise<void>>();
  let draining = false;
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === appUrl) {
      if (draining) {
        await route.abort();
        return;
      }
      // Routing alone doesn't cover redirects. Inspect without following, then
      // fulfill the ORIGINAL app response (including real action POST bodies).
      const response = await route.fetch({ maxRedirects: 0, timeout: 0 });
      const location = response.headers().location;
      if (location) {
        const target = new URL(location, url);
        if (target.origin !== appUrl) {
          if (
            request.method() === "GET" &&
            request.isNavigationRequest() &&
            target.origin === "https://login.eveonline.com" &&
            target.pathname === "/v2/oauth/authorize"
          ) {
            // Playwright 1.62 does not route a redirect's subsequent request.
            // A fresh navigation re-enters the picker boundary at the real EVE
            // URL. Keep the actual initiation response's cookies/state; never
            // replace action POSTs or callback responses with canned results.
            const headers: Record<string, string> = {
              ...response.headers(),
              "content-type": "text/html",
            };
            delete headers.location;
            await route.fulfill({
              response,
              status: 200,
              headers,
              body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeHtml(target.href)}">`,
            });
            return;
          }
          await client.violation("browser-redirect", target.href);
          await route.abort();
          return;
        }
      }
      await route.fulfill({ response });
      return;
    }
    if (
      request.method() === "GET" &&
      request.isNavigationRequest() &&
      url.origin === "https://login.eveonline.com" &&
      url.pathname === "/v2/oauth/authorize"
    ) {
      const choices = await client.picker();
      const links = await Promise.all(
        choices.map(async (ch) => {
          const { callback } = await client.authorize(url.href, ch.id);
          return `<li><a href="${escapeHtml(callback)}">Use ${escapeHtml(ch.name)}</a></li>`;
        }),
      );
      const cancel = new URL("/auth/eve/callback", appUrl);
      cancel.searchParams.set("state", url.searchParams.get("state") ?? "");
      cancel.searchParams.set("error", "access_denied");
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><title>Synthetic EVE picker</title><h1>Synthetic EVE picker</h1><ul>${links.join("")}</ul><a href="${escapeHtml(cancel.href)}">Cancel authorization</a></html>`,
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.origin === "https://images.evetech.net" &&
      /^\/characters\/\d+\/portrait$/.test(url.pathname) &&
      [...url.searchParams.keys()].every((key) => key === "size")
    ) {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#555"/></svg>',
      });
      return;
    }
    await client.violation("browser-http", request.url());
    await route.abort();
  };
  await context.route("**/*", async (route) => {
    const work = handle(route);
    active.add(work);
    try {
      await work;
    } finally {
      active.delete(work);
    }
  });
  await context.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    if (
      url.origin === appUrl.replace("http:", "ws:") &&
      ["/_next/hmr", "/_next/webpack-hmr"].includes(url.pathname)
    ) {
      socket.connectToServer();
      return;
    }
    void client.violation("browser-websocket", socket.url()).then(() => socket.close());
  });
  // Keep interception installed while draining: unrouteAll can release newly
  // queued requests while earlier route.fetch responses are still being fulfilled.
  return async () => {
    draining = true;
    await Promise.all(active);
  };
}

async function ownedClient() {
  if (!FLEET_INTEGRATIONS)
    throw new Error("[fleet-e2e] use test:e2e:fleet, not the dry-run profile");
  const connection = JSON.parse(
    readFileSync(FLEET_CONNECTION_FILE, "utf8"),
  ) as FixtureConnection;
  if (connection.worktree !== WORKTREE_ROOT || connection.appUrl !== BASE_URL)
    throw new Error("[fleet-e2e] stale/foreign fixture descriptor");
  const client = fleetClient(connection);
  const health = await client.health();
  if (health.worktree !== WORKTREE_ROOT || health.appUrl !== BASE_URL)
    throw new Error("[fleet-e2e] fixture identity mismatch");
  return client;
}

/** Task 4 imports this test, not @playwright/test: denial checks are automatic. */
export const test = base.extend<{ fleet: FleetClient }>({
  contextOptions: async ({ contextOptions }, use) => {
    const client = await ownedClient();
    await use({
      ...contextOptions,
      serviceWorkers: "block",
      proxy: { server: client.connection.url, bypass: "<-loopback>" },
    });
  },
  fleet: [
    async ({ context }, use) => {
      const client = await ownedClient();
      await client.reset();
      const drain = await installFleetBrowserBoundary(context, client);
      try {
        await use(client);
      } finally {
        // Close only after fetched responses settle; otherwise close disposes
        // their storage while a routing handler is still trying to fulfill it.
        await drain();
        await context.close();
        await drain();
        await client.assertClean();
      }
    },
    { auto: true },
  ],
});
export { expect };
