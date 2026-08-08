import type { LocationDisplay } from "@/core/location";
import { Status } from "./ui";

/**
 * The second line under a character's name, on the account manifest and inside
 * the members drawer's crew table — one component for both, so the two pages
 * cannot drift into two spellings of the same fact.
 *
 * `line` renders the location text. Both other cases render a one-line "not
 * reported" state instead of nothing:
 *
 * - `never` — nobody has ever completed a location read for this character: a
 *   missing scope, a dead token, or a job that has not reached them yet, all
 *   indistinguishable from here. The old shape collapsed this into a blank
 *   line, and the blank has more than one meaning — most of the time it means
 *   "with main" (walkthrough elision), but for a character in this state it
 *   means "we don't know", and `classifyCharacter` does not read location, so
 *   a row in this state can sit under a head saying every character is
 *   healthy. "not reported" says the true thing instead of nothing.
 * - `unresolved` — a read completed but no system came back. Not reachable
 *   through today's location job (`src/jobs/location.ts` writes all five
 *   columns together, and ESI's `solar_system_id` is non-nullable), but the
 *   formatter describes the snapshot it was given rather than assuming a
 *   caller's invariant (`LocationDisplay`'s own doc), so this renders the same
 *   honest "not reported" rather than inventing a UI for a state nothing
 *   produces.
 *
 * Neither is a second prompt: a character who never granted the location
 * scope already carries the `re-authorize` control in its own row as the
 * remedy. "not reported" is a statement of fact about what this row knows, not
 * another ask — the same distinction `ContactState`'s "not yet run" draws from
 * its own remedy control.
 *
 * `.st` (Status's own class) is `display: inline-flex` at `--t-label`
 * (0.6875rem), smaller than `.char__location`'s `--t-caption` (0.8125rem), so
 * this line never costs more height than the location line it replaces — the
 * requirement this state is held to since density is the page's own top
 * complaint.
 *
 * `.dim` is applied for an offline reading and for a stale one, which are
 * different facts with the same "true, but not now" visual answer — but
 * dimming alone did not say *which* of the two, so a member scanning a dim
 * row could not tell "docked somewhere else right now" from "we haven't
 * checked in a while and this may already be wrong" without opening the row.
 * Each now carries its own visible text alongside the shared dim: "last seen"
 * ahead of the location for offline (promoted from a screen-reader-only
 * prefix — sighted members get the same fact now, not just AT users), and a
 * trailing "(stale)" for a stale-but-online reading, which keeps its own
 * text because "last seen" would assert the character is no longer there,
 * and a stale-but-online character is genuinely where the line says it is —
 * only the timestamp of that fact is old. Both add width to the line, never
 * a second line: `.char__location` is `display: block`, one line per
 * character, and this state is held to the same one-line budget as "not
 * reported" above. A character can be offline and stale at once; "last seen"
 * covers that case too, since it is the stronger of the two claims.
 */
export function CharacterLocation({
  location,
  stale,
}: {
  location: LocationDisplay;
  stale: boolean;
}) {
  switch (location.kind) {
    // Both non-`line` kinds share one rendering, listed case by case rather
    // than caught by a `kind !== "line"` negative. src/app/admin/sync/page.tsx
    // records why: a negative check is satisfied by a future fourth member
    // too, so adding one compiles silently and falls through to whichever
    // sentence the negative branch happens to print. Here a fourth member is
    // a build failure at the `never` below, and sharing a rendering stays a
    // decision somebody made rather than one the control flow made for them.
    case "never":
    case "unresolved":
      return <Status tone="off">not reported</Status>;
    case "line":
      return (
        <span
          className={location.offline || stale ? "char__location dim" : "char__location"}
        >
          {location.offline ? "last seen " : null}
          {location.text}
          {!location.offline && stale ? " (stale)" : null}
        </span>
      );
    default: {
      const unhandled: never = location;
      throw new Error(`unhandled LocationDisplay kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
