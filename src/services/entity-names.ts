import { inArray, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import { esiEntityName } from "@/db/schema";
import type { EsiClient } from "@/lib/esi/client";

/**
 * Names for characters, corporations and alliances.
 *
 * Deliberately NOT `universeName`. That table's comment promises fork
 * operators that "no personal data lands here — systems, NPC stations and
 * player structures are places, not people" (src/db/schema.ts). Character
 * names are people, so they get their own table carrying its own honest
 * comment rather than quietly invalidating that one. The split is natural
 * anyway: this cache is batch-shaped around `POST /universe/names/` (1000 ids
 * per call) where `resolveUniverseName` is one id at a time.
 *
 * No TTL. These names change rarely, nothing acts on them — they are read out
 * to an admin who retypes them in-game — and a stale name beats a bare id.
 */
export type EsiEntityKind = "character" | "corporation" | "alliance";

/** The ESI categories this cache models; anything else is dropped on write. */
const CACHED_KINDS: ReadonlySet<string> = new Set([
  "character",
  "corporation",
  "alliance",
]);

/** Names for a batch of ids, read from the cache only. No ESI, no writes. */
export async function lookupEntityNames(
  dbx: Dbx,
  ids: number[],
): Promise<Map<number, string>> {
  // An empty `inArray` is a predicate that can never match; skip the round trip.
  if (ids.length === 0) return new Map();
  const rows = await dbx
    .select({ id: esiEntityName.id, name: esiEntityName.name })
    .from(esiEntityName)
    .where(inArray(esiEntityName.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Cache-first batched lookup. Reads the cache, asks ESI only for the misses,
 * upserts what comes back, and returns cached-plus-fresh.
 *
 * NEVER throws. Names are decoration on a monitoring page: an unresolved id
 * renders bare, which is strictly better than the whole page failing because
 * ESI was briefly unhappy. Both the cache read and the fetch degrade to
 * "return what we have".
 */
export async function resolveEntityNames(
  dbx: Dbx,
  esi: Pick<EsiClient, "getUniverseNames">,
  ids: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  let names: Map<number, string>;
  try {
    names = await lookupEntityNames(dbx, unique);
  } catch (err) {
    // A failed read degrades to "nothing cached" rather than rejecting. Log it:
    // silence here would make a broken cache table look like a cold one.
    console.error("entity-names: cache read failed", err);
    names = new Map();
  }
  const missing = unique.filter((id) => !names.has(id));
  if (missing.length === 0) return names;

  try {
    const fetched = await esi.getUniverseNames(missing);
    const fetchedAt = new Date();
    const rows = fetched
      // getUniverseNames also answers for systems, stations and inventory
      // types. `esi_entity_kind` has three values, so an unmodelled category
      // would fail the whole insert — drop it and let the id render bare.
      .filter((n) => CACHED_KINDS.has(n.category))
      .map((n) => ({
        id: n.id,
        kind: n.category as EsiEntityKind,
        name: n.name,
        fetchedAt,
      }));
    if (rows.length > 0) {
      await dbx
        .insert(esiEntityName)
        .values(rows)
        .onConflictDoUpdate({
          target: esiEntityName.id,
          set: {
            kind: sql`excluded.kind`,
            name: sql`excluded.name`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    for (const r of rows) names.set(r.id, r.name);
    return names;
  } catch (err) {
    // Whatever was cached. An id ESI would not or could not name simply has no
    // entry, and the caller renders the number.
    console.error("entity-names: resolve failed", err);
    return names;
  }
}
