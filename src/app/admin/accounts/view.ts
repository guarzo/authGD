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
 * - Four actions live in the row's always-visible `cells`
 *   (`unlinkDiscordAction`, `promoteAdminAction`, `demoteAdminAction`,
 *   `syncAccountAction`). These still redirect back here through `doneUrl`
 *   (same file), carrying `done`/`name`/`at` off the query string —
 *   untrusted input reaching copy, same posture `accountConfirmation` already
 *   has for `/account` — and land on `ConfirmNotice` (`_components`),
 *   page-level.
 * - Four live INSIDE the row's `Disclosure` drawer (`setTierAction`,
 *   `approveAction`, `returnToAutoAction`, `setStatusAction`). A redirect —
 *   even one that lands back on this same route — replaces the whole route
 *   tree on navigation, and the drawer's open/closed state is a plain
 *   `useState` in `disclosure.tsx` with nowhere else to live; a redirect
 *   resets it, closing the very drawer the admin had open to press the
 *   button. These four instead call `accountsConfirmation` directly, with
 *   values the action already has (no query string involved), and return the
 *   result through `useActionState` for `confirm-group.tsx`'s
 *   `ConfirmingForm`/`ConfirmGroup` to focus — no navigation, so the drawer
 *   is never touched. See `confirm-group.tsx`'s own docblock for the full
 *   account of why, including the failing e2e run that found it.
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
 * same, `unlinkDiscordAction`'s button turns into a bare "none" status, and
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
// through `useActionState` for the four drawer-scoped actions below — moved to
// `@/app/_components/confirm-group` once `/admin/sync` needed the identical
// shape for its own job-drawer action; imported from there by `actions.ts`.

/** The nine outcomes `/admin/accounts`'s mutating actions confirm with (all
 *  but `saveNoteAction`, whose own confirmation lives in `NoteForm`) — the
 *  four cell-level actions off the `?done=` query string, the four drawer
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

function isDoneCode(value: string | undefined): value is AdminAccountsDoneCode {
  return value !== undefined && (DONE_CODES as readonly string[]).includes(value);
}

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
export function accountsConfirmation(
  done: string | undefined,
  name: string | undefined,
  tier: string | undefined,
): string {
  if (!isDoneCode(done)) return "";
  switch (done) {
    case "tier":
      if (name && tier) return `${name} set to ${tier}.`;
      return tier ? `Set to ${tier}.` : "Tier updated.";
    case "approve":
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
