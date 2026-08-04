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
    ? await deps.triff.quote(typeIds, { stationId: opts.stationId, regionId: opts.regionId })
    : new Map<number, Awaited<ReturnType<typeof deps.triff.quote>> extends Map<number, infer V> ? V : never>();

  const items: AppraisedItem[] = lines.map((line) => {
    const typeId = idByLowerName.get(line.name.toLowerCase()) ?? null;
    const price = typeId !== null ? selectPrice(quotes.get(typeId), opts.pricingMode) : null;
    if (typeId === null || price === null) {
      return {
        typeId,
        name: line.name,
        qty: line.qty,
        priceSource: "unresolved",
        ...ZERO_PRICE,
      };
    }
    const unitCents = iskToCents(price.toFixed(2));
    const totalCents = unitCents * BigInt(line.qty);
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
