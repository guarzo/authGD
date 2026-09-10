import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import type { FleetCode, FleetReply, SignedFleetCall } from "@/core/fleet-sharing";
import {
  fleetLifecycleTransaction,
  FleetLifecycleRetry,
} from "@/services/fleet-lifecycle";
import {
  commitSessionCadence,
  isRetryableRelayError,
  RelayRefusal,
} from "@/services/fleet-relay";
import {
  prepareSharedAdmission,
  currentSourceEvidence,
  type SharedAdmission,
} from "@/services/fleet-shared-admission";
import { account, character, fleetEligibility } from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";

export type EligibleCharacter = {
  characterId: number;
  sourceId: string;
  sourceGeneration: number;
  authorityGeneration: number;
  expiresAt: Date;
};
export type EligibilityView = {
  participationGeneration: number;
  state: "ready" | "participation_off" | "not_verified";
  characters: EligibleCharacter[];
};
export type SharedCharacterEligibility = EligibleCharacter & {
  fleetId: number;
  linkEpoch: string;
};

/** Ownership/epoch and exactly ONE current fleet. An ambiguity is withheld, not
 * resolved by sorting fleet IDs. Independent unambiguous characters survive. */
export function sharedCharacterEligibility(
  p: SharedAdmission,
): Map<number, SharedCharacterEligibility> {
  const matches = new Map<number, Map<number, SharedCharacterEligibility>>();
  for (const e of p.evidence) {
    const ch = p.identities.find((row) => row.id === e.characterId);
    if (!ch || ch.fleetLinkEpoch !== e.linkEpoch || !currentSourceEvidence(p, e))
      continue;
    const fleets = matches.get(ch.id) ?? new Map<number, SharedCharacterEligibility>();
    fleets.set(e.fleetId, {
      characterId: ch.id,
      fleetId: e.fleetId,
      linkEpoch: ch.fleetLinkEpoch,
      sourceId: e.sourceId!,
      sourceGeneration: e.sourceGeneration!,
      authorityGeneration: e.authorityGeneration,
      expiresAt: e.expiresAt!,
    });
    matches.set(ch.id, fleets);
  }
  return new Map(
    [...matches].flatMap(([id, fleets]) =>
      fleets.size === 1 ? [[id, [...fleets.values()][0]] as const] : [],
    ),
  );
}

export async function readDeviceEligibility(
  db: Db,
  call: SignedFleetCall,
): Promise<FleetReply<EligibilityView>> {
  try {
    const value = await fleetLifecycleTransaction(db, async (tx) => {
      const p = await prepareSharedAdmission(tx, call, "eligibility");
      const d = p.actor.device;
      const eligible = sharedCharacterEligibility(p);
      const characters = d.participationEnabled
        ? p.owned
            .flatMap((ch) => {
              const e = eligible.get(ch.id);
              return e
                ? [
                    {
                      characterId: e.characterId,
                      sourceId: e.sourceId,
                      sourceGeneration: e.sourceGeneration,
                      authorityGeneration: e.authorityGeneration,
                      expiresAt: e.expiresAt,
                    },
                  ]
                : [];
            })
            .sort((a, b) => a.characterId - b.characterId)
        : [];
      await commitSessionCadence(tx, p.actor.session.id, {
        revision: call.revision,
        now: p.now,
        cadence: "read",
      });
      return {
        participationGeneration: d.participationGeneration,
        state: !d.participationEnabled
          ? ("participation_off" as const)
          : characters.length
            ? ("ready" as const)
            : ("not_verified" as const),
        characters,
      };
    });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (err instanceof FleetLifecycleRetry || isRetryableRelayError(err))
      return { ok: false, code: "service_unavailable" };
    throw err;
  }
}

export type DeviceCatalogue = {
  revision: number;
  characters: readonly { characterId: number; characterName: string }[];
};

export type Eligibility = {
  accountId: string;
  fleetIds: readonly number[];
  rosterByFleet: ReadonlyMap<number, ReadonlySet<number>>;
  expiresAt: Date;
};

/**
 * A paired device's whole view of an account: every character linked to it,
 * built ONLY from `character.accountId` — never from a fleet roster or ESI —
 * so a device can never learn about a character it has no link to.
 *
 * `revision` is a deterministic, stable hash of the exact (id, name) pairs
 * currently on the account, in ascending-id order: it changes only when the
 * linked-character set or one of its names changes, and is otherwise
 * identical across repeated calls, so a device can tell "nothing changed"
 * from "re-fetch me" without the server keeping any extra revision state of
 * its own.
 */
export async function buildDeviceCatalogue(
  dbx: Dbx,
  accountId: string,
): Promise<DeviceCatalogue> {
  const rows = await dbx
    .select({ characterId: character.id, characterName: character.name })
    .from(character)
    .where(eq(character.accountId, accountId))
    .orderBy(character.id);

  const digestInput = rows.map((r) => `${r.characterId}:${r.characterName}`).join("\n");
  const revision = createHash("sha256").update(digestInput).digest().readUInt32BE(0);

  return {
    revision,
    characters: rows.map((r) => ({
      characterId: r.characterId,
      characterName: r.characterName,
    })),
  };
}

/**
 * Reads the materialized `fleet_eligibility` cache for legacy-mode snapshots.
 * Relay routes never call live ESI: shared snapshot and eligibility authorization
 * preparation uses `prepareSharedAdmission` and current worker source evidence
 * instead of this cache. This legacy reader returns `null` for anything short of
 * definite, current evidence: below Member
 * tier; no unexpired row; an `outcomeCode` other than `"ok"` (any other
 * recorded outcome — forbidden, not-in-fleet, an error — is not fleet-read
 * evidence, whatever else the row happens to hold); a linked character
 * whose CURRENT `scopes` have since lost `FLEET_READ_SCOPE`; a character
 * whose CURRENT `accountId` no longer matches the account being read (the
 * row's own denormalized `fleetEligibility.accountId` can go stale if the
 * character is later reclaimed onto a different account, and this is the
 * check that catches that); or a row whose own `rosterCharacterIds` does
 * not include its own `characterId` (materialization that failed to record
 * itself correctly) — every one of those fails exactly the same way,
 * closed, never a "last known good" fallback.
 *
 * Cryo is deliberately NOT checked, unlike `requirePayoutOperator`
 * (src/services/payouts.ts), which requires an ACTIVE Member for a mutation.
 * This is a read path, and a cryo Member (someone who has stepped away, but
 * whose fleet-read evidence is still fresh) stays eligible.
 *
 * A multi-character/multi-fleet account can contribute several valid rows:
 * each names its own fleet's roster, unioned across rows that happen to
 * name the same fleet twice. Every fleet id in the result came from a
 * materialized row — nothing here is caller-selectable. The returned
 * `expiresAt` is the EARLIEST expiry among the rows actually used, so the
 * whole `Eligibility` is only as fresh as its most stale contributing row.
 */
export async function readEligibleAccount(
  dbx: Dbx,
  accountId: string,
  now: Date,
): Promise<Eligibility | null> {
  const [acc] = await dbx
    .select({ tier: account.tier })
    .from(account)
    .where(eq(account.id, accountId));
  if (!acc || acc.tier !== "member") return null;

  const rows = await dbx
    .select({
      fleetId: fleetEligibility.fleetId,
      characterId: fleetEligibility.characterId,
      rosterCharacterIds: fleetEligibility.rosterCharacterIds,
      expiresAt: fleetEligibility.expiresAt,
      outcomeCode: fleetEligibility.outcomeCode,
      scopes: character.scopes,
      characterAccountId: character.accountId,
    })
    .from(fleetEligibility)
    .innerJoin(character, eq(character.id, fleetEligibility.characterId))
    .where(
      and(eq(fleetEligibility.accountId, accountId), gt(fleetEligibility.expiresAt, now)),
    );

  const rosterByFleet = new Map<number, Set<number>>();
  let earliestExpiry: Date | null = null;

  for (const row of rows) {
    // Only a recorded "ok" outcome is fleet-read evidence at all — any other
    // outcome (forbidden, not-in-fleet, an ESI error) must not count, no
    // matter what its roster/scope/expiry happen to look like.
    if (row.outcomeCode !== "ok") continue;
    // The character may have been reclaimed onto a different account since
    // this row was written; the row's own `accountId` column would not
    // reflect that. The CURRENT link is the only one that counts.
    if (row.characterAccountId !== accountId) continue;
    // No scope: the character's evidence is stale even though the cache row
    // itself has not expired yet (a scope can be revoked mid-flight).
    if (!row.scopes.includes(FLEET_READ_SCOPE)) continue;
    // A roster that does not name its own character is broken evidence —
    // fails closed rather than being trusted as-is.
    if (!row.rosterCharacterIds.includes(row.characterId)) continue;

    const roster = rosterByFleet.get(row.fleetId) ?? new Set<number>();
    for (const id of row.rosterCharacterIds) roster.add(id);
    rosterByFleet.set(row.fleetId, roster);

    if (earliestExpiry === null || row.expiresAt.getTime() < earliestExpiry.getTime()) {
      earliestExpiry = row.expiresAt;
    }
  }

  if (rosterByFleet.size === 0 || earliestExpiry === null) return null;

  return {
    accountId,
    fleetIds: [...rosterByFleet.keys()].sort((a, b) => a - b),
    rosterByFleet,
    expiresAt: earliestExpiry,
  };
}
