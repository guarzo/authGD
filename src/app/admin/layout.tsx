import { AdminNav } from "@/app/_components/admin-nav";
import { getDb } from "@/db";
import { requireAdminPage } from "@/lib/admin-guard";
import { canReadPayouts } from "@/services/payouts";
import { countPendingCached } from "./pending-count";

/**
 * Guarded here as well as in each page, not instead of it. A layout is the
 * only thing that sees a route the moment it exists, so this is what covers
 * the admin page someone adds next and forgets to gate. It cannot replace the
 * per-page calls: layouts do not re-run on soft navigation, so a client-side
 * transition between two admin routes would skip this entirely, and server
 * actions never reach a layout at all — hence requireAdminAction.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAdminPage();
  // Same prop-drilling shape pendingCount already used, extended by one bit:
  // isAdmin is proven by requireAdminPage itself, but canReadPayouts is a
  // second, independent fact (tier === "member") that this layout has to look
  // up separately — see nav-items.ts for why the two cannot be inferred from
  // each other. Run alongside pendingCount rather than after it: neither
  // depends on the other's result.
  //
  // Staleness is bounded the same way the badge's already is, and by the same
  // mechanism: the tier writes live in admin/accounts/actions.ts, and every
  // one of them calls `revalidatePath("/admin/accounts")`, which re-runs this
  // layout rather than only the page under it — measured, not assumed, at
  // e2e/shell.spec.ts:384, where the badge changes without a document load.
  // So an admin who edits a tier through the roster gets both bits recomputed
  // together. The remaining window is a tier changed by a worker sync run,
  // which revalidates nothing: until the next full load this bar can be one
  // tier behind in either direction — a demoted admin keeps a Payouts link
  // that redirects them to /account when followed. That is the pre-existing
  // cost of reading a bit in a layout, the same one the badge pays, and the
  // failed click lands where the missing link would have sent them anyway.
  const [pendingCount, payoutsReader] = await Promise.all([
    countPendingCached(),
    canReadPayouts(getDb(), ctx.accountId),
  ]);
  return (
    <>
      <AdminNav pendingCount={pendingCount} canReadPayouts={payoutsReader} />
      {children}
    </>
  );
}
