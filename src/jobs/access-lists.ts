import { eq, notInArray } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db, Dbx } from "@/db";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  character,
} from "@/db/schema";
import {
  ACCESS_LISTS_SCOPE,
  EsiError,
  type AccessListsEsi,
  type EsiAccessList,
} from "@/lib/esi/client";
import { getHolder, getWatchedListIds, HOLDER_ROW_ID } from "@/services/access-lists";
import { getMemberCharacters } from "@/services/desired";
import { resolveEntityNames } from "@/services/entity-names";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

type Counts = {
  lists: number;
  watched: number;
  read: number;
  failed: number;
  skipped: number;
  noHolder: number;
  scopeMissing: number;
  holderChanged: number;
  named: number;
  namesResolved: number;
};

export async function runAccessListsJob(deps: {
  db: Db;
  cfg: Config;
  esi: AccessListsEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "access-lists", async () => {
    const counts: Counts = {
      lists: 0,
      watched: 0,
      read: 0,
      failed: 0,
      skipped: 0,
      noHolder: 0,
      scopeMissing: 0,
      holderChanged: 0,
      named: 0,
      namesResolved: 0,
    };

    // 1. No holder. An unconfigured optional feature must not paint
    //    /admin/sync red — the monitor page explains the missing designation.
    const holder = await getHolder(db);
    if (!holder) {
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    const [row] = await db
      .select({
        id: character.id,
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
    if (!row.scopes.includes(ACCESS_LISTS_SCOPE)) {
      counts.scopeMissing = 1;
      return { status: "ok", counts };
    }

    // 3. Token. getFreshAccessToken has FOUR outcomes and performs its own
    //    invalidation CAS internally (src/services/tokens.ts:92-98,126-133),
    //    so this job must not repeat it.
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
      // no_token / invalid: no read can succeed until the character
      // re-authenticates. The page renders the dark-monitor state; retrying
      // would only loop.
      return {
        status: "failed",
        errorSummary: `holder token ${token.reason}`,
        counts,
      };
    }

    return runReads({
      db,
      esi,
      counts,
      characterId: row.id,
      accessToken: token.accessToken,
    });
  });
}

/**
 * Whether `characterId` is STILL the designated holder, read inside the caller's
 * transaction.
 *
 * Outbox execution is at-least-once (src/worker/dispatcher.ts:124-136), so a
 * run that started under holder A can still be mid-flight when an admin
 * designates B — and A's late write would reconcile the catalog against the
 * set of lists *A* can see, discarding B's. This is the same
 * compare-and-swap shape the token code uses to discard stale concurrent
 * decisions (src/services/tokens.ts:100-115). Different holders legitimately
 * see different lists, so a miss is a discard, not a merge.
 */
async function stillHolder(tx: Dbx, characterId: number): Promise<boolean> {
  const [row] = await tx
    .select({ characterId: accessListHolder.characterId })
    .from(accessListHolder)
    .where(eq(accessListHolder.id, HOLDER_ROW_ID));
  return row?.characterId === characterId;
}

async function runReads(args: {
  db: Db;
  esi: AccessListsEsi;
  counts: Counts;
  characterId: number;
  accessToken: string;
}): Promise<JobResult> {
  const { db, esi, counts, characterId, accessToken } = args;
  const errors: string[] = [];

  // 4. Discovery. /access-lists returns ids ONLY, so every name costs its own
  //    detail call. `access_list_catalog` is the cache of those names, which is
  //    why this reconciles against the discovered set instead of deleting and
  //    rebuilding: a rebuild would throw away every cached name and re-buy the
  //    whole set every run. The name column is NOT NULL, and an id the job
  //    cannot name is not worth showing in a picker.
  //
  //    `access_lists` is nullish in the ESI schema, and the client coerces an
  //    absent/null field to `[]` (`src/lib/esi/client.ts`) — so "the holder was
  //    never granted any list" and "ESI omitted the field" are indistinguishable
  //    here, and both are written as the observation "the holder sees nothing".
  //    A discovered set of `[]` then reconciles the catalog down to empty too
  //    (`keep.length > 0 ? ... : undefined` below deletes unconditionally when
  //    nothing was kept). The blast radius is bounded — the watch list and its
  //    snapshots are untouched, the page falls back to its honest
  //    catalog-empty state, and names re-buy next run — but it is the one place
  //    in this job where an ambiguous read is written as if it were a
  //    confirmed one.
  let discovered: number[];
  try {
    discovered = await esi.getAccessLists(characterId, accessToken);
  } catch (err) {
    const msg = `list discovery failed: ${message(err)}`;
    const transient = err instanceof EsiError ? err.kind === "transient" : true;
    return { status: "failed", errorSummary: msg, counts, retry: transient || undefined };
  }
  counts.lists = discovered.length;

  const cached = new Map(
    (await db.select().from(accessListCatalog)).map((r) => [r.accessListId, r.name]),
  );
  const named: { accessListId: number; name: string; observedByCharacterId: number }[] =
    [];
  for (const accessListId of discovered) {
    const hit = cached.get(accessListId);
    if (hit !== undefined) {
      named.push({ accessListId, name: hit, observedByCharacterId: characterId });
      continue;
    }
    try {
      const detail = await esi.getAccessList(characterId, accessListId, accessToken);
      counts.named++;
      named.push({ accessListId, name: detail.name, observedByCharacterId: characterId });
    } catch (err) {
      // Left out of the catalog rather than inserted with a placeholder: the
      // next run retries it, and a row named "?" in the picker is worse than a
      // row that is not there yet.
      errors.push(`naming ${accessListId}: ${message(err)}`);
    }
  }

  const wrote = await db.transaction(async (tx) => {
    if (!(await stillHolder(tx, characterId))) return false;
    // Reconcile, not replace: drop what this holder can no longer see, keep
    // and refresh the rest.
    const keep = named.map((r) => r.accessListId);
    await tx
      .delete(accessListCatalog)
      .where(
        keep.length > 0 ? notInArray(accessListCatalog.accessListId, keep) : undefined,
      );
    if (named.length > 0) {
      await tx
        .insert(accessListCatalog)
        .values(named)
        .onConflictDoUpdate({
          target: accessListCatalog.accessListId,
          set: { observedByCharacterId: characterId },
        });
    }
    return true;
  });
  if (!wrote) {
    counts.holderChanged = 1;
    // The next run, under the new holder, produces the correct state.
    return { status: "ok", counts };
  }

  return readWatched({
    db,
    esi,
    counts,
    characterId,
    accessToken,
    errors,
    discovered,
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function entryRows(accessListId: number, detail: EsiAccessList) {
  return [
    ...detail.characters.map((m) => ({ kind: "character" as const, ...m })),
    ...detail.corporations.map((m) => ({ kind: "corporation" as const, ...m })),
    ...detail.alliances.map((m) => ({ kind: "alliance" as const, ...m })),
  ].map((m) => ({
    accessListId,
    kind: m.kind,
    entityId: m.id,
    access: m.access,
  }));
}

/**
 * Writes the ATTEMPT columns only, under the stale-holder guard. Returns true
 * if the holder changed mid-run, in which case the caller abandons the run.
 * observedAt and the entries are deliberately untouched: "never remove on
 * unknown state" (src/jobs/wanderer.ts:41-54) — a wiped snapshot renders as
 * "everyone lost access". Two timestamps, never collapsed.
 */
async function writeAttempt(
  db: Db,
  characterId: number,
  accessListId: number,
  attempt: { lastAttemptAt: Date; readStatus: "not_visible" | "failed"; detail: string },
): Promise<boolean> {
  // Without the guard a superseded holder's failure overwrites the current
  // holder's status, and the page shows "not visible" for a list the real
  // holder can read.
  return db.transaction(async (tx) => {
    if (!(await stillHolder(tx, characterId))) return true;
    await tx
      .insert(accessListSnapshot)
      .values({ accessListId, observedByCharacterId: characterId, ...attempt })
      .onConflictDoUpdate({
        target: accessListSnapshot.accessListId,
        set: attempt,
      });
    return false;
  });
}

async function readWatched(args: {
  db: Db;
  esi: AccessListsEsi;
  counts: Counts;
  characterId: number;
  accessToken: string;
  errors: string[];
  discovered: number[];
}): Promise<JobResult> {
  const { db, esi, counts, characterId, accessToken, errors } = args;
  const watched = await getWatchedListIds(db);
  counts.watched = watched.length;
  const observedIds = new Set<number>();
  const discoveredSet = new Set(args.discovered);

  // 5. Per watched list.
  for (const accessListId of watched) {
    // Discovery is the authority on what this holder can see. A watched id it
    // did not return is recorded not-visible WITHOUT a detail fetch — the
    // fetch is not just wasteful, it is unsafe: if ESI answers 200 with empty
    // membership for a list the holder lost, that is indistinguishable from
    // "an admin removed everyone" and would be written as a real observation,
    // wiping the last good entries. Skipping leaves them intact.
    if (!discoveredSet.has(accessListId)) {
      counts.failed++;
      errors.push(`${accessListId}: not in this holder's access lists`);
      const stale = await writeAttempt(db, characterId, accessListId, {
        lastAttemptAt: new Date(),
        readStatus: "not_visible",
        detail: "Not among the lists this character can see.",
      });
      if (stale) {
        counts.holderChanged = 1;
        return { status: "ok", counts };
      }
      continue;
    }

    let detail: EsiAccessList;
    try {
      detail = await esi.getAccessList(characterId, accessListId, accessToken);
    } catch (err) {
      counts.failed++;
      // A list discovery DID return can still fail: an admin can revoke
      // between the two calls. 403 and 404 both mean "no longer visible" — a
      // normal state, not a token fault — classified the way contacts
      // classifies its own (src/jobs/contacts.ts:224-240). Both are accepted
      // because which one ESI returns is not worth a round trip to find out,
      // and treating either as a fault would flag a benign permission change
      // as a broken token.
      const notVisible =
        err instanceof EsiError && (err.status === 403 || err.status === 404);
      errors.push(`${accessListId}: ${message(err)}`);
      const stale = await writeAttempt(db, characterId, accessListId, {
        lastAttemptAt: new Date(),
        readStatus: notVisible ? "not_visible" : "failed",
        detail: message(err).slice(0, 500),
      });
      if (stale) {
        counts.holderChanged = 1;
        return { status: "ok", counts };
      }
      continue;
    }

    const now = new Date();
    const skipped = await db.transaction(async (tx) => {
      if (!(await stillHolder(tx, characterId))) return true;
      const set = {
        observedAt: now,
        lastAttemptAt: now,
        readStatus: "ok" as const,
        observedByCharacterId: characterId,
        name: detail.name,
        description: detail.description,
        allowEveryone: detail.allowEveryone,
        detail: null,
      };
      await tx
        .insert(accessListSnapshot)
        .values({ accessListId, ...set })
        .onConflictDoUpdate({ target: accessListSnapshot.accessListId, set });
      // Replace THIS list's entries only, in the same transaction as its
      // snapshot: a reader must never see a snapshot beside another read's rows.
      await tx
        .delete(accessListEntry)
        .where(eq(accessListEntry.accessListId, accessListId));
      const rows = entryRows(accessListId, detail);
      if (rows.length > 0) await tx.insert(accessListEntry).values(rows);
      // A watched list's detail read is the freshest name anyone has, so it
      // refreshes the catalog cache. Unwatched lists keep the name they were
      // discovered with until someone watches them — the cost of not buying a
      // detail call per list per run.
      await tx
        .update(accessListCatalog)
        .set({ name: detail.name })
        .where(eq(accessListCatalog.accessListId, accessListId));
      return false;
    });
    if (skipped) {
      counts.holderChanged = 1;
      return { status: "ok", counts };
    }
    counts.read++;
    for (const r of entryRows(accessListId, detail)) observedIds.add(r.entityId);
  }

  // The roster's own corporation ids join the same batch. A member's corp is
  // not necessarily an access-list ENTRY — the "Missing access" panel names it
  // from the roster side of the comparison, not the list side — so nothing in
  // the loop above would ever add it. Null means affiliation unknown and is
  // never a matchable id (src/core/access-list-compare.ts:68).
  const roster = await getMemberCharacters(db);
  for (const c of roster) {
    if (c.corporationId !== null) observedIds.add(c.corporationId);
  }

  // 6. Names, last and best-effort: resolveEntityNames never throws, and
  //    unresolved ids render bare rather than failing the run.
  const names = await resolveEntityNames(db, esi, [...observedIds]);
  counts.namesResolved = names.size;

  if (counts.failed > 0) {
    // status "partial", not "failed": at least one read succeeded this run,
    // and pg-boss's job-level retry exists for a run that accomplished
    // nothing. The next hourly tick (JOB_CRON["access-lists"]) retries
    // whatever this run could not read, without burning the ~30-minute
    // failed-job retry budget on lists that are already fine.
    return {
      status: "partial",
      errorSummary: errors.slice(0, 5).join("; "),
      counts,
    };
  }
  return { status: "ok", counts };
}
