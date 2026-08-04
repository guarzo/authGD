import { Status } from "@/app/_components/ui";
import { parseLabelCandidates } from "@/core/contact-label";

/**
 * The contact job records a small set of result codes. "ok", "missing_label",
 * and "label_mismatch" get bespoke treatment; anything else is a failure the
 * member can act on by re-authing, so it reads as bad rather than as noise.
 *
 * A character the job never targets has no code and never will: blue and green
 * members are the *content* of a FLYGD member's contact list, not a list that
 * gets written. Reading that structural absence as "not yet run" told most of
 * the corp their first sync was pending, permanently. Their standing is still
 * being pushed; the LAST PUSHED section is where that question is answered.
 *
 * Lives in its own module, not page.tsx, so it can be imported and rendered
 * directly by tests/account-page.test.ts — a page.tsx may only export the
 * names Next.js recognizes (default, metadata, dynamic, ...), and an extra
 * named export there fails `tsc` against `.next/types`.
 */
export function ContactState({
  result,
  detail,
  label,
  target,
}: {
  result: string | null;
  detail: string | null;
  label: string;
  target: boolean;
}) {
  if (!target) {
    // The em dash alone told sighted users nothing that the "not applicable"
    // aria-label already told screen-reader users; say it in text so both
    // groups get the same explanation instead of the accessible one doing
    // all the work.
    return <span className="dim">— not managed</span>;
  }
  if (result === null) return <Status tone="off">not yet run</Status>;
  if (result === "ok") return <Status tone="ok">ok</Status>;
  if (result === "missing_label") {
    return (
      <>
        <Status tone="warn">label missing</Status>
        <span className="dim">
          Create a contact label named <code className="literal">{`"${label}"`}</code> in
          game. The next sync picks it up on its own — nothing to do here.
        </span>
      </>
    );
  }
  if (result === "label_mismatch") {
    // The job stores near-miss candidates as a JSON array
    // (src/core/contact-label.ts). Rendering each one as its own quoted literal
    // — rather than the serialized value as a single name — keeps the copy from
    // naming a label the member does not have.
    const candidates = parseLabelCandidates(detail);
    return (
      <>
        <Status tone="warn">label mismatch</Status>
        <span className="dim">
          {candidates.length === 1 ? (
            <>
              Your label is named <code className="literal">{`"${candidates[0]}"`}</code>.
              It must be exactly <code className="literal">{`"${label}"`}</code> —
              capitalization and spaces both count. Rename it in game. The next sync picks
              it up on its own — nothing to do here.
            </>
          ) : candidates.length > 1 ? (
            <>
              Labels named{" "}
              {candidates.map((c, i) => (
                <span key={`${c}-${i}`}>
                  <code className="literal">{`"${c}"`}</code>
                  {i < candidates.length - 2
                    ? ", "
                    : i === candidates.length - 2
                      ? " and "
                      : ""}
                </span>
              ))}{" "}
              {candidates.length === 2 ? "both" : "all"} differ only in capitalization or
              spacing. It must be exactly <code className="literal">{`"${label}"`}</code>{" "}
              — rename one in game. The next sync picks it up on its own — nothing to do
              here.
            </>
          ) : (
            <>
              A label differing only in capitalization or spacing exists. It must be
              exactly <code className="literal">{`"${label}"`}</code> — rename it in game.
              The next sync picks it up on its own — nothing to do here.
            </>
          )}
        </span>
      </>
    );
  }
  return <Status tone="bad">{result.replace(/_/g, " ")}</Status>;
}
