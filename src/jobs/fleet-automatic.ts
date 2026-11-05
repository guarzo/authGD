import type {
  AutomaticAuthLossProof,
  AutomaticBound,
  AutomaticClaim,
  AutomaticRetryFailure,
  AutomaticToken,
  AutomaticTask,
  AutomaticVerified,
} from "@/core/fleet-automatic";
import {
  deriveFleetCacheWindow,
  deriveFleetEvidenceWindow,
  deriveFleetPacingBoundary,
} from "@/core/fleet-freshness";
import {
  bindFleetAutomaticDiscovery,
  claimFleetAutomaticDiscovery,
  commitFleetAutomaticDiscovery,
  settleFleetAutomaticAuthorizationLoss,
  settleFleetAutomaticDiscovery,
} from "@/services/fleet-automatic";
import { FleetLinkSnapshotOverflow } from "@/services/fleet-source-observation";
import {
  createFleetUpstream,
  FleetTokenRejection,
  remember,
  type FleetSourceDeps,
} from "./fleet-upstream";

export type FleetAutomaticAttempt =
  | {
      readonly result: "UNCOMMITTED";
      readonly bound: AutomaticBound;
      readonly verified: AutomaticVerified;
    }
  | { readonly result: "suspended" | "fenced" | "settled" };

/** The queue callback owns claim, upstream, and final commit as one original
 * promise. In particular, UNCOMMITTED is never a successful queue completion. */
export async function runFleetAutomaticJob(
  deps: FleetSourceDeps,
  task: AutomaticTask,
): Promise<void> {
  try {
    if (deps.signal?.aborted) return;
    const claim = await claimFleetAutomaticDiscovery(deps.db, task, deps.now);
    if (!claim) return;
    const result = await attemptClaimedFleetAutomaticDiscovery(deps, claim);
    if (result.result === "UNCOMMITTED")
      await commitFleetAutomaticDiscovery(
        deps.db,
        result.bound,
        result.verified,
        deps.now,
      );
  } catch {
    // Queue output must never serialize DB parameters, tokens or provider text.
    throw new Error("fleet_automatic_job_failed");
  }
}

/** Bounded claimed-attempt phase, NOT a queue job. The full job consumes
 * UNCOMMITTED through the guarded positive commit. No scheduler, source intent,
 * positive authority, reservation or outbox is created here. "settled" means the
 * guarded retry port completed; it does not claim a stale callback changed rows. */
export async function attemptClaimedFleetAutomaticDiscovery(
  deps: FleetSourceDeps,
  claim: AutomaticClaim,
): Promise<FleetAutomaticAttempt> {
  try {
    return await attempt(deps, claim);
  } catch {
    throw new Error("fleet_automatic_job_failed");
  }
}
async function attempt(
  deps: FleetSourceDeps,
  claim: AutomaticClaim,
): Promise<FleetAutomaticAttempt> {
  if (deps.signal?.aborted) return { result: "fenced" };
  const up = createFleetUpstream(deps);
  const { state, clock, memory, esi } = up;
  let token: AutomaticToken | null = null;
  let bound: AutomaticBound | null = null;
  let request: ReturnType<typeof up.directRequest> | null = null;
  let proof: AutomaticAuthLossProof | null = null;
  let outcome: AutomaticRetryFailure["outcome"] = "service_unavailable";
  try {
    up.admit();
    const access = await up.getToken(claim.boss, true);
    token = {
      admission: "admitted",
      claim,
      settledTokenEnc: access.tokenEnc,
      accessTokenExpiresAt: access.expiresAt,
    };
    up.requireBudget();
    let discovery = memory.discovery.get(claim.boss.id);
    if (
      !discovery ||
      discovery.nextFetchAt <= clock() ||
      discovery.ownerHash !== claim.boss.ownerHash ||
      discovery.linkEpoch !== claim.boss.fleetLinkEpoch
    ) {
      state.stage = "membership";
      request = up.directRequest(
        `/characters/${claim.boss.id}/fleet/`,
        access.accessToken,
      );
      const result = await esi.getCharacterFleet(
        claim.boss.id,
        access.accessToken,
        request.request,
      );
      const cache = deriveFleetCacheWindow(result);
      if (
        !cache ||
        !Number.isSafeInteger(result.value.fleetId) ||
        result.value.fleetId <= 0
      ) {
        state.unsupportedConstraint ||= !cache;
        state.upstreamBoundary = Math.max(
          state.upstreamBoundary,
          deriveFleetPacingBoundary(result).getTime(),
        );
        throw new Error("membership_unusable");
      }
      discovery = {
        fleetId: result.value.fleetId,
        nextFetchAt: cache.nextFetchAt,
        ownerHash: claim.boss.ownerHash,
        linkEpoch: claim.boss.fleetLinkEpoch,
      };
    }
    // Cached membership is pacing/reuse only; bind always rechecks all current
    // consent, credential, predecessor and claim guards before roster admission.
    state.membershipBoundary = Math.max(
      state.membershipBoundary,
      discovery.nextFetchAt.getTime(),
    );
    up.requireBudget();
    bound = await bindFleetAutomaticDiscovery(
      deps.db,
      token,
      discovery.fleetId,
      new Date(Math.max(discovery.nextFetchAt.getTime(), state.upstreamBoundary)),
      deps.now,
    );
    if (!bound) return { result: "fenced" };
    remember(memory.discovery, claim.boss.id, discovery);
    up.admit();
    if (state.unsupportedConstraint) throw new Error("upstream_wait");
    state.stage = "roster";
    request = up.directRequest(`/fleets/${bound.fleetId}/members/`, access.accessToken);
    const roster = await esi.getFleetMembers(
      bound.fleetId,
      access.accessToken,
      request.request,
    );
    const evidence = deriveFleetEvidenceWindow(roster);
    state.unsupportedConstraint ||= !deriveFleetCacheWindow(roster);
    state.upstreamBoundary = Math.max(
      state.upstreamBoundary,
      deriveFleetPacingBoundary(roster).getTime(),
    );
    up.requireBudget();
    const memberIds = roster.value.map((ch) => ch.characterId);
    const retained = bound.linkedCharacters.filter((ch) =>
      memberIds.includes(ch.characterId),
    );
    if (
      !evidence ||
      state.unsupportedConstraint ||
      memberIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      !retained.some((ch) => ch.characterId === claim.boss.id) ||
      retained.length > 256
    ) {
      outcome = "untrustworthy_evidence";
    } else {
      return {
        result: "UNCOMMITTED",
        bound,
        verified: {
          evidence,
          memberIds,
          nextFetchAt: new Date(
            Math.max(evidence.nextFetchAt.getTime(), state.upstreamBoundary),
          ),
        },
      };
    }
  } catch (err) {
    // ESI may consume an error body after the response headers. Sample the same
    // deadline again before classifying that completed attempt, not only fetch.
    try {
      up.requireBudget();
    } catch {
      /* The owned signal now records timeout/shutdown. */
    }
    if (err instanceof FleetLinkSnapshotOverflow) state.unsupportedConstraint = true;
    outcome = up.signal.aborted ? "timed_out" : "service_unavailable";
    if (!up.signal.aborted) {
      if (state.stage === "token" && err instanceof FleetTokenRejection)
        proof = {
          cause: err.cause,
          rejected: {
            admission: "rejected",
            claim,
            settledTokenEnc: err.tokenEnc,
            accessTokenExpiresAt: err.expiresAt,
          },
        };
      // An error's status is deliberately irrelevant. Only this attempt's actual
      // expected HTTPS request and nonredirected response establish a refusal.
      const status = request?.status();
      if (state.stage === "membership" && token) {
        if (status === 401) proof = { cause: "esi_membership_unauthorized", token };
        if (status === 404) outcome = "not_in_fleet";
      }
      if (state.stage === "roster" && bound) {
        if (status === 401) proof = { cause: "esi_roster_unauthorized", bound };
        if (status === 403) outcome = "not_boss";
      }
    }
  } finally {
    up.close();
  }
  const nextAttemptAt = up.nextBoundary(true);
  if (proof)
    return {
      result: await settleFleetAutomaticAuthorizationLoss(
        deps.db,
        proof,
        nextAttemptAt,
        deps.now,
      ),
    };
  if (
    state.unsupportedConstraint &&
    outcome !== "not_in_fleet" &&
    outcome !== "not_boss" &&
    outcome !== "timed_out"
  )
    outcome = "untrustworthy_evidence";
  await settleFleetAutomaticDiscovery(
    deps.db,
    bound ?? token ?? claim,
    { outcome, nextAttemptAt },
    deps.now,
  );
  return { result: "settled" };
}
