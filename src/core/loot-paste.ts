export type ParsedLootLine = { name: string; qty: number };

// "12x Foo", "12 Foo" — qty (with optional comma grouping) leads the line.
const QTY_PREFIX = /^(\d[\d,]*)\s*x?\s+(.+)$/i;
// "Foo x12" — qty trails the line behind a literal "x".
const QTY_SUFFIX = /^(.+?)\s+x\s*(\d[\d,]*)$/i;
// "Foo, 12" — qty trails behind a comma.
const QTY_COMMA = /^(.+),\s*(\d[\d,]*)$/;

function parseQty(text: string): number {
  return Number(text.replace(/,/g, ""));
}

/**
 * Accepts the loot-paste shapes PayGD accepted: "12x Foo", "Foo x12",
 * tab-separated "Foo\t12", comma-separated "Foo, 12", and a bare name
 * (qty 1). Quantities may use comma grouping ("1,234"). Duplicate names
 * (exact string match, matching the source tool's dict-keyed behavior) sum
 * their quantities; order of first appearance is preserved.
 */
export function parseLootPaste(raw: string): ParsedLootLine[] {
  const totals = new Map<string, number>();
  const order: string[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

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
        const lastTabPart = tabParts[tabParts.length - 1].trim();
        if (tabParts.length >= 2 && /^[\d,]+$/.test(lastTabPart)) {
          qty = parseQty(lastTabPart);
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
    if (!totals.has(name)) order.push(name);
    totals.set(name, (totals.get(name) ?? 0) + qty);
  }

  return order.map((name) => ({ name, qty: totals.get(name)! }));
}
