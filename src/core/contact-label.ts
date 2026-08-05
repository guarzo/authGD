export type LabelMatch =
  | { kind: "exact"; labelId: number }
  | { kind: "near_miss"; candidates: string[] }
  | { kind: "absent" };

/**
 * Case and surrounding whitespace are the two ways a member's label can be
 * wrong while looking right: the EVE client renders "AuthGD " and "AuthGD"
 * identically, and a case-only change to STANDINGS_LABEL once stranded every
 * member at `missing_label` with no way to see why. Folding both away is what
 * lets the job say which of the two strings is wrong.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the latter is locale-dependent
 * (Turkish dotted-I) and the worker's locale is not pinned.
 */
const fold = (s: string): string => s.trim().toLowerCase();

/**
 * An exact match ALWAYS wins, even when fold-equal siblings exist — the app
 * owns the exact label and must never be talked out of it by a near miss.
 * Absent an exact match, every fold-equal name is returned: two labels
 * differing only in case is a real state, and reporting it honestly is better
 * than picking one and writing contacts under a label nobody configured.
 */
export function matchContactLabel(
  labels: Array<{ labelId: number; labelName: string }>,
  required: string,
): LabelMatch {
  const exact = labels.find((l) => l.labelName === required);
  if (exact) return { kind: "exact", labelId: exact.labelId };

  const wanted = fold(required);
  const candidates = labels
    .filter((l) => fold(l.labelName) === wanted)
    .map((l) => l.labelName)
    // Plain ordinal sort, intentionally: same rationale as `toLowerCase` above
    // — a locale-aware sort would make the reported order depend on the
    // worker's locale, which is not pinned.
    .sort();

  return candidates.length > 0 ? { kind: "near_miss", candidates } : { kind: "absent" };
}

/**
 * Near-miss candidates are persisted to `contact_sync_state.last_detail` as a
 * JSON array, not as a delimited string. Every candidate is a fold-equal
 * variant of STANDINGS_LABEL, so if that label contains the delimiter, EVERY
 * candidate does — a `", "` join then round-trips into a list of substrings
 * that name no label the member actually has, which is the exact defect this
 * feature exists to fix.
 */
export function encodeLabelCandidates(candidates: string[]): string {
  return JSON.stringify(candidates);
}

/**
 * Tolerant by design, because it reads a column two formats have been written
 * to: rows persisted before the JSON encoding above still hold a `", "` join,
 * and the contacts job only rewrites a row when it next runs for that
 * character. Anything that is not a JSON array of strings falls back to the
 * legacy split, so an old row renders as it did before rather than as raw JSON.
 */
export function parseLabelCandidates(detail: string | null): string[] {
  if (!detail) return [];
  try {
    const parsed: unknown = JSON.parse(detail);
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === "string")) {
      return parsed;
    }
  } catch {
    // Not JSON — legacy row; fall through to the delimiter split below.
  }
  return detail.split(", ");
}

export type LabelDifference = "case" | "spacing" | "case-and-spacing" | "other";

/**
 * Names WHY a single near-miss candidate isn't the configured label, in words
 * a screen reader can carry on its own. `matchContactLabel` already proved
 * `actual` is fold-equal to `expected` — `fold` lowercases and trims, but does
 * NOT collapse internal runs, so a real candidate can only differ by case
 * and/or SURROUNDING whitespace. This function's own `collapse` is
 * deliberately wider than that: it also folds internal runs, so the contract
 * holds for any two strings rather than only the narrower set the job can
 * produce, and `"other"` covers anything that isn't a pure case and/or
 * whitespace difference. In practice `"spacing"` therefore always means
 * leading/trailing whitespace, and `"other"` is unreachable from job data.
 *
 * Two independent probes, each fixing ONE axis and leaving the other intact:
 *
 * - `equalIgnoringCase` folds case but leaves whitespace exactly as written.
 *   True only when whitespace already matched, so if it's true and the raw
 *   strings still differ, case was the only thing wrong.
 * - `equalIgnoringSpacing` collapses whitespace (matching how the EVE client
 *   renders "AuthGD " and "AuthGD" identically) but leaves case exactly as
 *   written. True only when case already matched, so if it's true and the raw
 *   strings still differ, spacing was the only thing wrong.
 *
 * Reading both together: exactly one true means that axis alone explains the
 * difference; both false means both axes are wrong; both true means the raw
 * strings were already identical (not a real near miss).
 */
export function describeLabelDifference(
  actual: string,
  expected: string,
): LabelDifference {
  const collapse = (s: string) => s.trim().replace(/\s+/g, " ");
  const equalIgnoringCase = actual.toLowerCase() === expected.toLowerCase();
  const equalIgnoringSpacing = collapse(actual) === collapse(expected);
  const foldEqual = collapse(actual).toLowerCase() === collapse(expected).toLowerCase();
  if (!foldEqual) return "other";
  if (equalIgnoringCase && !equalIgnoringSpacing) return "case";
  if (!equalIgnoringCase && equalIgnoringSpacing) return "spacing";
  if (!equalIgnoringCase && !equalIgnoringSpacing) return "case-and-spacing";
  // Both probes true: the raw strings were already identical.
  // `matchContactLabel` would have reported this as an exact match, not a
  // near miss, so this branch should be unreachable in production. Kept as a
  // defined, tested outcome rather than an assertion failure, since this
  // function's contract is total over any two strings, not just the ones the
  // job actually hands it.
  return "other";
}
