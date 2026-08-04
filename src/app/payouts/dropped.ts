import type { DroppedLootLine } from "@/core/loot-paste";

/**
 * Dropped paste lines travel from `addAppraisedPoolAction` to the next render
 * of the detail page through the query string, because they are deliberately
 * never persisted (see the phase-2 design, defect 3). This module is the only
 * place that encoding is written or read, so the two halves cannot drift.
 *
 * base64url rather than raw JSON: the payload is operator-pasted text, and
 * base64url's alphabet is already URL-safe, so nothing here depends on a
 * caller remembering to percent-encode it.
 */

/** How many dropped lines are named in the notice. A query string is not a
 *  transport for arbitrary volume — past this the notice names the first
 *  `DROPPED_SAMPLE_LIMIT` and says how many more there were. The *count* is
 *  always exact, because that is the number an operator uses to decide
 *  whether to re-paste. */
export const DROPPED_SAMPLE_LIMIT = 20;

/** Longest single line carried. A pasted inventory row is well under this;
 *  anything longer is already unreadable in a notice. */
export const DROPPED_LINE_CHARS = 120;

/** Why each item was ignored, in words an operator can act on. Worded for the
 *  per-ITEM semantics of `parseLootPaste`, which sums quantities by name before
 *  it decides: "added up to" is not padding, it is the difference between a
 *  true sentence and a false one when the same item appeared on several lines.
 *  Typed as a total `Record` over the union, so adding a reason in
 *  `@/core/loot-paste` fails the build here rather than rendering a bare enum
 *  value. */
export const DROPPED_REASONS: Record<DroppedLootLine["reason"], string> = {
  "zero-quantity": "quantity added up to 0",
  "quantity-only": "just a number, with no item name",
  "quantity-too-large": "quantity added up past what can be recorded exactly",
};

/** One dropped ITEM, quoting the first raw line that introduced it — never a
 *  raw line count. See `DROPPED_REASONS`. */
export type DroppedReport = { total: number; sample: DroppedLootLine[] };

export function encodeDropped(dropped: DroppedLootLine[]): string {
  const report: DroppedReport = {
    total: dropped.length,
    sample: dropped.slice(0, DROPPED_SAMPLE_LIMIT).map((d) => ({
      line: d.line.slice(0, DROPPED_LINE_CHARS),
      reason: d.reason,
    })),
  };
  return Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
}

/**
 * Null for anything this page cannot faithfully render — an absent param, a
 * hand-typed one, a truncated one. Same rule the `ERRORS` map follows for an
 * unrecognized `?error=` code: degrade to the plain page, never to an empty
 * or half-filled notice.
 */
export function decodeDropped(raw: string | undefined): DroppedReport | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { total, sample } = parsed as { total?: unknown; sample?: unknown };
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return null;
  if (!Array.isArray(sample)) return null;
  const clean = sample
    .filter(
      (d): d is DroppedLootLine =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as { line?: unknown }).line === "string" &&
        typeof (d as { reason?: unknown }).reason === "string" &&
        // `Object.hasOwn`, not `in`: this string comes off the query param, and
        // `in` walks the prototype chain, so "constructor" and "toString" pass
        // an `in` check and then render whatever `DROPPED_REASONS[reason]`
        // resolves to on Object.prototype.
        Object.hasOwn(DROPPED_REASONS, (d as { reason: string }).reason),
    )
    .slice(0, DROPPED_SAMPLE_LIMIT)
    .map((d) => ({ line: d.line.slice(0, DROPPED_LINE_CHARS), reason: d.reason }));
  return { total, sample: clean };
}
