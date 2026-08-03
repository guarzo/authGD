import { and, eq } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character } from "@/db/schema";
import { EveSsoError, verifyEveAccessToken } from "@/lib/esi/sso";
import { reclaimTransferredCharacter } from "@/services/accounts";
import { logAudit } from "@/services/audit";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken, invalidateTokenIfUnchanged } from "@/services/tokens";

export async function runTokenHealthJob(deps: {
  db: Db;
  cfg: Config;
  fetchImpl?: typeof fetch;
  jwks?: JWTVerifyGetKey;
}): Promise<JobResult> {
  const { db, cfg } = deps;
  return runJob(db, "token-health", async () => {
    const chars = await db.select().from(character);
    const counts = { refreshed: 0, invalid: 0, needsReauth: 0, unlinked: 0, skipped: 0 };
    let transientFailures = 0;

    for (const ch of chars) {
      if (!ch.refreshTokenEnc || ch.tokenStatus === "invalid") {
        counts.skipped++;
        continue;
      }
      const token = await getFreshAccessToken(db, cfg, ch, deps.fetchImpl);
      if (!token.ok) {
        // dry_run is NOT a token problem — the refresh was refused by the
        // safety guard, not by EVE. Falling through to counts.invalid would
        // report every character as having a broken token (spec D4).
        if (token.reason === "dry_run") counts.skipped++;
        else if (token.reason === "transient") transientFailures++;
        else counts.invalid++; // permanent-only invalidation done in the service
        continue;
      }
      // A permanently failed token never blocks the rest of a sync: a
      // deterministic verify failure (bad/missing claims, malformed subject)
      // marks this character and moves on; transient trouble (JWKS fetch,
      // network) leaves state untouched and counts as transient so the run
      // retries without permanently invalidating anything.
      let identity;
      try {
        identity = await verifyEveAccessToken(token.accessToken, deps.jwks);
      } catch (err) {
        if (err instanceof EveSsoError) {
          const applied = await invalidateTokenIfUnchanged(db, ch.id, token.tokenEnc, {
            action: "token.verify_failed",
            details: { error: err.message },
          });
          if (applied) counts.invalid++;
          else transientFailures++;
        } else {
          transientFailures++;
        }
        continue;
      }

      if (identity.characterId !== ch.id) {
        // Fail closed: a token whose subject is another character must never
        // vouch for this row. Guard on the blob our CAS just stored so a
        // concurrent re-auth/reclaim discards this stale decision.
        const applied = await invalidateTokenIfUnchanged(db, ch.id, token.tokenEnc, {
          action: "token.subject_mismatch",
          details: { subjectCharacterId: identity.characterId },
        });
        if (applied) counts.invalid++;
        else transientFailures++;
        continue;
      }

      if (identity.ownerHash !== ch.ownerHash) {
        // Ownership transfer (spec: Auth flows): full reclaim — main cleared,
        // demotion unless locked, deprovision jobs enqueued, sessions revoked.
        // No last-character guard: transfer legitimately empties accounts.
        // The service re-verifies account+owner under the character lock, so a
        // transfer that already completed concurrently is never double-applied.
        const result = await db.transaction(async (tx) => {
          const r = await reclaimTransferredCharacter(tx, ch.id, {
            accountId: ch.accountId,
            ownerHash: ch.ownerHash,
          });
          if (r.ok) {
            await logAudit(tx, {
              actor: "system",
              action: "character.owner_mismatch",
              target: String(ch.id),
              details: { detectedBy: "token-health" },
            });
          }
          return r;
        });
        if (result.ok) counts.unlinked++;
        else transientFailures++; // row changed underneath — next run decides
        continue;
      }

      // Scope shortfall vs the CURRENT required set ⇒ needs_reauth (one-click
      // in-place re-auth in the UI); full coverage ⇒ valid. Guarded on the
      // blob we rotated to — a miss means the row moved on without us.
      const covered = cfg.eveSso.scopes.every((s) => identity.scopes.includes(s));
      const nextStatus = covered ? ("valid" as const) : ("needs_reauth" as const);
      const statusRows = await db
        .update(character)
        .set({ scopes: identity.scopes, tokenStatus: nextStatus })
        .where(
          and(eq(character.id, ch.id), eq(character.refreshTokenEnc, token.tokenEnc)),
        )
        .returning({ id: character.id });
      if (statusRows.length === 0) {
        transientFailures++;
        continue;
      }
      if (nextStatus === "needs_reauth" && ch.tokenStatus !== "needs_reauth") {
        await logAudit(db, {
          actor: "system",
          action: "token.needs_reauth",
          target: String(ch.id),
        });
        counts.needsReauth++;
      }
      counts.refreshed++;
    }

    if (transientFailures > 0) {
      return {
        status: "partial",
        errorSummary: `${transientFailures} transient refresh failures`,
        counts,
        retry: true,
      };
    }
    return { status: "ok", counts };
  });
}
