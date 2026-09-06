import { spawn } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { connect } from "node:net";
import { loadConfig } from "../../src/config";
import { createEsiClient } from "../../src/lib/esi/client";
import { refreshEveToken, verifyEveAccessToken } from "../../src/lib/esi/sso";

async function main() {
  const mode = process.argv[2];
  if (mode === "bootstrap") return;
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
