/**
 * Which pasted roster names drew a full share without resolving to a linked
 * character, at the moment an operation is created.
 *
 * `resolveRosterNames` (`@/services/payouts`) already gives an unresolved
 * paste entry its own row — `accountId: null`, `displayName` equal to
 * whatever was typed — rather than refusing it: an operator pasting a fleet
 * comp with one unmatched pilot is an ordinary case, not an error (see
 * `createOperationAction`'s own comment). What the create path did NOT do
 * until now is say so anywhere reachable before the operator goes looking:
 * not on `/payouts/new` itself, not on the redirect that follows, and the
 * detail page's own `duplicateUnresolvedNames` warning
 * (`../[id]/roster-warnings.ts`) only fires once the same unresolved spelling
 * appears twice — a single typo is invisible everywhere. This is the create
 * path's half of that fix.
 *
 * Pulled out of `createOperationAction` so the derivation has its own unit
 * test rather than being reachable only through the server action (which
 * needs a session, a database and `next/headers` to run at all) — the same
 * reason `roster-warnings.ts` exists as its own module. Typed structurally
 * off the two fields this needs, not by importing `RosterEntry`, for the
 * same reason that module gives: a pure function of the fields it actually
 * reads is trivial to feed a fixture in a test.
 *
 * Deliberately not deduplicated: `resolveRosterNames`'s own docblock notes
 * that two unresolved entries sharing a spelling are not evidence they're the
 * same person, and a report that silently collapsed "Bob" and "Bob" into one
 * line would understate exactly the row count the roster half's cost
 * argument turns on — two full shares going out under one displayed name.
 */
export type UnresolvedRosterCandidate = {
  displayName: string;
  accountId: string | null;
};

export function unresolvedRosterNames(entries: UnresolvedRosterCandidate[]): string[] {
  return entries.filter((e) => e.accountId === null).map((e) => e.displayName);
}
