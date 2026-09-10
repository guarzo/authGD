import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@/db";
import {
  character,
  fleetPublisherLease,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
} from "@/db/schema";

/** LIFECYCLE-ONLY fixture. These hand-seeded intent/evidence rows test termination
 * and provenance cleanup. They are NOT worker-verified authority, and MUST NOT be
 * used as positive shared admission evidence in Tasks 4/5 acceptance tests. */
export async function seedLifecycleSource(
  db: Db,
  args: {
    boss: typeof character.$inferSelect;
    deviceId: string;
    now: Date;
    fleetId?: number;
  },
) {
  const { boss, deviceId, now } = args;
  const fleetId = args.fleetId ?? 123;
  const [source] = await db
    .insert(fleetSourceIntent)
    .values({
      id: randomUUID(),
      accountId: boss.accountId,
      deviceId,
      bossCharacterId: boss.id,
      bossOwnerHash: boss.ownerHash,
      bossLinkEpoch: boss.fleetLinkEpoch,
      generation: 1,
      state: "active",
      intentCreatedAt: now,
      intentExpiresAt: new Date(now.getTime() + 60_000),
      activatedAt: now,
      fleetId,
      retainUntil: new Date(now.getTime() + 86400000),
    })
    .returning();
  await db.insert(fleetSourceAuthority).values({
    fleetId,
    sourceId: source.id,
    sourceGeneration: 1,
    authorityGeneration: 7,
    linkedCharacters: [{ characterId: boss.id, linkEpoch: boss.fleetLinkEpoch }],
    verifiedAt: now,
    expiresAt: new Date(now.getTime() + 10000),
  });
  return source;
}

/** LIFECYCLE-ONLY provenance fixture, not a positive shared publish or worker
 * proof. Pairing/session and character inputs come from the real test setup. */
export async function seedLifecycleProjection(
  db: Db,
  args: {
    participant: typeof character.$inferSelect;
    source: typeof fleetSourceIntent.$inferSelect;
    deviceId: string;
    sessionId: string;
    now: Date;
  },
) {
  const { participant, source, deviceId, now } = args;
  const common = {
    characterId: participant.id,
    deviceId,
    sessionId: createHash("sha256").update(args.sessionId).digest("base64url"),
    fleetId: source.fleetId!,
    sourceId: source.id,
    sourceGeneration: source.generation,
    authorityGeneration: 7,
    linkEpoch: participant.fleetLinkEpoch,
    participationGeneration: 1,
  };
  const [row] = await db
    .insert(fleetTelemetryRow)
    .values({
      ...common,
      dps: 42,
      receivedAt: now,
      staleAt: new Date(now.getTime() + 3000),
      hardExpiresAt: new Date(now.getTime() + 10000),
    })
    .returning();
  const [lease] = await db
    .insert(fleetPublisherLease)
    .values({ ...common, leaseExpiresAt: new Date(now.getTime() + 10000) })
    .returning();
  return { row, lease };
}
