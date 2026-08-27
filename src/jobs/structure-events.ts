import { and, asc, eq, inArray } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character, structure, structureEvent } from "@/db/schema";
import {
  buildStructureAlertEmbed,
  extractStructureEvent,
  isStructureEventType,
} from "@/core/structure-event";
import { EsiError, NOTIFICATIONS_SCOPE } from "@/lib/esi/client";
import type { StructureEventsEsi } from "@/lib/esi/client";
import {
  OpsWebhookError,
  postStructureWebhook,
  resolveStructureWebhookUrl,
} from "@/lib/ops-webhook";
import {
  getStructureHolder,
  markSeeded,
  recordReadState,
  stillStructureHolder,
} from "@/services/structures";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";
import { lookupCachedNames } from "@/services/universe-names";

/**
 * The roster columns the sender needs to render an alert. Derived from the
 * schema rather than hand-written, so a nullability change to `structure`
 * cannot silently diverge from what this job actually selects.
 */
type RosterLookup = Pick<
  typeof structure.$inferSelect,
  "structureId" | "name" | "typeName" | "typeId" | "systemId"
>;

type Counts = {
  fetched: number;
  recorded: number;
  alerted: number;
  failedPosts: number;
  noHolder: number;
  scopeMissing: number;
  skipped: number;
  seeded: number;
  unconfigured: number;
};

/**
 * Polls the holder's notifications for structure damage and posts each newly
 * recorded one to Discord.
 *
 * The delivery contract is at-least-once. Rows are inserted `pending` and
 * flipped to `sent` only after a post succeeds, so a crash between the two
 * re-sends on the next tick; a duplicate Discord post is preferred to a lost
 * one. A failed post returns "partial", not "failed" — the ten-minute tick is
 * the retry, and pg-boss's retry budget is for a run that accomplished nothing.
 */
export async function runStructureEventsJob(deps: {
  db: Db;
  cfg: Config;
  esi: StructureEventsEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "structure-events", async () => {
    const counts: Counts = {
      fetched: 0,
      recorded: 0,
      alerted: 0,
      failedPosts: 0,
      noHolder: 0,
      scopeMissing: 0,
      skipped: 0,
      seeded: 0,
      unconfigured: 0,
    };

    const holder = await getStructureHolder(db);
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
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    if (!row.scopes.includes(NOTIFICATIONS_SCOPE)) {
      counts.scopeMissing = 1;
      return { status: "ok", counts };
    }

    // The token branch comes BEFORE any insert or post. In dry-run
    // getFreshAccessToken returns `dry_run` without a network call, so this
    // job never reaches the sender — which is what stops a dry-run worker from
    // consuming real pending alerts against a production database.
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
    let notifications;
    try {
      notifications = await esi.getCharacterNotifications(row.id, token.accessToken);
    } catch (err) {
      // A 403 here is the Director/CEO role missing in game: corp structure
      // notifications are not delivered to the character at all.
      const forbidden = err instanceof EsiError && err.status === 403;
      const transient = err instanceof EsiError ? err.kind === "transient" : true;
      await recordReadState(db, {
        kind: "events",
        corporationId: holder.corporationId,
        status: forbidden ? "forbidden" : "failed",
        detail: forbidden ? "director-role" : "read failed",
        observed: false,
        at,
      });
      if (forbidden) {
        return { status: "partial", errorSummary: "notifications forbidden", counts };
      }
      return {
        status: "failed",
        errorSummary: "notifications read failed",
        counts,
        retry: transient || undefined,
      };
    }
    counts.fetched = notifications.length;

    // Resolve the recipient BEFORE inserting. postStructureWebhook cannot tell
    // "delivered" from "nowhere to deliver" once it has returned, so a row
    // inserted `pending` on a deployment with no webhook would be marked
    // `sent` by a post that never happened.
    const hasWebhook = resolveStructureWebhookUrl(cfg) !== undefined;
    if (!hasWebhook) counts.unconfigured = 1;
    const seeding = holder.seededAt === null;

    // Only the four damage types are persisted. The endpoint returns every
    // notification the character has — mail, war decs, kill rights, corp
    // applications — and none of those reach Postgres.
    const damage = notifications.filter((n) => isStructureEventType(n.type));

    await db.transaction(async (tx) => {
      if (!(await stillStructureHolder(tx, holder.characterId, holder.designatedAt)))
        return;
      for (const n of damage) {
        const parsed = extractStructureEvent(n.text);
        const inserted = await tx
          .insert(structureEvent)
          .values({
            notificationId: n.notificationId,
            type: n.type,
            sentAt: n.timestamp,
            structureId: parsed.structureId,
            corporationId: holder.corporationId,
            alertStatus: seeding || !hasWebhook ? "seeded" : "pending",
            details: parsed.details,
          })
          .onConflictDoNothing()
          .returning({ id: structureEvent.notificationId });
        if (inserted.length > 0) counts.recorded += 1;
      }
      if (seeding || !hasWebhook) counts.seeded = counts.recorded;
      if (seeding) {
        await markSeeded(tx, at);
      }
      await recordReadState(tx, {
        kind: "events",
        corporationId: holder.corporationId,
        status: "ok",
        detail: null,
        observed: true,
        at,
      });
    });

    if (seeding || !hasWebhook) return { status: "ok", counts };

    // The insert transaction's CAS only covers what happens inside it. This
    // phase runs AFTER that transaction commits, so a designation change in
    // the gap — or a second, overlapping run of this same job (the cron tick
    // racing a "Check now") — is invisible to it. Re-check here rather than
    // trust the holder snapshot read at the top of the run.
    if (!(await stillStructureHolder(db, holder.characterId, holder.designatedAt))) {
      return { status: "ok", counts };
    }

    // Every pending row for the PINNED corp, oldest first. This picks up
    // leftovers from a previous run's failed posts, and excludes anything
    // recorded under a previous holder (those were retired to `abandoned`).
    const pending = await db
      .select({
        notificationId: structureEvent.notificationId,
        type: structureEvent.type,
        structureId: structureEvent.structureId,
        sentAt: structureEvent.sentAt,
        details: structureEvent.details,
      })
      .from(structureEvent)
      .where(
        and(
          eq(structureEvent.corporationId, holder.corporationId),
          eq(structureEvent.alertStatus, "pending"),
        ),
      )
      .orderBy(asc(structureEvent.sentAt));

    // One batched roster read plus one cache-only name read, covering every
    // system a pending alert's structure sits in. Batched BEFORE the post
    // loop rather than resolved per-event, matching the admin page's read
    // (src/app/admin/structures/page.tsx). Scoped by `structureId` — via
    // `inArray` on the deduped, non-null ids the pending events reference —
    // rather than the whole corp's roster: strictly less data than a
    // corp-wide read, and it preserves the per-event `eq(structureId, ...)`
    // semantics a corp-wide filter would silently widen.
    //
    // Both are skipped entirely when nothing is pending, which is the
    // overwhelmingly common tick: this job runs every ten minutes and new
    // damage is rare, so the empty case is the one worth not paying for.
    // Hoisting them out of the loop must not turn "no alerts to post" into
    // two queries that the per-event lookup never made.
    const structureById = new Map<number, RosterLookup>();
    let systemNames = new Map<number, string>();
    const pendingIds = [
      ...new Set(
        pending.map((e) => e.structureId).filter((id): id is number => id !== null),
      ),
    ];
    if (pendingIds.length > 0) {
      const knownStructures = await db
        .select({
          structureId: structure.structureId,
          name: structure.name,
          typeName: structure.typeName,
          typeId: structure.typeId,
          systemId: structure.systemId,
        })
        .from(structure)
        .where(inArray(structure.structureId, pendingIds));
      for (const s of knownStructures) structureById.set(s.structureId, s);
      systemNames = await lookupCachedNames(db, [
        ...new Set(knownStructures.map((s) => s.systemId)),
      ]);
    }

    /** True for a value that will render as a well-formed positive integer id. */
    function isPositiveSafeInteger(value: string | number | null | undefined): boolean {
      if (value === null || value === undefined || value === "") return false;
      const n = Number(value);
      return Number.isSafeInteger(n) && n > 0;
    }

    let firstPostError: string | undefined;
    for (const event of pending) {
      const known = event.structureId ? structureById.get(event.structureId) : undefined;
      const systemName = known ? (systemNames.get(known.systemId) ?? null) : null;
      // The notification body normally carries its own `structureTypeID`, but
      // when it doesn't parse (see extractStructureEvent's "unparseable body"
      // fallback) the roster row known from `structureId` still has one — free
      // to fall back to, since it was already selected above. Gated on the
      // same positive-safe-integer test the embed builder uses for its own
      // thumbnail check: a junk body can put a non-coercing STRING here,
      // which is `!== undefined` but still not usable, and would otherwise
      // silently skip a perfectly good roster fallback.
      const details = { ...(event.details ?? {}) };
      if (
        !isPositiveSafeInteger(details.structureTypeID) &&
        known?.typeId !== undefined
      ) {
        details.structureTypeID = known.typeId;
      }
      // `details.solarsystemID` is persisted on every event (KEPT_KEYS) but
      // otherwise unread. When the holder has lost the in-game Director role,
      // the roster read 403s and `structure` goes stale, so `known` misses —
      // dropping name, type, system AND link all at once. Falling back to the
      // body's own system id here keeps at least the zkillboard link and
      // system-name lookup alive.
      const systemId =
        known?.systemId ??
        (isPositiveSafeInteger(details.solarsystemID)
          ? Number(details.solarsystemID)
          : null);
      try {
        // Built INSIDE the try: a throw here (bad data slipping past every
        // gate above) degrades to one failedPosts count, not an aborted
        // post loop that leaves every remaining pending row untouched.
        const embed = buildStructureAlertEmbed({
          type: event.type,
          structureName: known?.name ?? null,
          typeName: known?.typeName ?? null,
          systemName,
          systemId,
          sentAt: event.sentAt,
          notificationId: event.notificationId,
          details,
        });
        await postStructureWebhook(cfg, embed, deps.fetchImpl);
        // Conditional, not unconditional: a concurrent run (the cron tick
        // racing a "Check now") can select the same pending row and post it
        // too. Only the run whose UPDATE actually flips `pending` -> `sent`
        // counts it, so an overlap does not double-count `counts.alerted`.
        const flipped = await db
          .update(structureEvent)
          .set({ alertStatus: "sent" })
          .where(
            and(
              eq(structureEvent.notificationId, event.notificationId),
              eq(structureEvent.alertStatus, "pending"),
            ),
          )
          .returning({ id: structureEvent.notificationId });
        if (flipped.length > 0) counts.alerted += 1;
      } catch (err) {
        // Leave the row pending. The ten-minute tick is the retry; burning
        // pg-boss's retry budget on a Discord blip would dead-letter a job
        // that read ESI successfully.
        counts.failedPosts += 1;
        // Only the FIRST failure's message survives into errorSummary — that
        // is enough to say why, and it keeps the summary from growing with
        // every subsequent row's post attempt. OpsWebhookError's own message
        // is safe to surface: it originates in postWebhookBody, which never
        // interpolates the url into it. Anything else is a throw this code
        // did not construct, so its text is not trusted — same posture as
        // the worker's boot-failure handler (src/worker/index.ts).
        if (firstPostError === undefined) {
          firstPostError =
            err instanceof OpsWebhookError ? err.message : "structure alert post failed";
        }
      }
    }

    if (counts.failedPosts > 0) {
      return {
        status: "partial",
        errorSummary: `some alerts failed to post: ${firstPostError}`,
        counts,
      };
    }
    return { status: "ok", counts };
  });
}
