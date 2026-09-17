import {
  deriveFleetCacheWindow,
  deriveFleetEvidenceWindow,
  deriveFleetPacingBoundary,
} from "@/core/fleet-freshness";
import { EsiError } from "@/lib/esi/client";
import {
  bindPendingFleet,
  claimFleetSourceFetch,
  commitFleetSourceObservation,
  FleetLinkSnapshotOverflow,
  type FleetSourceObservation,
} from "@/services/fleet-source-observation";
import {
  createFleetUpstream,
  FleetTokenRejection,
  remember,
  type FleetSourceDeps,
} from "./fleet-upstream";
export { createFleetSourceMemory, type FleetSourceDeps } from "./fleet-upstream";

/** This job is deliberately NOT runJob: routine evidence must not create sync
 * history or persist provider errors. Caller owns this promise through credential
 * settlement, even if pg-boss expiration has already stopped waiting for it. */
export async function runFleetSourceJob(
  deps: FleetSourceDeps,
  input: { sourceId: string; generation: number },
): Promise<void> {
  try {
    await run(deps, input);
  } catch {
    throw new Error("fleet_source_job_failed");
  }
}
async function run(
  deps: FleetSourceDeps,
  input: { sourceId: string; generation: number },
) {
  if (deps.signal?.aborted) return;
  let ticket = await claimFleetSourceFetch(deps.db, input, deps.now);
  if (!ticket) return;
  const up = createFleetUpstream(deps);
  const { state, clock, memory, esi, fleetRequest, requireBudget } = up;
  let settledTokenEnc = ticket.boss.refreshTokenEnc!;
  let observation: FleetSourceObservation = {
    kind: "failure",
    reason: "service_unavailable",
    nextFetchAt: new Date(clock().getTime() + 5000),
  };
  try {
    up.admit();
    const token = await up.getToken(ticket.boss);
    settledTokenEnc = token.tokenEnc;
    ticket = { ...ticket, accessTokenExpiresAt: token.expiresAt };
    requireBudget();
    let discovery = memory.discovery.get(ticket.boss.id);
    if (
      !discovery ||
      discovery.nextFetchAt <= clock() ||
      discovery.ownerHash !== ticket.boss.ownerHash ||
      discovery.linkEpoch !== ticket.boss.fleetLinkEpoch
    ) {
      state.stage = "membership";
      const result = await esi.getCharacterFleet(
        ticket.boss.id,
        token.accessToken,
        fleetRequest,
      );
      const cache = deriveFleetCacheWindow(result);
      if (!cache || result.value.fleetId <= 0) {
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
        ownerHash: ticket.boss.ownerHash,
        linkEpoch: ticket.boss.fleetLinkEpoch,
      };
    }
    const bound = await bindPendingFleet(
      deps.db,
      ticket,
      discovery.fleetId,
      token.tokenEnc,
      deps.now,
      new Date(Math.max(discovery.nextFetchAt.getTime(), state.upstreamBoundary)),
    );
    // A fenced callback is not a second observation of newer source state.
    if (!bound) return;
    remember(memory.discovery, ticket.boss.id, discovery);
    ticket = bound;
    requireBudget();
    if (state.upstreamBoundary > clock().getTime() || state.unsupportedConstraint)
      throw new Error("upstream_wait");
    state.stage = "roster";
    const roster = await esi.getFleetMembers(
      discovery.fleetId,
      token.accessToken,
      fleetRequest,
    );
    const evidence = deriveFleetEvidenceWindow(roster);
    const cache = deriveFleetCacheWindow(roster);
    if (!cache) state.unsupportedConstraint = true;
    state.upstreamBoundary = Math.max(
      state.upstreamBoundary,
      deriveFleetPacingBoundary(roster).getTime(),
    );
    requireBudget();
    observation =
      evidence && !state.unsupportedConstraint
        ? {
            kind: "verified",
            evidence,
            memberIds: roster.value.map((ch) => ch.characterId),
            nextFetchAt: new Date(
              Math.max(evidence.nextFetchAt.getTime(), state.upstreamBoundary),
            ),
          }
        : { kind: "failure", reason: "untrustworthy_evidence", nextFetchAt: null };
  } catch (err) {
    if (state.stage === "membership")
      state.upstreamBoundary = Math.max(state.upstreamBoundary, state.membershipBoundary);
    if (err instanceof FleetLinkSnapshotOverflow) state.unsupportedConstraint = true;
    observation = {
      kind: "failure",
      reason: up.signal.aborted ? "timed_out" : "service_unavailable",
      nextFetchAt: null,
    };
    if (err instanceof FleetTokenRejection) {
      settledTokenEnc = err.tokenEnc;
      ticket = { ...ticket, accessTokenExpiresAt: err.expiresAt };
      observation.terminal =
        err.cause === "verified_scope_missing"
          ? "fleet_read_invalid"
          : "identity_changed";
    }
    // Existing manual classification stays unchanged by the extraction.
    if (err instanceof EsiError) {
      if (err.status === 404 && state.stage === "membership")
        observation.terminal = "not_in_fleet";
      if (err.status === 403 && state.stage === "roster")
        observation.terminal = "boss_lost";
      if (err.status === 401) observation.terminal = "fleet_read_invalid";
    }
  } finally {
    up.close();
  }
  const boundary = up.nextBoundary();
  settledTokenEnc = state.settledTokenEnc ?? settledTokenEnc;
  if (state.unsupportedConstraint)
    observation = {
      kind: "failure",
      reason: "untrustworthy_evidence",
      nextFetchAt: boundary,
      ...(observation.kind === "failure" && observation.terminal
        ? { terminal: observation.terminal }
        : {}),
    };
  else if (observation.kind === "failure") observation.nextFetchAt = boundary;
  else
    observation.nextFetchAt = new Date(
      Math.max(observation.nextFetchAt.getTime(), state.upstreamBoundary),
    );
  await commitFleetSourceObservation(
    deps.db,
    ticket,
    settledTokenEnc,
    observation,
    deps.now,
  );
}
