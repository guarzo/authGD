import profile from "./fleet-combat-v2-profile.json";

/** Frozen Unicode-16 log-source labels, not character identity validation.
 * Never use host ICU tables: Wingman must agree under Python 3.11/Unicode 14.
 */
const primary = profile.limits;
const effectOrder = Object.freeze([...profile.effect_order]);
const namedPerRow =
  effectOrder.filter((kind) => kind !== "NEUT").length * primary.named_per_tackle;
// One null bucket per kind, one row-activity key per row and one sample key.
const observationsPerRow = namedPerRow + effectOrder.length;
const associationsPerAttempt = primary.put_rows * (1 + observationsPerRow) + 1;

export const COMBAT_LIMITS = Object.freeze({
  ...primary,
  effect_order: effectOrder,
  effects_per_row: effectOrder.length,
  observations_per_tackle: primary.named_per_tackle + 1,
  named_per_row: namedPerRow,
  observations_per_row: observationsPerRow,
  associations_per_attempt: associationsPerAttempt,
  association_capacity:
    (Math.floor(primary.activity_ms / primary.signed_interval_ms) + 1) *
    associationsPerAttempt,
  receiver_capacity:
    Math.floor(
      (primary.activity_ms + primary.clock_error_ms + primary.request_elapsed_ms) /
        primary.signed_interval_ms,
    ) + 1,
});

const forbiddenRanges = profile.forbidden_ranges;
const trimScalars = new Set(profile.trim_scalars);
const decomposition: Readonly<Record<number, readonly number[]>> =
  profile.canonical_decomposition;
const combiningClass: Readonly<Record<number, number>> = profile.combining_class;
const composition: Readonly<Record<string, number>> = profile.composition;
const casefold: Readonly<Record<number, readonly number[]>> = profile.full_casefold;
const utf8 = new TextEncoder();

// UAX #15's algorithmic Hangul constants, not profile-specific combat limits.
const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

function forbidden(cp: number): boolean {
  let low = 0;
  let high = forbiddenRanges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const [start, end] = forbiddenRanges[middle];
    if (cp < start) high = middle;
    else if (cp > end) low = middle + 1;
    else return true;
  }
  return false;
}

function decompose(cp: number, output: number[]): void {
  const syllable = cp - S_BASE;
  if (syllable >= 0 && syllable < S_COUNT) {
    output.push(
      L_BASE + Math.floor(syllable / N_COUNT),
      V_BASE + Math.floor((syllable % N_COUNT) / T_COUNT),
    );
    const tail = syllable % T_COUNT;
    if (tail !== 0) output.push(T_BASE + tail);
  } else {
    const parts = decomposition[cp];
    if (parts) {
      for (const part of parts) decompose(part, output);
    } else output.push(cp);
  }
}

function compose(first: number, second: number): number | undefined {
  const lead = first - L_BASE;
  const vowel = second - V_BASE;
  if (lead >= 0 && lead < L_COUNT && vowel >= 0 && vowel < V_COUNT) {
    return S_BASE + (lead * V_COUNT + vowel) * T_COUNT;
  }
  const syllable = first - S_BASE;
  const tail = second - T_BASE;
  if (
    syllable >= 0 &&
    syllable < S_COUNT &&
    syllable % T_COUNT === 0 &&
    tail > 0 &&
    tail < T_COUNT
  ) {
    return first + tail;
  }
  // The frozen pair table already omits composition exclusions.
  return composition[`${first},${second}`];
}

function nfc(codepoints: readonly number[]): string {
  const decomposed: number[] = [];
  for (const cp of codepoints) decompose(cp, decomposed);
  // Stable canonical ordering: equal classes retain order, and no mark can
  // cross a starter (class zero). Input is bounded before any expansion.
  for (let index = 1; index < decomposed.length; index++) {
    const cp = decomposed[index];
    const combining = combiningClass[cp] ?? 0;
    if (combining !== 0) {
      let position = index;
      while (
        position > 0 &&
        (combiningClass[decomposed[position - 1]] ?? 0) > combining
      ) {
        decomposed[position] = decomposed[position - 1];
        position--;
      }
      decomposed[position] = cp;
    }
  }
  if (decomposed.length === 0) return "";
  const composed = [decomposed[0]];
  let starter = 0;
  let lastClass = combiningClass[decomposed[0]] ?? 0;
  for (let index = 1; index < decomposed.length; index++) {
    const cp = decomposed[index];
    const combining = combiningClass[cp] ?? 0;
    const composite =
      lastClass === 0 || lastClass < combining
        ? compose(composed[starter], cp)
        : undefined;
    if (composite !== undefined) {
      composed[starter] = composite;
      // A consumed mark does not block a subsequent composition.
    } else {
      if (combining === 0) starter = composed.length;
      composed.push(cp);
      lastClass = combining;
    }
  }
  return String.fromCodePoint(...composed);
}

/** Bound, reject unsafe raw input, trim only Zs, then frozen NFC.
 * Internal spaces are neither trimmed nor collapsed (NFC still applies).
 * Invalid external values return null, never a coerced or truncated identity.
 */
export function normalizeObservedName(value: unknown): string | null {
  // A scalar uses at most two UTF-16 code units. Refuse giant input before
  // allocating Array.from, then count real scalars rather than code units.
  if (
    typeof value !== "string" ||
    value.length > COMBAT_LIMITS.source_candidate_scalars * 2
  ) {
    return null;
  }
  const scalars = Array.from(value, (char) => char.codePointAt(0)!);
  if (scalars.length > COMBAT_LIMITS.source_candidate_scalars) return null;
  if (scalars.some((cp) => cp === 0x3c || cp === 0x3e || forbidden(cp))) return null;
  // Reject surrogates before TextEncoder could silently replace them.
  if (utf8.encode(value).length > COMBAT_LIMITS.source_candidate_utf8) return null;
  let start = 0;
  let end = scalars.length;
  while (start < end && trimScalars.has(scalars[start])) start++;
  while (end > start && trimScalars.has(scalars[end - 1])) end--;
  const normalized = nfc(scalars.slice(start, end));
  const length = Array.from(normalized).length;
  if (length < 1 || length > COMBAT_LIMITS.observed_name_scalars) return null;
  if (utf8.encode(normalized).length > COMBAT_LIMITS.observed_name_utf8) return null;
  return normalized;
}

/** True only for an already canonical, valid observed name on the wire. */
export function validateObservedName(value: unknown): value is string {
  return typeof value === "string" && normalizeObservedName(value) === value;
}

/** Full default casefold then NFC; noncanonical/invalid input returns null.
 * Keys are retention identities, not display names. Folding may expand beyond
 * the display limits; revalidating or truncating would lose valid identities.
 */
export function observedNameKey(value: unknown): string | null {
  if (!validateObservedName(value)) return null;
  const folded: number[] = [];
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    folded.push(...(casefold[cp] ?? [cp]));
  }
  return nfc(folded);
}
