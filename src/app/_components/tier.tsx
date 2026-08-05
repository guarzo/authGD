import "server-only";
import { tierEnum } from "@/db/schema";
import { tierLabel } from "./labels";

/**
 * The tier enum's own value set, not re-typed here. `(string & {})` keeps the
 * union open: the audit log renders historic tier values straight from the
 * DB (`admin/accounts/page.tsx`'s audit rows), and those can outlive the enum
 * if a tier is ever renamed or retired, so this prop must still accept a
 * plain string rather than close on today's three tiers.
 */
export type TierName = (typeof tierEnum.enumValues)[number] | (string & {});

/**
 * `size="lead"` is for the one place a tier is the subject of the page rather
 * than a cell in a list. It buys hierarchy with size alone: the badge already
 * carries its tier's hue, so growing it spends no extra colour against
 * DESIGN.md's ration.
 *
 * Its own module rather than `_components/ui.tsx`: reading the configured
 * label makes this `server-only`, and `ui.tsx` is imported by two client
 * boundaries (`error.tsx`, `admin-nav.tsx`). `server-only` fails at module
 * resolution, so it would poison their bundles even though neither imports
 * `Tier` by name.
 */
export function Tier({
  tier,
  locked,
  size,
}: {
  tier: TierName;
  locked?: boolean;
  size?: "lead";
}) {
  const known =
    tier === "member" || tier === "associate" || tier === "alumni" || tier === "pending";
  // An unknown tier is a data problem, not an associate member: give it a neutral
  // badge rather than borrowing another tier's colour and asserting a lie.
  const tone = known ? `tier tier--${tier}` : "tier tier--unknown";
  return (
    <span className={size === "lead" ? `${tone} tier--lead` : tone}>
      {/* The label is display only — `tone` above and the CSS both key off the
          raw enum value, so a deployment naming its members "FlyGD" still gets
          .tier--member. */}
      {tierLabel(tier)}
      {locked && (
        <>
          {/* CSS-drawn, not the 🔒 emoji: a vendor glyph ignored --tone (a
              fourth uncommanded colour on the one badge that carries exactly
              one) and its advance width broke the mono column's tabular
              rhythm. .tier__lock::after draws in currentColor at the mono
              advance instead. */}
          <span className="tier__lock" aria-hidden="true" />
          <span className="visually-hidden">pinned by an admin</span>
        </>
      )}
    </span>
  );
}
