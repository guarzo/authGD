import { chromium, type BrowserContext } from "@playwright/test";
import { createFleetTrust } from "./fleet-tls";
import { startFleetFixtures } from "./fleet-fixtures";
import { withFleetResources } from "./fleet-resources";
import { BASE_URL, WORKTREE_ROOT } from "./env";

export async function withFleetCertificateContext(
  mode: "trusted" | "untrusted" | "wrong-host",
  check: (context: BrowserContext, appUrl: string) => Promise<void>,
) {
  return withFleetResources(async (own) => {
    const stranger = own(createFleetTrust(), (trust) => trust.close());
    const appUrl =
      mode === "wrong-host" ? BASE_URL.replace("localhost", "127.0.0.1") : BASE_URL;
    const proxy = own(
      await startFleetFixtures({ appUrl, worktree: WORKTREE_ROOT }),
      (fixture) => fixture.close(),
    );
    own(proxy.client, (client) => client.assertClean());
    const chrome = own(
      await chromium.launch({
        proxy: { server: proxy.connection.url, bypass: "<-loopback>" },
        env: {
          ...process.env,
          HOME: mode === "untrusted" ? stranger.home : process.env.HOME!,
        },
      }),
      (browser) => browser.close(),
    );
    const context = own(
      await chrome.newContext({
        serviceWorkers: "block",
        proxy: { server: proxy.connection.url, bypass: "<-loopback>" },
      }),
      (context) => context.close(),
    );
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === appUrl ? route.continue() : route.abort(),
    );
    await check(context, appUrl);
  });
}
