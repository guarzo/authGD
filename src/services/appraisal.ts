import type { createEsiClient } from "@/lib/esi/client";
import type { createTriffClient } from "@/lib/triff/client";
import { centsToIsk, iskToCents } from "@/core/payout-split";
import { parseLootPaste } from "@/core/loot-paste";
import { selectPrice, type PricingMode } from "@/core/pricing";

export type AppraisedItem = {
  typeId: number | null;
  name: string;
  qty: number;
  unitPrice: string; // "12.34"
  totalValue: string; // "1234.00"
  priceSource: "triff" | "unresolved";
};
export type AppraisalResult = { items: AppraisedItem[]; totalValue: string };

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
  const lines = parseLootPaste(raw);
  const idByLowerName = await deps.esi.resolveIds(lines.map((l) => l.name));
  const typeIds = [...new Set(idByLowerName.values())];
  const quotes = typeIds.length
    ? await deps.triff.quote(typeIds, {
        stationId: opts.stationId,
        regionId: opts.regionId,
      })
    : new Map<
        number,
        Awaited<ReturnType<typeof deps.triff.quote>> extends Map<number, infer V>
          ? V
          : never
      >();

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
    // What is left is IEEE-754's ~1.1e-16 RELATIVE error on the product —
    // under a cent for any line total below ~9e13 ISK, well inside
    // numeric(20,2).
    const totalCents = BigInt(Math.round(price * line.qty * 100));
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
  return { items, totalValue: centsToIsk(totalCents) };
}
