import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
import { fleetKeyPair, reconcileFleetKeys } from "./helpers/fleet-sharing";
import { beginPairing } from "@/services/fleet-pairing";
import { createSession } from "@/services/session";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import FleetPairPage from "@/app/fleet/pair/[id]/page";
const cookie = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => cookie }) }));
process.env.DATABASE_URL = TEST_URL;
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  cookie.value = await createSession(
    ctx.db,
    (await seedAccount(ctx.db, { tier: "member" })).id,
  );
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
});
afterAll(() => ctx.cleanup());
it.each([[], ["shared-source-v1"], ["shared-source-v1", "combat-v2"]])(
  "real pairing page discloses exactly requested rights (%j)",
  async (...caps: string[]) => {
    const { pairingId } = await beginPairing(ctx.db, {
      publicKeySpki: fleetKeyPair().publicKeySpki,
      requestedCapabilities: caps,
    });
    const html = renderToStaticMarkup(
      await FleetPairPage({ params: Promise.resolve({ id: pairingId }) }),
    );
    expect(html).toContain("Approve");
    if (caps.includes("combat-v2"))
      for (const text of [
        "incoming and outgoing DPS",
        "recent activity",
        "POINT/SCRAM/NEUT",
        "unverified log labels",
      ])
        expect(html).toContain(text);
    else {
      expect(html).not.toContain("publish");
      expect(html).not.toContain("DPS");
    }
    expect(html).toContain("does not turn on participation or automatic verification");
  },
);
