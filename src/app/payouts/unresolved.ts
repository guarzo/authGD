import { DROPPED_LINE_CHARS, DROPPED_SAMPLE_LIMIT } from "./dropped";

/**
 * Unresolved roster names travel from `createOperationAction` to the detail
 * page's first render through the query string, the same way dropped loot
 * lines already do (see `./dropped`'s own docblock) — they are never
 * persisted as their own record, so the query string is the only channel.
 * This module is the roster half of that same shape: a second, independent
 * encode/decode pair rather than a change to `./dropped`'s, because a name has
 * no `reason` union to carry the way a dropped loot line does.
 *
 * The two caps are reused rather than re-invented — `DROPPED_SAMPLE_LIMIT` and
 * `DROPPED_LINE_CHARS` bound "how much of a paste can a query string carry" for
 * exactly the reason argued in `./dropped`, and a pasted roster is no
 * different a shape of problem than a pasted fleet comp.
 */

/** One unresolved report: an exact `total` (what the operator uses to decide
 *  whether to fix and re-paste) plus a `sample` bounded the same way a dropped
 *  loot report's is. */
export type UnresolvedReport = { total: number; sample: string[] };

export function encodeUnresolved(names: string[]): string {
  const report: UnresolvedReport = {
    total: names.length,
    sample: names
      .slice(0, DROPPED_SAMPLE_LIMIT)
      .map((n) => n.slice(0, DROPPED_LINE_CHARS)),
  };
  return Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
}

/** Null for anything this page cannot faithfully render — an absent param, a
 *  hand-typed one, a truncated one. Same rule `decodeDropped` follows: degrade
 *  to the plain page, never to an empty or half-filled notice. */
export function decodeUnresolved(raw: string | undefined): UnresolvedReport | null {
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
    .filter((n): n is string => typeof n === "string")
    .slice(0, DROPPED_SAMPLE_LIMIT)
    .map((n) => n.slice(0, DROPPED_LINE_CHARS));
  return { total, sample: clean };
}
