import type { LocationDisplay } from "@/core/location";

/**
 * The second line under a character's name, on the account manifest and inside
 * the members drawer's crew table — one component for both, so the two pages
 * cannot drift into two spellings of the same fact.
 *
 * Renders nothing at all for `{ kind: "none" }`. A character who never granted
 * the location scope has the `re-authorize` control in its own row as the
 * remedy (design line 48); a second prompt here would be the same ask twice in
 * one row.
 *
 * `.dim` is applied for an offline reading and for a stale one, which are
 * different facts with the same visual answer: in both cases the text is still
 * true, just not now. Only the offline case also gets hidden "last seen " text,
 * because a stale-but-online character is genuinely where the line says it is —
 * "last seen" would be false for it.
 */
export function CharacterLocation({
  location,
  stale,
}: {
  location: LocationDisplay;
  stale: boolean;
}) {
  if (location.kind === "none") return null;
  return (
    <span className={location.offline || stale ? "char__location dim" : "char__location"}>
      {location.offline ? <span className="visually-hidden">last seen </span> : null}
      {location.text}
    </span>
  );
}
