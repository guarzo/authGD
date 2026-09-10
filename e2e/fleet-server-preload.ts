import { get } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { threadId } from "node:worker_threads";
import { http, HttpResponse, passthrough } from "msw";
import { setupServer } from "msw/node";
import { fleetClient, safeDestination } from "./fleet-fixtures";
import {
  assertFleetDatabaseUrl,
  assertFleetEnvironment,
  fleetFontWorkerPort,
} from "./fleet-server";

export async function installFleetInterception() {
  const connection = assertFleetEnvironment(process.env);
  const client = fleetClient(connection);
  const db = assertFleetDatabaseUrl(process.env.DATABASE_URL!);
  const upstream = new URL(process.env.E2E_FLEET_UPSTREAM ?? connection.appUrl);
  if (
    upstream.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(upstream.hostname) ||
    !upstream.port
  )
    throw new Error("[fleet-e2e] invalid private upstream");
  const allowedPorts = new Set([
    upstream.port,
    db.port,
    new URL(connection.url).port,
    new URL(connection.appUrl).port,
  ]);
  const fontWorkerPort = fleetFontWorkerPort();
  if (fontWorkerPort) allowedPorts.add(fontWorkerPort);
  // Invoked with Reflect.apply and the original socket receiver below.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalConnect = Socket.prototype.connect;
  // MSW covers global fetch and node:http(s). This lower boundary also denies
  // direct undici/http2/raw sockets before DNS or connect, instead of trusting
  // that every future dependency will use the currently intercepted fetch.
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    const options =
      typeof first === "object" && first !== null
        ? (first as { host?: string; port?: number | string; path?: string })
        : {
            port: first,
            host: typeof normalized[1] === "string" ? normalized[1] : "localhost",
          };
    const host = options.host ?? "localhost";
    if (
      !("path" in options && options.path) &&
      ["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host) &&
      allowedPorts.has(String(options.port))
    ) {
      return Reflect.apply(originalConnect, this, args) as Socket;
    }
    // Recording keeps an app's catch from hiding this violation. A failed
    // control channel is itself fatal, never a reason to connect externally.
    void client.violation("socket", `tcp://${host}:${String(options.port)}`).catch(() => {
      process.exitCode = 1;
    });
    throw new Error("[fleet-e2e] denied outbound socket before connection");
  };

  const checkUrl = "https://fleet-interception.invalid/self-check";
  const msw = setupServer(
    http.all("*", async ({ request }) => {
      const url = new URL(request.url);
      if (url.href === checkUrl)
        return HttpResponse.json({ intercepted: connection.token });
      // Next 16 devtools lazily fetch version metadata when HMR connects. Keep
      // its explicit optional asset offline; do not allow registry passthrough.
      if (
        process.env.NODE_ENV === "development" &&
        request.method === "GET" &&
        url.href === "https://registry.npmjs.org/-/package/next/dist-tags"
      )
        return new HttpResponse(null, { status: 503 });
      if (
        url.origin === upstream.origin ||
        url.origin === connection.url ||
        url.origin === connection.appUrl ||
        url.origin === connection.appUrl.replace("localhost", "127.0.0.1")
      )
        return passthrough();
      if (
        url.origin === "https://login.eveonline.com" ||
        url.origin === "https://esi.evetech.net"
      ) {
        const response = await client.provider({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
        });
        return new HttpResponse(JSON.stringify(response.body), {
          status: response.status,
          headers: { "content-type": "application/json", ...response.headers },
        });
      }
      await client.violation("server-http", safeDestination(request.url));
      return HttpResponse.error();
    }),
  );
  msw.listen({ onUnhandledRequest: "error" });
  // MSW patches the CommonJS HTTP objects; refresh named ESM builtin exports
  // too, including `get` imported above before interception was installed.
  syncBuiltinESMExports();
  const result = (await (await fetch(checkUrl)).json()) as { intercepted?: string };
  if (result.intercepted !== connection.token)
    throw new Error("[fleet-e2e] fetch interception self-check failed");
  const httpResult = await new Promise<string>((resolve, reject) => {
    get(checkUrl, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
  if (JSON.parse(httpResult).intercepted !== connection.token)
    throw new Error("[fleet-e2e] HTTP interception self-check failed");
  const identity = await client.health();
  if (identity.worktree !== connection.worktree || identity.appUrl !== connection.appUrl)
    throw new Error("[fleet-e2e] fixture ownership handshake failed");
  await client.preload(process.pid, threadId);
  // Deliberately retain interception for the process lifetime, including Next's
  // shutdown work. Restoring fetch before exit creates an unguarded tail.
}
