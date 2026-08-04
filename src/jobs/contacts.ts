import { and, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db, Dbx } from "@/db";
import { character, contactSyncState } from "@/db/schema";
import { matchContactLabel } from "@/core/contact-label";
import { diffContacts } from "@/core/contacts-diff";
import { EsiError, type EsiClient } from "@/lib/esi/client";
import { getFlygdCharacters, type FlygdCharacter } from "@/services/desired";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

export const CONTACT_SCOPES = [
  "esi-characters.read_contacts.v1",
  "esi-characters.write_contacts.v1",
] as const;

/**
 * Per-job scope gate (spec: needs_reauth is a capability warning, never a
 * global blocker): a token missing some unrelated scope still pushes contacts
 * as long as BOTH contact scopes are granted and the token isn't dead.
 */
export function canPushContacts(
  ch: Pick<FlygdCharacter, "tokenStatus" | "scopes" | "refreshTokenEnc">,
): boolean {
  if (!ch.refreshTokenEnc) return false;
  if (ch.tokenStatus === "invalid" || ch.tokenStatus === "missing") return false;
  return CONTACT_SCOPES.every((s) => ch.scopes.includes(s));
}

export type ContactsEsi = Pick<
  EsiClient,
  | "getContactLabels"
  | "getAllContacts"
  | "addContacts"
  | "editContacts"
  | "deleteContacts"
>;

/**
 * `detail` is written on EVERY path, null included. The upsert sets only the
 * columns named here, so omitting it on the success path would leave a fixed
 * member staring at the name they already corrected.
 */
async function recordResult(
  dbx: Dbx,
  characterId: number,
  result: string,
  synced: boolean,
  detail: string | null = null,
): Promise<void> {
  const set = synced
    ? { lastResult: result, lastDetail: detail, lastSyncedAt: new Date() }
    : { lastResult: result, lastDetail: detail };
  await dbx
    .insert(contactSyncState)
    .values({ characterId, ...set })
    .onConflictDoUpdate({ target: contactSyncState.characterId, set });
}

export async function runContactsJob(deps: {
  db: Db;
  cfg: Config;
  esi: ContactsEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "contacts", async () => {
    const flygd = await getFlygdCharacters(db);
    const desiredAll = flygd.map((c) => c.characterId);
    const counts = {
      targets: 0,
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
    };
    let transientFailures = 0;
    const errors: string[] = [];

    for (const target of flygd) {
      if (!canPushContacts(target)) {
        counts.skipped++;
        // Persist WHY, so the member/admin pages can show remediation.
        const deadToken =
          !target.refreshTokenEnc ||
          target.tokenStatus === "invalid" ||
          target.tokenStatus === "missing";
        await recordResult(
          db,
          target.characterId,
          deadToken ? "token_invalid" : "missing_scope",
          false,
        );
        continue;
      }
      counts.targets++;
      const token = await getFreshAccessToken(
        db,
        cfg,
        {
          id: target.characterId,
          refreshTokenEnc: target.refreshTokenEnc,
          tokenStatus: target.tokenStatus,
        },
        deps.fetchImpl,
      );
      if (!token.ok) {
        if (token.reason === "dry_run") {
          // The guard refused the refresh, so there is no access token and no
          // way to read contacts — this character is skipped, not failed, and
          // MUST NOT be recorded as synced (spec D4).
          counts.targets--;
          counts.skipped++;
          await recordResult(db, target.characterId, "dry_run", false);
        } else if (token.reason === "transient") {
          transientFailures++;
          await recordResult(db, target.characterId, "token_refresh_failed", false);
        } else {
          counts.failed++;
          await recordResult(db, target.characterId, "token_invalid", false);
        }
        continue;
      }
      try {
        // Labels first: ESI cannot create labels, so a missing label is a
        // user-remediation state — record it and skip ALL writes (spec job 2).
        const labels = await esi.getContactLabels(target.characterId, token.accessToken);
        const match = matchContactLabel(labels, cfg.standings.label);
        if (match.kind !== "exact") {
          counts.skipped++;
          // A near miss is reported, never accepted: diffContacts DELETES every
          // contact under the matched label that leaves the desired set, so that
          // authority stays bound to the exact configured name.
          await recordResult(
            db,
            target.characterId,
            match.kind === "near_miss" ? "label_mismatch" : "missing_label",
            false,
            match.kind === "near_miss" ? match.candidates.join(", ") : null,
          );
          continue;
        }
        // Read ALL pages before any destructive diff; getAllContacts rejects
        // on any page failure, aborting this character's reconciliation.
        const contacts = await esi.getAllContacts(target.characterId, token.accessToken);
        const diff = diffContacts({
          desiredIds: desiredAll.filter((id) => id !== target.characterId),
          standing: cfg.standings.value,
          labelId: match.labelId,
          contacts,
        });
        // Add/edit failures (e.g. ESI 400-rejecting a since-biomassed desired
        // id) must not block removal: removals are tried separately below,
        // regardless of whether this step failed.
        let stepErr: unknown = null;
        try {
          if (diff.add.length > 0) {
            await esi.addContacts(
              target.characterId,
              token.accessToken,
              diff.add,
              cfg.standings.value,
              [match.labelId],
            );
          }
          // Group takeovers by their preserved label set — PUT replaces
          // label_ids wholesale, so each distinct union is its own call.
          const groups = new Map<string, { labelIds: number[]; ids: number[] }>();
          for (const u of diff.update) {
            const sortedLabelIds = [...u.labelIds].sort((a, b) => a - b);
            const key = sortedLabelIds.join(",");
            const g = groups.get(key) ?? { labelIds: sortedLabelIds, ids: [] };
            g.ids.push(u.contactId);
            groups.set(key, g);
          }
          for (const g of groups.values()) {
            await esi.editContacts(
              target.characterId,
              token.accessToken,
              g.ids,
              cfg.standings.value,
              g.labelIds,
            );
          }
          counts.added += diff.add.length;
          counts.updated += diff.update.length;
        } catch (err) {
          stepErr = err;
        }

        try {
          if (diff.remove.length > 0) {
            await esi.deleteContacts(target.characterId, token.accessToken, diff.remove);
          }
          counts.removed += diff.remove.length;
        } catch (err) {
          stepErr ??= err; // report the add/edit failure first if both failed
        }

        // stepErr is the `unknown` captured from one of the two blocks above,
        // rethrown so the original failure reaches the outer handler unwrapped.
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate rethrow of a caught unknown captured across two try/catch blocks; the rule's allowRethrowing option only covers `throw` directly inside a catch.
        if (stepErr) throw stepErr;

        await recordResult(db, target.characterId, "ok", true);
      } catch (err) {
        const needsReauth = err instanceof EsiError && err.kind === "needs_reauth";
        const transient = err instanceof EsiError ? err.kind === "transient" : true;
        if (needsReauth) {
          counts.failed++;
          // CAS on the blob our refresh just stored (F5): if the row rotated
          // or was reclaimed since, this stale decision must not touch it.
          await db
            .update(character)
            .set({ tokenStatus: "needs_reauth" })
            .where(
              and(
                eq(character.id, target.characterId),
                eq(character.refreshTokenEnc, token.tokenEnc),
              ),
            );
          await recordResult(db, target.characterId, "needs_reauth", false);
        } else {
          if (transient) transientFailures++;
          else counts.failed++;
          await recordResult(db, target.characterId, "sync_failed", false);
        }
        errors.push(
          `${target.characterId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (transientFailures > 0 || counts.failed > 0) {
      return {
        status: "partial",
        errorSummary: errors.slice(0, 5).join("; ") || "token failures",
        counts,
        retry: transientFailures > 0,
      };
    }
    return { status: "ok", counts };
  });
}
