/**
 * The account page's single derived verdict: whether a member needs to look
 * past the fold at all. Pure and DB-free so it is unit-testable directly and
 * shared between the verdict line, the first-sync notice (previously computed
 * inline in page.tsx), and the "Add character" button's colour grade — one
 * rule instead of three copies drifting apart.
 */

import type { ContactSyncResult } from "@/core/contact-result";
import { cronFor } from "@/core/schedules";
import { isOverdue } from "@/core/run-health";

/** The subset of `AccountView`'s character shape this derivation reads. A
 *  structural `Pick`-style interface rather than importing `AccountView`
 *  itself, so this stays a leaf module with no dependency on the service
 *  layer or the DB it talks to. */
export interface CharacterHealthInput {
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  needsReauthForScopes: boolean;
  contactsTarget: boolean;
  /** `string`, not `ContactSyncResult`: this value crossed the database
   *  boundary, so a code from an older deployment is reachable here and must
   *  fall through to `stalled` rather than fail to type-check. */
  contactSyncResult: string | null;
}

/**
 * Deliberately not an input: map ACL membership. `onMapAcl` comes from
 * `wanderer_acl_observation`, which src/services/account-view.ts documents as a
 * delete-and-replace snapshot where "a character legitimately off the ACL has
 * no row, which is indistinguishable from a job that has not run". False and
 * fine is therefore the same value as false and broken, so a verdict counting
 * it would raise an alarm it cannot substantiate for every member who is
 * legitimately off the map. The MAP column still reports the raw fact per row.
 * If that table ever gains a "checked at" of its own, revisit this.
 */
export interface AccountHealth {
  /** How many characters need the member to do something. */
  attention: number;
  /**
   * How many characters are not syncing for a reason the member cannot act on
   * — a transient job failure that retries itself, or SYNC_MODE being off.
   * Counted apart from `attention` because the remediation copy for these
   * states says "nothing to do here", and a headline demanding attention above
   * copy saying the opposite teaches members to distrust the headline.
   */
  stalled: number;
  /**
   * The contacts job targets at least one character and has never recorded a
   * result for any of them. Deliberately independent of `attention`: a
   * freshly-linked character has no scopes yet, so it counts as needing
   * attention AND is waiting on its first run, and the notice explaining that
   * the first run is minutes away must not vanish because of the former.
   */
  firstSyncPending: boolean;
  /** The discord-roles job has not run inside its own schedule, on an account
   *  that has a Discord link for it to push to. */
  discordStale: boolean;
  /** Which single fact the one-line verdict leads with. */
  verdict: "degraded" | "stalled" | "discord-stale" | "first-sync-pending" | "nominal";
}

/**
 * Account-level Discord-push facts, kept apart from `CharacterHealthInput`
 * because "the last push happened" is a fact about the account's Discord
 * link, not about any one character. A second, required parameter rather than
 * an optional one: this module's own `MEMBER_FIXABLE` comment below tells the
 * story of what an easy-to-forget input does when it is allowed to default
 * away silently — a verdict that quietly under-counts forever. Required makes
 * a call site that forgets Discord entirely a compile error instead.
 */
export interface DiscordPushInput {
  /** Whether a Discord link exists. Nothing is pushed without one. */
  linked: boolean;
  /** Completion of the newest discord-roles run, or null if none has landed. */
  lastPushedAt: Date | null;
  now: Date;
}

/**
 * Contacts result codes the member can clear without an admin: each one is
 * fixed by re-linking the character or renaming a label in game.
 *
 * Typed `ReadonlySet<ContactSyncResult>` rather than the inferred `Set<string>`
 * so a typo here is a compile error. Untyped, `"missing_labl"` compiled
 * happily and its only symptom was a verdict that quietly under-counted
 * forever: the character still showed LABEL MISSING in its own row, so nothing
 * about the page looked broken. That is the failure this union exists to
 * prevent. See src/core/contact-result.ts for why the codes are a compile-time
 * union and not a pgEnum.
 *
 * Declared `ReadonlySet<string>` but CONSTRUCTED `Set<ContactSyncResult>`. The
 * construction is where the typo check happens; the declaration is what lets
 * `.has()` take the widened value a reader actually holds, without an `as`
 * cast that would defeat the point.
 */
const MEMBER_FIXABLE: ReadonlySet<string> = new Set<ContactSyncResult>([
  "missing_label",
  "label_mismatch",
  "token_invalid",
  "missing_scope",
  "needs_reauth",
]);

/**
 * A character needs attention when its token is anything but valid, when it is
 * missing a scope authGD requires, or when the contacts job targets it and came
 * back with a failure the member can clear themselves. A `null` result is
 * excluded on purpose: for a target character that is "first sync pending", not
 * a failure, reported by its own field rather than folded into this count.
 */
function needsAttention(c: CharacterHealthInput): boolean {
  if (c.tokenStatus !== "valid") return true;
  if (c.needsReauthForScopes) return true;
  return c.contactsTarget && c.contactSyncResult !== null
    ? MEMBER_FIXABLE.has(c.contactSyncResult)
    : false;
}

/**
 * Not syncing, but not the member's to fix: `token_refresh_failed` and
 * `sync_failed` retry on their own, `dry_run` is an operator setting, and an
 * unrecognized code is one the member can only take to an admin. Still worth
 * saying out loud — silence here would read as "everything is fine" while
 * standings sit stale.
 */
function isStalled(c: CharacterHealthInput): boolean {
  if (needsAttention(c)) return false; // a real fault already covers this character
  return c.contactsTarget && c.contactSyncResult !== null && c.contactSyncResult !== "ok";
}

/**
 * `verdict` is a headline and only one fact can lead. The order is by what it
 * asks of the member: something to fix outranks something to merely know
 * about, which outranks an account-wide push that stopped, which outranks a
 * first run still in flight. `discord-stale` sits above `first-sync-pending`
 * because "should have happened and didn't" is a stronger fact than "hasn't
 * happened yet". The underlying facts stay separately readable so a caller
 * that wants a quieter one — the first-sync notice — is not forced through
 * that priority. An account with no contacts targets at all (associate/alumni
 * members, or zero characters) can never be pending, matching the reasoning
 * in account-view.ts's `contactsTarget` doc.
 */
export function computeAccountHealth(
  characters: CharacterHealthInput[],
  discord: DiscordPushInput,
): AccountHealth {
  const attention = characters.filter(needsAttention).length;
  const stalled = characters.filter(isStalled).length;
  const targets = characters.filter((c) => c.contactsTarget);
  const firstSyncPending =
    targets.length > 0 && targets.every((c) => c.contactSyncResult === null);
  // Account-level, not per-character, so it deliberately does not fold into
  // `stalled` — see that field's doc for why counting it there would make
  // "N characters not syncing" a lie. `lastPushedAt === null` reads as "not
  // stale" via `isOverdue`'s own null-`since` guard: a link with no completed
  // push yet has no anchor to be late against, which is first-run territory,
  // not a stopped job.
  const discordStale =
    discord.linked &&
    isOverdue(cronFor("discord-roles"), discord.lastPushedAt, discord.now);
  return {
    attention,
    stalled,
    firstSyncPending,
    discordStale,
    verdict:
      attention > 0
        ? "degraded"
        : stalled > 0
          ? "stalled"
          : discordStale
            ? "discord-stale"
            : firstSyncPending
              ? "first-sync-pending"
              : "nominal",
  };
}
