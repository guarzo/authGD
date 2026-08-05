import { cache } from "react";
import { getDb } from "@/db";
import { countAccountsByTier } from "@/services/account-view";

/**
 * `countAccountsByTier(db, "pending")` deduplicated per request. The admin
 * LAYOUT needs it for the nav badge and /admin/accounts needs it again for its
 * banner; a layout and its page render in one request, so `cache` collapses
 * them to a single query. Same idiom as src/app/payouts/[id]/page.tsx.
 *
 * No index is added for it. `tier` is a four-value enum on a table holding one
 * row per corp member, and Postgres scans a table that small either way.
 */
export const countPendingCached = cache(async (): Promise<number> =>
  countAccountsByTier(getDb(), "pending"),
);
