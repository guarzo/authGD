"use client";

import { usePathname } from "next/navigation";
import { SiteHeader } from "./ui";

const ITEMS = [
  { key: "/admin/accounts", href: "/admin/accounts", label: "Accounts" },
  { key: "/admin/audit", href: "/admin/audit", label: "Audit log" },
  { key: "/admin/sync", href: "/admin/sync", label: "Sync" },
  { key: "/account", href: "/account", label: "Your account" },
];

/**
 * The one client component in the app. It exists only so the active admin tab
 * can be marked with aria-current, which needs the pathname.
 */
export function AdminNav() {
  const pathname = usePathname();
  return <SiteHeader items={ITEMS} current={pathname} />;
}
