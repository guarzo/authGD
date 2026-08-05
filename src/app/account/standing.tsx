import { Status } from "@/app/_components/ui";
import { Tier } from "@/app/_components/tier";
import { tierLabel } from "@/app/_components/labels";
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
 *
 * Alumni and associate get the same badge-plus-sentence treatment for the same
 * reason: both are the account's state AFTER standings and map access stop
 * being pushed (desired.ts targets `tier === "member"` only), and PRODUCT.md's
 * core promise — "derole, don't boot" — means that fact must not land as a
 * bare uppercase badge with no reassurance attached. Alumni is the system's own
 * call (tier.ts) and converges back to member on its own; associate is
 * admin-set and does not self-correct. The two sentences say which is true,
 * never the word "demoted" and never that anything was "removed".
 */
export function StandingTier({ tier }: { tier: TierValue }) {
  if (tier === "pending") {
    return (
      <>
        {/* `Status` rather than `Tier` for the token's tone (see the doc
            comment), but the word is still a tier name, so it takes the
            configured label like every other one. */}
        <Status>{tierLabel("pending")}</Status>
        <span className="dim">
          Your access is awaiting approval from an admin. Nothing is wrong — someone on
          the team will review your account.
        </span>
      </>
    );
  }
  if (tier === "alumni") {
    return (
      <>
        <Tier tier={tier} size="lead" />
        <span className="dim">
          Your main isn&rsquo;t in the alliance right now, so standings and map access
          aren&rsquo;t pushed — your account, characters, and Discord link stay as they
          are, and this reverts on its own once that changes.
        </span>
      </>
    );
  }
  if (tier === "associate") {
    return (
      <>
        <Tier tier={tier} size="lead" />
        <span className="dim">
          An admin set this — standings and map access aren&rsquo;t pushed at this tier,
          but your account, characters, and Discord link stay as they are.
        </span>
      </>
    );
  }
  return <Tier tier={tier} size="lead" />;
}
