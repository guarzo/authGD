"use client";

import { useConfirmReport } from "@/app/_components/confirm-group";
import { Submit } from "@/app/_components/submit";

/**
 * The one control every watched row carries, expandable or not. A plain
 * submit button, not a form of its own: it submits the single `ConfirmingForm`
 * that wraps the whole watched-lists region (`page.tsx`'s
 * `AdminAccessListsPage`), carrying its own `accessListId` by name/value the
 * way any button in a shared HTML form does. `<form>` cannot nest, and this
 * row's own form would unmount with it anyway — the button's job ends at the
 * press.
 *
 * The region-wide form exists because a row-level (or even row-level-group)
 * `ConfirmingForm` unmounts in the same commit that would paint its own
 * confirmation: `revalidatePath` and this action's `useActionState` result
 * land together, so removing the last row collapses straight to the empty
 * `Notice`, taking whatever reported the text with it.
 * `src/app/admin/accounts/page.tsx:1075-1097` documents the same failure for
 * the Discord drawer group and states the fix this page follows: "hoisting
 * the host alone is not enough... both halves have to outlive the press" —
 * here that means the `ConfirmingForm`, not just the `ConfirmGroup`, has to
 * sit above every row rather than inside one.
 *
 * A client component rather than part of `page.tsx`'s server tree, and only
 * for the refusal channel below: `onRefused` is a function, which a server
 * component cannot hand to a client one.
 *
 * No `pendingLabel` here, unlike every other `Submit` on this page.
 * `useFormStatus` (inside `Submit`) reports the nearest parent `<form>`'s
 * pending state, and that form is shared by every row — pressing one row's
 * button flips `pending` for all of them at once, so a "Removing…" label would
 * name the wrong row on every row but the one actually in flight. `aria-busy`
 * still fans out the same way, but that is honest rather than a bug: the
 * shared form genuinely is busy, region-wide, until the one submission it can
 * hold at a time resolves. Same reason `useSubmitGuard` correctly refuses a
 * second press anywhere in the region while the first is in flight, not just
 * on the pressed row's own button — one form, one in-flight submission.
 * Undoing any of this would mean giving the row its own form again, which is
 * the exact structure that breaks the confirmation.
 */
export function StopWatching({
  accessListId,
  name,
}: {
  accessListId: number;
  name: string;
}) {
  // A refused re-press is otherwise entirely silent (`submit-guard.ts`): no
  // POST, no response, nothing for `ConfirmingForm` to forward. Silence is the
  // right answer where the first press navigates, and the wrong one here —
  // `removeWatchAction` deliberately does not redirect (see `actions.ts`), so
  // the page does not move and the admin is left watching a press do nothing.
  // The region shares one form, so the button refused is frequently a
  // DIFFERENT row's than the one in flight, which makes the silence harder to
  // read here than anywhere else this pattern appears.
  //
  // Wording and safety follow `ConfirmSubmit`'s identical wiring
  // (`_components/confirm-submit.tsx`): the sentence is safe to leave standing
  // because the press was refused precisely because an action is in flight,
  // and that action's own outcome overwrites it when it resolves.
  const report = useConfirmReport();
  return (
    <Submit
      name="accessListId"
      value={accessListId}
      className="btn btn--quiet"
      // Every watched row renders this button with the same visible words, so
      // the accessible name has to carry the row's identity — `Submit`'s own
      // rule for when an aria-label is required. The visible text stays
      // "Stop watching"; the label appends the list it acts on.
      aria-label={`Stop watching ${name}`}
      onRefused={
        report
          ? () => report({ text: "Still working on the last press.", tone: "warn" })
          : undefined
      }
    >
      Stop watching
    </Submit>
  );
}
