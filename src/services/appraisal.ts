import type { createEsiClient } from "@/lib/esi/client";
import type { createTriffClient, TriffQuote } from "@/lib/triff/client";
import { centsToIsk, iskToCents } from "@/core/payout-split";
import {
  assertExactLineTotal,
  lineTotalCents,
  parseLootPaste,
  type DroppedLootLine,
} from "@/core/loot-paste";
import { selectPrice, type PricingMode } from "@/core/pricing";

export type AppraisedItem = {
  typeId: number | null;
  name: string;
  qty: number;
  unitPrice: string; // "12.34"
  totalValue: string; // "1234.00"
  priceSource: "triff" | "unresolved";
};
export type AppraisalResult = {
  items: AppraisedItem[];
  totalValue: string;
  /** Lines the parser refused. Carried, never persisted: the pool total comes
   *  from `items` alone, and the form names these back to the operator. */
  dropped: DroppedLootLine[];
};

const ZERO_PRICE = { unitPrice: "0.00", totalValue: "0.00" } as const;

/**
 * Orchestrates esi.resolveIds -> triff.quote -> parseLootPaste -> selectPrice.
 * No database access (contract: appraisal is a pure orchestration layer over
 * two injected clients so it can run interactively, see design doc "An
 * architectural exception, stated plainly"). An item with no type id, or a
 * type id with no price for the chosen mode, becomes `priceSource:
 * "unresolved"` at "0.00" — it is NEVER dropped from `items`, only from the
 * money side of the total.
 */
export async function appraiseLoot(
  raw: string,
  opts: { pricingMode: PricingMode; stationId?: number; regionId?: number },
  deps: {
    esi: Pick<ReturnType<typeof createEsiClient>, "resolveIds">;
    triff: ReturnType<typeof createTriffClient>;
  },
): Promise<AppraisalResult> {
  const { items: lines, dropped } = parseLootPaste(raw);
  const idByLowerName = await deps.esi.resolveIds(lines.map((l) => l.name));
  const typeIds = [...new Set(idByLowerName.values())];
  const quotes = typeIds.length
    ? await deps.triff.quote(typeIds, {
        stationId: opts.stationId,
        regionId: opts.regionId,
      })
    : new Map<number, TriffQuote>();

  const items: AppraisedItem[] = lines.map((line) => {
    const typeId = idByLowerName.get(line.name.toLowerCase()) ?? null;
    const price =
      typeId !== null ? selectPrice(quotes.get(typeId), opts.pricingMode) : null;
    if (typeId === null || price === null) {
      return {
        typeId,
        name: line.name,
        qty: line.qty,
        priceSource: "unresolved",
        ...ZERO_PRICE,
      };
    }
    // Round ONCE, at the line total. Rounding the per-unit price to cents
    // first commits the error per unit and then multiplies it by qty, so it
    // scales with quantity instead of staying bounded at half a cent per
    // line: 5.005 ISK x 2,000,000,000 units loses 10,000,000 ISK, and
    // 0.004 ISK x 10,000,000 units stores 0.00 for a line genuinely worth
    // 40,000 ISK. p05 is an interpolated percentile, so sub-cent and
    // half-cent unit prices are ordinary, not hypothetical.
    // What is left is IEEE-754's ~1.1e-16 RELATIVE error on the product, and
    // bounding qty does NOT remove it: at 1e17 cents the representable values
    // are 16 cents apart, so 1000000.01 ISK x 1,000,000,000 units rounds a
    // cent low. Bounding the PRODUCT does not remove it either — that only
    // makes the answer representable, not correct: 48804.84 ISK x
    // 1,845,177,173 units is under MAX_EXACT_LINE_CENTS and still computed a
    // cent low in a float. So the multiply itself is done in bigint, over the
    // price's decimal expansion, and the bound below is what it says it is: a
    // ceiling on a single line, refused by name rather than stored wrong.
    const productCents = price * line.qty * 100;
    assertExactLineTotal(productCents, `the line total for ${line.name}`);
    const totalCents = lineTotalCents(price, line.qty);
    // The stored unit price stays 2dp because that is the column's type. It
    // is a DISPLAY value: unitPrice * qty deliberately need not equal
    // totalValue, and for a sub-cent price it will not. A row where
    // unitPrice is "0.00" while totalValue is not is exactly that case, and
    // the detail page marks it rather than showing a bare 0.00 — derivable
    // from the persisted row, so no column and no migration are needed.
    const unitCents = iskToCents(price.toFixed(2));
    return {
      typeId,
      name: line.name,
      qty: line.qty,
      unitPrice: centsToIsk(unitCents),
      totalValue: centsToIsk(totalCents),
      priceSource: "triff",
    };
  });

  const totalCents = items.reduce((sum, it) => sum + iskToCents(it.totalValue), 0n);
  return { items, totalValue: centsToIsk(totalCents), dropped };
}
