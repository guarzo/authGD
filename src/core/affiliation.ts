import { chunk } from "@/core/chunk";
import { EsiError, type Affiliation } from "@/lib/esi/client";

export type AffiliationOutcome = {
  resolved: Map<number, { corporationId: number; allianceId: number | null }>;
  /** Deterministic 400 on a single id — safe to flag affiliation_invalid. */
  invalid: number[];
  /** Transient or ambiguous failures — never flagged, retried next run. */
  unresolved: number[];
};

const CHUNK_SIZE = 500;

export async function resolveAffiliations(
  ids: number[],
  post: (ids: number[]) => Promise<Affiliation[]>,
): Promise<AffiliationOutcome> {
  const out: AffiliationOutcome = { resolved: new Map(), invalid: [], unresolved: [] };
  for (const batch of chunk(ids, CHUNK_SIZE)) {
    await resolveChunk(batch, post, out);
  }
  return out;
}

async function resolveChunk(
  ids: number[],
  post: (ids: number[]) => Promise<Affiliation[]>,
  out: AffiliationOutcome,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const rows = await post(ids);
    const returned = new Set<number>();
    for (const r of rows) {
      returned.add(r.characterId);
      out.resolved.set(r.characterId, {
        corporationId: r.corporationId,
        allianceId: r.allianceId,
      });
    }
    for (const id of ids) if (!returned.has(id)) out.unresolved.push(id);
  } catch (err) {
    // Bisect ONLY deterministic invalid-request responses. Anything else
    // (420/5xx/network, or odd permanent statuses) must never flag characters.
    if (err instanceof EsiError && err.status === 400) {
      if (ids.length === 1) {
        out.invalid.push(ids[0]);
        return;
      }
      const mid = Math.ceil(ids.length / 2);
      await resolveChunk(ids.slice(0, mid), post, out);
      await resolveChunk(ids.slice(mid), post, out);
      return;
    }
    out.unresolved.push(...ids);
  }
}
