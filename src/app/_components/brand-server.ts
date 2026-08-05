import "server-only";
import { getConfig } from "@/config";

/**
 * `SiteHeader`'s three brand props, for server callers.
 *
 * Spread rather than passed one at a time: six pages render the header, and
 * three separate props at each is six chances to wire two of them and miss the
 * third — a failure that shows up as the generic name on one page only. One
 * spread means a new page either has branding or visibly has none.
 *
 * The two client callers (`error.tsx`, `admin-nav.tsx`) cannot use this — they
 * take the same values from `useBrand()`. See `brand-context.tsx`.
 */
export function brandProps() {
  const { brand } = getConfig();
  return {
    brandName: brand.name,
    brandTagline: brand.tagline,
    brandMarkUrl: brand.markUrl,
  };
}
