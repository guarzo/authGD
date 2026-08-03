import type { Config } from "@/config";
import type { Db } from "@/db";
import { wandererAclObservation } from "@/db/schema";
import { diffAcl } from "@/core/acl-diff";
import { WandererError, type WandererClient } from "@/lib/wanderer/client";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { logAudit } from "@/services/audit";
import { getFlygdCharacters } from "@/services/desired";
import { runJob, type JobResult } from "@/services/sync-run";

type CharacterEntry = { characterId: number; role: string };

/** The job manages ONLY character entries; corp/alliance members are inert. */
function characterEntries(
  members: Array<{ characterId: number | null; role: string }>,
): CharacterEntry[] {
  return members.flatMap((m) =>
    m.characterId !== null ? [{ characterId: m.characterId, role: m.role }] : [],
  );
}

const isTransient = (err: unknown): boolean =>
  err instanceof WandererError ? err.transient : true;

export async function runWandererJob(deps: {
  db: Db;
  cfg: Config;
  wanderer: WandererClient;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, wanderer } = deps;
  return runJob(db, "wanderer", async () => {
    const desiredIds = (await getFlygdCharacters(db)).map((c) => c.characterId);

    // Never remove on unknown state: a failed read aborts before ANY mutation.
    let members;
    try {
      members = await wanderer.getAclMembers();
    } catch (err) {
      const msg = `ACL read failed: ${err instanceof Error ? err.message : String(err)}`;
      if (isTransient(err)) {
        return { status: "failed", errorSummary: msg, retry: true };
      }
      // Permanent (e.g. rotated API key): this is otherwise a silent,
      // permanent outage — pg-boss sees a returned "failed" as handled and
      // never dead-letters it, so alert directly.
      await postOpsWebhook(cfg, `authGD: wanderer ${msg}`, deps.fetchImpl);
      return { status: "failed", errorSummary: msg };
    }

    const diff = diffAcl({ desiredIds, members: characterEntries(members) });
    const errors: string[] = [];
    let anyTransient = false;
    let added = 0;
    let removed = 0;
    for (const id of diff.add) {
      try {
        await wanderer.addAclMember(id);
        added++;
        await logAudit(db, { actor: "system", action: "wanderer.added", target: String(id) });
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`add ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const id of diff.remove) {
      try {
        await wanderer.removeAclMember(id);
        removed++;
        await logAudit(db, { actor: "system", action: "wanderer.removed", target: String(id) });
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`remove ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A blocked desired member has no effective access — reset to viewer.
    let unblocked = 0;
    for (const id of diff.unblock) {
      try {
        await wanderer.updateAclMemberRole(id, "viewer");
        unblocked++;
        await logAudit(db, { actor: "system", action: "wanderer.unblocked", target: String(id) });
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`unblock ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Persist the POST-mutation state (spec: the UI never shows pre-mutation
    // state). No mutation → the initial read is already the live state.
    let observed: typeof members | null = members;
    if (added + removed + unblocked > 0 || errors.length > 0) {
      try {
        observed = await wanderer.getAclMembers();
      } catch (err) {
        observed = null; // keep the previous observation: stale but honest
        anyTransient ||= isTransient(err);
      }
    }
    if (observed !== null) {
      const rows = characterEntries(observed);
      const observedAt = new Date();
      await db.transaction(async (tx) => {
        await tx.delete(wandererAclObservation);
        if (rows.length > 0) {
          await tx.insert(wandererAclObservation).values(
            rows.map((m) => ({ characterId: m.characterId, role: m.role, observedAt })),
          );
        }
      });
    }

    const counts = {
      added,
      removed,
      unblocked,
      addFailed: diff.add.length - added,
      removeFailed: diff.remove.length - removed,
      unblockFailed: diff.unblock.length - unblocked,
    };
    if (errors.length > 0 || observed === null) {
      return {
        status: "partial",
        errorSummary: [...errors, ...(observed === null ? ["post-mutation re-read failed"] : [])]
          .slice(0, 5)
          .join("; "),
        counts,
        // Preserve classification: only transient trouble earns a retry.
        ...(anyTransient ? { retry: true } : {}),
      };
    }
    return { status: "ok", counts };
  });
}
