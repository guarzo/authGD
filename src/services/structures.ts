import { desc, eq } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import {
  account,
  character,
  structure,
  structureEvent,
  structureHolder,
  structureReadState,
  type StructureReadStatus,
} from "@/db/schema";
import { logAudit } from "@/services/audit";
import { NOTIFICATIONS_SCOPE, STRUCTURES_SCOPE } from "@/lib/esi/client";

/**
 * The holder table is a singleton enforced by `CHECK (id = 1)`. One constant so
 * every read and write spells the key the same way; a literal `1` scattered
 * across call sites is how a second row eventually appears.
 */
export const STRUCTURE_HOLDER_ROW_ID = 1;

export type StructureHolder = {
  characterId: number;
  corporationId: number;
  designatedAt: Date;
  designatedBy: string;
  seededAt: Date | null;
};

export async function getStructureHolder(dbx: Dbx): Promise<StructureHolder | null> {
  const [row] = await dbx
    .select({
      characterId: structureHolder.characterId,
      corporationId: structureHolder.corporationId,
      designatedAt: structureHolder.designatedAt,
      designatedBy: structureHolder.designatedBy,
      seededAt: structureHolder.seededAt,
    })
    .from(structureHolder)
    .where(eq(structureHolder.id, STRUCTURE_HOLDER_ROW_ID));
  return row ?? null;
}

/**
 * Points the monitor at a character and PINS the corporation, in one
 * transaction so the audit row, the designation and the retired alerts cannot
 * disagree.
 *
 * Three things happen together and must not be separable:
 *   1. the designation is written, with `seededAt` reset to null so the new
 *      holder re-seeds rather than replaying a 90-day backlog;
 *   2. the retirement sweep runs ONLY when the corporation actually changes.
 *      Replacing the holder WITHIN the same corp leaves every `pending` row
 *      alone — those alerts are still for the corp being watched and are
 *      still deliverable, so retiring them would silently drop a live attack.
 *      Replacing it with a holder in a DIFFERENT corp retires every `pending`
 *      row to `abandoned`, unfiltered by corporation — those alerts are no
 *      longer valid for anyone, and narrowing the WHERE to the old corp would
 *      leave a third corp's stale `pending` rows sitting live, ready to fire
 *      the moment that corp is re-designated;
 *   3. the audit row records how many were retired, which is the only number
 *      that says whether a holder swap swallowed a live attack.
 */
export async function designateStructureHolder(
  db: Db,
  characterId: number,
  corporationId: number,
  actor: string,
): Promise<{ abandonedAlerts: number }> {
  return db.transaction(async (tx) => {
    const previous = await getStructureHolder(tx);
    const designatedAt = new Date();
    await tx
      .insert(structureHolder)
      .values({
        id: STRUCTURE_HOLDER_ROW_ID,
        characterId,
        corporationId,
        designatedAt,
        designatedBy: actor,
        seededAt: null,
      })
      .onConflictDoUpdate({
        target: structureHolder.id,
        set: {
          characterId,
          corporationId,
          designatedAt,
          designatedBy: actor,
          seededAt: null,
        },
      });

    const retired =
      previous && previous.corporationId !== corporationId
        ? await tx
            .update(structureEvent)
            .set({ alertStatus: "abandoned" })
            .where(eq(structureEvent.alertStatus, "pending"))
            .returning({ id: structureEvent.notificationId })
        : [];

    await logAudit(tx, {
      actor,
      action: previous ? "structure.holder_replaced" : "structure.holder_designated",
      target: String(characterId),
      details: previous
        ? {
            previousCharacterId: previous.characterId,
            characterId,
            corporationId,
            abandonedAlerts: retired.length,
          }
        : { characterId, corporationId },
    });
    return { abandonedAlerts: retired.length };
  });
}

/**
 * Whether `characterId` is STILL the designated holder, read inside the
 * caller's transaction. A job that read the holder minutes ago must not write
 * another character's data under this designation; every write CASes on this.
 */
export async function stillStructureHolder(
  tx: Dbx,
  characterId: number,
): Promise<boolean> {
  const holder = await getStructureHolder(tx);
  return holder?.characterId === characterId;
}

/** Stamps the first completed poll, which is what switches seeding off. */
export async function markSeeded(dbx: Dbx, at: Date): Promise<void> {
  await dbx
    .update(structureHolder)
    .set({ seededAt: at })
    .where(eq(structureHolder.id, STRUCTURE_HOLDER_ROW_ID));
}

/**
 * Records one read attempt. `observedAt` advances ONLY on success, so the page
 * can say how stale a roster is without either lying about freshness or
 * discarding the failure that made it stale.
 */
export async function recordReadState(
  dbx: Dbx,
  input: {
    kind: "roster" | "events";
    corporationId: number;
    status: StructureReadStatus;
    detail?: string | null;
    observed: boolean;
    at: Date;
  },
): Promise<void> {
  const set: Record<string, unknown> = {
    lastAttemptAt: input.at,
    readStatus: input.status,
    detail: input.detail ?? null,
  };
  if (input.observed) set.observedAt = input.at;
  await dbx
    .insert(structureReadState)
    .values({
      kind: input.kind,
      corporationId: input.corporationId,
      observedAt: input.observed ? input.at : null,
      lastAttemptAt: input.at,
      readStatus: input.status,
      detail: input.detail ?? null,
    })
    .onConflictDoUpdate({
      target: [structureReadState.kind, structureReadState.corporationId],
      set,
    });
}

export type ReadStateRow = {
  observedAt: Date | null;
  lastAttemptAt: Date;
  readStatus: StructureReadStatus;
  detail: string | null;
};

export async function getReadStates(
  dbx: Dbx,
  corporationId: number,
): Promise<Record<string, ReadStateRow>> {
  const rows = await dbx
    .select()
    .from(structureReadState)
    .where(eq(structureReadState.corporationId, corporationId));
  const out: Record<string, ReadStateRow> = {};
  for (const r of rows) {
    out[r.kind] = {
      observedAt: r.observedAt,
      lastAttemptAt: r.lastAttemptAt,
      readStatus: r.readStatus,
      detail: r.detail,
    };
  }
  return out;
}

export type RosterRow = {
  structureId: number;
  name: string | null;
  typeName: string | null;
  systemId: number;
  state: string;
  stateTimerEnd: Date | null;
  fuelExpires: Date | null;
  observedAt: Date;
  missingSince: Date | null;
};

export async function getRoster(dbx: Dbx, corporationId: number): Promise<RosterRow[]> {
  return dbx
    .select({
      structureId: structure.structureId,
      name: structure.name,
      typeName: structure.typeName,
      systemId: structure.systemId,
      state: structure.state,
      stateTimerEnd: structure.stateTimerEnd,
      fuelExpires: structure.fuelExpires,
      observedAt: structure.observedAt,
      missingSince: structure.missingSince,
    })
    .from(structure)
    .where(eq(structure.corporationId, corporationId));
}

export type EventRow = {
  notificationId: number;
  type: string;
  sentAt: Date;
  structureId: number | null;
  details: Record<string, string | number | null> | null;
};

export async function getRecentEvents(
  dbx: Dbx,
  corporationId: number,
  limit: number,
): Promise<EventRow[]> {
  return dbx
    .select({
      notificationId: structureEvent.notificationId,
      type: structureEvent.type,
      sentAt: structureEvent.sentAt,
      structureId: structureEvent.structureId,
      details: structureEvent.details,
    })
    .from(structureEvent)
    .where(eq(structureEvent.corporationId, corporationId))
    .orderBy(desc(structureEvent.sentAt))
    .limit(limit);
}

/**
 * The character's CURRENT corporation, read fresh from Postgres. The
 * designate action must not trust a corp id sent in from the client — a
 * hidden form field is attacker-controlled, so the corp that gets pinned has
 * to come from a server-side read of what the database actually says.
 */
export async function getCharacterCorporationId(
  dbx: Dbx,
  characterId: number,
): Promise<number | null> {
  const [row] = await dbx
    .select({ corporationId: character.corporationId })
    .from(character)
    .where(eq(character.id, characterId));
  return row?.corporationId ?? null;
}

/**
 * The first admin-owned character whose PERSISTED `scopes` carry both
 * structure scopes. Reads `character.scopes`, never `cfg.eveSso.scopes`:
 * config says what we ask for, the column says what was granted.
 *
 * Deterministic by character id, not insertion order, so a re-run of the
 * page picks the same candidate rather than one that happens to sort
 * differently row to row.
 */
export async function findGrantableCharacter(
  dbx: Dbx,
): Promise<{ characterId: number; name: string; corporationId: number | null } | null> {
  const rows = await dbx
    .select({
      characterId: character.id,
      name: character.name,
      corporationId: character.corporationId,
      scopes: character.scopes,
    })
    .from(character)
    .innerJoin(account, eq(account.id, character.accountId))
    .where(eq(account.isAdmin, true))
    .orderBy(character.id);
  const found = rows.find(
    (r) => r.scopes.includes(STRUCTURES_SCOPE) && r.scopes.includes(NOTIFICATIONS_SCOPE),
  );
  return found
    ? {
        characterId: found.characterId,
        name: found.name,
        corporationId: found.corporationId,
      }
    : null;
}

export type HolderView = {
  characterId: number;
  name: string;
  scopes: string[];
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  /** The corp PINNED at designation. */
  corporationId: number;
  /** What character.corporationId says right now — null when never resolved. */
  currentCorporationId: number | null;
};

/**
 * Joins the designated holder to its character row for the four fields the
 * page needs beyond the raw designation: name, granted scopes, token health,
 * and where that character sits right now (which can drift from the corp
 * pinned at designation — that drift is exactly what the page warns about).
 */
export async function toHolderView(
  dbx: Dbx,
  holder: StructureHolder,
): Promise<HolderView> {
  const [row] = await dbx
    .select({
      name: character.name,
      scopes: character.scopes,
      tokenStatus: character.tokenStatus,
      currentCorporationId: character.corporationId,
    })
    .from(character)
    .where(eq(character.id, holder.characterId));
  if (!row) {
    throw new Error(`structure holder character ${holder.characterId} not found`);
  }
  return {
    characterId: holder.characterId,
    name: row.name,
    scopes: row.scopes,
    tokenStatus: row.tokenStatus,
    corporationId: holder.corporationId,
    currentCorporationId: row.currentCorporationId,
  };
}
