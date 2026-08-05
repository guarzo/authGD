export type PricingMode = "sell_best" | "sell_p05" | "buy_best" | "buy_p05";

export type QuoteSides = {
  sell: { best: number | null; p05: number | null };
  buy: { best: number | null; p05: number | null };
};

/**
 * Mirrors PayGD's choose_price: pick the requested side/field, and if a p05
 * request comes back null fall back to that side's best (triff sometimes has
 * too few orders to compute a percentile). A missing "best" has nothing left
 * to fall back to and stays null — callers turn that into an unresolved item,
 * never a silently smaller total.
 */
export function selectPrice(q: QuoteSides | undefined, mode: PricingMode): number | null {
  if (!q) return null;
  const side = mode.startsWith("sell") ? q.sell : q.buy;
  const field = mode.endsWith("p05") ? "p05" : "best";
  const primary = side[field];
  if (primary !== null) return primary;
  if (field === "p05") return side.best;
  return null;
}
