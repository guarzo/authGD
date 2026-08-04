/**
 * Splits the real fleet-composition paste ("A / B / C") or a newline-per-name
 * paste into names. Empty segments from doubled separators or stray
 * whitespace are dropped. Dedupe is case-insensitive but the first spelling
 * seen is kept, because that's the one the FC actually typed.
 */
export function parseRosterPaste(raw: string): string[] {
  const seen = new Map<string, string>(); // lowercase key -> first spelling
  const order: string[] = [];
  for (const segment of raw.split(/[/\n]+/)) {
    const name = segment.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, name);
      order.push(key);
    }
  }
  return order.map((key) => seen.get(key)!);
}
