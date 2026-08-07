/**
 * The DOM ids the pay flow moves focus to, shared by the two sides that have
 * to agree on them.
 *
 * Deliberately its own module, with no `"use client"` directive. `page.tsx` is
 * a Server Component and uses these at render time to build `id` props;
 * `pay-flow.tsx` is a Client Component and uses them inside an effect to look
 * up a DOM node by id. Every export of a `"use client"` file becomes a client
 * reference for any importer, and a Server Component cannot invoke a client
 * reference as a plain function — only render it as a component or pass it
 * through props. Defining them here, outside that boundary, is what lets both
 * sides use them directly while still sharing one definition.
 *
 * Tests address these ids by literal selector on purpose: a test that imports
 * the constant it is asserting on cannot catch the id changing.
 */

/** The `copy amount` button on one owed row — the one control in the action
 *  cell that renders regardless of paid state, and therefore the only stable
 *  focus target across both `mark paid` and `revert`. */
export function copyAmountId(participantId: string): string {
  return `pay-copy-${participantId}`;
}

/** The Split / Roster heading, focused when the last owed participant is paid,
 *  or the last participant removed, and there is no next row to move to.
 *  Rendered by `page.tsx`, focused by `PayFlow` — two files that must agree,
 *  so neither spells it out. */
export const ROSTER_HEADING_ID = "roster-heading";

/** The `<form>` wrapping one participant's `remove` control. `PayFlow` reads
 *  this to find the NEXT row's button after a removal — a query on the form
 *  rather than a prop threaded onto `ConfirmSubmit`, which does not accept an
 *  `id` and is out of this route's scope to change (see
 *  `RemoveParticipantForm` in `pay-flow.tsx`). */
export function removeParticipantFormId(participantId: string): string {
  return `remove-participant-${participantId}`;
}

/** The `<form>` wrapping one pool's `delete` control. Same reasoning and same
 *  caller-side query as `removeParticipantFormId`, for `PoolFlow`. */
export function deletePoolFormId(poolId: string): string {
  return `delete-pool-${poolId}`;
}

/** The "Loot" heading, focused when the deleted pool was the last one and
 *  there is no next pool row to move to. */
export const LOOT_HEADING_ID = "loot-heading";
