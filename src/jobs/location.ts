import { and, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character } from "@/db/schema";
import { EsiError, type EsiClient } from "@/lib/esi/client";
import { logAudit } from "@/services/audit";
import { getLocatableCharacters, type MemberCharacter } from "@/services/desired";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";
import { resolveUniverseName } from "@/services/universe-names";

export const LOCATION_SCOPE_REQUIRED = "esi-location.read_location.v1";

/**
 * Requested in the same consent event as the required scope, but gated per
 * read rather than here: a character missing one of these still gets a
 * location line, with less detail (spec: Scopes — one required, two optional).
 */
export const LOCATION_SCOPES_OPTIONAL = [
  "esi-universe.read_structures.v1",
  "esi-location.read_online.v1",
] as const;

/**
 * Shaped like `canPushContacts` for the token checks, but deliberately NOT
 * `.every()` over all three location scopes. Gating on the optional two would
 * make the whole feature all-or-nothing and contradict the degradation table
 * in the spec — a wormholer without `read_structures` should still see which
 * system they are in.
 */
export function canReadLocation(
  ch: Pick<MemberCharacter, "tokenStatus" | "scopes" | "refreshTokenEnc">,
): boolean {
  if (!ch.refreshTokenEnc) return false;
  if (ch.tokenStatus === "invalid" || ch.tokenStatus === "missing") return false;
  return ch.scopes.includes(LOCATION_SCOPE_REQUIRED);
}

export type LocationEsi = Pick<
  EsiClient,
  "getLocation" | "getOnline" | "getSystemName" | "getStationName" | "getStructureName"
>;

export async function runLocationJob(deps: {
  db: Db;
  cfg: Config;
  esi: LocationEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "location", async () => {
    const characters = await getLocatableCharacters(db);
    const counts = {
      targets: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      namesUnresolved: 0,
    };
    let transientFailures = 0;
    const errors: string[] = [];

    for (const ch of characters) {
      if (!canReadLocation(ch)) {
        counts.skipped++;
        continue;
      }
      counts.targets++;
      const token = await getFreshAccessToken(
        db,
        cfg,
        {
          id: ch.characterId,
          refreshTokenEnc: ch.refreshTokenEnc,
          tokenStatus: ch.tokenStatus,
        },
        deps.fetchImpl,
      );
      if (!token.ok) {
        if (token.reason === "dry_run") {
          // The guard refused the refresh, so there is no access token and no
          // way to read a location — this character is skipped, not failed,
          // and its stored location MUST be left exactly as it was.
          counts.targets--;
          counts.skipped++;
        } else if (token.reason === "transient") {
          transientFailures++;
        } else {
          counts.failed++;
        }
        continue;
      }
      try {
        const loc = await esi.getLocation(ch.characterId, token.accessToken);
        // Optional scope: absence OR failure costs this character only the
        // online/offline detail, never the write, and never a needs_reauth
        // verdict — a 403 here says nothing about the REQUIRED scope's
        // health (spec: missing/failed optional scope degrades this field
        // only, never the row or the token status). `.catch(() => null)`
        // keeps a bad optional read from ever reaching the outer catch,
        // which exists to handle the REQUIRED read's failures.
        const online = ch.scopes.includes(LOCATION_SCOPES_OPTIONAL[1])
          ? await esi.getOnline(ch.characterId, token.accessToken).catch(() => null)
          : null;

        // Every null below is counted but never escalates the job status: a
        // character docked where the corp has no access is a steady state, and
        // an amber row for it would train operators to ignore the colour.
        const system = await resolveUniverseName(db, esi, {
          id: loc.systemId,
          kind: "system",
          accessToken: token.accessToken,
        });
        if (system === null) counts.namesUnresolved++;
        if (loc.stationId !== null) {
          const station = await resolveUniverseName(db, esi, {
            id: loc.stationId,
            kind: "station",
            accessToken: token.accessToken,
          });
          if (station === null) counts.namesUnresolved++;
        }
        if (loc.structureId !== null && ch.scopes.includes(LOCATION_SCOPES_OPTIONAL[0])) {
          const structure = await resolveUniverseName(db, esi, {
            id: loc.structureId,
            kind: "structure",
            accessToken: token.accessToken,
          });
          if (structure === null) counts.namesUnresolved++;
        }

        await db
          .update(character)
          .set({
            locationSystemId: loc.systemId,
            locationStationId: loc.stationId,
            locationStructureId: loc.structureId,
            locationOnline: online,
            locationCheckedAt: new Date(),
          })
          .where(eq(character.id, ch.characterId));
        counts.updated++;
      } catch (err) {
        // This branch writes NO location columns, deliberately — not even
        // locationCheckedAt. Keeping the last known values and the last
        // SUCCESSFUL timestamp is what makes the UI's "as of" label honest
        // about staleness, instead of the row silently blanking. Do not "fix"
        // the missing write.
        const needsReauth = err instanceof EsiError && err.kind === "needs_reauth";
        const transient = err instanceof EsiError ? err.kind === "transient" : true;
        // Recorded before the branching so the CAS-miss path, which bails out
        // early, still contributes its message to the run's error summary.
        errors.push(
          `${ch.characterId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (needsReauth) {
          // CAS on the blob our refresh just stored: if the row rotated or was
          // reclaimed since, this stale decision must not touch it.
          const statusRows = await db
            .update(character)
            .set({ tokenStatus: "needs_reauth" })
            .where(
              and(
                eq(character.id, ch.characterId),
                eq(character.refreshTokenEnc, token.tokenEnc),
              ),
            )
            .returning({ id: character.id });
          if (statusRows.length === 0) {
            // The row moved on without us, so nothing was written and there is
            // nothing to audit. Transient, not failed: the next run decides
            // against whatever state actually landed.
            transientFailures++;
            continue;
          }
          counts.failed++;
          // Only on the TRANSITION into needs_reauth. This job ticks every ~15
          // minutes, so auditing every tick would write ~96 identical rows a
          // day for one permanently broken character.
          if (ch.tokenStatus !== "needs_reauth") {
            await logAudit(db, {
              actor: "system",
              action: "token.needs_reauth",
              target: String(ch.characterId),
              // Not token-health's `missingScopes`: nothing was computed
              // against config here. The stored `scopes` column still claims
              // this grant and ESI refused the read anyway, so the scope that
              // 403'd is the fact worth recording.
              details: { scope: LOCATION_SCOPE_REQUIRED, detectedBy: "location" },
            });
          }
        } else if (transient) {
          transientFailures++;
        } else {
          counts.failed++;
        }
      }
    }

    if (transientFailures > 0 || counts.failed > 0) {
      return {
        status: "partial",
        errorSummary: errors.slice(0, 5).join("; ") || "location read failures",
        counts,
        retry: transientFailures > 0,
      };
    }
    return { status: "ok", counts };
  });
}
