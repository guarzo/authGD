import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createSocket } from "node:dgram";
import { request } from "node:https";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { createFleetTrust, startFleetTls } from "../e2e/fleet-tls";
import { startFleetFixtures } from "../e2e/fleet-fixtures";
import { pinnedWingmanRoot } from "../e2e/fleet-run";
import { withFleetResources } from "../e2e/fleet-resources";
import { WORKTREE_ROOT } from "../e2e/env";

async function closeServer(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
}
async function listen(server: Server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener missing");
  return `http://127.0.0.1:${address.port}`;
}
async function probePython(
  trust: ReturnType<typeof createFleetTrust>,
  probe: string,
  ca = trust.ca,
) {
  return withFleetResources(async (own) => {
    const root = join(trust.root, `${probe}-${Date.now()}`);
    mkdirSync(root, { mode: 0o700 });
    const python = process.env.E2E_WINGMAN_PYTHON;
    if (!python) throw new Error("explicit pinned Python required");
    const child = own(
      spawn(python, [join(WORKTREE_ROOT, "e2e/fleet-python.py")], {
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          E2E_WINGMAN_ROOT: pinnedWingmanRoot(),
          FLEET_INSTALL_ROOT: root,
          FLEET_ORIGIN: "https://localhost:3988",
          FLEET_PROBE: probe,
          SSL_CERT_FILE: ca,
          SSL_CERT_DIR: trust.emptyCaDir,
          LOCALAPPDATA: root,
          HOME: root,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      async (child) => {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const ended = once(child, "close");
          child.kill("SIGKILL");
          await ended;
        }
      },
    );
    let output = Buffer.alloc(0);
    let oversized = false;
    let stderr = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 512) {
        oversized = true;
        child.kill("SIGKILL");
      } else if (!oversized) output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", () => {
      stderr = true;
    });
    own(
      setTimeout(() => child.kill("SIGKILL"), 10_000),
      clearTimeout,
    );
    const [code] = await once(child, "close");
    expect(oversized).toBe(false);
    expect(stderr, `Python ${probe} emitted an error`).toBe(false);
    expect(code, `Python ${probe} bootstrap failed`).toBe(0);
    return JSON.parse(output.toString()) as {
      tls?: string;
      denials?: number;
      escaped?: number;
      reason?: number;
      redirect?: string;
    };
  });
}

/** HTTPS is the logical identity, not a relaxed production client origin. */
describe("joint fleet fixture boundary", () => {
  it("stages and reveals the factory-created Fleet page, checks Linux fallback, and refuses every stale page callback", async () => {
    let removedRoot = "";
    await withFleetResources(async (own) => {
      const trust = own(createFleetTrust(), (trust) => trust.close());
      removedRoot = trust.root;
      expect(await probePython(trust, "page-identity")).toEqual({
        identity: "verified",
        denials: 0,
        native_resize: false,
        native_activation: false,
        callbacks: [
          "fleet_bar_snapshot",
          "fleet_bar_ready",
          "fit_fleet_bar_height",
          "save_fleet_bar_pos",
          "settle_fleet_bar_resize",
          "reset_fleet_bar_page_width",
          "hide_fleet_bar",
          "activate_fleet_bar",
          "deactivate_fleet_bar",
        ],
        position_phases: ["begin", "end"],
      });
    });
    expect(existsSync(removedRoot)).toBe(false);
  });
  it("verifies fixture CA and hostname, preserves signed bytes/cookies and refuses redirects", async () => {
    let removedRoot = "";
    const send = (host: string, ca?: Buffer) =>
      new Promise<{ status: number; cookies: string[]; body: string }>(
        (resolve, reject) => {
          const req = request(
            `https://${host}:3988/api/fleet/v1/snapshot?raw=%2f`,
            {
              method: "PUT",
              ca,
              agent: false,
              headers: {
                "x-fleet-signature": "synthetic-exact-signature",
                "x-forwarded-proto": "http",
                "x-forwarded-host": "attacker.invalid",
              },
            },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += String(chunk);
              });
              res.on("end", () =>
                resolve({
                  status: res.statusCode!,
                  cookies: res.headers["set-cookie"]!,
                  body,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end('{ "rows": [] }');
        },
      );
    await withFleetResources(async (own) => {
      const trust = own(createFleetTrust(), (trust) => trust.close());
      removedRoot = trust.root;
      const seen: Array<{
        path: string;
        body: string;
        host: string;
        proto: string;
        signature: string;
      }> = [];
      const upstream = own(
        createServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => {
            body += String(chunk);
          });
          req.on("end", () => {
            seen.push({
              path: req.url!,
              body,
              host: String(req.headers.host),
              proto: String(req.headers["x-forwarded-proto"]),
              signature: String(req.headers["x-fleet-signature"]),
            });
            res.writeHead(307, {
              "set-cookie": [
                "first=one; Secure; HttpOnly",
                "second=two; Secure; HttpOnly",
              ],
              location: "https://not-owned.invalid/never",
            });
            res.end("unchanged");
          });
        }),
        closeServer,
      );
      own(
        await startFleetTls({
          appUrl: "https://localhost:3988",
          upstreamUrl: await listen(upstream),
          cert: trust.cert,
          key: trust.key,
        }),
        (front) => front.close(),
      );
      await expect(send("localhost")).rejects.toMatchObject({
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      await expect(send("127.0.0.1", readFileSync(trust.ca))).rejects.toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
      expect(await send("localhost", readFileSync(trust.ca))).toEqual({
        status: 307,
        cookies: ["first=one; Secure; HttpOnly", "second=two; Secure; HttpOnly"],
        body: "unchanged",
      });
      expect(seen).toEqual([
        {
          path: "/api/fleet/v1/snapshot?raw=%2f",
          body: '{ "rows": [] }',
          host: "localhost:3988",
          proto: "https",
          signature: "synthetic-exact-signature",
        },
      ]);
    });
    expect(existsSync(removedRoot)).toBe(false);
    await expect(send("localhost")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
  it.each(["trusted", "untrusted", "wrong-host", "egress"])(
    "bootstraps Python default verifying transport: %s",
    async (probe) => {
      await withFleetResources(async (own) => {
        const trust = own(createFleetTrust(), (trust) => trust.close());
        const stranger = own(createFleetTrust(), (trust) => trust.close());
        const upstream = own(
          createServer((_req, res) => res.end("fixture")),
          closeServer,
        );
        let escaped = 0;
        const forbidden = own(createServer(), closeServer);
        forbidden.on("connection", (socket) => {
          escaped++;
          socket.destroy();
        });
        await listen(forbidden, 3989);
        for (const [kind, host] of [
          ["udp4", "127.0.0.1"],
          ["udp6", "::1"],
        ] as const) {
          const udp = own(
            createSocket(kind),
            (socket) => new Promise<void>((resolve) => socket.close(resolve)),
          );
          udp.on("message", () => {
            escaped++;
          });
          udp.bind(3989, host);
          await once(udp, "listening");
        }
        own(
          await startFleetTls({
            appUrl: "https://localhost:3988",
            upstreamUrl: await listen(upstream),
            cert: trust.cert,
            key: trust.key,
          }),
          (front) => front.close(),
        );
        const result = await probePython(
          trust,
          probe,
          probe === "untrusted" ? stranger.ca : trust.ca,
        );
        if (probe === "trusted") expect(result.tls).toBe("verified");
        else if (probe === "egress") {
          expect(result.escaped).toBe(0);
          expect(result.denials).toBe(14);
        } else {
          expect(result.tls).toBe("certificate_rejected");
          expect(result.reason).toBeGreaterThan(0);
        }
        expect(escaped, "denied TCP/UDP reached its destination").toBe(0);
      });
    },
  );
  it("Python's production signed client refuses redirects without touching their fixture target", async () => {
    await withFleetResources(async (own) => {
      const trust = own(createFleetTrust(), (trust) => trust.close());
      let redirected = 0;
      let signed = 0;
      const upstream = own(
        createServer((req, res) => {
          if (req.url === "/redirect-target") {
            redirected++;
            res.end();
            return;
          }
          if (req.headers["x-fleet-signature"] && req.headers["x-fleet-session"])
            signed++;
          res.writeHead(307, { location: "https://localhost:3988/redirect-target" });
          res.end();
        }),
        closeServer,
      );
      own(
        await startFleetTls({
          appUrl: "https://localhost:3988",
          upstreamUrl: await listen(upstream),
          cert: trust.cert,
          key: trust.key,
        }),
        (front) => front.close(),
      );
      expect(await probePython(trust, "signed-redirect")).toEqual({
        redirect: "refused",
        denials: 0,
      });
      expect(signed).toBe(1);
      expect(redirected).toBe(0);
    });
  });
  it("an occupied front port releases owned startup resources, not the external holder", async () => {
    const holder = createServer((_req, res) => res.end());
    let trustRoot = "";
    let upstream: Server | undefined;
    try {
      await listen(holder, 3988);
      await expect(
        withFleetResources(async (own) => {
          const trust = own(createFleetTrust(), (trust) => trust.close());
          trustRoot = trust.root;
          upstream = own(createServer(), closeServer);
          own(
            await startFleetTls({
              appUrl: "https://localhost:3988",
              upstreamUrl: await listen(upstream),
              cert: trust.cert,
              key: trust.key,
            }),
            (front) => front.close(),
          );
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(existsSync(trustRoot)).toBe(false);
      expect(upstream?.listening).toBe(false);
      expect(holder.listening).toBe(true);
    } finally {
      await closeServer(holder);
    }
  });
  it("accepts one canonical owned HTTPS origin without allowing a remote proxy", async () => {
    await withFleetResources(async (own) => {
      const fixture = own(
        await startFleetFixtures({
          appUrl: "https://localhost:3988",
          worktree: WORKTREE_ROOT,
        }),
        (fixture) => fixture.close(),
      );
      expect(await fixture.client.health()).toEqual({
        appUrl: "https://localhost:3988",
        worktree: WORKTREE_ROOT,
      });
      await fixture.client.assertClean();
    });
    await expect(
      startFleetFixtures({
        appUrl: "https://not-owned.example:3988",
        worktree: WORKTREE_ROOT,
      }),
    ).rejects.toThrow(/loopback/);
  });
});
