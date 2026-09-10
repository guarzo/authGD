import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "@/db";
import {
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetSourceIntent,
} from "@/db/schema";
import {
  SHARED_CAPABILITY,
  type SignedFleetCall,
  type FleetReply,
  type FleetCode,
} from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { logAudit } from "@/services/audit";
import { fleetDatabaseNow } from "@/services/fleet-key-identity";
import {
  fleetLifecycleTransaction,
  hasUsableFleetRead,
  invalidateFleetSources,
  lockFleetAccounts,
  lockFleetIdentityCharacters,
  lockFleetLifecycle,
  FLEET_SOURCE_INTENT_TTL_MS,
  FLEET_SOURCE_TOMBSTONE_RETENTION_MS,
} from "@/services/fleet-lifecycle";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  commitSessionCadence,
  gateSignedSession,
  isRetryableRelayError,
  RelayRefusal,
  sampleFleetSessionAdmission,
} from "@/services/fleet-relay";
import { enqueueSync } from "@/services/outbox";

export type SourceCommand =
  | {
      operation: "start";
      sourceId: string;
      expectedGeneration: 0;
      characterId: number;
      characterLinkEpoch: string;
      intentCreatedAt: Date;
    }
  | { operation: "stop"; sourceId: string; expectedGeneration: number };
// Terminal lifecycle reasons remain private. Unknown historical reasons collapse
// to ended, never leak database/provider messages through the closed DTO.
const REASONS = [
  "stopped",
  "expired",
  "superseded",
  "not_in_fleet",
  "boss_lost",
  "identity_changed",
  "fleet_read_invalid",
  "member_lost",
  "device_revoked",
  "token_invalid",
  "mode_transition",
  "service_unavailable",
  "untrustworthy_evidence",
  "timed_out",
  "ended",
] as const;
export type SourceReason = (typeof REASONS)[number];
export type SourceView = {
  sourceId: string;
  generation: number;
  characterId: number | null;
  state: "pending" | "active" | "paused" | "ended";
  reason: SourceReason | null;
  pendingExpiresAt: Date | null;
};
export type SourceStateView = {
  sources: SourceView[];
  characters: {
    characterId: number;
    characterName: string;
    characterLinkEpoch: string;
    hasFleetRead: boolean;
    tokenUsable: boolean;
  }[];
};
const commandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("start"),
      sourceId: z.uuid(),
      expectedGeneration: z.literal(0),
      characterId: z.number().int().positive(),
      characterLinkEpoch: z.uuid(),
      intentCreatedAt: z.date(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("stop"),
      sourceId: z.uuid(),
      expectedGeneration: z.number().int().min(0).max(2_147_483_646),
    })
    .strict(),
]);
/** Per-account caps include every device: cycling device IDs cannot evade storage
 * limits. Retained fences count, while identical retries need no new capacity. */
export const MAX_LIVE_FLEET_SOURCES = 16;
export const MAX_RETAINED_FLEET_INTENTS = 256;
export const MAX_SOURCE_CONTROL_CHARACTERS = 256;
export function sourceView(source: typeof fleetSourceIntent.$inferSelect): SourceView {
  const reason =
    source.terminalReason ??
    (source.latestOutcome === "verified" ? null : source.latestOutcome);
  return {
    sourceId: source.id,
    generation: source.generation,
    characterId: source.bossCharacterId,
    state: source.state,
    reason:
      reason === null
        ? null
        : REASONS.includes(reason as SourceReason)
          ? (reason as SourceReason)
          : "ended",
    pendingExpiresAt:
      source.state !== "ended" && source.activatedAt === null
        ? source.intentExpiresAt
        : null,
  };
}
async function actorProbe(tx: DbTx, sessionId: string) {
  const key = createHash("sha256").update(sessionId).digest("base64url");
  const [probe] = await tx
    .select({ accountId: fleetDevice.accountId, deviceId: fleetDevice.id })
    .from(fleetDeviceSession)
    .innerJoin(fleetDevice, eq(fleetDevice.id, fleetDeviceSession.deviceId))
    .where(eq(fleetDeviceSession.id, key));
  if (!probe) throw new RelayRefusal("unauthorized");
  return probe;
}
async function gateControl(
  tx: DbTx,
  call: SignedFleetCall,
  probe: Awaited<ReturnType<typeof actorProbe>>,
  tier?: string,
) {
  const gate = await gateSignedSession(tx, {
    ...call,
    cadence: "read",
    invalidSessionCode: "unauthorized",
  });
  if (gate.device.id !== probe.deviceId || gate.device.accountId !== probe.accountId)
    throw new RelayRefusal("unauthorized");
  if (tier !== "member") throw new RelayRefusal("forbidden");
  if (
    ![
      gate.device.approvedCapabilities,
      gate.session.approvedCapabilities,
      gate.session.acknowledgedCapabilities,
    ].every((c) => c.includes(SHARED_CAPABILITY))
  )
    throw new RelayRefusal("capability_required");
  return gate;
}
async function reply<T>(work: () => Promise<T>): Promise<FleetReply<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (isRetryableRelayError(err)) return { ok: false, code: "service_unavailable" };
    throw err;
  }
}
export async function controlFleetSource(
  db: Db,
  call: SignedFleetCall & { command: SourceCommand },
): Promise<FleetReply<SourceView>> {
  const parsed = commandSchema.safeParse(call.command);
  if (!parsed.success) return { ok: false, code: "invalid_intent" };
  const command = parsed.data;
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const mode = await lockFleetSharingMode(tx);
      if (!mode.enabled || mode.keyIdentityPhase !== "ready")
        throw new RelayRefusal("feature_disabled");
      const probe = await actorProbe(tx, call.sessionId);
      const identities = await lockFleetIdentityCharacters(
        tx,
        command.operation === "start" ? [command.characterId] : [],
      );
      const owner = (await lockFleetAccounts(tx, [probe.accountId])).get(probe.accountId);
      // Prepare the actor device as well as existing source devices BEFORE the
      // shared gate, including Stop's absent-ID cancellation fence.
      const locked = await lockFleetLifecycle(tx, {
        sourceIds: [command.sourceId],
        deviceIds: [probe.deviceId],
      });
      const gate = await gateControl(tx, call, probe, owner?.tier);
      const now = await fleetDatabaseNow(tx, call.now);
      const [old] = await tx
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.id, command.sourceId));
      // Account-owned controls never transfer the initiating device attribution.
      if (old && old.accountId !== probe.accountId) throw new RelayRefusal("forbidden");
      const finish = async (source: typeof fleetSourceIntent.$inferSelect) => {
        const admitted = sampleFleetSessionAdmission(gate.session, {
          ...call,
          cadence: "read",
          invalidSessionCode: "unauthorized",
        });
        await commitSessionCadence(tx, gate.session.id, {
          revision: call.revision,
          now: admitted,
          cadence: "read",
        });
        return sourceView(source);
      };
      if (command.operation === "start") {
        const created = command.intentCreatedAt.getTime();
        if (
          created > now.getTime() ||
          now.getTime() >= created + FLEET_SOURCE_INTENT_TTL_MS
        )
          throw new RelayRefusal("invalid_intent");
        const boss = identities.get(command.characterId);
        if (
          !boss ||
          boss.accountId !== probe.accountId ||
          boss.fleetLinkEpoch !== command.characterLinkEpoch
        )
          throw new RelayRefusal("forbidden");
        if (!hasUsableFleetRead(boss)) throw new RelayRefusal("fleet_read_required");
        if (old) {
          if (
            old.state === "ended" ||
            old.bossCharacterId !== boss.id ||
            old.bossOwnerHash !== boss.ownerHash ||
            old.bossLinkEpoch !== boss.fleetLinkEpoch ||
            old.intentCreatedAt.getTime() !== created
          )
            throw new RelayRefusal("conflict");
          return finish(old);
        }
      } else if (old) {
        if (old.generation !== command.expectedGeneration)
          throw new RelayRefusal("conflict");
        if (old.state === "ended") return finish(old);
        await invalidateFleetSources(
          tx,
          {
            ...locked,
            sources: locked.sources.filter((s) => s.id === old.id),
            selectors: { sourceIds: [old.id] },
          },
          "stopped",
          probe.accountId,
          now,
        );
        const [ended] = await tx
          .select()
          .from(fleetSourceIntent)
          .where(eq(fleetSourceIntent.id, old.id));
        return finish(ended);
      } else if (command.expectedGeneration !== 0) throw new RelayRefusal("conflict");
      const retained = await tx
        .select({ id: fleetSourceIntent.id })
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.accountId, probe.accountId))
        .limit(MAX_RETAINED_FLEET_INTENTS);
      if (retained.length >= MAX_RETAINED_FLEET_INTENTS)
        throw new RelayRefusal("rate_limited");
      if (command.operation === "start") {
        const live = await tx
          .select({ id: fleetSourceIntent.id })
          .from(fleetSourceIntent)
          .where(
            and(
              eq(fleetSourceIntent.accountId, probe.accountId),
              ne(fleetSourceIntent.state, "ended"),
            ),
          )
          .limit(MAX_LIVE_FLEET_SOURCES);
        if (live.length >= MAX_LIVE_FLEET_SOURCES) throw new RelayRefusal("rate_limited");
      }
      const boss =
        command.operation === "start" ? identities.get(command.characterId)! : null;
      const created = command.operation === "start" ? command.intentCreatedAt : now;
      const expires = new Date(created.getTime() + FLEET_SOURCE_INTENT_TTL_MS);
      const [source] = await tx
        .insert(fleetSourceIntent)
        .values({
          id: command.sourceId,
          accountId: probe.accountId,
          deviceId: probe.deviceId,
          bossCharacterId: boss?.id ?? null,
          bossOwnerHash: boss?.ownerHash ?? null,
          bossLinkEpoch: boss?.fleetLinkEpoch ?? null,
          generation: 1,
          state: boss ? "pending" : "ended",
          intentCreatedAt: created,
          intentExpiresAt: expires,
          nextFetchAt: boss ? now : null,
          endedAt: boss ? null : now,
          terminalReason: boss ? null : "stopped",
          retainUntil: new Date(expires.getTime() + FLEET_SOURCE_TOMBSTONE_RETENTION_MS),
        })
        .returning();
      await logAudit(tx, {
        actor: probe.accountId,
        action: boss ? "fleet_source.started" : "fleet_source.ended",
        target: source.id,
        details: { deviceId: probe.deviceId, reason: boss ? "requested" : "stopped" },
      });
      if (boss)
        await enqueueSync(tx, {
          kind: "fleet-source",
          sourceId: source.id,
          generation: source.generation,
        });
      return finish(source);
    }),
  );
}
export async function readFleetSourceState(
  db: Db,
  call: SignedFleetCall,
): Promise<FleetReply<SourceStateView>> {
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const mode = await lockFleetSharingMode(tx);
      if (!mode.enabled || mode.keyIdentityPhase !== "ready")
        throw new RelayRefusal("feature_disabled");
      const probe = await actorProbe(tx, call.sessionId);
      const owner = (await lockFleetAccounts(tx, [probe.accountId])).get(probe.accountId);
      const gate = await gateControl(tx, call, probe, owner?.tier);
      const sources = await tx
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.accountId, probe.accountId))
        .orderBy(fleetSourceIntent.id)
        .limit(MAX_RETAINED_FLEET_INTENTS);
      const characters = await tx
        .select()
        .from(character)
        .where(eq(character.accountId, probe.accountId))
        .orderBy(character.id)
        .limit(MAX_SOURCE_CONTROL_CHARACTERS + 1);
      if (characters.length > MAX_SOURCE_CONTROL_CHARACTERS)
        throw new RelayRefusal("service_unavailable");
      const now = sampleFleetSessionAdmission(gate.session, {
        ...call,
        cadence: "read",
        invalidSessionCode: "unauthorized",
      });
      await commitSessionCadence(tx, gate.session.id, {
        revision: call.revision,
        now,
        cadence: "read",
      });
      return {
        sources: sources.map(sourceView),
        characters: characters.map((ch) => ({
          characterId: ch.id,
          characterName: ch.name,
          characterLinkEpoch: ch.fleetLinkEpoch,
          hasFleetRead: ch.scopes.includes(FLEET_READ_SCOPE),
          tokenUsable:
            !!ch.refreshTokenEnc &&
            ch.tokenStatus !== "invalid" &&
            ch.tokenStatus !== "missing",
        })),
      };
    }),
  );
}
