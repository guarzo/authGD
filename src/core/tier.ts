export type Tier = "pending" | "flygd" | "blue" | "green";

/**
 * Membership rule: unlocked accounts are system-managed — the desired tier is
 * flygd when the main is in the configured alliance, green otherwise (this is
 * how an unlocked Blue converges after "return to auto"). Transitions require
 * a CONFIRMED affiliation read of the main in this run. Returns the tier to
 * set, or null for no change.
 */
export function decideTier(input: {
  tier: Tier;
  tierLocked: boolean;
  mainConfirmed: boolean;
  mainInAlliance: boolean;
}): "flygd" | "green" | null {
  if (input.tierLocked || !input.mainConfirmed) return null;
  const desired = input.mainInAlliance ? "flygd" : "green";
  return input.tier === desired ? null : desired;
}
