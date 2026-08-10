import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
  character,
  type AccessListReadStatus,
} from "@/db/schema";
import { logAudit } from "@/services/audit";
import type { AccessEntry } from "@/core/access-list-compare";

/**
 * The holder table is a singleton enforced by `CHECK (id = 1)`. The constant
 * exists so every read and write spells the key the same way; a literal `1`
 * scattered across call sites is how a second row eventually appears.
 */
export const HOLDER_ROW_ID = 1;

export type Holder = {
  characterId: number;
  designatedAt: Date;
  designatedBy: string;
};

export async function getHolder(dbx: Dbx): Promise<Holder | null> {
  const [row] = await dbx
    .select({
      characterId: accessListHolder.characterId,
      designatedAt: accessListHolder.designatedAt,
      designatedBy: accessListHolder.designatedBy,
    })
    .from(accessListHolder)
    .where(eq(accessListHolder.id, HOLDER_ROW_ID));
  return row ?? null;
}

/**
 * Points the monitor at a character, in one transaction so the audit row and
 * the designation cannot disagree.
 *
 * A replacement is a real event with consequences — a different holder may see
 * a different set of lists, and watched rows can go "not visible to holder" —
 * so it audits under its own action carrying BOTH ids. `designatedBy` records
 * only the current state, so without this row a replacement leaves no trace of
 * what it displaced (CONTRIBUTING.md: every state change writes an audit row).
 *
 * Re-designating the character that is already the holder still rewrites
 * `designatedBy`/`designatedAt` and so still audits, as a replace.
 */
export async function designateHolder(
  db: Db,
  characterId: number,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const previous = await getHolder(tx);
    const designatedAt = new Date();
    await tx
      .insert(accessListHolder)
      .values({ id: HOLDER_ROW_ID, characterId, designatedAt, designatedBy: actor })
      .onConflictDoUpdate({
        target: accessListHolder.id,
        set: { characterId, designatedAt, designatedBy: actor },
      });
    await logAudit(tx, {
      actor,
      action: previous ? "access_list.holder_replaced" : "access_list.holder_designated",
      target: String(characterId),
      details: previous
        ? { previousCharacterId: previous.characterId, characterId }
        : { characterId },
    });
  });
}

export async function getWatchedListIds(dbx: Dbx): Promise<number[]> {
  const rows = await dbx
    .select({ accessListId: accessListWatch.accessListId })
    .from(accessListWatch)
    .orderBy(asc(accessListWatch.accessListId));
  return rows.map((r) => r.accessListId);
}

/**
 * The list's name for the audit row. The catalog is reconciled against what the
 * holder can currently see on every discovery, so a list that went invisible
 * has no catalog row — fall back to the last snapshot, then to null. An id with
 * no name anywhere still audits; a missing name must never cost the row.
 */
async function watchedListName(dbx: Dbx, accessListId: number): Promise<string | null> {
  const [cat] = await dbx
    .select({ name: accessListCatalog.name })
    .from(accessListCatalog)
    .where(eq(accessListCatalog.accessListId, accessListId));
  if (cat?.name) return cat.name;
  const [snap] = await dbx
    .select({ name: accessListSnapshot.name })
    .from(accessListSnapshot)
    .where(eq(accessListSnapshot.accessListId, accessListId));
  return snap?.name ?? null;
}

/**
 * Adds a list to the shared watchlist. Idempotent: watching an already-watched
 * list changes nothing and therefore audits nothing, so a double submit does
 * not manufacture history.
 *
 * Returns whether a row was actually inserted, which is the same fact the
 * audit branch turns on. The caller needs it because "idempotent" and
 * "confirmed as done" are different claims: the page filters already-watched
 * lists out of its `<select>`, so reaching this branch means the admin was
 * looking at a stale catalog, and telling them the list was added would
 * describe an act that did not happen.
 */
export async function addWatch(
  db: Db,
  accessListId: number,
  actor: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(accessListWatch)
      .values({ accessListId, addedAt: new Date(), addedBy: actor })
      .onConflictDoNothing({ target: accessListWatch.accessListId })
      .returning({ accessListId: accessListWatch.accessListId });
    if (inserted.length === 0) return false;
    await logAudit(tx, {
      actor,
      action: "access_list.watch_added",
      target: String(accessListId),
      details: { accessListId, name: await watchedListName(tx, accessListId) },
    });
    return true;
  });
}

/**
 * Removes a list from the watchlist. Audits only when a row actually went.
 *
 * Returns both halves the caller needs to write an honest confirmation: the
 * name it read (the same one that lands in the audit row, when one is written)
 * so the list can be named rather than numbered, and `removed` so a press that
 * deleted nothing is not confirmed as a removal. `name` is populated on both
 * branches — the catalog and snapshot rows outlive the watch row, so a list
 * that was already off the watchlist can still be named in the notice saying
 * so.
 */
export async function removeWatch(
  db: Db,
  accessListId: number,
  actor: string,
): Promise<{ removed: boolean; name: string | null }> {
  return db.transaction(async (tx) => {
    // Read the name BEFORE the delete: nothing here cascades to the snapshot,
    // but reading first keeps the audit row correct regardless of what a later
    // change makes the delete cascade to.
    const name = await watchedListName(tx, accessListId);
    const removed = await tx
      .delete(accessListWatch)
      .where(eq(accessListWatch.accessListId, accessListId))
      .returning({ accessListId: accessListWatch.accessListId });
    if (removed.length === 0) return { removed: false, name };
    await logAudit(tx, {
      actor,
      action: "access_list.watch_removed",
      target: String(accessListId),
      details: { accessListId, name },
    });
    return { removed: true, name };
  });
}

export type HolderView = {
  characterId: number;
  name: string;
  scopes: string[];
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  designatedAt: Date;
};

/** The holder joined to its character row — the four fields `monitorState`
 *  needs. Separate from `getHolder` (which the job uses and which must stay a
 *  single-table read for the stale-holder compare-and-swap). */
export async function getHolderView(dbx: Dbx): Promise<HolderView | null> {
  const [row] = await dbx
    .select({
      characterId: character.id,
      name: character.name,
      scopes: character.scopes,
      tokenStatus: character.tokenStatus,
      designatedAt: accessListHolder.designatedAt,
    })
    .from(accessListHolder)
    .innerJoin(character, eq(character.id, accessListHolder.characterId))
    .where(eq(accessListHolder.id, HOLDER_ROW_ID));
  return row ?? null;
}

export type CatalogEntry = { accessListId: number; name: string };

export async function getCatalog(dbx: Dbx): Promise<CatalogEntry[]> {
  return dbx
    .select({
      accessListId: accessListCatalog.accessListId,
      name: accessListCatalog.name,
    })
    .from(accessListCatalog)
    .orderBy(accessListCatalog.accessListId);
}

export type WatchedListView = {
  accessListId: number;
  name: string | null;
  readStatus: AccessListReadStatus | null;
  observedAt: Date | null;
  lastAttemptAt: Date | null;
  detail: string | null;
  allowEveryone: boolean | null;
  entries: AccessEntry[];
};

/**
 * Every watched list, LEFT-joined to its snapshot: a list added to the
 * watchlist a minute ago has no snapshot row at all, and that "never read"
 * state is one the page renders rather than a row it drops.
 *
 * Also LEFT-joined to the catalog, with the name sourced as
 * COALESCE(catalog, snapshot): a list can be watched before the worker ever
 * takes a snapshot of it, in which case only the catalog has a name at all.
 *
 * The two sources rarely disagree — a successful read writes `snapshot.name`
 * and `catalog.name` from the same ESI detail in one transaction
 * (`jobs/access-lists.ts`) — so the precedence only decides the edges, and
 * both edges want the catalog first: a watched-but-never-read list has only a
 * catalog row, and a list the holder can no longer see is pruned from the
 * catalog by discovery, leaving only the last snapshot. Keeping this in the
 * same order as `watchedListName()` above is load-bearing: the page and the
 * audit log must never disagree about what a list is called.
 */
export async function getWatchedListViews(dbx: Dbx): Promise<WatchedListView[]> {
  const rows = await dbx
    .select({
      accessListId: accessListWatch.accessListId,
      name: sql<
        string | null
      >`coalesce(${accessListCatalog.name}, ${accessListSnapshot.name})`,
      readStatus: accessListSnapshot.readStatus,
      observedAt: accessListSnapshot.observedAt,
      lastAttemptAt: accessListSnapshot.lastAttemptAt,
      detail: accessListSnapshot.detail,
      allowEveryone: accessListSnapshot.allowEveryone,
    })
    .from(accessListWatch)
    .leftJoin(
      accessListSnapshot,
      eq(accessListSnapshot.accessListId, accessListWatch.accessListId),
    )
    .leftJoin(
      accessListCatalog,
      eq(accessListCatalog.accessListId, accessListWatch.accessListId),
    )
    .orderBy(accessListWatch.accessListId);
  if (rows.length === 0) return [];
  const entries = await dbx
    .select({
      accessListId: accessListEntry.accessListId,
      kind: accessListEntry.kind,
      entityId: accessListEntry.entityId,
      access: accessListEntry.access,
    })
    .from(accessListEntry)
    .where(
      inArray(
        accessListEntry.accessListId,
        rows.map((r) => r.accessListId),
      ),
    );
  // Group once rather than re-scanning `entries` per row: watching a few dozen
  // lists with a few hundred entries each turns the naive filter into a
  // quadratic scan for no reason.
  const byList = new Map<number, Omit<(typeof entries)[number], "accessListId">[]>();
  for (const { accessListId, kind, entityId, access } of entries) {
    const bucket = byList.get(accessListId);
    if (bucket === undefined) byList.set(accessListId, [{ kind, entityId, access }]);
    else bucket.push({ kind, entityId, access });
  }
  return rows.map((r) => ({
    ...r,
    entries: byList.get(r.accessListId) ?? [],
  }));
}

export type OwnCharacter = {
  characterId: number;
  name: string;
  scopes: string[];
};

/**
 * The viewer's own linked characters, for the "Designate as holder" control.
 *
 * Tier-independent on purpose. `getMemberCharacters` (`services/desired.ts`)
 * inner-joins `account.tier = 'member'`, which is right for the desired set and
 * wrong here: `isAdmin` and `tier` are orthogonal, and an admin's default tier
 * is `alumni` (`_components/nav-items.ts`). Sourcing this from the member
 * roster would leave an alumni admin looking at a "Grant access" button that
 * never becomes "Designate as holder", with nothing on the page to explain it.
 *
 * `affiliationInvalid` characters are excluded — ESI rejects them, so one
 * could never actually hold the designation.
 */
export async function getOwnCharacters(
  dbx: Dbx,
  accountId: string,
): Promise<OwnCharacter[]> {
  return dbx
    .select({
      characterId: character.id,
      name: character.name,
      scopes: character.scopes,
    })
    .from(character)
    .where(
      and(eq(character.accountId, accountId), eq(character.affiliationInvalid, false)),
    )
    .orderBy(character.id);
}
