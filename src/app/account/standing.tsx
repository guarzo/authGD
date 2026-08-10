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
 * than a Notice: this renders inside a `.page__meta-item` flex line in the
 * page head, where a block-level callout would force its own row rather than
 * sit beside the badge, and DESIGN.md reserves warning colour for the admin
 * table. Nothing here reads as a fault (PRODUCT.md); the member has done
 * nothing wrong and is waiting on someone else.
 *
 * Alumni and associate get the same badge-plus-sentence treatment for the same
 * reason: both are the account's state AFTER standings and map access stop
 * being pushed (desired.ts targets `tier === "member"` only), and PRODUCT.md's
 * core promise — "derole, don't boot" — means that fact must not land as a
 * bare uppercase badge with no reassurance attached. Alumni is the system's own
 * call (tier.ts) and converges back to member on its own *when the tier machine
 * is reading the right character* — associate is admin-set and never
 * self-corrects. The two sentences say which is true, never the word
 * "demoted" and never that anything was "removed".
 *
 * `canFixMain` (core/main-fix.ts, via AccountView) overrides both the pending
 * and alumni sentences with one that names the actual, fixable problem: a
 * linked character is in the alliance and the account's main is not, so
 * `decideTier` (core/tier.ts) is reading the wrong character's affiliation.
 * Neither displaced sentence stays true in this state — pending's promised
 * review never arrives (`decideTier` returns `null` while the main is broken)
 * and alumni's "reverts on its own" never fires (nothing changes about the
 * main that would revert it) — so both are replaced rather than appended to.
 */
export function StandingTier({
  tier,
  canFixMain,
}: {
  tier: TierValue;
  canFixMain: boolean;
}) {
  // One sentence for both tiers: the member's situation is identical in
  // pending and alumni here (a linked alt is in-alliance, the main isn't), and
  // the remedy is identical too. Written against the effect (the main isn't
  // counted) rather than the three causes core/main-fix.ts distinguishes
  // (missing main, out-of-alliance main, stale affiliation read) — a member
  // can't tell those apart from here and doesn't need to. Points at the
  // self-service selector already on this page (page.tsx's per-row `make
  // main` action, gated only on `!c.isMain`) rather than an admin: the member
  // can fix this themselves in one press without leaving `/account`.
  const mainFix = (
    <span className="dim">
      One of your other characters is in the alliance, but it isn&rsquo;t set as your main
      — open that character below and press &ldquo;make main&rdquo;.
    </span>
  );
  if (tier === "pending") {
    return (
      <>
        {/* `Status` rather than `Tier` for the token's tone (see the doc
            comment), but the word is still a tier name, so it takes the
            configured label like every other one. */}
        <Status>{tierLabel("pending")}</Status>
        {canFixMain ? (
          mainFix
        ) : (
          <span className="dim">
            Your access is awaiting approval from an admin. Nothing is wrong — someone on
            the team will review your account.
          </span>
        )}
      </>
    );
  }
  if (tier === "alumni") {
    return (
      <>
        <Tier tier={tier} size="lead" />
        {canFixMain ? (
          mainFix
        ) : (
          <span className="dim">
            Your main isn&rsquo;t in the alliance right now, so standings and map access
            aren&rsquo;t pushed — your account, characters, and Discord link stay as they
            are, and this reverts on its own once that changes.
          </span>
        )}
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
