export type Tier = "pending" | "flygd" | "blue" | "green";

/**
 * Membership rule: unlocked accounts are system-managed — the desired tier is
 * flygd when the main is in the configured alliance, green otherwise (this is
 * how an unlocked Blue converges after "return to auto"). Transitions require
 * a CONFIRMED affiliation read of the main in this run. A pending account is
 * held as-is until a confirmed alliance main promotes it to flygd; it is
 * never auto-converged to green. Returns the tier to set, or null for no
 * change.
 */
export function decideTier(input: {
  tier: Tier;
  tierLocked: boolean;
  mainConfirmed: boolean;
  mainInAlliance: boolean;
}): "flygd" | "green" | null {
  if (input.tierLocked || !input.mainConfirmed) return null;
  // A pending account is never moved by the system except to promote a
  // confirmed alliance member. Falling through to the desired-tier rule below
  // would hand it green — the automatic grant this state exists to withhold.
  if (input.tier === "pending" && !input.mainInAlliance) return null;
  const desired = input.mainInAlliance ? "flygd" : "green";
  return input.tier === desired ? null : desired;
}
