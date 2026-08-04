import type { Config } from "@/config";
import type { Db } from "@/db";
import { wandererAclObservation } from "@/db/schema";
import { diffAcl } from "@/core/acl-diff";
import {
  ACL_GRANT_ROLE,
  WandererError,
  type WandererClient,
} from "@/lib/wanderer/client";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { isDryRun } from "@/lib/sync-mode";
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

    const entries = characterEntries(members);
    // The role each member holds right now, from the list already fetched
    // above: which permission level a removal revoked is what an admin needs
    // to restore the entry if the removal turns out to have been wrong.
    const roleById = new Map(entries.map((m) => [m.characterId, m.role]));
    const diff = diffAcl({ desiredIds, members: entries });
    const errors: string[] = [];
    let anyTransient = false;
    let added = 0;
    let removed = 0;
    // In dry-run the client methods return normally without issuing a request,
    // so this job cannot tell a suppressed write from a real one. Writing audit
    // rows here would fabricate a permanent record of mutations that never
    // happened — audit_log is what an operator reconstructs an incident from.
    // Suppress the rows, and report under would* keys so the counts cannot be
    // mistaken for applied changes either (spec D6).
    const dry = isDryRun(cfg);
    for (const id of diff.add) {
      try {
        await wanderer.addAclMember(id);
        added++;
        if (!dry) {
          await logAudit(db, {
            actor: "system",
            action: "wanderer.added",
            target: String(id),
          });
        }
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`add ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const id of diff.remove) {
      try {
        await wanderer.removeAclMember(id);
        removed++;
        if (!dry) {
          await logAudit(db, {
            actor: "system",
            action: "wanderer.removed",
            target: String(id),
            details: { role: roleById.get(id) },
          });
        }
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`remove ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A blocked desired member has no effective access — reset to the granted role.
    let unblocked = 0;
    for (const id of diff.unblock) {
      try {
        await wanderer.updateAclMemberRole(id, ACL_GRANT_ROLE);
        unblocked++;
        if (!dry) {
          await logAudit(db, {
            actor: "system",
            action: "wanderer.unblocked",
            target: String(id),
          });
        }
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
          await tx
            .insert(wandererAclObservation)
            .values(
              rows.map((m) => ({ characterId: m.characterId, role: m.role, observedAt })),
            );
        }
      });
    }

    const counts = {
      ...(dry
        ? { wouldAdd: added, wouldRemove: removed, wouldUnblock: unblocked }
        : { added, removed, unblocked }),
      addFailed: diff.add.length - added,
      removeFailed: diff.remove.length - removed,
      unblockFailed: diff.unblock.length - unblocked,
    };
    if (errors.length > 0 || observed === null) {
      return {
        status: "partial",
        errorSummary: [
          ...errors,
          ...(observed === null ? ["post-mutation re-read failed"] : []),
        ]
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
