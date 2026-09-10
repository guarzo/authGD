import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect } from "vitest";
import type { Db } from "@/db";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { runFleetSourceJob, createFleetSourceMemory } from "@/jobs/fleet-source";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { setFleetParticipation } from "@/services/fleet-participation";
import { controlFleetSource } from "@/services/fleet-source";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { pairDevice, reconcileFleetKeys } from "./fleet-sharing";
import { seedAccount, seedCharacter } from "./seed";
import { testConfig } from "./config";

export const NOW = new Date("2026-09-07T12:00:00.000Z");
export const at = (ms: number) => new Date(NOW.getTime() + ms);
const keys = await generateKeyPair("RS256");
const getKey = createLocalJWKSet({
  keys: [{ ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "shared-test" }],
});

/** Real pairing, explicit consent and actual source job/JWT/ESI parser. Only the
 * provider transport is synthetic. No source/evidence/projection fixture writes. */
export async function sharedAccounts(db: Db) {
  const ready = await reconcileFleetKeys(db);
  await transitionFleetSharingMode(db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(db, { tier: "member" });
  const participant = await seedAccount(db, { tier: "member", status: "cryo" });
  const boss = await seedCharacter(db, testConfig(), {
    id: 90000001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const alts = [];
  for (const id of [90000002, 90000003, 90000004])
    alts.push(
      await seedCharacter(db, testConfig(), {
        id,
        accountId: participant.id,
        scopes: [],
        refreshToken: null,
        tokenStatus: "missing",
      }),
    );
  const a = await participatingDevice(db, owner.id);
  const b = await participatingDevice(db, participant.id);
  const source = await realSource(db, a, boss, 123, [boss.id, alts[0].id, alts[1].id]);
  return { owner, participant, boss, alts, a, b, source };
}

export async function participatingDevice(db: Db, accountId: string) {
  const p = await pairDevice(db, accountId, NOW, [SHARED_CAPABILITY]);
  expect(
    (
      await acknowledgeFleetCapabilities(db, {
        sessionId: p.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      })
    ).ok,
  ).toBe(true);
  expect(
    await setFleetParticipation(db, {
      sessionId: p.sessionId,
      revision: 2,
      now: at(500),
      enabled: true,
      expectedGeneration: 0,
    }),
  ).toEqual({ ok: true, value: { enabled: true, generation: 1 } });
  return p;
}

export async function realSource(
  db: Db,
  p: Awaited<ReturnType<typeof pairDevice>>,
  boss: Awaited<ReturnType<typeof seedCharacter>>,
  fleet: number,
  rosterIds: number[],
  observedAt = 2000,
) {
  const sourceId = randomUUID();
  expect(
    (
      await controlFleetSource(db, {
        sessionId: p.sessionId,
        revision: 3,
        now: at(1000),
        command: {
          operation: "start",
          sourceId,
          expectedGeneration: 0,
          characterId: boss.id,
          characterLinkEpoch: boss.fleetLinkEpoch,
          intentCreatedAt: NOW,
        },
      })
    ).ok,
  ).toBe(true);
  let now = at(observedAt);
  const fetchImpl: typeof fetch = async (raw, init) => {
    const url = String(raw);
    if (url === "https://login.eveonline.com/v2/oauth/token") {
      const jwt = await new SignJWT({
        name: boss.name,
        owner: boss.ownerHash,
        scp: [FLEET_READ_SCOPE],
      })
        .setProtectedHeader({ alg: "RS256", kid: "shared-test" })
        .setIssuer("https://login.eveonline.com")
        .setAudience("EVE Online")
        .setSubject(`CHARACTER:EVE:${boss.id}`)
        .setExpirationTime(Math.floor(at(3600000).getTime() / 1000))
        .sign(keys.privateKey);
      return Response.json({ access_token: jwt, refresh_token: "synthetic-rotated" });
    }
    if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer "))
      throw new Error("missing synthetic bearer");
    const headers = {
      Date: now.toUTCString(),
      "Cache-Control": "max-age=5",
      "x-esi-error-limit-remain": "100",
      "x-esi-error-limit-reset": "60",
    };
    if (url === `https://esi.evetech.net/latest/characters/${boss.id}/fleet/`)
      return Response.json({ fleet_id: fleet, fleet_boss_id: boss.id }, { headers });
    if (url === `https://esi.evetech.net/latest/fleets/${fleet}/members/`)
      return Response.json(
        rosterIds.map((id) => ({ character_id: id })),
        { headers },
      );
    throw new Error("unexpected synthetic provider endpoint");
  };
  const deps = {
    db,
    cfg: testConfig(),
    fetchImpl,
    getKey,
    now: () => now,
    memory: createFleetSourceMemory(),
  };
  const run = () => runFleetSourceJob(deps, { sourceId, generation: 1 });
  await run();
  return {
    sourceId,
    run,
    setNow: (ms: number) => {
      now = at(ms);
    },
    setRosterIds: (ids: number[]) => {
      rosterIds = ids;
    },
  };
}
