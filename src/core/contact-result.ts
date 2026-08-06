/**
 * The contacts job's result vocabulary, in one place. `src/jobs/contacts.ts`
 * is the only writer; `contact_sync_state.last_result` is where it lands; the
 * account page and the admin accounts table are the readers.
 *
 * A `text()` column narrowed with `$type<>()` rather than a `pgEnum` like
 * `token_status`, deliberately, and the difference is not stylistic:
 *
 * - `token_status` is a closed set the tier state machine branches on. A value
 *   outside it is a bug with no sensible handling, so the database refusing to
 *   store one is a feature.
 * - This vocabulary is open and expected to grow. `ContactRemedy` already has
 *   a designed fallback for a code it does not recognize ("Ask an admin to
 *   check the job log"), and `tests/account-page.test.ts` pins that behaviour.
 *   A `pgEnum` would make every new code a migration, and would turn a
 *   rolling deploy — new worker writing a code the old enum lacks — into a
 *   write failure rather than a slightly vague line of UI copy.
 *
 * So the constraint is compile-time only. It catches the failure that actually
 * happens (a typo'd literal at a write site, or a reader's set of codes
 * drifting from the writer's) and costs nothing at the database.
 *
 * Because it is compile-time only, a row CAN hold something outside this
 * union: written by an older deployment, or by hand. Readers therefore keep
 * `string | null` and must keep their fallback branch. See the widening note
 * in src/services/account-view.ts.
 */
export const CONTACT_SYNC_RESULTS = [
  /** Contacts were pushed, or were already correct. */
  "ok",
  /** No label named STANDINGS_LABEL on the character. */
  "missing_label",
  /** A label exists that differs only in capitalization or spacing. */
  "label_mismatch",
  /** The character's refresh token is dead or absent. */
  "token_invalid",
  /** The token lacks one or both of CONTACT_SCOPES. */
  "missing_scope",
  /** ESI revoked the token mid-sync; the character is marked needs_reauth. */
  "needs_reauth",
  /** Refreshing the token failed transiently. The job retries. */
  "token_refresh_failed",
  /** The push itself failed transiently. The job retries. */
  "sync_failed",
  /** SYNC_MODE is not live, so nothing was pushed. An operator setting. */
  "dry_run",
] as const;

export type ContactSyncResult = (typeof CONTACT_SYNC_RESULTS)[number];

/**
 * The subset of `CONTACT_SYNC_RESULTS` that a successful re-auth invalidates.
 * All four describe the *token*, not the character's in-game labels or an
 * operator setting — so a fresh, fully-scoped token makes every one of them
 * stale. `label_mismatch` / `missing_label` are findings about labels and
 * survive a re-auth untouched; `dry_run` and `ok` aren't faults to begin with.
 * Used by `reauthCharacter` to decide whether to clear a stale verdict rather
 * than let it sit on screen until the enqueued sync overwrites it.
 */
export const TOKEN_FAULT_RESULTS = [
  "token_invalid",
  "missing_scope",
  "needs_reauth",
  "token_refresh_failed",
] as const satisfies readonly ContactSyncResult[];
