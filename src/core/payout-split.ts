/**
 * ISK-cent arithmetic for the fight-payout split. Native bigint, no decimal
 * library: the split needs only +, -, x, and floor division, which bigint
 * does exactly. Drizzle returns numeric(20,2) as a string, so this module is
 * the only place strings become bigint cents and back.
 */

/** Parses a decimal ISK string (up to 2dp) into integer cents. */
export function iskToCents(value: string): bigint {
  const m = /^-?\d+(\.\d{1,2})?$/.exec(value.trim());
  if (!m) throw new Error(`not a valid ISK amount: ${value}`);
  const negative = value.trim().startsWith("-");
  const abs = negative ? value.trim().slice(1) : value.trim();
  const [whole, frac = ""] = abs.split(".");
  const paddedFrac = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(paddedFrac);
  return negative ? -cents : cents;
}

/** Formats integer cents back into a 2dp decimal string, e.g. "1234.56". */
export function centsToIsk(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const sign = negative && abs !== 0n ? "-" : "";
  return `${sign}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

/**
 * The largest value `numeric(20,2)` holds: 20 significant digits with 2 after
 * the point leaves 18 integer digits, so 999999999999999999.99 — which is
 * 10^20 - 1 in cents. Callers computing a money value (a line total, a pool
 * total) compare against this before it reaches the column, so an overflow is
 * a readable message rather than a raw Postgres numeric-field-overflow.
 */
export const MAX_MONEY_CENTS = 10n ** 20n - 1n;

export type SplitParticipant = { id: string; shares: string; excluded: boolean };

export type SplitResult = {
  corpAmountCents: bigint;
  amounts: Map<string, bigint>;
};

export function computeSplit(input: {
  totalCents: bigint;
  corpSharePct: string;
  participants: SplitParticipant[];
}): SplitResult {
  // Defence in depth: the DB check constraints catch both of these at persist
  // time, but only after this function has already produced a plausible-looking
  // split from them, and only as an unreadable Postgres error.
  if (input.totalCents < 0n) {
    throw new Error(`total cannot be negative: ${centsToIsk(input.totalCents)}`);
  }
  const pctBp = iskToCents(input.corpSharePct); // "10.00" -> 1000n basis points
  if (pctBp < 0n || pctBp > 10000n) {
    throw new Error(`corp share must be between 0 and 100: ${input.corpSharePct}`);
  }
  const corpBase = (input.totalCents * pctBp) / 10000n;
  const pool = input.totalCents - corpBase;

  const included = input.participants.filter((p) => !p.excluded);
  const sharesH = new Map(included.map((p) => [p.id, iskToCents(p.shares)]));
  const totalSharesH = [...sharesH.values()].reduce((sum, s) => sum + s, 0n);

  const perShare = totalSharesH === 0n ? 0n : (pool * 100n) / totalSharesH;

  const amounts = new Map<string, bigint>();
  let distributed = 0n;
  for (const p of included) {
    const amount = (perShare * (sharesH.get(p.id) ?? 0n)) / 100n;
    amounts.set(p.id, amount);
    distributed += amount;
  }

  const corpAmountCents = corpBase + (pool - distributed);
  return { corpAmountCents, amounts };
}
