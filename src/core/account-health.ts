/**
 * The account page's single derived verdict: whether a member needs to look
 * past the fold at all. Pure and DB-free so it is unit-testable directly and
 * shared between the verdict line, the first-sync notice (previously computed
 * inline in page.tsx), and the "Add character" button's colour grade — one
 * rule instead of three copies drifting apart.
 */

/** The subset of `AccountView`'s character shape this derivation reads. A
 *  structural `Pick`-style interface rather than importing `AccountView`
 *  itself, so this stays a leaf module with no dependency on the service
 *  layer or the DB it talks to. */
export interface CharacterHealthInput {
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  needsReauthForScopes: boolean;
  contactsTarget: boolean;
  contactSyncResult: string | null;
}

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
  /** Which single fact the one-line verdict leads with. */
  verdict: "degraded" | "stalled" | "first-sync-pending" | "nominal";
}

/**
 * Contacts result codes the member can clear without an admin: each one is
 * fixed by re-linking the character or renaming a label in game. The codes are
 * src/jobs/contacts.ts's vocabulary — read it before adding to this set.
 */
const MEMBER_FIXABLE = new Set([
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
 * asks of the member: something to fix outranks something to merely know about,
 * which outranks a first run still in flight. The underlying facts stay
 * separately readable so a caller that wants a quieter one — the first-sync
 * notice — is not forced through that priority. An account with no contacts
 * targets at all (blue/green members, or zero characters) can never be pending,
 * matching the reasoning in account-view.ts's `contactsTarget` doc.
 */
export function computeAccountHealth(characters: CharacterHealthInput[]): AccountHealth {
  const attention = characters.filter(needsAttention).length;
  const stalled = characters.filter(isStalled).length;
  const targets = characters.filter((c) => c.contactsTarget);
  const firstSyncPending =
    targets.length > 0 && targets.every((c) => c.contactSyncResult === null);
  return {
    attention,
    stalled,
    firstSyncPending,
    verdict:
      attention > 0
        ? "degraded"
        : stalled > 0
          ? "stalled"
          : firstSyncPending
            ? "first-sync-pending"
            : "nominal",
  };
}
