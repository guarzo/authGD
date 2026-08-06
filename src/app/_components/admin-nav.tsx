"use client";

import { usePathname } from "next/navigation";
import { useBrand } from "./brand-context";
import { MEMBERS_HREF, navFor } from "./nav-items";
import { SiteHeader } from "./ui";

/**
 * One of several client components in the app (see also Scroller,
 * ConfirmSubmit, Submit...). This one needs the pathname to mark the active
 * admin tab with aria-current, which only a client component can read.
 */
export function AdminNav({
  pendingCount,
  canReadPayouts,
}: {
  pendingCount: number;
  canReadPayouts: boolean;
}) {
  const pathname = usePathname();
  // Being a client component, this cannot call getConfig() — the branding
  // comes down through the root layout's provider instead. Without it the
  // admin section would be the one place that ignores BRAND_*.
  const brand = useBrand();
  // `isAdmin: true` because AdminNav renders only inside admin/layout.tsx,
  // which already ran requireAdminPage. `canReadPayouts` is a real bit read
  // from the account row, not assumed from isAdmin — see nav-items.ts for why
  // those two are orthogonal.
  const items = navFor({ canReadPayouts, isAdmin: true }).map((i) =>
    i.href === MEMBERS_HREF && pendingCount > 0
      ? { ...i, badge: { count: pendingCount, description: "awaiting approval" } }
      : i,
  );
  return (
    <SiteHeader
      items={items}
      current={pathname}
      admin
      brandName={brand.name}
      brandTagline={brand.tagline}
      brandMarkUrl={brand.markUrl}
    />
  );
}
