/**
 * Groups a `numeric(20,2)` money string for display: `"4821430000.00"` reads
 * `"4,821,430,000.00"`.
 *
 * Six sites render `centsToIsk()` (`src/core/payout-split.ts:21-28`) raw, where
 * ten to twelve unbroken digits make `999999999.00` and `1000000000.00` nearly
 * identical glyph runs — and left-aligned, the larger of the two is the shorter
 * one on the right. Grouping is the whole of the fix; the column still wants
 * `.num` for the alignment half.
 *
 * It works on the string and never on a number. These values run to
 * `MAX_MONEY_CENTS` (10^20 - 1), far past 2^53, so `Number("99999999999999999999.99")`
 * silently rounds and would render an ISK figure that is not the one in the
 * database. The trailing `.00` is deliberately kept: every value in a column is
 * formatted the same way, and dropping the fraction only on whole amounts would
 * ragged the decimal point of the one column that most needs it lined up.
 *
 * Input is trusted to be the decimal form Postgres returns for `numeric` — an
 * optional sign, digits, and at most one `.`. Anything else is passed through
 * unchanged rather than mangled, on the grounds that a formatter is the wrong
 * place to discover a malformed amount.
 */
export function fmtIsk(value: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(value);
  if (!m) return value;
  const [, sign, whole, fraction = ""] = m;
  return `${sign}${whole.replace(/\B(?=(\d{3})+$)/g, ",")}${fraction}`;
}
