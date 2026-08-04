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

export type SplitParticipant = { id: string; shares: string; excluded: boolean };

export type SplitResult = {
  corpAmountCents: bigint;
  perShareCents: bigint;
  amounts: Map<string, bigint>;
};

export function computeSplit(input: {
  totalCents: bigint;
  corpSharePct: string;
  participants: SplitParticipant[];
}): SplitResult {
  const pctBp = iskToCents(input.corpSharePct); // "10.00" -> 1000n basis points
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
  return { corpAmountCents, perShareCents: perShare, amounts };
}
