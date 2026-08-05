"use client";

import { usePathname } from "next/navigation";
import { useBrand } from "./brand-context";
import { SiteHeader } from "./ui";

// "Members", not "Accounts": the member nav links to this same route, so it
// must carry one name from either side (WCAG 3.2.4 Consistent Identification)
// — and that shared name cannot contain "account", because the member nav
// shows it directly beside "Your account". A pair reading "Your account |
// Accounts" is separated only by a possessive, which is not a distinction a
// reader should have to notice. "Members" names the same thing the page's own
// H1 does and collides with nothing.
const ITEMS = [
  { href: "/admin/accounts", label: "Members" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/sync", label: "Sync" },
  { href: "/account", label: "Your account" },
];

/**
 * One of several client components in the app (see also Scroller,
 * ConfirmSubmit, Submit...). This one needs the pathname to mark the active
 * admin tab with aria-current, which only a client component can read.
 */
export function AdminNav({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  // Being a client component, this cannot call getConfig() — the branding
  // comes down through the root layout's provider instead. Without it the
  // admin section would be the one place that ignores BRAND_*.
  const brand = useBrand();
  // ITEMS stays static: the badge is derived per render, so the array is
  // still a module constant and the label text still cannot drift.
  const items = ITEMS.map((i) =>
    i.href === "/admin/accounts" && pendingCount > 0
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
