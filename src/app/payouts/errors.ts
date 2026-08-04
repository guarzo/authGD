/**
 * The `?error=` codes the payout pages can render, and the copy each one shows.
 *
 * These live here rather than beside the pages that render them so the actions
 * module can be typed against them without importing a page component. That is
 * the whole point of the file: `operationFailed` and `createFailed` take a
 * `keyof typeof` these maps, so a code with no entry is a typecheck failure
 * rather than a redirect that renders an unchanged form and no explanation.
 *
 * TWO maps, not one, and codes are deliberately NOT globally unique.
 * `share_format` and `share_range` appear in both with different copy: the
 * detail page's "The old value is unchanged." is true there (a stored value is
 * at stake) and false on the create form (the operation does not exist yet).
 * A single map would force one message that is wrong on one of the two pages,
 * or `share_format_new` / `share_format_detail` — uniqueness as bookkeeping,
 * with no property gained. Each page's map is its namespace; the types are what
 * make that namespace enforceable.
 */

/** Every code `createOperationAction` can reject with, rendered by
 *  `/payouts/new`.
 *
 *  All of these land back there with the submitted values echoed in the query
 *  string and reapplied, so each message can honestly say the work survived:
 *  the operator fixes one field rather than retyping five. */
export const NEW_OPERATION_ERRORS = {
  name_required: "An operation needs a name. Everything else is still filled in.",
  date_invalid: "Date must be a real calendar date. Everything else is still filled in.",
  url_invalid:
    "That battle report is not a URL. Paste the full link, or leave it blank and add it later.",
  url_scheme: "Battle report links must start with http:// or https://.",
  share_format: "Corp share must be a plain percentage like 10 or 12.5.",
  share_range:
    "Corp share cannot exceed 100% — that would leave the roster nothing to split.",
} as const;

/** Every code an action on `/payouts/[id]` can redirect with.
 *
 *  Several of these are backstops rather than everyday errors: the appraisal
 *  form's pricing mode and location kind are <select>s and its location id is
 *  pattern-guarded, so `pricing_mode`, `location_kind`, `station_invalid` and
 *  `region_invalid` are unreachable by filling the form in. That is deliberate
 *  — a redirect cannot carry the loot paste back, so those failures are
 *  prevented at the input rather than explained after the fact. None of these
 *  messages claims the paste survived, because on those paths it did not. */
export const OPERATION_ERRORS = {
  appraisal_failed:
    "Could not price that paste right now (triff.tools did not answer). Nothing was saved — adjust and try again, or use a flat pool.",
  pricing_mode: "That is not one of the four pricing modes. Nothing was saved.",
  location_kind:
    "Price against a station or a region — triff accepts exactly one. Nothing was saved.",
  station_invalid:
    "Station ID must be digits only — Jita 4-4 is 60003760. Nothing was saved.",
  region_invalid: "Region ID must be digits only. Nothing was saved.",
  note_required:
    "A flat pool needs a note saying where the number came from. It is the only record of why this total is what it is.",
  total_invalid:
    "Total must be a plain number like 12345.67 — no commas, and no shorthand like 1e5.",
  price_invalid:
    "Price must be a plain number like 12.34 — no commas, and at most two decimals. The item price was left as it was.",
  shares_required: "Shares cannot be blank. The roster value was left as it was.",
  shares_invalid:
    "Shares must be a plain number like 1 or 1.5. The roster value was left as it was.",
  shares_positive:
    "Shares must be greater than zero. To pay someone nothing, exclude them instead — that keeps them on the roster and out of the split.",
  shares_range: "Shares cannot exceed 9999.99. The roster value was left as it was.",
  share_format:
    "Corp share must be a plain percentage like 10 or 12.5. The old value is unchanged.",
  share_range:
    "Corp share cannot exceed 100% — that would leave the roster nothing to split. The old value is unchanged.",
  participant_name_required:
    "Type a character name to add someone to the roster. Nothing was added.",
  participant_duplicate:
    "Someone is already on this roster under that name. Nothing was added — two rows under one unresolved name pay two full shares to whoever answers to it.",
  // The expected outcome on a busy night, not a fault, and the ONLY message
  // here that claims to know why: it is used only when ESI's own error body
  // said so. Worded as a fact about the game, because the fallback — copy the
  // amount, pay by hand — is exactly what operators did before this control.
  open_info_offline:
    "EVE says that character is not logged in, so there was nowhere to open the window. Nothing else changed — copy the amount and pay them when they are next online.",
  // Distinct from offline because the fix is different, and is the operator's
  // own to make: the grant is missing from THEIR login, not the recipient's.
  open_info_reauth:
    "Opening a window in EVE needs a permission your login does not carry yet. Add your character again from your account page to grant it — everything else here keeps working without it.",
  open_info_busy:
    "EVE is rate-limiting us right now. Nothing changed — wait a minute and try again, or copy the amount and pay by hand.",
  // The one failure where the call may actually have SUCCEEDED, so it must not
  // tell the operator to click again without looking first.
  open_info_timeout:
    "EVE took too long to answer. The window may still have opened, so check your client before trying again.",
  // The honest catch-all. It says what happened and what to do next, and
  // deliberately does not guess at a cause we cannot prove.
  open_info_failed:
    "Could not open that window just then. Nothing changed — try again in a moment, or copy the amount and pay by hand.",
  open_info_target:
    "That line cannot be opened: it is excluded, has no linked character, or the operation is no longer finalized. Reload the page to see where it stands.",
  open_info_dry_run:
    "This deployment is in dry-run mode, so nothing is sent to EVE. The amounts and the payment controls are real; only the in-game window is suppressed.",
} as const;

export type NewOperationErrorCode = keyof typeof NEW_OPERATION_ERRORS;
export type OperationErrorCode = keyof typeof OPERATION_ERRORS;

/** Reads a code that came off the query string, where it is a `string` and not
 *  yet one of ours — anyone can type `?error=nonsense`. An unrecognized code
 *  yields no message and the page renders without a notice, exactly as it does
 *  today (`src/app/payouts/dropped.ts` takes the same stance on its payload).
 *  What changed is that a code WE emit can no longer be the unrecognized one:
 *  `operationFailed` and `createFailed` only accept keys of these maps. */
export function lookupErrorMessage(
  map: Readonly<Record<string, string>>,
  code: string | undefined,
): string | undefined {
  return code !== undefined && Object.hasOwn(map, code) ? map[code] : undefined;
}
