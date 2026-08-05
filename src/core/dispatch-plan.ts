import type { outbox } from "@/db/schema";
import { isJobType, type JobType } from "@/core/schedules";

/** Derived from the schema's payload column so the two can never drift. */
export type OutboxPayload = typeof outbox.$inferSelect.payload;

/**
 * One job an outbox payload targets, plus whatever scoping the send needs.
 * Deliberately NOT the pg-boss queue/data/singletonKey shape `planDispatch`
 * sends — that shape needs `globalSingletonKey`, which lives in
 * `@/worker/queues` and has no business being importable from `@/services`
 * (see `jobsFor` below). A `PlannedJob` is the pure fact "this payload targets
 * this job type, with this scoping"; the worker turns that into a send, and
 * the sync-status service projects it down to just the job type.
 *
 * Discriminated on `scope`, not structural: a structural union whose account
 * and discord-user arms are both subsumed by the bare `{ jobType }` arm let
 * `{ jobType, accountId, discordUserId }` typecheck (silently dropping the
 * discord scoping at the narrower branch `sendFor` would take) and let a
 * fourth arm compile with `sendFor` unchanged, falling through to the global
 * send path with no compile error. `scope` closes both holes and makes
 * `sendFor`'s switch exhaustively checkable.
 */
export type PlannedJob =
  | { scope: "global"; jobType: JobType }
  | { scope: "account"; jobType: JobType; accountId: string }
  | { scope: "discord-user"; jobType: JobType; discordUserId: string };

/**
 * The ONE mapping from an outbox payload to the job types it targets. Both
 * `planDispatch` (which actually sends to pg-boss) and `getSyncStatus` (which
 * only needs to know "is anything queued for this job type") read this, so
 * the admin sync page's queued marker can never drift from what the worker
 * will actually dispatch — the same argument `@/core/schedules` makes for
 * cadence.
 *
 * Returns `[]` for a payload this project does not recognize or cannot
 * dispatch, mirroring `planDispatch`'s drop arm: an unrecognized `kind` or an
 * unrunnable `job` targets nothing, it does not throw.
 */
export function jobsFor(payload: OutboxPayload): PlannedJob[] {
  const raw: unknown = payload;
  if (raw === null || typeof raw !== "object" || !("kind" in raw)) return [];

  switch (payload.kind) {
    case "account":
      // Membership and Discord roles are account-scopable; the desired
      // contact/ACL sets are GLOBAL (every member pushes every other
      // member), so an account change still fans out to global contacts and
      // wanderer reconciliations.
      return [
        { scope: "account", jobType: "membership", accountId: payload.accountId },
        { scope: "global", jobType: "contacts" },
        { scope: "global", jobType: "wanderer" },
        { scope: "account", jobType: "discord-roles", accountId: payload.accountId },
      ];
    case "discord-user":
      return [
        {
          scope: "discord-user",
          jobType: "discord-roles",
          discordUserId: payload.discordUserId,
        },
      ];
    case "membership-recheck":
      return [{ scope: "global", jobType: "membership-recheck" }];
    case "all":
      return [
        { scope: "global", jobType: "membership" },
        { scope: "global", jobType: "contacts" },
        { scope: "global", jobType: "wanderer" },
        { scope: "global", jobType: "discord-roles" },
      ];
    case "job":
      // Mirrors planDispatch's former RERUNNABLE gate: an unrunnable jobType
      // targets nothing, matching the queue it will actually never reach.
      // RERUNNABLE and JOB_CRON's keys are proven equal by
      // tests/dispatcher.test.ts, so isJobType is the same gate.
      return isJobType(payload.jobType)
        ? [{ scope: "global", jobType: payload.jobType }]
        : [];
    default:
      return [];
  }
}
