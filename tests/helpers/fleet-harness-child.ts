import { spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { request } from "node:https";
import { connect } from "node:net";
import { loadConfig } from "../../src/config";
import { createEsiClient } from "../../src/lib/esi/client";
import { refreshEveToken, verifyEveAccessToken } from "../../src/lib/esi/sso";

async function main() {
  const mode = process.argv[2];
  if (mode === "bootstrap") return;
  if (mode === "next-registry" || mode === "next-registry-denied") {
    const probes =
      mode === "next-registry"
        ? [
            {
              transport: "fetch",
              method: "POST",
              url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "https",
              method: "POST",
              url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "fetch",
              method: "GET",
              url: "https://registry.npmjs.org/-/package/next/dist-tags",
            },
          ]
        : [
            {
              transport: "fetch",
              method: "GET",
              url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "fetch",
              method: "PUT",
              url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "fetch",
              method: "POST",
              url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk/",
            },
            {
              transport: "fetch",
              method: "POST",
              url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk?probe=lookalike",
            },
            {
              transport: "fetch",
              method: "POST",
              url: "http://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "fetch",
              method: "POST",
              url: "https://registry.npmjs.org.example.com/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "fetch",
              method: "POST",
              url: "https://registry.npmjs.org:8443/-/npm/v1/security/advisories/bulk",
            },
            {
              transport: "fetch",
              method: "POST",
              url: "https://registry.npmjs.org/-/package/next/dist-tags",
            },
          ];
    const results = [];
    // Await each refusal's ledger write before starting the next fixed probe.
    for (const probe of probes) {
      try {
        const response =
          probe.transport === "https"
            ? await new Promise<{ status: number | undefined; body: string }>(
                (resolve, reject) => {
                  const req = request(probe.url, { method: probe.method }, (res) => {
                    let body = "";
                    res.on("data", (chunk: Buffer) => {
                      body += chunk.toString();
                    });
                    res.on("end", () => resolve({ status: res.statusCode, body }));
                    res.on("error", reject);
                  });
                  req.on("error", reject);
                  req.end();
                },
              )
            : await fetch(probe.url, { method: probe.method }).then(async (res) => ({
                status: res.status,
                body: await res.text(),
              }));
        results.push({ ...probe, ...response });
      } catch {
        results.push({ ...probe, refused: true });
      }
    }
    console.log(`FLEET_NEXT_REGISTRY_RESULTS=${JSON.stringify(results)}`);
    return;
  }
  if (mode === "denied") {
    const target = process.env.FLEET_HARNESS_TARGET!;
    await fetch(target).catch(() => null);
    await fetch("https://esi.evetech.net/latest/unexpected/").catch(() => null);
    await new Promise<void>((resolve) => {
      get(target)
        .on("error", () => resolve())
        .on("response", (res) => {
          res.resume();
          resolve();
        });
    });
    const url = new URL(target);
    try {
      connect({ host: url.hostname, port: Number(url.port) }).destroy();
    } catch {
      /* Deliberately caught: the fixture ledger must still fail the run. */
    }
    return;
  }
  if (mode === "providers") {
    // A second actual Node process must inherit interception without adding
    // NODE_OPTIONS itself. This models the Next CLI's server child boundary.
    const nested = spawn(process.execPath, [process.argv[1], "leaf"], {
      stdio: "inherit",
      env: process.env,
    });
    const [code] = await once(nested, "exit");
    if (code !== 0) throw new Error("inherited child failed");
    return;
  }
  const cfg = loadConfig();
  const tokens = await refreshEveToken(cfg, "fleet-test-refresh");
  const identity = await verifyEveAccessToken(tokens.accessToken);
  const esi = createEsiClient({ userAgent: cfg.esiContact });
  const membership = await esi.getCharacterFleet(
    identity.characterId,
    tokens.accessToken,
  );
  const roster = await esi.getFleetMembers(membership.value.fleetId, tokens.accessToken);
  console.log(JSON.stringify({ identity, roster: roster.value }));
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
