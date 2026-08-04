import { Status } from "@/app/_components/ui";

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
    return (
      <span className="dim" aria-label="not applicable">
        —
      </span>
    );
  }
  if (result === null) return <Status tone="off">not yet run</Status>;
  if (result === "ok") return <Status tone="ok">ok</Status>;
  if (result === "missing_label") {
    return (
      <>
        <Status tone="warn">label missing</Status>
        <span className="dim">
          Create a contact label named <code>{label}</code> in game, then re-sync.
        </span>
      </>
    );
  }
  if (result === "label_mismatch") {
    // The job stores near-miss candidates joined with ", " (src/jobs/contacts.ts).
    // Splitting them back out lets each render as its own quoted literal instead
    // of one quoted blob that isn't the name of any label the member actually
    // has — the same defect this feature exists to fix, just moved into the copy.
    const candidates = detail ? detail.split(", ") : [];
    return (
      <>
        <Status tone="warn">label mismatch</Status>
        <span className="dim">
          {candidates.length === 1 ? (
            <>
              Your label is named <code className="literal">{`"${candidates[0]}"`}</code>.
              It must be exactly <code className="literal">{`"${label}"`}</code> —
              capitalization and spaces both count. Rename it in game, then re-sync.
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
              — rename one in game, then re-sync.
            </>
          ) : (
            <>
              A label differing only in capitalization or spacing exists. It must be
              exactly <code className="literal">{`"${label}"`}</code> — rename it in game,
              then re-sync.
            </>
          )}
        </span>
      </>
    );
  }
  return <Status tone="bad">{result.replace(/_/g, " ")}</Status>;
}
