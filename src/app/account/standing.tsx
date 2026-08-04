import { Status, Tier } from "@/app/_components/ui";
import type { Tier as TierValue } from "@/core/tier";

/**
 * The Standing row's tier value. Extracted from page.tsx as its own module so
 * it can be rendered in a unit test without a database, matching
 * account/contact-state.tsx.
 *
 * Pending gets cryo's treatment — a neutral token plus a dim sentence — rather
 * than a Notice: this renders inside the `.facts` grid's dd, where a block-level
 * callout would break the two-column tracks, and DESIGN.md reserves warning
 * colour for the admin table. Nothing here reads as a fault (PRODUCT.md); the
 * member has done nothing wrong and is waiting on someone else.
 */
export function StandingTier({ tier }: { tier: TierValue }) {
  if (tier === "pending") {
    return (
      <>
        <Status>pending</Status>
        <span className="dim">
          Your access is awaiting approval from an admin. Nothing is wrong — someone on
          the team will review your account.
        </span>
      </>
    );
  }
  return <Tier tier={tier} size="lead" />;
}
