import { once } from "node:events";
import { createServer } from "node:http";
import type { BrowserContext, WebSocketRoute } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { disposeFleetResources, installFleetBrowserBoundary } from "../e2e/fleet-browser";
import { fleetClient } from "../e2e/fleet-fixtures";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

// Keep the unit job browser-free: substitute only Playwright's registration and
// socket seam. Denial reporting still uses FleetClient's real HTTP/error path.
it.each(["success", "rejection", "timeout"] as const)(
  "closes a denied WebSocket and exposes reporting %s at boundary teardown",
  async (mode) => {
    let received: unknown;
    const control = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        received = { path: req.url, ...JSON.parse(body) };
        if (mode === "timeout") return;
        if (mode === "rejection") res.writeHead(503).end("denial ledger unavailable");
        else res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    control.listen(0, "127.0.0.1");
    await once(control, "listening");
    const closeControl = async () => {
      control.closeAllConnections();
      await new Promise<void>((done) => control.close(() => done()));
    };
    disposers.push(closeControl);
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const client = fleetClient({
      url: `http://127.0.0.1:${address.port}`,
      token: "synthetic-control-token",
      worktree: "synthetic-worktree",
      appUrl: "http://localhost:3987",
    });
    if (mode === "timeout") {
      // Exercise fetch's actual abort/rejection without spending 30 seconds or
      // changing FleetClient's control-channel timeout for the rest of the suite.
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        expect(ms).toBe(30_000);
        return timeout(100);
      });
    }
    let onSocket!: (socket: WebSocketRoute) => void;
    const context = {
      route: async () => {},
      routeWebSocket: async (_pattern: string, handle: typeof onSocket) => {
        onSocket = handle;
      },
    } as unknown as BrowserContext;
    let closed = false;
    const socket = {
      url: () => "wss://unknown.invalid/socket",
      close: async () => {
        closed = true;
      },
    } as unknown as WebSocketRoute;
    const reporting = vi.spyOn(client, "violation");
    const drain = await installFleetBrowserBoundary(context, client);
    onSocket(socket);
    if (mode === "success") {
      await drain();
    } else {
      // Let the real control-channel failure finish before teardown. It must
      // remain observable even after the active work has left the drain set.
      await expect(reporting.mock.results[0].value).rejects.toThrow();
      await expect(drain()).rejects.toMatchObject({
        errors: [
          mode === "timeout"
            ? expect.objectContaining({ name: "TimeoutError" })
            : expect.objectContaining({
                message: expect.stringContaining("denial ledger unavailable"),
              }),
        ],
      });
      // A failure cannot disappear just because reporting finished before drain.
      await expect(drain()).rejects.toThrow(/browser boundary/i);
      let contextClosed = false;
      const laterFailure = new Error("later cleanup failed");
      let cleanupError: unknown;
      try {
        await disposeFleetResources([
          async () => {
            await closeControl();
            throw laterFailure;
          },
          async () => {
            try {
              await drain();
            } finally {
              contextClosed = true;
            }
          },
        ]);
      } catch (error) {
        cleanupError = error;
      }
      // A reporting failure must not strand the remaining guard listeners.
      expect(contextClosed).toBe(true);
      expect(control.listening).toBe(false);
      expect(cleanupError).toMatchObject({
        errors: [
          expect.objectContaining({
            message: expect.stringMatching(/browser boundary/i),
          }),
          laterFailure,
        ],
      });
    }
    expect(closed).toBe(true);
    expect(received).toEqual({
      path: "/violation",
      source: "browser-websocket",
      destination: "wss://unknown.invalid/socket",
    });
  },
);
