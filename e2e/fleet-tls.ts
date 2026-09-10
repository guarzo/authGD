import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import { WORKTREE_ROOT } from "./env";

/** Owns only new files. Never import into a real browser/user/system trust store. */
export function createFleetTrust() {
  const parent = join(WORKTREE_ROOT, "tmp/task-10/fix1");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "trust-"));
  const ca = join(root, "ca.pem");
  const key = join(root, "leaf.key");
  const cert = join(root, "leaf.pem");
  const home = join(root, "home");
  const nss = join(home, ".pki/nssdb");
  const emptyCaDir = join(root, "empty-ca");
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, {
      cwd: root,
      stdio: "ignore",
      timeout: 10_000,
    });
  try {
    chmodSync(root, 0o700);
    mkdirSync(nss, { recursive: true, mode: 0o700 });
    mkdirSync(emptyCaDir, { mode: 0o700 });
    run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Owned fleet fixture CA",
      "-keyout",
      "ca.key",
      "-out",
      ca,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    run("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      key,
      "-out",
      "leaf.csr",
    ]);
    writeFileSync(
      join(root, "leaf.ext"),
      "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n",
      { mode: 0o600 },
    );
    run("openssl", [
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      ca,
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      "leaf.ext",
      "-out",
      cert,
    ]);
    chmodSync(key, 0o600);
    chmodSync(join(root, "ca.key"), 0o600);
    run("certutil", ["-N", "--empty-password", "-d", `sql:${nss}`]);
    run("certutil", [
      "-A",
      "-d",
      `sql:${nss}`,
      "-n",
      "owned-fleet-ca",
      "-t",
      "C,,",
      "-i",
      ca,
    ]);
    return {
      root,
      ca,
      key,
      cert,
      home,
      emptyCaDir,
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      "[fleet-e2e] isolated TLS prerequisite failed (OpenSSL and NSS certutil required)",
    );
  }
}

export function fleetForwardHeaders(headers: IncomingHttpHeaders, origin: URL) {
  // Never trust the peer's forwarding claims. Keep signature headers untouched.
  const result = { ...headers };
  for (const name of Object.keys(result))
    if (name === "forwarded" || name.startsWith("x-forwarded-")) delete result[name];
  return {
    ...result,
    host: origin.host,
    "x-forwarded-host": origin.host,
    "x-forwarded-proto": "https",
    "x-forwarded-port": origin.port,
  };
}

/** Streaming fixed-upstream front: no redirect following, body parsing or URL rewriting. */
export async function startFleetTls(input: {
  appUrl: string;
  upstreamUrl: string;
  cert: string;
  key: string;
  relayMode?: (
    signal: AbortSignal,
  ) => Promise<{ mode: "normal" | "capture" | "replay" | "disconnect" }>;
}) {
  const origin = new URL(input.appUrl);
  const upstream = new URL(input.upstreamUrl);
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "localhost" ||
    !origin.port ||
    origin.origin !== input.appUrl ||
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    !upstream.port ||
    upstream.origin !== input.upstreamUrl ||
    origin.port === upstream.port
  )
    throw new Error("[fleet-e2e] TLS requires distinct fixed owned loopback listeners");
  const sockets = new Set<Socket>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const admissions = new Set<AbortController>();
  const handlers = new Set<Promise<void>>();
  const peers = new Set<ClientRequest>();
  const failures: unknown[] = [];
  function trackPeer(peer: ClientRequest) {
    peers.add(peer);
    peer.on("close", () => peers.delete(peer));
    return peer;
  }
  const cached = new Map<string, { headers: IncomingHttpHeaders; body: Buffer }>();
  async function handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal) {
    const fleetRequest = req.url?.startsWith("/api/fleet/v1/");
    const mode =
      fleetRequest && input.relayMode ? (await input.relayMode(signal)).mode : "normal";
    // A request admitted before close can resume AFTER close. Never create a
    // backend socket then, nor after a disconnected client abandoned its wait.
    if (closed || signal.aborted || req.socket.destroyed || res.destroyed) return;
    if (mode === "normal") cached.clear();
    if (mode === "disconnect") {
      req.socket.destroy();
      return;
    }
    const snapshot = req.method === "GET" && req.url === "/api/fleet/v1/snapshot";
    const session = String(req.headers["x-fleet-session"] ?? "");
    const previous = cached.get(session);
    if (snapshot && mode === "replay" && previous) {
      res.writeHead(200, previous.headers);
      res.end(previous.body);
      return;
    }
    const peer = trackPeer(
      request(
        {
          hostname: "127.0.0.1",
          port: upstream.port,
          path: req.url,
          method: req.method,
          headers: fleetForwardHeaders(req.headers, origin),
          agent: false,
        },
        (response) => {
          // Node's header representation retains Set-Cookie as an array.
          res.writeHead(response.statusCode ?? 502, response.headers);
          if (snapshot && mode === "capture" && response.statusCode === 200) {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1024 * 1024) {
                response.destroy();
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              if (cached.size < 4 || cached.has(session))
                cached.set(session, {
                  headers: response.headers,
                  body: Buffer.concat(chunks),
                });
            });
          }
          response.pipe(res);
        },
      ),
    );
    peer.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => peer.destroy());
    res.on("close", () => peer.destroy());
    const settled = new Promise<void>((resolve) => peer.once("close", resolve));
    req.pipe(peer);
    await settled;
  }
  const server = createServer(
    { cert: readFileSync(input.cert), key: readFileSync(input.key) },
    (req, res) => {
      if (closed) {
        res.destroy();
        return;
      }
      const admission = new AbortController();
      admissions.add(admission);
      // Wire cancellation BEFORE the mode await, including a normally-ended
      // request whose response is abandoned while admission is pending.
      const cancel = () => admission.abort();
      req.once("aborted", cancel);
      res.once("close", cancel);
      const handler = handle(req, res, admission.signal)
        .catch((error) => {
          if (!admission.signal.aborted) failures.push(error);
          res.destroy();
        })
        .finally(() => {
          admissions.delete(admission);
          handlers.delete(handler);
          req.off("aborted", cancel);
          res.off("close", cancel);
        });
      handlers.add(handler);
    },
  );
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  server.on("upgrade", (req, socket, head) => {
    if (
      closed ||
      !["/_next/hmr", "/_next/webpack-hmr"].includes((req.url ?? "").split("?")[0])
    ) {
      socket.destroy();
      return;
    }
    const peer = trackPeer(
      request({
        hostname: "127.0.0.1",
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: fleetForwardHeaders(req.headers, origin),
        agent: false,
      }),
    );
    peer.on("upgrade", (response, backend, initial) => {
      if (closed || socket.destroyed) {
        backend.destroy();
        return;
      }
      track(backend);
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
          response.rawHeaders.reduce((s, v, i) => s + v + (i % 2 ? "\r\n" : ": "), "") +
          "\r\n",
      );
      if (initial.length) socket.write(initial);
      if (head.length) backend.write(head);
      socket.pipe(backend).pipe(socket);
      socket.on("close", () => backend.destroy());
      backend.on("error", () => socket.destroy());
    });
    peer.on("response", (response) => {
      response.resume();
      socket.destroy();
    });
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
    socket.on("close", () => peer.destroy());
    peer.end();
  });
  try {
    server.listen(Number(origin.port), "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server.close();
    throw error;
  }
  return {
    close() {
      if (closing) return closing;
      closed = true;
      for (const admission of admissions) admission.abort();
      for (const peer of peers) peer.destroy();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([
              ...handlers,
              ...[...peers].map(
                (peer) => new Promise<void>((resolve) => peer.once("close", resolve)),
              ),
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
            ]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("[fleet-e2e] TLS drain deadline")),
                3000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          cached.clear();
        }
        if (failures.length)
          throw new AggregateError(failures, "[fleet-e2e] TLS front failed");
      })();
      return closing;
    },
  };
}
