import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, character, fleetEligibility } from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";

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
 * Reads the materialized `fleet_eligibility` cache — never a live ESI call
 * (Global Constraint: relay routes only ever read this cache). Returns
 * `null` for anything short of definite, current evidence: below Member
 * tier; no unexpired row; a linked character whose CURRENT `scopes` have
 * since lost `FLEET_READ_SCOPE`; or a row whose own `rosterCharacterIds`
 * does not include its own `characterId` (materialization that failed to
 * record itself correctly) — every one of those fails exactly the same way,
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
      scopes: character.scopes,
    })
    .from(fleetEligibility)
    .innerJoin(character, eq(character.id, fleetEligibility.characterId))
    .where(
      and(eq(fleetEligibility.accountId, accountId), gt(fleetEligibility.expiresAt, now)),
    );

  const rosterByFleet = new Map<number, Set<number>>();
  let earliestExpiry: Date | null = null;

  for (const row of rows) {
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
