/**
 * Two name clashes the detail page warns about, neither of which the service
 * layer refuses (see `addParticipant` in `@/services/payouts`, which refuses
 * only unresolved-vs-unresolved — deliberately, and unchanged by this
 * module). Pulled out of the page component so the derivation has its own
 * unit tests rather than being reachable only through e2e; mirrors the
 * precedent set by `../dropped.ts`.
 *
 * Typed structurally off the page's participant rows (see
 * `PayoutParticipantView` in `@/services/payout-view`) rather than importing
 * that type, so this stays a pure function of the two fields it actually
 * needs and is trivial to feed fixtures in a test.
 */
export type RosterWarningRow = {
  displayName: string;
  accountId: string | null;
};

export type RosterWarnings = {
  /** A display name held by more than one UNRESOLVED row (accountId null on
   *  both). The service refuses this combination going forward, but a roster
   *  written before that guard existed can still carry it, so the page keeps
   *  warning about it as a backstop. */
  duplicateUnresolvedNames: string[];
  /** A display name held by at least one row with an account and at least
   *  one row without one. Unlike the case above, the service ALLOWS this: the
   *  resolved row carries accountId and recipientCharacterId, so payment and
   *  "open info" target it unambiguously regardless of what the unresolved
   *  row is also called. The shared string is a label, not an identity, so
   *  refusing would block the ordinary case where a roster pasted on the
   *  night leaves someone unresolved and their ESI link lands later — the
   *  operator needs to be able to add the now-linked pilot without deleting
   *  the row that ought to stay. A warning is recoverable in both directions
   *  (removeParticipant is available for exactly as long as the warning is,
   *  both gated on canEdit); a refusal would not be. */
  crossStateClashes: string[];
};

/**
 * Derives both warnings from the participant rows the page already loaded.
 *
 * Two things this deliberately does NOT do, matching the pre-existing
 * unresolved/unresolved derivation this replaces:
 *
 * - It does not filter out `excluded` rows. The original derivation counted
 *   every participant regardless of exclusion, and giving the two warnings
 *   different exclusion rules would be worse than the mild noise of warning
 *   about a row that draws no share. (Whether excluded rows *should* count is
 *   a separate question, out of scope here.) `RosterWarningRow` does not even
 *   name `excluded`, so that decision is structural rather than a filter
 *   someone could quietly drop — the page passes rows that carry the field,
 *   and this function cannot see it.
 * - It does not suppress a name that appears in both warning lists. Three
 *   rows named "Bob" — two unresolved, one resolved — genuinely need both:
 *   "remove one duplicate" is not the same fix as "check whether the
 *   unlinked one is the same pilot as the linked one", and hiding either
 *   warning would hide half the problem.
 */
export function deriveRosterWarnings(participants: RosterWarningRow[]): RosterWarnings {
  // key (lowercased) -> first-seen spelling, so the operator sees the
  // capitalization actually on the roster rather than a normalized form.
  const firstSpellingByKey = new Map<string, string>();
  const unresolvedCountByKey = new Map<string, number>();
  const resolvedKeys = new Set<string>();
  // First-appearance order, so both warnings list names in the order an
  // operator scanning the roster would meet them, not alphabetically.
  const keyOrder: string[] = [];

  for (const p of participants) {
    const key = p.displayName.toLowerCase();
    if (!firstSpellingByKey.has(key)) {
      firstSpellingByKey.set(key, p.displayName);
      keyOrder.push(key);
    }
    if (p.accountId === null) {
      unresolvedCountByKey.set(key, (unresolvedCountByKey.get(key) ?? 0) + 1);
    } else {
      resolvedKeys.add(key);
    }
  }

  const duplicateUnresolvedNames = keyOrder
    .filter((key) => (unresolvedCountByKey.get(key) ?? 0) > 1)
    .map((key) => firstSpellingByKey.get(key)!);

  const crossStateClashes = keyOrder
    .filter((key) => resolvedKeys.has(key) && (unresolvedCountByKey.get(key) ?? 0) > 0)
    .map((key) => firstSpellingByKey.get(key)!);

  return { duplicateUnresolvedNames, crossStateClashes };
}
