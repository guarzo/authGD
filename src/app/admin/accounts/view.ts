/**
 * The pure half of the /admin/accounts confirmation notice, split out so it
 * can be unit-tested the way `account/view.ts`'s `accountConfirmation` and
 * `admin/sync/view.ts`'s `queuedNotice` both are: this is a cheap branch per
 * outcome, exactly the kind of thing that wants a test per case rather than a
 * browser.
 *
 * Nine actions mutate a row on this page (`actions.ts`); eight of them build
 * their confirmation through `accountsConfirmation`, but NOT all eight reach
 * it the same way — this page turned out to need two different plumbing
 * shapes, discovered by running the e2e suite against the first (all-redirect)
 * version of this fix and watching it fail:
 *
 * - Three actions live in the row's always-visible `cells`
 *   (`promoteAdminAction`, `demoteAdminAction`, `syncAccountAction`). These
 *   still redirect back here through `doneUrl` (same file), carrying
 *   `done`/`name`/`at` off the query string — untrusted input reaching copy,
 *   same posture `accountConfirmation` already has for `/account` — and land
 *   on `ConfirmNotice` (`_components`), page-level.
 * - Five live INSIDE the row's `Disclosure` drawer (`setTierAction`,
 *   `approveAction`, `returnToAutoAction`, `setStatusAction`,
 *   `unlinkDiscordAction`). A redirect — even one that lands back on this
 *   same route — replaces the whole route tree on navigation, and the
 *   drawer's open/closed state is a plain `useState` in `disclosure.tsx` with
 *   nowhere else to live; a redirect resets it, closing the very drawer the
 *   admin had open to press the button. These five instead call
 *   `accountsConfirmation` directly, with values the action already has (no
 *   query string involved), and return the result through `useActionState`
 *   for `confirm-group.tsx`'s `ConfirmingForm`/`ConfirmGroup` to focus — no
 *   navigation, so the drawer is never touched. See `confirm-group.tsx`'s own
 *   docblock for the full account of why, including the failing e2e run that
 *   found it. `unlinkDiscordAction` joined this group under
 *   docs/design-walkthrough.md's ruling R2, which moved its control off the
 *   row's always-visible cells and into a drawer group of its own
 *   (`page.tsx`) — it used to sit in the cell-level group above.
 *
 * Both shapes end at the same sentence-building function below, so there is
 * one copy of "what does 'tier' outcome say" rather than two.
 *
 * The pressed control is exactly what each of those eight changes out from
 * under itself — `setTierAction`'s own matching button locks (a locked
 * tier's button is `disabled`, and a disabled element cannot hold focus at
 * all), `approveAction`'s pending-only buttons unmount into the ordinary tier
 * row, `setStatusAction`'s freeze/wake button swaps branches,
 * `promoteAdminAction`/`demoteAdminAction`'s grant/revoke button does the
 * same, `unlinkDiscordAction`'s whole drawer group unmounts outright once
 * `discordLinked` flips false — the one case where the notice that focus is
 * meant to land on would go with it, which is why that action's
 * `ConfirmGroup` is hoisted above the conditional rather than sitting inside
 * the group like the rest (page.tsx), and
 * `returnToAutoAction`'s "auto" button disappears outright once the tier it
 * exists to unlock is unlocked. Left alone, the admin's focus falls to
 * `<body>` and a keyboard or screen-reader admin working a long roster has to
 * re-traverse the document to find out whether the press even landed. The
 * ninth, `saveNoteAction`, already sits inside `NoteForm`'s `useActionState` —
 * the note field's own form never unmounts or disables itself on a save, so
 * its focus was never at risk, and it already carries its own live-region
 * confirmation (`· saved`) beside the button rather than a redirect. It has
 * no `done` code here for that reason.
 */

/**
 * Whether a roster row matches a `?q=` search, for the "find one member"
 * problem the page had no answer to: the roster is one row per account, and
 * the only handle an admin usually has is a name -- the main's, an alt's, or
 * the Discord handle the row already shows -- not the account uuid nobody
 * copies down. Matched fields mirror exactly what the row already renders
 * (the pinned name cell and the Discord cell), so "I can see it on screen"
 * and "I can find it" never disagree.
 *
 * A bare, case-insensitive substring test, not a fuzzy or tokenized one:
 * the roster is small enough (one deployment's whole membership) that a
 * plain `includes` is not a performance problem, and a simple rule is one an
 * admin can predict -- "Zed" finds "Zed Alt" and "Old Zed", nothing cleverer.
 * The exact account uuid is also accepted, case-insensitively, for the admin
 * who copied one off a URL or another row's history link rather than typing a
 * name; it is compared for equality, not substring, since a partial uuid
 * paste is not a search an admin is likely to attempt.
 *
 * An empty (or all-whitespace) query matches everything -- the caller decides
 * whether to run this at all, but a defensive default keeps a stray blank
 * `?q=` from hiding the whole roster if that decision is ever skipped.
 */
export function matchesAccountSearch(
  row: {
    accountId: string;
    mainName: string | null;
    discordUsername: string | null;
    characters: ReadonlyArray<{ name: string }>;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.accountId.toLowerCase() === q) return true;
  if (row.mainName?.toLowerCase().includes(q)) return true;
  if (row.discordUsername?.toLowerCase().includes(q)) return true;
  return row.characters.some((c) => c.name.toLowerCase().includes(q));
}

// `ActionOutcome` — the result `confirm-group.tsx`'s `ConfirmingForm` threads
// through `useActionState` for the five drawer-scoped actions below — moved to
// `@/app/_components/confirm-group` once `/admin/sync` needed the identical
// shape for its own job-drawer action; imported from there by `actions.ts`.

/** The nine outcomes `/admin/accounts`'s mutating actions confirm with (all
 *  but `saveNoteAction`, whose own confirmation lives in `NoteForm`) — the
 *  three cell-level actions off the `?done=` query string, the five drawer
 *  actions through `useActionState`, per this file's head docblock. A code
 *  outside this set (hand-typed, or from a build that has since dropped
 *  one) renders no confirmation at all — see `accountsConfirmation`'s
 *  default, same posture as `/account`'s `accountConfirmation`.
 *
 *  The list is the tuple, and the type is derived from it, rather than the
 *  two being written out separately: the runtime guard and the exhaustive
 *  switch have to agree about the same nine strings, and two hand-kept
 *  copies agree only until someone adds a tenth to one of them. Adding it to
 *  the tuple alone is enough — the switch stops compiling until it handles
 *  the new case. Same shape in `/account`'s `view.ts`. */
const DONE_CODES = [
  "tier",
  "approve",
  "auto",
  "freeze",
  "wake",
  "grant",
  "revoke",
  "discord",
  "sync",
] as const;

export type AdminAccountsDoneCode = (typeof DONE_CODES)[number];

/**
 * Exported so `page.tsx` can narrow `params.done` — a raw query-string value,
 * typed `string | undefined` by Next.js with no way for it to know about this
 * module's tuple — before calling `accountsConfirmation`, which now takes
 * `AdminAccountsDoneCode` and nothing looser. That boundary is the only place
 * an unrecognised code can legitimately arrive (a hand-edited URL, or a build
 * that has since dropped one), so it is the only place this guard rejects a
 * value the types could not have caught first.
 *
 * That is not the same as saying the call inside `accountsConfirmation` is
 * merely defensive — it is load-bearing there for an unrelated reason, and
 * the comment at that call site says which. Both callers need it; they need
 * it for different things.
 */
export function isDoneCode(value: string | undefined): value is AdminAccountsDoneCode {
  return value !== undefined && (DONE_CODES as readonly string[]).includes(value);
}

/**
 * The half of the tier confirmation that says what the press actually did.
 *
 * `setTierManual` (services/admin-accounts.ts) locks the account on any
 * manual set that changes the tier — including approving the row's OTHER two
 * chips, which is why this sentence names the pin at all rather than reading
 * like a plain "set". A press on the tier the account already holds locks it
 * too, on an account that was unlocked: that IS the pin (an admin reaching
 * for it before a member leaves the alliance, while the tier still reads
 * correctly), so this sentence is the true outcome for every "tier" press
 * that reaches here, not a special case to word around.
 *
 * (An earlier pass through this sweep briefly treated a same-tier press on
 * an unlocked account as a no-op instead and gave this function a `locked`
 * parameter so it could say "already X" for that case. That guard proved
 * costly — it made the one real way to pin an already-current tier route
 * through a fabricated demote-then-repromote, which wrote a false audit row
 * and enqueued real Discord/map churn for nothing — so `setTierManual`
 * reverted to locking unconditionally on any set. `setTierAction` can no
 * longer produce a `false` here, so the parameter and its branch are gone
 * rather than kept for a case the UI can no longer reach.)
 *
 * The clause names the undo by the word written on the control that performs
 * it (`auto`, rendered only while `r.tierLocked`), rather than describing the
 * lock in the abstract: the admin reading this has that button in front of
 * them for the first time, because the press that produced this sentence is
 * what made it appear.
 *
 * It is this short for a layout reason, not a stylistic one, and lengthening
 * it is not free, though the ceiling is higher than a first measurement of it
 * suggested and the correction is worth having here. For a tier press the
 * sentence lands in `ConfirmGroup`'s `Notice`
 * (`_components/confirm-group.tsx`), a grid item in the `.drawer__group`
 * holding the tier buttons, which is itself an item of `.drawer__controls` — a
 * wrapping flex row shared with Cryo, Note and History. A group is as wide as
 * its widest item, so a long enough notice sets that width and pushes the
 * siblings along the row.
 *
 * This wording is not long enough, and neither is anything close to it. The
 * tier group's `.btn-group` is `inline-flex` with no `flex-wrap`
 * (globals.css), so its min-content equals its max-content and it is the
 * group's floor at 282.9px on the seeded drawer. Isolated in Chromium by
 * pressing a tier on an account that was *already* locked — so the press
 * changes the notice and nothing else in the group — the notice arrives at
 * 176px and the group, the flex row and the region's `scrollWidth` are
 * byte-identical before and after. An earlier pass attributed a 79px sibling
 * shift to this notice; that shift was the `auto` button appearing, which the
 * same press mounts (`page.tsx`, under `r.tierLocked`), and which is the
 * thing that actually widens the group.
 *
 * So the real ceiling is the point where the notice exceeds that 282.9px
 * floor. A fuller draft of this sentence ("Automatic tier changes are off
 * until you press auto.") measured 531px and did push Note and History onto a
 * second line at 1024px — the controls the admin is most likely to reach for
 * next, moving out from under the pointer as a *result* of the press. That
 * remains the reason not to write a paragraph here. It is a wider gate than
 * "four words", and a notice materially past the button row's width is what
 * trips it.
 */
const PINNED = "Press auto to unpin.";

/**
 * The one-line outcome of the press that landed here, or `""` for no
 * confirmation to show. Mounted unconditionally into `ConfirmNotice` by the
 * page.
 *
 * `name` is the row's own `identity` (page.tsx's mainName-or-firstName-or-id
 * pick), echoed straight through with no further validation — same posture as
 * `/account`'s `accountConfirmation` echoing `?name=`: it travels off a
 * redirect this same request wrote, so a hand-edited query string is the
 * only way to make it disagree with reality, and the cost of that is a wrong
 * sentence, not an unsafe one. It has to be named here at all, unlike
 * `/account`'s single-account page: this is a filtered, sorted LIST, and the
 * row a mutation just changed may no longer be in view (a tier change can
 * drop it out of a `?tier=` filter entirely), so the confirmation is the only
 * place left saying whose account changed.
 *
 * `tier` is the already-localized tier label (`tierLabel()`, computed by the
 * server action, which has the config this pure function does not), not the
 * raw enum value — so this module stays free of `server-only`'s config read,
 * the same division `admin/sync/view.ts`'s `queuedNotice` keeps by taking
 * `workerAge` pre-formatted rather than computing it itself.
 *
 * Missing `name`/`tier` (a stripped query string, not a real redirect) falls
 * back to the bare verb rather than a sentence with a hole in it, same
 * fallback shape as `accountConfirmation`'s `"main"` case.
 */
// `done` is `AdminAccountsDoneCode | undefined`, not `string | undefined` —
// every call site in `actions.ts` passes a literal (`"tier"`, `"approve"`,
// …), so a typo there is now a compile error caught at the call site, not a
// silent `""` at runtime found only by reading the page and noticing the
// confirmation never appeared. An overload pair was tried here first and
// reverted: TypeScript resolves overloads by trying the first match in
// order, so a narrow signature stacked above a permissive `string | undefined`
// one is inert — `"teir"` simply falls through to the second overload and
// compiles clean. There is exactly one real boundary where an unrecognised
// string can legitimately arrive: `page.tsx`'s `params.done`, straight off
// the query string. That boundary now narrows with the exported `isDoneCode`
// before calling this function at all, rather than this function accepting
// the raw string itself.
export function accountsConfirmation(
  done: AdminAccountsDoneCode | undefined,
  name: string | undefined,
  tier: string | undefined,
): string {
  // Still load-bearing, not merely defensive: the switch below has no
  // `default` and every case returns, so this is what strips `undefined` —
  // delete it and the function stops compiling under `strict` (an implicit
  // `undefined` return). What it no longer guards against is a typo'd
  // literal at a call site, since `done` is `AdminAccountsDoneCode |
  // undefined` now, not `string | undefined` — every real caller is typed to
  // hand it a recognised code or `undefined`. It still earns its keep for a
  // second reason: a future code added to `actions.ts` before `DONE_CODES`
  // learns about it would otherwise reach the switch below untyped.
  if (!isDoneCode(done)) return "";
  switch (done) {
    case "tier":
      if (name && tier) return `${name} pinned to ${tier}. ${PINNED}`;
      return tier ? `Pinned to ${tier}. ${PINNED}` : `Tier pinned. ${PINNED}`;
    case "approve":
      // Deliberately carries no `PINNED` clause, unlike `tier` above. An
      // approval does NOT run through `setTierManual`: `approveAccount`
      // (services/admin-accounts.ts) sets `tierLocked: tier === "associate"`,
      // so one of the two approve buttons pins and the other does not — and
      // this function cannot tell them apart, because `tier` arrives as the
      // already-localized label (`tierLabel()`, deployment-configurable) and
      // not the enum. Saying "pinned" here would be wrong on every alumni
      // approval; saying nothing is at least not wrong, and the `auto` button
      // appearing on the approved row is the same tell it is after a manual
      // set. Naming the pin here needs a fourth argument carrying the lock
      // state from the action, which is more than a copy change.
      if (name && tier) return `${name} approved as ${tier}.`;
      return tier ? `Approved as ${tier}.` : "Account approved.";
    case "auto":
      return name ? `${name} returned to automatic tier.` : "Returned to automatic tier.";
    case "freeze":
      return name ? `${name} frozen.` : "Frozen.";
    case "wake":
      return name ? `${name} active again.` : "Active again.";
    case "grant":
      return name ? `${name} granted admin.` : "Admin granted.";
    case "revoke":
      return name ? `${name}'s admin access revoked.` : "Admin access revoked.";
    case "discord":
      return name ? `Discord unlinked for ${name}.` : "Discord unlinked.";
    case "sync":
      return `Sync queued${name ? ` for ${name}` : ""}. The worker picks it up within a few seconds.`;
  }
}

/**
 * The one drawer outcome `accountsConfirmation` above does not cover: a lost
 * `not_linked` race on `unlinkDiscordAction`. Every other sentence in this
 * file confirms something the press just did; this one instead corrects
 * something the press assumed — the drawer's Discord group only renders when
 * the row reads as linked, so between that render and this press landing,
 * something else (another admin, the member themselves) already cleared it.
 * Saying nothing here, the way the plain "don't confirm a no-op" rule says to
 * for every other sibling race in `actions.ts`, would leave the row still
 * claiming to be linked underneath a drawer the admin has no reason to
 * distrust. This is why it gets its own sentence and its own `tone: "warn"`
 * (`confirm-group.tsx`'s `ActionOutcome`) instead of the silent `null` those
 * other races return.
 *
 * Takes the same `name` `accountsConfirmation` does (the row's own `identity`,
 * bound at the call site in `page.tsx` and passed through the action), and
 * degrades the same way when the account has no display name to give.
 */
export function accountsDiscordAlreadyUnlinked(name: string | undefined): string {
  return name
    ? `Discord was already unlinked for ${name}.`
    : "Discord was already unlinked.";
}

/**
 * The other half of "this press changed nothing", for the three drawer
 * controls whose service short-circuits when the account already holds the
 * value being set (`changed: false`, services/admin-accounts.ts). Same
 * problem `accountsDiscordAlreadyUnlinked` solves and a deliberately
 * different tone.
 *
 * That one is `warn` because the row LIES: the Discord group only renders on
 * a row that reads as linked, so a `not_linked` result means what the admin
 * is looking at is stale and the sentence has to correct it. These three do
 * not lie — the tier chip already carries `aria-pressed`, the Cryo control
 * already reads as frozen, and the note field already shows the note. The
 * display was right; only the verb was wrong, claiming an act for a press
 * that wrote no row, logged no audit entry and queued no sync. So these say
 * "was already" in the untoned rendering rather than raising a warning about
 * a screen that is telling the truth.
 *
 * Kept as a separate function from `accountsConfirmation` rather than a
 * `changed` parameter on it, because that one is also reached from the query
 * string (`page.tsx`'s `params.done`) where no such flag survives the
 * redirect — a parameter there would be silently `undefined` on exactly the
 * three actions that still redirect.
 */
export function accountsNoChange(
  done: "tier" | "auto" | "freeze" | "wake",
  name: string | undefined,
  tier: string | undefined,
): string {
  switch (done) {
    case "tier":
      // No `PINNED` clause even though the account IS pinned, and that is the
      // one place this family diverges from `accountsConfirmation`: "press
      // auto to unpin" is instruction for a lock this press just created. The
      // lock here predates the press, the `auto` button is already on screen,
      // and repeating its instruction would read as though something just
      // happened.
      if (name && tier) return `${name} was already pinned to ${tier}.`;
      return tier ? `Already pinned to ${tier}.` : "Tier was already pinned.";
    case "auto":
      return name
        ? `${name} was already on automatic tier.`
        : "Already on automatic tier.";
    case "freeze":
      return name ? `${name} was already frozen.` : "Already frozen.";
    case "wake":
      return name ? `${name} was already active.` : "Already active.";
  }
}
