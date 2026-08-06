/**
 * The id of a row's `copy amount` button — the one control in the action cell
 * that renders regardless of paid state, and therefore the only stable focus
 * target across both transitions.
 *
 * Deliberately its own module, with no `"use client"` directive. `page.tsx` is
 * a Server Component and calls this at render time to build `id` props;
 * `pay-flow.tsx` is a Client Component and calls it inside an effect to look
 * up a DOM node by id. Every export of a `"use client"` file becomes a client
 * reference for any importer, and a Server Component cannot invoke a client
 * reference as a plain function — only render it as a component or pass it
 * through props. Defining `copyAmountId` here, outside that boundary, is what
 * lets both sides call it directly while still sharing one definition of the
 * format.
 */
export function copyAmountId(participantId: string): string {
  return `pay-copy-${participantId}`;
}
