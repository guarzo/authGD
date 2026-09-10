import { it, expect } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { request } from "node:https";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createFleetTrust, startFleetTls } from "../e2e/fleet-tls";

for (const cancellation of ["owner", "client"] as const)
  it(`fences deferred relay admission after ${cancellation} cancellation`, async () => {
    const trust = createFleetTrust();
    const upstream = createServer((_req, res) => res.end());
    let front: Awaited<ReturnType<typeof startFleetTls>> | undefined;
    let resolveMode!: (mode: { mode: "normal" }) => void;
    let admitted!: () => void;
    const entered = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const mode = new Promise<{ mode: "normal" }>((resolve) => {
      resolveMode = resolve;
    });
    let signal: AbortSignal | undefined;
    let escaped = 0;
    upstream.on("connection", () => {
      escaped++;
    });
    try {
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const addr = upstream.address();
      if (!addr || typeof addr === "string") throw new Error("listener missing");
      front = await startFleetTls({
        appUrl: "https://localhost:3988",
        upstreamUrl: `http://127.0.0.1:${addr.port}`,
        cert: trust.cert,
        key: trust.key,
        relayMode: (admission) => {
          signal = admission;
          admitted();
          return mode;
        },
      });
      const client = request("https://localhost:3988/api/fleet/v1/snapshot", {
        ca: readFileSync(trust.ca),
        agent: false,
      });
      client.on("error", () => {});
      const clientClosed = new Promise<void>((resolve) => client.on("close", resolve));
      client.end();
      await entered;
      let drained = false;
      const closing =
        cancellation === "owner"
          ? front.close().then(() => {
              drained = true;
            })
          : undefined;
      if (cancellation === "client") client.destroy();
      await clientClosed;
      await delay(20);
      expect(signal?.aborted).toBe(true);
      expect(drained, "close reported success with an unsettled admission").toBe(false);
      resolveMode({ mode: "normal" });
      await closing;
      await delay(50);
      expect(escaped).toBe(0);
      await front.close();
    } finally {
      resolveMode?.({ mode: "normal" });
      try {
        await front?.close();
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        trust.close();
      }
    }
  });
