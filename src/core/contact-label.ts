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
