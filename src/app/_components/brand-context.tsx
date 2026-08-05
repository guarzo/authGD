"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Brand values for the two boundaries that cannot read config.
 *
 * `src/app/error.tsx` is a client component (App Router requires it) that
 * hoists its own `<title>` and renders `<SiteHeader>`. `AdminNav` is a client
 * component (it needs `usePathname()`) and renders `<SiteHeader>` on every
 * admin page. Neither can call `getConfig()`. A `NEXT_PUBLIC_` var would bake
 * the value at build time, which defeats configuration for anyone deploying a
 * prebuilt image, so the root layout reads config on the server and hands the
 * values down.
 *
 * `markUrl` is here and not just the two strings: both consumers render the
 * header, and without it a deployment that sets BRAND_MARK_URL would show its
 * own mark everywhere except the admin section and the error page.
 *
 * This is not the general route to brand config — server components take
 * `getConfig().brand` directly. It carries only what a client boundary needs.
 */
export type Brand = { name: string; tagline: string; markUrl: string };

const DEFAULT: Brand = {
  name: "authGD",
  tagline: "Auth",
  markUrl: "/brand/mark.webp",
};

const BrandContext = createContext<Brand>(DEFAULT);

export function BrandProvider({
  value,
  children,
}: {
  value: Brand;
  children: ReactNode;
}) {
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

/**
 * Falls back to the generic defaults rather than throwing when no provider is
 * above it. An error boundary is the worst place in the app to add a second
 * failure mode: a missing provider would replace the error page with a crash.
 */
export function useBrand(): Brand {
  return useContext(BrandContext);
}
