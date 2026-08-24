import { and, asc, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character, structure, structureEvent } from "@/db/schema";
import {
  extractStructureEvent,
  formatStructureAlert,
  isStructureEventType,
} from "@/core/structure-event";
import { EsiError, NOTIFICATIONS_SCOPE } from "@/lib/esi/client";
import type { StructureEventsEsi } from "@/lib/esi/client";
import { postStructureWebhook, resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import {
  getStructureHolder,
  markSeeded,
  recordReadState,
  stillStructureHolder,
} from "@/services/structures";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

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
      if (!(await stillStructureHolder(tx, holder.characterId))) return;
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
      if (seeding) {
        counts.seeded = counts.recorded;
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

    // Every pending row for the PINNED corp, oldest first. This picks up
    // leftovers from a previous run's failed posts, and excludes anything
    // recorded under a previous holder (those were retired to `abandoned`).
    const pending = await db
      .select({
        notificationId: structureEvent.notificationId,
        type: structureEvent.type,
        structureId: structureEvent.structureId,
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

    for (const event of pending) {
      const [known] = event.structureId
        ? await db
            .select({ name: structure.name, typeName: structure.typeName })
            .from(structure)
            .where(eq(structure.structureId, event.structureId))
        : [];
      const content = formatStructureAlert({
        type: event.type,
        structureName: known?.name ?? null,
        typeName: known?.typeName ?? null,
        systemName: null,
        details: event.details ?? {},
      });
      try {
        await postStructureWebhook(cfg, content, deps.fetchImpl);
        await db
          .update(structureEvent)
          .set({ alertStatus: "sent" })
          .where(eq(structureEvent.notificationId, event.notificationId));
        counts.alerted += 1;
      } catch {
        // Leave the row pending. The ten-minute tick is the retry; burning
        // pg-boss's retry budget on a Discord blip would dead-letter a job
        // that read ESI successfully.
        counts.failedPosts += 1;
      }
    }

    if (counts.failedPosts > 0) {
      return { status: "partial", errorSummary: "some alerts failed to post", counts };
    }
    return { status: "ok", counts };
  });
}
