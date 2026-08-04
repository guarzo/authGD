export type ParsedLootLine = { name: string; qty: number };

/** A line the parser refused, and why, so the page can name what it ignored
 *  instead of the operator discovering it as a missing item later. */
export type DroppedLootLine = {
  line: string;
  reason: "zero-quantity" | "quantity-only" | "quantity-too-large";
};

export type LootPasteResult = { items: ParsedLootLine[]; dropped: DroppedLootLine[] };

/**
 * `lootItem.qty` is `bigint("qty", { mode: "number" })` (src/db/schema.ts), so
 * past 2^53 the quantity is already the wrong number in JavaScript before
 * Postgres ever sees it. This is a correctness bound, not a taste bound —
 * which is why it is this number and not a game-flavoured cap.
 */
export const MAX_LOOT_QTY = Number.MAX_SAFE_INTEGER;

/**
 * The largest line total, IN CENTS, that this system can compute exactly.
 *
 * Bounding `qty` is not enough. An appraised line total is `price * qty * 100`
 * evaluated in a float, and above 2^53 cents the representable values are 2,
 * then 4, then 16 cents apart — so `Math.round` returns a neighbouring cent
 * rather than the true one. Two ordinary market prices at ordinary mineral
 * quantities: 1000000.01 ISK x 1,000,000,000 units computes
 * 100000001000000000 where the exact product is 100000001000000001, and
 * 1234567.89 ISK x 900,000,000 units computes 111111110099999984 where the
 * exact product is 111111110099999991. Both fit `numeric(20, 2)` with room to
 * spare, so the column bound never sees them.
 *
 * At or below this bound every integer is representable, so the cent grid has
 * spacing one and `Math.round` returns the true cent total to within half of
 * one — the floor of doing the multiply in a float at all.
 *
 * It coincides numerically with `MAX_LOOT_QTY` because both fall out of 2^53,
 * but it is a different bound on a different quantity: that one counts units,
 * this one counts cents. Neither implies the other.
 */
export const MAX_EXACT_LINE_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * Checked BEFORE the `BigInt(Math.round(...))` conversion, because that
 * conversion launders a wrong number into an exact-looking one and there is no
 * later check that can tell.
 *
 * A sibling of `assertWithinMoneyRange` in `src/services/payout-loot.ts` — same
 * plain `Error`, same "<what> exceeds ..." sentence — rather than the same
 * function, because it bounds a different thing: that one bounds a bigint
 * against the `numeric(20, 2)` COLUMN, this one bounds a float against what
 * IEEE-754 multiplies exactly. `MAX_EXACT_LINE_CENTS` is roughly ten thousand
 * times smaller than `MAX_MONEY_CENTS`, so the column check can never fire
 * first and merging the two would silently widen this one.
 */
export function assertExactLineTotal(productCents: number, what: string): void {
  if (productCents > MAX_EXACT_LINE_CENTS) {
    throw new Error(`${what} exceeds the largest value this system can compute exactly`);
  }
}

// "12x Foo", "12 Foo" — qty (with optional comma grouping) leads the line.
const QTY_PREFIX = /^(\d[\d,]*)\s*x?\s+(.+)$/i;
// "Foo x12" — qty trails the line behind a literal "x".
const QTY_SUFFIX = /^(.+?)\s+x\s*(\d[\d,]*)$/i;
// "Foo, 12" — qty trails behind a comma.
const QTY_COMMA = /^(.+),\s*(\d[\d,]*)$/;
// "12", "1,234" — a line that is nothing but a quantity, with no item at all.
const QTY_ONLY = /^[\d,]+$/;

function parseQty(text: string): number {
  return Number(text.replace(/,/g, ""));
}

/**
 * Accepts the loot-paste shapes PayGD accepted: "12x Foo", "Foo x12",
 * tab-separated "Foo\t12", comma-separated "Foo, 12", and a bare name
 * (qty 1). Quantities may use comma grouping ("1,234"). Duplicate names
 * (exact string match, matching the source tool's dict-keyed behavior) sum
 * their quantities; order of first appearance is preserved.
 *
 * Junk is dropped rather than rejected — one bad line must not cost the
 * operator a 200-line paste — but it is REPORTED, so "N lines ignored" can be
 * shown next to the total. Blank lines are the exception: they are noise from
 * copying, not a mistake worth naming.
 */
export function parseLootPaste(raw: string): LootPasteResult {
  const totals = new Map<string, number>();
  const order: string[] = [];
  // Quantity problems are only knowable after summing, so a dropped item is
  // reported against the first line that introduced it.
  const firstLineByName = new Map<string, string>();
  const dropped: DroppedLootLine[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // A bare "12" used to be absorbed as an item literally NAMED "12", which
    // landed as a zero-priced unresolved row: a silent wrong answer rather
    // than an obvious mistake.
    if (QTY_ONLY.test(line)) {
      dropped.push({ line, reason: "quantity-only" });
      continue;
    }

    let qty = 1;
    let name = line;

    const prefixMatch = line.match(QTY_PREFIX);
    if (prefixMatch) {
      qty = parseQty(prefixMatch[1]);
      name = prefixMatch[2];
    } else {
      const suffixMatch = line.match(QTY_SUFFIX);
      if (suffixMatch) {
        name = suffixMatch[1];
        qty = parseQty(suffixMatch[2]);
      } else {
        const tabParts = line.split(/\t+/);
        // The SECOND field, never the last. EVE's inventory window copies more
        // than two tab-separated columns (Name / Qty / Est. Price, and wider
        // variants), so reading the last numeric field takes a price as the
        // quantity — "Tritanium\t100\t500,000" would parse as qty 500000 and
        // overvalue the line 5000x, silently, with no unresolved-item warning
        // to catch it. Column two is the quantity in every layout EVE emits.
        const secondTabPart = tabParts[1]?.trim() ?? "";
        if (tabParts.length >= 2 && /^[\d,]+$/.test(secondTabPart)) {
          qty = parseQty(secondTabPart);
          name = tabParts[0];
        } else {
          const commaMatch = line.match(QTY_COMMA);
          if (commaMatch) {
            name = commaMatch[1];
            qty = parseQty(commaMatch[2]);
          }
        }
      }
    }

    name = name.trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (!totals.has(name)) {
      order.push(name);
      firstLineByName.set(name, line);
    }
    totals.set(name, (totals.get(name) ?? 0) + qty);
  }

  const items: ParsedLootLine[] = [];
  for (const name of order) {
    const qty = totals.get(name)!;
    const line = firstLineByName.get(name)!;
    // "0x Foo" (and any name whose lines all sum to zero) is dropped rather
    // than rejected, matching this parser's lenience toward junk lines. A
    // qty-0 row would otherwise reach loot_item as a genuine value-carrying
    // line and die on the raw loot_item_qty_ck constraint.
    if (qty <= 0) {
      dropped.push({ line, reason: "zero-quantity" });
      continue;
    }
    // Checked on the SUM, which is >= every contributing line's quantity (the
    // regexes match digits only, so no quantity is ever negative). One check
    // therefore covers both a single absurd line and a run that adds up to
    // one. Today such a line dies downstream as a raw Postgres error.
    if (qty > MAX_LOOT_QTY) {
      dropped.push({ line, reason: "quantity-too-large" });
      continue;
    }
    items.push({ name, qty });
  }

  return { items, dropped };
}
