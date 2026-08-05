export type Tier = "pending" | "member" | "associate" | "alumni";

/**
 * Membership rule: unlocked accounts are system-managed — the desired tier is
 * member when the main is in the configured alliance, alumni otherwise (this is
 * how an unlocked associate converges after "return to auto"). Transitions
 * require a CONFIRMED affiliation read of the main in this run. A pending
 * account is held as-is until a confirmed alliance main promotes it to member;
 * it is never auto-converged to alumni. Returns the tier to set, or null for no
 * change.
 */
export function decideTier(input: {
  tier: Tier;
  tierLocked: boolean;
  mainConfirmed: boolean;
  mainInAlliance: boolean;
}): "member" | "alumni" | null {
  if (input.tierLocked || !input.mainConfirmed) return null;
  // A pending account is never moved by the system except to promote a
  // confirmed alliance member. Falling through to the desired-tier rule below
  // would hand it alumni — the automatic grant this state exists to withhold.
  if (input.tier === "pending" && !input.mainInAlliance) return null;
  const desired = input.mainInAlliance ? "member" : "alumni";
  return input.tier === desired ? null : desired;
}
