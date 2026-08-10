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
    // Second sentence for the same reason `"wake"` below has one, and worded
    // to match it: `setMainCharacter` (services/accounts.ts:552) ends in
    // `enqueueSync`, which fans out via `core/dispatch-plan.ts` to membership,
    // contacts, wanderer and discord-roles. What that does with the new main is
    // not a formality — the membership job derives the account's tier from the
    // MAIN character's alliance ("main joined alliance", jobs/membership.ts:65),
    // so this press can change the account's tier and always re-pushes its
    // Discord roles. Neither lands on this render: the row moves to the top of
    // the manifest immediately, the tier and roles change whenever the worker
    // gets to it.
    //
    // Said here rather than as a `ConfirmCost` on the button, unlike unlink's
    // cost sentence (page.tsx): `make main` is one press with no armed state
    // to reveal prose on, and permanent prose in the drawer is the thing that
    // panel's own `visibility="reveal"` note argues against — it would be the
    // tallest element in every open drawer, describing an action most members
    // opening it aren't taking. This is the cheaper half of the same fact and
    // it is `"wake"`'s established shape.
    case "main":
      return name
        ? `Main character set to ${name}. Sync queued.`
        : "Main character updated. Sync queued.";
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
