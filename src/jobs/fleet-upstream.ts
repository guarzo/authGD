import { createRemoteJWKSet, customFetch, decodeJwt, type JWTVerifyGetKey } from "jose";
import type { Db } from "@/db";
import type { Config } from "@/config";
import type { character } from "@/db/schema";
import { classifyOAuthError } from "@/core/errors";
import {
  deriveFleetCacheWindow,
  deriveFleetPacingBoundary,
  FLEET_CONSERVATIVE_PROBE_MS,
  fleetHeaderSeconds,
  fleetHttpDate,
} from "@/core/fleet-freshness";
import {
  createEsiClient,
  FLEET_READ_SCOPE,
  type EsiClient,
  type FleetRequestOptions,
} from "@/lib/esi/client";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import { getFreshAccessToken } from "@/services/tokens";

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
/** One worker-owned memory, shared by manual and automatic attempts. Eviction
 * sacrifices reuse, never consent. No new cache, limiter or polling owner. */
export function createFleetSourceMemory() {
  return { tokens: new Map<number, Token>(), discovery: new Map<number, Discovery>() };
}
export function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  if (map.size >= 1024) map.delete(map.keys().next().value!);
  map.set(key, value);
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
export class FleetTokenRejection extends Error {
  constructor(
    readonly cause:
      "verified_subject_mismatch" | "verified_owner_mismatch" | "verified_scope_missing",
    readonly tokenEnc: string,
    readonly expiresAt: Date,
  ) {
    super(cause);
  }
}

/** Per-attempt upstream lifetime extracted from the manual source worker. All
 * token-service promises are awaited directly, including CAS after HTTP abort. */
export function createFleetUpstream(deps: FleetSourceDeps) {
  const clock = deps.now ?? (() => new Date());
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
  const state = {
    stage: "token" as "token" | "membership" | "roster",
    settledTokenEnc: null as string | null,
    upstreamBoundary: clock().getTime(),
    membershipBoundary: 0,
    unsupportedConstraint: false,
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
      if (seconds === null && date === null) state.unsupportedConstraint = true;
      else
        state.upstreamBoundary = Math.max(
          state.upstreamBoundary,
          seconds !== null ? now + seconds * 1000 : date!,
        );
    }
    const remain = response.headers.get("x-esi-error-limit-remain");
    const reset = response.headers.get("x-esi-error-limit-reset");
    if (remain !== null || reset !== null) {
      const r = fleetHeaderSeconds(remain);
      const s = fleetHeaderSeconds(reset);
      if (r === null || s === null) state.unsupportedConstraint = true;
      if (s !== null && (r === null || r <= 5))
        state.upstreamBoundary = Math.max(state.upstreamBoundary, now + s * 1000);
    }
    // Membership cache limits discovery, not independent healthy active roster.
    if (state.stage !== "token" || !response.ok) {
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
        state.unsupportedConstraint = true;
      if (state.stage === "membership" && response.ok)
        state.membershipBoundary = Math.max(state.membershipBoundary, pacing);
      else state.upstreamBoundary = Math.max(state.upstreamBoundary, pacing);
    }
    if (state.stage === "token" && !response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const raw =
        body !== null &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : undefined;
      // Keep generic permanent OAuth/CAS ownership, without persisting arbitrary
      // provider text in the token service's existing sanitized audit reason.
      const safe =
        classifyOAuthError(raw, response.status) === "permanent"
          ? "invalid_token"
          : "temporarily_unavailable";
      return Response.json(
        { error: safe },
        { status: response.status, headers: response.headers },
      );
    }
    if (state.stage === "token" && response.ok) {
      // Finish abortable HTTP before the token service's local CAS. Never race
      // or abandon that write when its row lock outlives the upstream budget.
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
  const fleetRequest: FleetRequestOptions = { fetchImpl, now: () => clock().getTime() };
  function sharedBoundary() {
    state.upstreamBoundary = Math.max(
      state.upstreamBoundary,
      esi.getFleetRetryAt(clock().getTime()) ?? 0,
    );
  }
  function admit() {
    requireBudget();
    sharedBoundary();
    if (state.upstreamBoundary > clock().getTime()) throw new Error("upstream_wait");
  }
  async function getToken(
    boss: typeof character.$inferSelect,
    strict = false,
  ): Promise<Token> {
    let token = memory.tokens.get(boss.id);
    if (
      token &&
      token.tokenEnc === boss.refreshTokenEnc &&
      token.ownerHash === boss.ownerHash &&
      token.linkEpoch === boss.fleetLinkEpoch &&
      token.expiresAt.getTime() > clock().getTime() + 1000 &&
      boss.scopes.includes(FLEET_READ_SCOPE) &&
      boss.tokenStatus !== "invalid" &&
      boss.tokenStatus !== "missing"
    ) {
      // Automatic cannot trust a legacy/generic verifier's coerced raw claims,
      // even when sharing a cached cryptographically verified access token.
      if (strict) validateRawClaims(token.accessToken);
      return token;
    }
    memory.tokens.delete(boss.id);
    const refreshed = await getFreshAccessToken(deps.db, deps.cfg, boss, fetchImpl);
    if (!refreshed.ok) throw new Error("token_unavailable");
    state.settledTokenEnc = refreshed.tokenEnc;
    requireBudget();
    const getKey =
      deps.getKey ??
      createRemoteJWKSet(new URL("https://login.eveonline.com/oauth/jwks"), {
        [customFetch]: fetchImpl,
      });
    const identity = await verifyEveAccessToken(refreshed.accessToken, getKey, {
      includeExpiry: true,
      currentDate: clock(),
    }).catch(() => {
      throw new Error("token_unverified");
    });
    requireBudget();
    // Even negative identity/scope facts need verified, finite future expiry.
    if (
      !identity.expiresAt ||
      !Number.isFinite(identity.expiresAt.getTime()) ||
      identity.expiresAt <= clock()
    )
      throw new Error("token_unverified");
    if (strict) validateRawClaims(refreshed.accessToken);
    const cause =
      identity.characterId !== boss.id
        ? "verified_subject_mismatch"
        : identity.ownerHash !== boss.ownerHash
          ? "verified_owner_mismatch"
          : !identity.scopes.includes(FLEET_READ_SCOPE)
            ? "verified_scope_missing"
            : null;
    if (cause)
      throw new FleetTokenRejection(cause, refreshed.tokenEnc, identity.expiresAt);
    token = {
      accessToken: refreshed.accessToken,
      tokenEnc: refreshed.tokenEnc,
      ownerHash: identity.ownerHash,
      linkEpoch: boss.fleetLinkEpoch,
      expiresAt: identity.expiresAt,
    };
    remember(memory.tokens, boss.id, token);
    return token;
  }
  /** A local expected request AND its direct response, never EsiError status.
   * This wrapper is used only by automatic proof-bearing endpoints; unrelated
   * ESI consumers keep their existing redirect policy. */
  function directRequest(path: string, accessToken: string) {
    const expected = `https://esi.evetech.net/latest${path}`;
    let status: number | null = null;
    const request: FleetRequestOptions = {
      now: fleetRequest.now,
      fetchImpl: async (raw, init) => {
        status = null;
        const url = raw instanceof Request ? raw.url : raw.toString();
        const method = init?.method ?? (raw instanceof Request ? raw.method : "GET");
        const headers =
          init?.headers ?? (raw instanceof Request ? raw.headers : undefined);
        if (
          url !== expected ||
          method !== "GET" ||
          new Headers(headers).get("authorization") !== `Bearer ${accessToken}`
        )
          throw new Error("unexpected_fleet_request");
        const response = await fetchImpl(raw, { ...init, redirect: "error" });
        requireBudget();
        if (response.redirected || response.url !== expected)
          throw new Error("uncertain_fleet_response");
        status = response.status;
        return response;
      },
    };
    return { request, status: () => status };
  }
  function nextBoundary(negative = false) {
    sharedBoundary();
    return new Date(
      Math.max(
        state.upstreamBoundary,
        negative ? state.membershipBoundary : 0,
        clock().getTime() +
          (state.unsupportedConstraint ? FLEET_CONSERVATIVE_PROBE_MS : 5000),
      ),
    );
  }
  return {
    clock,
    memory,
    signal,
    state,
    esi,
    fleetRequest,
    requireBudget,
    admit,
    getToken,
    directRequest,
    nextBoundary,
    close: () => clearTimeout(timer),
  };
}

/** Narrow bounded-path validation AFTER crypto verification, not a change to
 * SSO/token-health coercion or permanent OAuth classification. */
function validateRawClaims(accessToken: string) {
  const claims = decodeJwt(accessToken);
  const match =
    typeof claims.sub === "string" ? /^CHARACTER:EVE:([1-9]\d*)$/.exec(claims.sub) : null;
  if (
    !match ||
    !Number.isSafeInteger(Number(match[1])) ||
    !(
      claims.scp === undefined ||
      typeof claims.scp === "string" ||
      (Array.isArray(claims.scp) && claims.scp.every((s) => typeof s === "string"))
    )
  )
    throw new Error("token_unverified");
}
