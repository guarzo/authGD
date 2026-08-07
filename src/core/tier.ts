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

/**
 * What pressing "make main" for one candidate character would do to the
 * account's tier, stated honestly rather than as a blanket warning —
 * `/account`'s sweep item #6. Reuses `decideTier` rather than re-deriving the
 * state machine: the membership job (`jobs/membership.ts`) is the only other
 * caller of that rule, and a second copy here would drift the moment either
 * changed.
 *
 * `allianceId` is the candidate's own LAST-CACHED affiliation
 * (`character.allianceId`), written by the membership job, not a live ESI
 * read — the web tier never calls ESI directly (see the repo's web-tier
 * guardrail). `null` means the job has never resolved this character at all,
 * which is exactly the freshest-alt case the sweep item describes: a member
 * links an alt and presses "make main" before any job has run against it. That
 * is reported as `"unknown"` rather than folded into "no change", because
 * `decideTier`'s own `!mainConfirmed` branch answers "not confirmed THIS RUN"
 * — true of every account between job runs — and would silently claim "no
 * consequence" for the one candidate this preview most needs to flag.
 *
 * An already-locked account never returns `"change"`: `decideTier` would
 * refuse the same account for the same reason (`tierLocked` short-circuits
 * it), so nothing "make main" does here can move an account the membership
 * job has already stopped touching.
 */
export type MainChangePreview =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "change"; nextTier: "member" | "alumni" };

export function previewMainChange(input: {
  tier: Tier;
  tierLocked: boolean;
  allianceId: number | null;
  configuredAllianceId: number;
}): MainChangePreview {
  if (input.tierLocked) return { kind: "none" };
  if (input.allianceId === null) return { kind: "unknown" };
  const next = decideTier({
    tier: input.tier,
    tierLocked: false,
    mainConfirmed: true,
    mainInAlliance: input.allianceId === input.configuredAllianceId,
  });
  return next === null ? { kind: "none" } : { kind: "change", nextTier: next };
}
