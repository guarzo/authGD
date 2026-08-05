import { AdminNav } from "@/app/_components/admin-nav";
import { requireAdminPage } from "@/lib/admin-guard";
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
  await requireAdminPage();
  const pendingCount = await countPendingCached();
  return (
    <>
      <AdminNav pendingCount={pendingCount} />
      {children}
    </>
  );
}
