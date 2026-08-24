import { and, eq, inArray, isNull, not } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character, structure } from "@/db/schema";
import { EsiError } from "@/lib/esi/client";
import type { StructuresEsi } from "@/lib/esi/client";
import { STRUCTURES_SCOPE } from "@/lib/esi/client";
import {
  getStructureHolder,
  recordReadState,
  stillStructureHolder,
} from "@/services/structures";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

type Counts = {
  structures: number;
  missing: number;
  noHolder: number;
  scopeMissing: number;
  corpChanged: number;
  skipped: number;
  forbidden: number;
};

/**
 * Refreshes the roster of structures the pinned corporation owns.
 *
 * Staged exactly like the access-lists job: no holder is a normal `ok`, the
 * scope is checked against the PERSISTED grant before any network call, and
 * every write CASes on the holder still being the holder.
 */
export async function runStructuresJob(deps: {
  db: Db;
  cfg: Config;
  esi: StructuresEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "structures", async () => {
    const counts: Counts = {
      structures: 0,
      missing: 0,
      noHolder: 0,
      scopeMissing: 0,
      corpChanged: 0,
      skipped: 0,
      forbidden: 0,
    };

    // 1. No holder. An unconfigured optional feature must not paint
    //    /admin/sync red — the monitor page explains the missing designation.
    const holder = await getStructureHolder(db);
    if (!holder) {
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    const [row] = await db
      .select({
        id: character.id,
        corporationId: character.corporationId,
        refreshTokenEnc: character.refreshTokenEnc,
        tokenStatus: character.tokenStatus,
        scopes: character.scopes,
      })
      .from(character)
      .where(eq(character.id, holder.characterId));
    if (!row) {
      // The holder FK cascades, so a missing character row means the
      // designation was deleted concurrently. Same state as no holder.
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    // 2. Scope, from the PERSISTED grant and before any ESI call: calling
    //    anyway would spend a refresh-token rotation to earn a certain 403.
    if (!row.scopes.includes(STRUCTURES_SCOPE)) {
      counts.scopeMissing = 1;
      return { status: "ok", counts };
    }

    // 3. The corporation is PINNED. If the holder has moved, reading their new
    //    corp's structures under this designation would stamp missingSince on
    //    every structure of the old one — a fabricated mass-destruction event.
    //    Refuse, and let the page ask for a re-designation.
    if (row.corporationId !== holder.corporationId) {
      counts.corpChanged = 1;
      await recordReadState(db, {
        kind: "roster",
        corporationId: holder.corporationId,
        status: "failed",
        detail: "corp-changed",
        observed: false,
        at: new Date(),
      });
      return { status: "partial", errorSummary: "holder left the pinned corp", counts };
    }

    // 4. Token. getFreshAccessToken has FOUR outcomes and performs its own
    //    invalidation CAS internally, so this job must not repeat it.
    const token = await getFreshAccessToken(
      db,
      cfg,
      {
        id: row.id,
        refreshTokenEnc: row.refreshTokenEnc,
        tokenStatus: row.tokenStatus,
      },
      deps.fetchImpl,
    );
    if (!token.ok) {
      if (token.reason === "dry_run") {
        counts.skipped = 1;
        return { status: "ok", counts };
      }
      if (token.reason === "transient") {
        return {
          status: "failed",
          errorSummary: `token refresh failed: ${token.detail ?? "transient"}`,
          counts,
          retry: true,
        };
      }
      return { status: "failed", errorSummary: `holder token ${token.reason}`, counts };
    }

    const at = new Date();
    let rows;
    try {
      rows = await esi.getCorporationStructures(holder.corporationId, token.accessToken);
    } catch (err) {
      // A 403 here is the Station_Manager role missing in game — a normal
      // state this app cannot fix, not a token fault. It classifies
      // `permanent` because the ESI body names a role, not a scope or token.
      const forbidden = err instanceof EsiError && err.status === 403;
      const transient = err instanceof EsiError ? err.kind === "transient" : true;
      counts.forbidden = forbidden ? 1 : 0;
      await recordReadState(db, {
        kind: "roster",
        corporationId: holder.corporationId,
        status: forbidden ? "forbidden" : "failed",
        detail: forbidden ? "station-manager-role" : "read failed",
        observed: false,
        at,
      });
      if (forbidden) {
        // Never retry a permission the app cannot obtain; the hourly tick is
        // enough to notice the role being granted.
        return { status: "partial", errorSummary: "roster read forbidden", counts };
      }
      return {
        status: "failed",
        errorSummary: "roster read failed",
        counts,
        retry: transient || undefined,
      };
    }

    // Resolve type names once per run. Best-effort: a name failure must not
    // fail the roster, since nothing branches on it.
    const typeIds = [...new Set(rows.map((r) => r.typeId))];
    let typeNames = new Map<number, string>();
    try {
      const named = await esi.getUniverseNames(typeIds);
      typeNames = new Map(named.map((n) => [n.id, n.name]));
    } catch {
      // leave typeNames empty; rows keep whatever name they already had
    }

    await db.transaction(async (tx) => {
      if (!(await stillStructureHolder(tx, holder.characterId, holder.designatedAt)))
        return;
      const seen = rows.map((r) => r.structureId);
      for (const r of rows) {
        const values = {
          structureId: r.structureId,
          corporationId: holder.corporationId,
          typeId: r.typeId,
          typeName: typeNames.get(r.typeId) ?? null,
          systemId: r.systemId,
          name: r.name,
          state: r.state,
          stateTimerStart: r.stateTimerStart,
          stateTimerEnd: r.stateTimerEnd,
          fuelExpires: r.fuelExpires,
          observedAt: at,
          missingSince: null,
        };
        await tx
          .insert(structure)
          .values(values)
          .onConflictDoUpdate({
            target: structure.structureId,
            // typeName only overwrites when this run resolved one, so a failed
            // name lookup does not blank a name that was already good.
            set: {
              ...values,
              typeName: typeNames.get(r.typeId) ?? undefined,
            },
          });
      }
      counts.structures = rows.length;

      // Absent from the response: stamp, never delete. Only rows that are not
      // already stamped, so missingSince records when it FIRST went missing.
      //
      // A clean empty `rows` here is affirmative, not a coerced default:
      // `fetchAllPages` throws on a missing or non-integer `x-pages`, so
      // reaching this point with zero rows means ESI reported the corp owns
      // no structures. That is unlike the access-lists case, where a nullable
      // field is coalesced to `[]` in the client and "empty" and "absent" are
      // genuinely indistinguishable. The branch is also self-healing: the
      // upsert above writes `missingSince: null` on conflict, so a structure
      // that reappears next run is cleared here rather than left stamped.
      const missing = await tx
        .update(structure)
        .set({ missingSince: at })
        .where(
          and(
            eq(structure.corporationId, holder.corporationId),
            isNull(structure.missingSince),
            seen.length > 0 ? not(inArray(structure.structureId, seen)) : undefined,
          ),
        )
        .returning({ id: structure.structureId });
      counts.missing = missing.length;

      await recordReadState(tx, {
        kind: "roster",
        corporationId: holder.corporationId,
        status: "ok",
        detail: null,
        observed: true,
        at,
      });
    });

    return { status: "ok", counts };
  });
}
