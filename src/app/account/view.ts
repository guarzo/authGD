/**
 * The pure half of the /account confirmation notice, split out so it can be
 * unit-tested the way `admin/sync/view.ts`'s `queuedNotice` is: `done` and
 * `name` arrive off the query string, which is untrusted input reaching copy,
 * and that is exactly the kind of branch that wants a cheap test per case
 * rather than a browser.
 */

/** The four outcomes `/account`'s server actions redirect back with. A code
 *  outside this set (hand-typed, or from a build that has since dropped one)
 *  renders no confirmation at all — see `accountConfirmation`'s default.
 *
 *  Tuple first, type derived from it: the guard below and the exhaustive
 *  switch have to agree about the same four strings, and a separately-written
 *  union is one edit away from disagreeing. Same shape in
 *  `admin/accounts/view.ts`. */
const DONE_CODES = ["main", "unlink", "wake", "discord"] as const;

export type AccountDoneCode = (typeof DONE_CODES)[number];

function isDoneCode(value: string | undefined): value is AccountDoneCode {
  return value !== undefined && (DONE_CODES as readonly string[]).includes(value);
}

/**
 * The one-line outcome of the press that landed here, or `""` for no
 * confirmation to show (no `done` at all, or one this build doesn't
 * recognize). Mounted unconditionally into `Notice` by the page — see that
 * component's docblock for why an empty string, not an omitted element, is
 * the correct "nothing to say" value.
 *
 * `name` is echoed straight into the sentence for `"main"` with no further
 * validation: it travels as `?name=` from a redirect this same request wrote
 * (`setMainAction` reads it off `setMainCharacter`'s own return, which reads
 * it off the row it just locked), so a hand-edited query string is the only
 * way to make it disagree with reality, and the cost of that is a wrong
 * sentence, not an unsafe one — React escapes it like any other child.
 * Missing rather than mismatched (a stripped `?name=`) falls back to the
 * bare verb rather than printing "Main character set to ." with nothing
 * after "to".
 */
export function accountConfirmation(
  done: string | undefined,
  name: string | undefined,
): string {
  if (!isDoneCode(done)) return "";
  switch (done) {
    case "main":
      return name ? `Main character set to ${name}.` : "Main character updated.";
    case "unlink":
      return "Character unlinked.";
    // wakeSelf (services/accounts.ts) does two things at once — clears cryo
    // and enqueues an account sync — and the cryo half is already visible a
    // few lines up as the `Status` token leaving "cryo". This names the half
    // that ISN'T otherwise visible on this render: the resync that will
    // actually push the account's standings, map access and Discord roles
    // back into step.
    case "wake":
      return "Active again. Sync queued.";
    case "discord":
      return "Discord unlinked.";
  }
}
