import { Status } from "@/app/_components/ui";
import { describeLabelDifference, parseLabelCandidates } from "@/core/contact-label";

/**
 * Split in two so the account page can put the status token in the CONTACTS
 * cell and the explanatory prose below the table entirely: at 320px the table
 * lives in a horizontally-scrolling Scroller, and prose inside a cell drove
 * row height to ~340px while staying unreachable off-screen. `ContactState`
 * is the token; `ContactRemedy` is everything a member would need to read to
 * fix (or stop worrying about) that state. Neither renders anything for "ok",
 * "not yet run", or a non-target character — there is nothing to explain.
 *
 * "ok" and the label states get bespoke treatment. The remaining codes split
 * three ways: `token_invalid`/`missing_scope`/`needs_reauth` are the member's
 * to fix by re-linking; `token_refresh_failed`/`sync_failed` are transient and
 * retried automatically, so they must not read as something the member broke;
 * `dry_run` is an operator setting (SYNC_MODE) the member has no way to touch
 * at all. Read src/jobs/contacts.ts before changing any of these — the codes
 * are its vocabulary, not this file's.
 *
 * Lives in its own module, not page.tsx, so it can be imported and rendered
 * directly by tests/account-page.test.ts — a page.tsx may only export the
 * names Next.js recognizes (default, metadata, dynamic, ...), and an extra
 * named export there fails `tsc` against `.next/types`.
 */

/**
 * Whether `ContactRemedy` will render anything for this state. Exported so a
 * caller can decide whether to point a table cell at the remedy via
 * `aria-describedby`, and whether to render the remedy's wrapper at all,
 * without re-deriving "which codes explain themselves" in a second place.
 */
export function hasContactRemedy(result: string | null, target: boolean): boolean {
  return target && result !== null && result !== "ok";
}

export function ContactState({
  result,
  target,
}: {
  result: string | null;
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
  // Plain English, not the job's own vocabulary. `missing_label` and
  // `label_mismatch` are src/jobs/contacts.ts result codes; rendering them
  // verbatim put two compound nouns in a scanned column and left the token
  // unable to stand without the remedy prose below the table. The codes are
  // unchanged — only what a member reads is.
  if (result === "missing_label") return <Status tone="warn">label needed</Status>;
  if (result === "label_mismatch") return <Status tone="warn">label wrong</Status>;
  // Member-fixable by re-linking the character: a dead token, a missing scope,
  // or ESI revoking the token mid-sync all land the same place a re-auth does.
  if (result === "token_invalid") return <Status tone="bad">token invalid</Status>;
  if (result === "missing_scope") return <Status tone="warn">scope missing</Status>;
  if (result === "needs_reauth") return <Status tone="warn">re-auth needed</Status>;
  // Transient: the job retries these on its own. Amber rather than
  // --signal-bad, so a passing failure doesn't read with the same alarm as a
  // state that actually needs the member to act.
  if (result === "token_refresh_failed") {
    return <Status tone="warn">token refresh failed</Status>;
  }
  if (result === "sync_failed") return <Status tone="warn">sync failed</Status>;
  // An operator guard (SYNC_MODE is not live), not a fault of this character
  // or this member — reads neutral, the same as "not yet run".
  if (result === "dry_run") return <Status tone="off">sync disabled</Status>;
  return <Status tone="bad">{result.replace(/_/g, " ")}</Status>;
}

export function ContactRemedy({
  result,
  detail,
  label,
  showReauth = false,
}: {
  result: string | null;
  detail: string | null;
  label: string;
  /**
   * Whether to render the re-authorize control alongside the reason. Off by
   * default and opt-in per caller, because the control is only meaningful to
   * the person who owns the character: `/auth/eve/link` links a character to
   * *the clicking user's* account, so on the admin table — which renders this
   * for other members' characters — it could not fix the row it sits under and
   * would instead start a link flow against the admin's own account. The
   * account page opts in only when its TOKEN cell isn't already offering the
   * same control, so the row never shows two links to one href.
   */
  showReauth?: boolean;
}) {
  if (result === null || result === "ok") return null;
  if (result === "missing_label") {
    return (
      <span className="dim">
        Create a contact label named <code className="literal">{`"${label}"`}</code> in
        game. The next sync picks it up.
      </span>
    );
  }
  if (result === "label_mismatch") {
    // The job stores near-miss candidates as a JSON array
    // (src/core/contact-label.ts). Rendering each one as its own quoted literal
    // — rather than the serialized value as a single name — keeps the copy from
    // naming a label the member does not have.
    const candidates = parseLabelCandidates(detail);
    // Speech output normalizes whitespace and does not announce case, so a
    // single-candidate sentence that only differed by quoting two
    // near-identical strings was heard as the same sentence twice. Naming the
    // actual axis of difference in words (case / spacing / both) makes the
    // sentence stand on its own before either literal is read.
    // "other" is unreachable in practice (matchContactLabel only reports a
    // fold-equal near miss) but keeps today's unqualified wording rather than
    // asserting a difference this function can't name.
    const difference =
      candidates.length === 1 ? describeLabelDifference(candidates[0], label) : null;
    return (
      <span className="dim">
        {candidates.length === 1 && difference !== "other" ? (
          <>
            Your label is named <code className="literal">{`"${candidates[0]}"`}</code>,
            which differs from <code className="literal">{`"${label}"`}</code>{" "}
            {difference === "case"
              ? "only in capitalization"
              : difference === "spacing"
                ? "only in spacing"
                : "in both capitalization and spacing"}
            . Rename it in game to match exactly. The next sync picks it up.
          </>
        ) : candidates.length === 1 ? (
          <>
            Your label is named <code className="literal">{`"${candidates[0]}"`}</code>.
            It must be exactly <code className="literal">{`"${label}"`}</code> —
            capitalization and spaces both count. Rename it in game. The next sync picks
            it up.
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
            spacing. It must be exactly <code className="literal">{`"${label}"`}</code> —
            rename one in game. The next sync picks it up.
          </>
        ) : (
          <>
            A label differing only in capitalization or spacing exists. It must be exactly{" "}
            <code className="literal">{`"${label}"`}</code> — rename it in game. The next
            sync picks it up.
          </>
        )}
      </span>
    );
  }
  if (
    result === "token_invalid" ||
    result === "missing_scope" ||
    result === "needs_reauth"
  ) {
    const why =
      result === "token_invalid"
        ? "This character's EVE token is dead."
        : result === "missing_scope"
          ? "This character's EVE token is missing a scope authGD needs for standings."
          : "EVE revoked this character's token mid-sync.";
    return (
      <span className="dim">
        {why}
        {showReauth ? (
          <>
            {" "}
            <a className="btn btn--quiet btn--micro" href="/auth/eve/link">
              re-authorize
            </a>
          </>
        ) : (
          // No control here: either the caller's own UI already offers one for
          // this character, or the reader is not the person who can act.
          " Re-linking the character clears it."
        )}
      </span>
    );
  }
  if (result === "token_refresh_failed" || result === "sync_failed") {
    return (
      <span className="dim">
        {result === "token_refresh_failed"
          ? "Refreshing this character's token failed."
          : "The last sync for this character failed."}{" "}
        {/* Not "the next sync picks it up": the label remedies above end on
            that phrase, and they earn it by having just issued an in-game
            imperative — the sync picks up work the member did. This code asks
            nothing of anyone at all, so borrowing the phrase here would imply
            a pending fix that does not exist, and would teach members to skim
            past the sentence that does ask for something.

            (This clause used to read "on its own — nothing else to do here" in
            the label branches; it was cut to six words because it was the same
            14-word tail repeated once per affected character. The distinction
            this comment draws survives the cut: the label branches point at
            the next sync, this one points at the retry.) */}
        authGD retries automatically. No action needed.
      </span>
    );
  }
  if (result === "dry_run") {
    return (
      <span className="dim">
        Standings sync is turned off by an operator setting, not by anything on this
        account. Ask an admin if you expect it to be live.
      </span>
    );
  }
  return (
    <span className="dim">
      Unrecognized result <code className="literal">{`"${result}"`}</code>. Ask an admin
      to check the job log.
    </span>
  );
}
