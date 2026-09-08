import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from "jose";
import type { Db } from "@/db";
import type { Config } from "@/config";
import type { character } from "@/db/schema";
import { classifyOAuthError } from "@/core/errors";
import {
  deriveFleetCacheWindow,
  deriveFleetEvidenceWindow,
  deriveFleetPacingBoundary,
  FLEET_CONSERVATIVE_PROBE_MS,
  fleetHeaderSeconds,
  fleetHttpDate,
} from "@/core/fleet-freshness";
import {
  createEsiClient,
  EsiError,
  FLEET_READ_SCOPE,
  type EsiClient,
  type FleetRequestOptions,
} from "@/lib/esi/client";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import { getFreshAccessToken } from "@/services/tokens";
import {
  bindPendingFleet,
  claimFleetSourceFetch,
  commitFleetSourceObservation,
  FleetLinkSnapshotOverflow,
  type FleetSourceObservation,
} from "@/services/fleet-source-observation";

class SourceProofLoss extends Error {
  constructor(readonly reason: "identity_changed" | "fleet_read_invalid") {
    super(reason);
  }
}
type Token = {
  accessToken: string;
  tokenEnc: string;
  ownerHash: string;
  linkEpoch: string;
  expiresAt: Date;
};
type Discovery = {
  fleetId: number;
  nextFetchAt: Date;
  ownerHash: string;
  linkEpoch: string;
};
/** Worker-owned, bounded memory only. Ordinary/generic token callers keep their
 * existing refresh and settlement semantics. Eviction sacrifices reuse, not consent. */
export function createFleetSourceMemory() {
  return { tokens: new Map<number, Token>(), discovery: new Map<number, Discovery>() };
}
function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  if (map.size >= 1024) map.delete(map.keys().next().value!);
  map.set(key, value);
}
function cachedToken(
  memory: ReturnType<typeof createFleetSourceMemory>,
  boss: typeof character.$inferSelect,
  now: Date,
) {
  const token = memory.tokens.get(boss.id);
  if (
    token &&
    token.tokenEnc === boss.refreshTokenEnc &&
    token.ownerHash === boss.ownerHash &&
    token.linkEpoch === boss.fleetLinkEpoch &&
    token.expiresAt.getTime() > now.getTime() + 1000 &&
    boss.scopes.includes(FLEET_READ_SCOPE) &&
    boss.tokenStatus !== "invalid" &&
    boss.tokenStatus !== "missing"
  )
    return token;
  memory.tokens.delete(boss.id);
  return null;
}
export type FleetSourceDeps = {
  db: Db;
  cfg: Config;
  esi?: Pick<EsiClient, "getCharacterFleet" | "getFleetMembers" | "getFleetRetryAt">;
  fetchImpl?: typeof fetch;
  getKey?: JWTVerifyGetKey;
  now?: () => Date;
  memory?: ReturnType<typeof createFleetSourceMemory>;
  signal?: AbortSignal;
};

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
  } // No DB parameters, JWTs, private ESI paths/bodies in pg-boss serialization.
}
async function run(
  deps: FleetSourceDeps,
  input: { sourceId: string; generation: number },
) {
  if (deps.signal?.aborted) return;
  const clock = deps.now ?? (() => new Date());
  let ticket = await claimFleetSourceFetch(deps.db, input, deps.now);
  if (!ticket) return;
  const memory = deps.memory ?? createFleetSourceMemory();
  const controller = new AbortController();
  const signal = deps.signal
    ? AbortSignal.any([controller.signal, deps.signal])
    : controller.signal;
  const deadline = clock().getTime() + 15_000;
  const timer = setTimeout(() => controller.abort(), 15_000);
  const requireBudget = () => {
    if (clock().getTime() >= deadline) controller.abort();
    signal.throwIfAborted();
  };
  let upstreamBoundary = clock().getTime();
  let membershipBoundary = 0;
  let unsupportedConstraint = false;
  let stage: "token" | "membership" | "roster" = "token";
  let settledTokenEnc = ticket.boss.refreshTokenEnc!;
  let observation: FleetSourceObservation = {
    kind: "failure",
    reason: "service_unavailable",
    nextFetchAt: new Date(clock().getTime() + 5000),
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    requireBudget();
    const requestSignal =
      init?.signal ?? (url instanceof Request ? url.signal : undefined);
    const response = await (deps.fetchImpl ?? fetch)(url, {
      ...init,
      signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
    });
    const now = clock().getTime();
    const retry = response.headers.get("retry-after");
    if (retry !== null) {
      const seconds = fleetHeaderSeconds(retry);
      const date = fleetHttpDate(retry);
      if (seconds === null && date === null) unsupportedConstraint = true;
      else
        upstreamBoundary = Math.max(
          upstreamBoundary,
          seconds !== null ? now + seconds * 1000 : date!,
        );
    }
    const remain = response.headers.get("x-esi-error-limit-remain");
    const reset = response.headers.get("x-esi-error-limit-reset");
    if (remain !== null || reset !== null) {
      const r = fleetHeaderSeconds(remain);
      const s = fleetHeaderSeconds(reset);
      if (r === null || s === null) unsupportedConstraint = true;
      if (s !== null && (r === null || r <= 5))
        upstreamBoundary = Math.max(upstreamBoundary, now + s * 1000);
    }
    // Capture pacing before ESI parses (or rejects) a successful HTTP body too.
    // Healthy membership caching delays discovery, not the independent roster.
    if (stage !== "token" || !response.ok) {
      const timing = {
        date: response.headers.get("date"),
        age: response.headers.get("age"),
        expires: response.headers.get("expires"),
        cacheControl: response.headers.get("cache-control"),
        requestStartedAt: new Date(now),
        responseCompletedAt: new Date(now),
      };
      const pacing = deriveFleetPacingBoundary(timing).getTime();
      const hasTiming =
        response.headers.has("cache-control") || response.headers.has("expires");
      if ((response.ok || hasTiming) && !deriveFleetCacheWindow(timing))
        unsupportedConstraint = true;
      if (stage === "membership" && response.ok)
        membershipBoundary = Math.max(membershipBoundary, pacing);
      else upstreamBoundary = Math.max(upstreamBoundary, pacing);
    }
    if (stage === "token" && !response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const raw =
        body !== null &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : undefined;
      // Preserve generic classification and owned CAS/invalidation, while keeping
      // arbitrary provider text out of the token service's existing audit reason.
      const safe =
        classifyOAuthError(raw, response.status) === "permanent"
          ? "invalid_token"
          : "temporarily_unavailable";
      return Response.json(
        { error: safe },
        { status: response.status, headers: response.headers },
      );
    }
    if (stage === "token" && response.ok) {
      // Complete abortable HTTP before token-service CAS; never race/abandon the
      // subsequent local settlement when its row lock outlives the HTTP budget.
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  };
  const esi =
    deps.esi ??
    createEsiClient({
      userAgent: `authgd/0.1.0 (${deps.cfg.esiContact})`,
      syncMode: deps.cfg.syncMode,
    });
  const fleetRequest: FleetRequestOptions = {
    fetchImpl,
    now: () => clock().getTime(),
  };
  try {
    const sharedBoundary = esi.getFleetRetryAt(clock().getTime());
    upstreamBoundary = Math.max(upstreamBoundary, sharedBoundary ?? 0);
    if (upstreamBoundary > clock().getTime()) throw new Error("upstream_wait");
    let token = cachedToken(memory, ticket.boss, clock());
    if (!token) {
      const refreshed = await getFreshAccessToken(
        deps.db,
        deps.cfg,
        ticket.boss,
        fetchImpl,
      );
      if (!refreshed.ok) throw new Error("token_unavailable");
      settledTokenEnc = refreshed.tokenEnc;
      requireBudget();
      const getKey =
        deps.getKey ??
        createRemoteJWKSet(new URL("https://login.eveonline.com/oauth/jwks"), {
          [customFetch]: fetchImpl,
        });
      const identity = await verifyEveAccessToken(refreshed.accessToken, getKey, {
        includeExpiry: true,
        currentDate: clock(),
      });
      requireBudget();
      // Expiry is part of every verified upstream fact, including terminal
      // owner/scope loss. Carry it into the final post-wait commit first.
      if (
        !identity.expiresAt ||
        !Number.isFinite(identity.expiresAt.getTime()) ||
        identity.expiresAt <= clock()
      )
        throw new Error("token_unverified");
      ticket = { ...ticket, accessTokenExpiresAt: identity.expiresAt };
      if (
        identity.characterId !== ticket.boss.id ||
        identity.ownerHash !== ticket.boss.ownerHash
      )
        throw new SourceProofLoss("identity_changed");
      if (!identity.scopes.includes(FLEET_READ_SCOPE))
        throw new SourceProofLoss("fleet_read_invalid");
      token = {
        accessToken: refreshed.accessToken,
        tokenEnc: refreshed.tokenEnc,
        ownerHash: identity.ownerHash,
        linkEpoch: ticket.boss.fleetLinkEpoch,
        expiresAt: identity.expiresAt,
      };
      remember(memory.tokens, ticket.boss.id, token);
    }
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
      stage = "membership";
      const result = await esi.getCharacterFleet(
        ticket.boss.id,
        token.accessToken,
        fleetRequest,
      );
      const cache = deriveFleetCacheWindow(result);
      if (!cache || result.value.fleetId <= 0) {
        unsupportedConstraint ||= !cache;
        upstreamBoundary = Math.max(
          upstreamBoundary,
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
      new Date(Math.max(discovery.nextFetchAt.getTime(), upstreamBoundary)),
    );
    // Null means consent/claim/credential was fenced (or terminally ended).
    // Do not turn that stale callback into a second observation of newer state.
    if (!bound) return;
    remember(memory.discovery, ticket.boss.id, discovery);
    {
      ticket = bound;
      requireBudget();
      if (upstreamBoundary > clock().getTime() || unsupportedConstraint)
        throw new Error("upstream_wait");
      stage = "roster";
      const roster = await esi.getFleetMembers(
        discovery.fleetId,
        token.accessToken,
        fleetRequest,
      );
      const evidence = deriveFleetEvidenceWindow(roster);
      const cache = deriveFleetCacheWindow(roster);
      if (!cache) unsupportedConstraint = true;
      upstreamBoundary = Math.max(
        upstreamBoundary,
        deriveFleetPacingBoundary(roster).getTime(),
      );
      requireBudget();
      if (
        evidence &&
        !unsupportedConstraint &&
        roster.value.some((ch) => ch.characterId === ticket!.boss.id)
      ) {
        observation = {
          kind: "verified",
          evidence,
          memberIds: roster.value.map((ch) => ch.characterId),
          nextFetchAt: new Date(
            Math.max(evidence.nextFetchAt.getTime(), upstreamBoundary),
          ),
        };
      } else
        observation = {
          kind: "failure",
          reason: "untrustworthy_evidence",
          nextFetchAt: null,
          ...(!roster.value.some((ch) => ch.characterId === ticket!.boss.id)
            ? { terminal: "boss_lost" as const }
            : {}),
        };
    }
  } catch (err) {
    if (stage === "membership")
      upstreamBoundary = Math.max(upstreamBoundary, membershipBoundary);
    if (err instanceof FleetLinkSnapshotOverflow) unsupportedConstraint = true;
    observation = {
      kind: "failure",
      reason: signal.aborted ? "timed_out" : "service_unavailable",
      nextFetchAt: null,
    };
    if (err instanceof SourceProofLoss) observation.terminal = err.reason;
    if (err instanceof EsiError) {
      if (err.status === 404 && stage === "membership")
        observation.terminal = "not_in_fleet";
      if (err.status === 403 && stage === "roster") observation.terminal = "boss_lost";
      if (err.status === 401) observation.terminal = "fleet_read_invalid";
    }
  } finally {
    clearTimeout(timer);
  }
  const finalBoundary = esi.getFleetRetryAt(clock().getTime());
  upstreamBoundary = Math.max(upstreamBoundary, finalBoundary ?? 0);
  if (unsupportedConstraint)
    observation = {
      kind: "failure",
      reason: "untrustworthy_evidence",
      nextFetchAt: new Date(
        Math.max(clock().getTime() + FLEET_CONSERVATIVE_PROBE_MS, upstreamBoundary),
      ),
      ...(observation.kind === "failure" && observation.terminal
        ? { terminal: observation.terminal }
        : {}),
    };
  else if (observation.kind === "failure")
    observation.nextFetchAt = new Date(
      Math.max(clock().getTime() + 5000, upstreamBoundary),
    );
  else
    observation.nextFetchAt = new Date(
      Math.max(observation.nextFetchAt.getTime(), upstreamBoundary),
    );
  await commitFleetSourceObservation(
    deps.db,
    ticket,
    settledTokenEnc,
    observation,
    deps.now,
  );
}
