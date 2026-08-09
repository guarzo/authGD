import { asc, eq } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import {
  accessListCatalog,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
} from "@/db/schema";
import { logAudit } from "@/services/audit";

/**
 * The holder table is a singleton enforced by `CHECK (id = 1)`. The constant
 * exists so every read and write spells the key the same way; a literal `1`
 * scattered across call sites is how a second row eventually appears.
 */
const HOLDER_ROW_ID = 1;

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
 */
export async function addWatch(
  db: Db,
  accessListId: number,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(accessListWatch)
      .values({ accessListId, addedAt: new Date(), addedBy: actor })
      .onConflictDoNothing({ target: accessListWatch.accessListId })
      .returning({ accessListId: accessListWatch.accessListId });
    if (inserted.length === 0) return;
    await logAudit(tx, {
      actor,
      action: "access_list.watch_added",
      target: String(accessListId),
      details: { accessListId, name: await watchedListName(tx, accessListId) },
    });
  });
}

/** Removes a list from the watchlist. Audits only when a row actually went. */
export async function removeWatch(
  db: Db,
  accessListId: number,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Read the name BEFORE the delete: nothing here cascades to the snapshot,
    // but reading first keeps the audit row correct regardless of what a later
    // change makes the delete cascade to.
    const name = await watchedListName(tx, accessListId);
    const removed = await tx
      .delete(accessListWatch)
      .where(eq(accessListWatch.accessListId, accessListId))
      .returning({ accessListId: accessListWatch.accessListId });
    if (removed.length === 0) return;
    await logAudit(tx, {
      actor,
      action: "access_list.watch_removed",
      target: String(accessListId),
      details: { accessListId, name },
    });
  });
}
