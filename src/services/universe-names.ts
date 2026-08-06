import { eq, inArray } from "drizzle-orm";
import type { Dbx } from "@/db";
import { universeName } from "@/db/schema";
import type { EsiClient } from "@/lib/esi/client";

/** Structures can be renamed or unanchored, so their cached names expire. */
export const STRUCTURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type UniverseNameKind = "system" | "station" | "structure";

export type NameResolver = Pick<
  EsiClient,
  "getSystemName" | "getStationName" | "getStructureName"
>;

/** True when a cached row may still be used without re-fetching. */
export function isCacheFresh(
  kind: UniverseNameKind,
  fetchedAt: Date,
  now: Date = new Date(),
): boolean {
  // Systems and stations are static universe data; only structures change.
  if (kind !== "structure") return true;
  return now.getTime() - fetchedAt.getTime() < STRUCTURE_TTL_MS;
}

async function fetchName(
  esi: NameResolver,
  input: { id: number; kind: UniverseNameKind; accessToken: string },
): Promise<string> {
  if (input.kind === "system") return esi.getSystemName(input.id);
  if (input.kind === "station") return esi.getStationName(input.id);
  return esi.getStructureName(input.id, input.accessToken);
}

/**
 * Cache-first name lookup. NEVER throws: an ESI failure of any kind returns
 * null, which the caller counts as `namesUnresolved` and renders as "Docked".
 * Callers are inside a per-character loop that must not abort on a name.
 */
export async function resolveUniverseName(
  dbx: Dbx,
  esi: NameResolver,
  input: { id: number; kind: UniverseNameKind; accessToken: string },
): Promise<string | null> {
  const [cached] = await dbx
    .select()
    .from(universeName)
    .where(eq(universeName.id, input.id));
  if (cached && isCacheFresh(input.kind, cached.fetchedAt)) return cached.name;
  try {
    const name = await fetchName(esi, input);
    const fetchedAt = new Date();
    await dbx
      .insert(universeName)
      .values({ id: input.id, kind: input.kind, name, fetchedAt })
      .onConflictDoUpdate({
        target: universeName.id,
        set: { kind: input.kind, name, fetchedAt },
      });
    return name;
  } catch {
    // A STALE name beats no name. The alternative is that a citadel renamed
    // once reads "Docked" forever, because the refetch that would fix it is
    // exactly the call that keeps failing (403 after an access change).
    return cached?.name ?? null;
  }
}

/** Names for a batch of ids, read from the cache only. No ESI, no writes. */
export async function lookupCachedNames(
  dbx: Dbx,
  ids: number[],
): Promise<Map<number, string>> {
  // An empty `inArray` is a predicate that can never match; skip the round trip.
  if (ids.length === 0) return new Map();
  const rows = await dbx
    .select({ id: universeName.id, name: universeName.name })
    .from(universeName)
    .where(inArray(universeName.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
