import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbTx } from "@/db";
import { character, fleetSourceIntent } from "@/db/schema";
import {
  SourceStartSchema,
  SourceStopSchema,
  SourceStartResultSchema,
  SourceStopResultSchema,
  SourceStopReceiptSchema,
  SourcesGetSchema,
  parseSourceStartResult,
  parseSourceStopResult,
  AUTOMATIC_INTENT_TTL_MS,
  AUTOMATIC_RECEIPT_TTL_MS,
  type SourceStart,
  type SourceStop,
  type SourceView,
  type SourceStartResult,
  type SourceStopResult,
  type SourceStopReceipt,
  type SourcesGet,
} from "@/core/fleet-automatic";
import { FLEET_V2_BYTE_LIMITS, checkedDateAdd } from "@/core/fleet-api-v2";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import type { SignedFleetCall, FleetReply, FleetCode } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { serializeFleetV2Json } from "@/lib/fleet-api-v2";
import { logAudit } from "@/services/audit";
import {
  fleetLifecycleTransaction,
  FleetLifecycleRetry,
  hasUsableFleetRead,
  invalidateFleetSources,
  FLEET_SOURCE_INTENT_TTL_MS,
  FLEET_SOURCE_TOMBSTONE_RETENTION_MS,
} from "@/services/fleet-lifecycle";
import {
  prepareFleetSourceControl,
  requireFleetSourceWork,
  findFleetControlReceipt,
  closeFleetAutomaticForSourceStop,
  readFleetSourceAutomaticStatus,
} from "@/services/fleet-automatic";
import {
  commitSessionCadence,
  isRetryableRelayError,
  RelayRefusal,
} from "@/services/fleet-relay";
import { enqueueSync } from "@/services/outbox";

export type SourceCommand = SourceStart | SourceStop;
export const SourceCommandSchema = z.union([SourceStartSchema, SourceStopSchema]);
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
type Source = typeof fleetSourceIntent.$inferSelect;
type Prepared = Awaited<ReturnType<typeof prepareFleetSourceControl>>;
/** Per-account caps include every device: cycling device IDs cannot evade storage
 * limits. Retained fences count, while identical retries need no new capacity. */
export const MAX_LIVE_FLEET_SOURCES = 16;
export const MAX_RETAINED_FLEET_INTENTS = 256;
export const MAX_SOURCE_CONTROL_CHARACTERS = 256;
export function sourceView(source: Source): SourceView {
  const reason =
    source.terminalReason ??
    (source.latestOutcome === "verified" ? null : source.latestOutcome);
  return {
    source_id: source.id,
    generation: source.generation,
    character_id: source.bossCharacterId,
    state: source.state,
    reason:
      reason === null
        ? null
        : REASONS.includes(reason as (typeof REASONS)[number])
          ? (reason as (typeof REASONS)[number])
          : "ended",
    pending_expires_at:
      source.state !== "ended" && source.activatedAt === null
        ? source.intentExpiresAt.toISOString()
        : null,
    automatic:
      source.automaticConsentGeneration === null
        ? null
        : { consent_generation: source.automaticConsentGeneration },
  };
}
type SourceReply<T> =
  | (Extract<FleetReply<T>, { ok: true }> & { json: string })
  | Extract<FleetReply<T>, { ok: false }>;
async function reply<T>(
  work: () => Promise<{ value: T; json: string }>,
): Promise<SourceReply<T>> {
  try {
    return { ok: true, ...(await work()) };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (err instanceof FleetLifecycleRetry || isRetryableRelayError(err))
      return { ok: false, code: "service_unavailable" };
    throw err;
  }
}
function dateAfter(date: Date, ms: number) {
  const value = checkedDateAdd(date.toISOString(), ms);
  if (!value) throw new RelayRefusal("service_unavailable");
  return new Date(value);
}
function fresh(command: SourceCommand, now: Date) {
  const age = now.getTime() - Date.parse(command.intent_created_at);
  if (age < 0 || age >= AUTOMATIC_INTENT_TTL_MS) throw new RelayRefusal("invalid_intent");
}
async function capacity(tx: DbTx, accountId: string, live: boolean) {
  const retained = await tx
    .select({ id: fleetSourceIntent.id })
    .from(fleetSourceIntent)
    .where(
      and(
        eq(fleetSourceIntent.accountId, accountId),
        live ? ne(fleetSourceIntent.state, "ended") : undefined,
      ),
    )
    .limit(live ? MAX_LIVE_FLEET_SOURCES : MAX_RETAINED_FLEET_INTENTS);
  if (retained.length >= (live ? MAX_LIVE_FLEET_SOURCES : MAX_RETAINED_FLEET_INTENTS))
    throw new RelayRefusal("rate_limited");
}
async function start(
  tx: DbTx,
  p: Prepared,
  command: SourceStart,
  old?: Source,
): Promise<SourceStartResult> {
  fresh(command, p.now);
  requireFleetSourceWork(p);
  if (old && old.accountId !== p.accountId) throw new RelayRefusal("forbidden");
  const boss = p.identities.find((c) => c.id === command.character_id);
  if (
    !boss ||
    boss.accountId !== p.accountId ||
    boss.fleetLinkEpoch.toLowerCase() !== command.character_link_epoch.toLowerCase()
  )
    throw new RelayRefusal("forbidden");
  if (!hasUsableFleetRead(boss)) throw new RelayRefusal("fleet_read_required");
  const created = new Date(command.intent_created_at);
  if (old) {
    if (
      old.automaticConsentAccountId !== null ||
      old.state === "ended" ||
      old.bossCharacterId !== boss.id ||
      old.bossOwnerHash !== boss.ownerHash ||
      old.bossLinkEpoch !== boss.fleetLinkEpoch ||
      old.intentCreatedAt.getTime() !== created.getTime()
    )
      throw new RelayRefusal("conflict");
    return { protocol: 2, source: sourceView(old) };
  }
  await capacity(tx, p.accountId, false);
  await capacity(tx, p.accountId, true);
  const expires = dateAfter(created, FLEET_SOURCE_INTENT_TTL_MS);
  const [source] = await tx
    .insert(fleetSourceIntent)
    .values({
      id: command.source_id.toLowerCase(),
      accountId: p.accountId,
      deviceId: p.deviceId,
      bossCharacterId: boss.id,
      bossOwnerHash: boss.ownerHash,
      bossLinkEpoch: boss.fleetLinkEpoch,
      generation: 1,
      state: "pending",
      intentCreatedAt: created,
      intentExpiresAt: expires,
      nextFetchAt: p.now,
      retainUntil: dateAfter(expires, FLEET_SOURCE_TOMBSTONE_RETENTION_MS),
    })
    .returning();
  await logAudit(tx, {
    actor: p.accountId,
    action: "fleet_source.started",
    target: source.id,
    details: { deviceId: p.deviceId, reason: "requested" },
  });
  await enqueueSync(tx, {
    kind: "fleet-source",
    sourceId: source.id,
    generation: source.generation,
  });
  return { protocol: 2, source: sourceView(source) };
}
async function stop(
  tx: DbTx,
  p: Prepared,
  command: SourceStop,
  old?: Source,
): Promise<SourceStopResult> {
  const retained = await findFleetControlReceipt(
    tx,
    p.accountId,
    command.request_id,
    p.now,
  );
  if (retained) {
    if (retained.kind !== "source_stop") throw new RelayRefusal("request_id_conflict");
    const value: SourceStopResult = {
      protocol: 2,
      request_id: command.request_id,
      result: "replayed",
      receipt: retained,
      source: retained.source,
      automatic_effect: retained.automatic_effect,
      status: await readFleetSourceAutomaticStatus(tx, p),
    };
    // The production contextual validator compares every normalized field,
    // including case-insensitive ExistingUuid identities, before stale CAS/age.
    if (!parseSourceStopResult(value, command).success)
      throw new RelayRefusal("request_id_conflict");
    return value;
  }
  fresh(command, p.now);
  if (old && old.accountId !== p.accountId) throw new RelayRefusal("forbidden");
  if (
    old
      ? old.generation !== command.expected_generation ||
        old.automaticConsentGeneration !==
          (command.expected_automatic?.consent_generation ?? null)
      : command.expected_generation !== 0 || command.expected_automatic !== null
  )
    throw new RelayRefusal("conflict");
  // Close CURRENT generation before an ended-source early return. A natural end
  // is not explicit opt-out and cannot consume this source's reserved receipt.
  let source = old;
  if (!source) {
    await capacity(tx, p.accountId, false);
    const expires = dateAfter(p.now, FLEET_SOURCE_INTENT_TTL_MS);
    [source] = await tx
      .insert(fleetSourceIntent)
      .values({
        id: command.source_id.toLowerCase(),
        accountId: p.accountId,
        deviceId: p.deviceId,
        generation: 1,
        state: "ended",
        intentCreatedAt: p.now,
        intentExpiresAt: expires,
        endedAt: p.now,
        terminalReason: "stopped",
        retainUntil: dateAfter(expires, FLEET_SOURCE_TOMBSTONE_RETENTION_MS),
      })
      .returning();
  }
  // Check the new receipt's terminal horizon before lifecycle withdrawal adds
  // the same retention interval. A correlated no-op allocates no new horizon.
  if (!source.explicitlyStopped) dateAfter(p.now, AUTOMATIC_RECEIPT_TTL_MS);
  const automatic = await closeFleetAutomaticForSourceStop(tx, p, source);
  if (source.explicitlyStopped) {
    if (source.state !== "ended" || automatic.effect === "disabled_current")
      throw new RelayRefusal("service_unavailable");
    return {
      protocol: 2,
      request_id: command.request_id,
      result: "already_stopped",
      receipt: null,
      source: sourceView(source),
      automatic_effect: automatic.effect,
      status: await readFleetSourceAutomaticStatus(tx, p),
    };
  }
  if (source.state !== "ended" && automatic.effect !== "disabled_current") {
    await invalidateFleetSources(
      tx,
      {
        ...p.locked,
        sources: p.locked.sources.filter((s) => s.id === source.id),
        selectors: { sourceIds: [source.id] },
      },
      "stopped",
      p.accountId,
      p.now,
    );
  }
  const [ended] = await tx
    .select()
    .from(fleetSourceIntent)
    .where(eq(fleetSourceIntent.id, source.id));
  const receipt: SourceStopReceipt = {
    kind: "source_stop",
    command,
    accepted_at: p.now.toISOString(),
    expires_at: dateAfter(p.now, AUTOMATIC_RECEIPT_TTL_MS).toISOString(),
    source: sourceView(ended),
    automatic_effect: old ? automatic.effect : "unknown_cancelled",
    consent: automatic.consent,
  };
  if (!serializeFleetV2Json(receipt, SourceStopReceiptSchema, 2048).ok)
    throw new RelayRefusal("service_unavailable");
  await tx
    .update(fleetSourceIntent)
    .set({
      stopReceipt: receipt,
      explicitlyStopped: true,
      retainUntil: new Date(
        Math.max(
          ended.retainUntil.getTime(),
          dateAfter(ended.intentExpiresAt, FLEET_SOURCE_TOMBSTONE_RETENTION_MS).getTime(),
          dateAfter(ended.endedAt!, FLEET_SOURCE_TOMBSTONE_RETENTION_MS).getTime(),
          Date.parse(receipt.expires_at),
        ),
      ),
    })
    .where(eq(fleetSourceIntent.id, ended.id));
  await logAudit(tx, {
    actor: p.accountId,
    action: "fleet_source.stopped",
    target: ended.id,
    details: { deviceId: p.deviceId, effect: receipt.automatic_effect },
  });
  return {
    protocol: 2,
    request_id: command.request_id,
    result: "applied",
    receipt,
    source: receipt.source,
    automatic_effect: receipt.automatic_effect,
    status: await readFleetSourceAutomaticStatus(tx, p),
  };
}
export async function controlFleetSource(
  db: Db,
  call: SignedFleetCall & { command: SourceCommand },
): Promise<SourceReply<SourceStartResult | SourceStopResult>> {
  const parsed = safeParseFleetV2Dto(SourceCommandSchema, call.command);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 2048)
    return { ok: false, code: "bad_request" };
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const command = parsed.data;
      const p = await prepareFleetSourceControl(tx, call, command);
      const [old] = await tx
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.id, command.source_id));
      const value =
        command.operation === "start"
          ? await start(tx, p, command, old)
          : await stop(tx, p, command, old);
      const validated =
        command.operation === "start"
          ? parseSourceStartResult(value, command)
          : parseSourceStopResult(value, command);
      if (!validated.success) throw new RelayRefusal("service_unavailable");
      const serialized = serializeFleetV2Json(
        value,
        z.union([SourceStartResultSchema, SourceStopResultSchema]),
        FLEET_V2_BYTE_LIMITS.sourcesPut.successBytes,
      );
      if (!serialized.ok) throw new RelayRefusal("service_unavailable");
      await commitSessionCadence(tx, p.session.id, {
        revision: call.revision,
        now: p.now,
        cadence: "read",
      });
      return { value, json: serialized.json };
    }),
  );
}
export async function readFleetSourceState(
  db: Db,
  call: SignedFleetCall,
): Promise<SourceReply<SourcesGet>> {
  return reply(() =>
    fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareFleetSourceControl(tx, call);
      requireFleetSourceWork(p);
      const sources = await tx
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.accountId, p.accountId))
        .orderBy(fleetSourceIntent.id)
        .limit(MAX_RETAINED_FLEET_INTENTS + 1);
      const characters = await tx
        .select()
        .from(character)
        .where(eq(character.accountId, p.accountId))
        .orderBy(character.id)
        .limit(MAX_SOURCE_CONTROL_CHARACTERS + 1);
      const value: SourcesGet = {
        protocol: 2,
        sources: sources.map(sourceView),
        characters: characters.map((ch) => ({
          character_id: ch.id,
          character_name: ch.name,
          character_link_epoch: ch.fleetLinkEpoch,
          has_fleet_read: ch.scopes.includes(FLEET_READ_SCOPE),
          token_usable:
            !!ch.refreshTokenEnc &&
            ch.tokenStatus !== "invalid" &&
            ch.tokenStatus !== "missing",
        })),
      };
      const serialized = serializeFleetV2Json(
        value,
        SourcesGetSchema,
        FLEET_V2_BYTE_LIMITS.sourcesGet.successBytes,
      );
      if (!serialized.ok) throw new RelayRefusal("service_unavailable");
      await commitSessionCadence(tx, p.session.id, {
        revision: call.revision,
        now: p.now,
        cadence: "read",
      });
      return { value, json: serialized.json };
    }),
  );
}
