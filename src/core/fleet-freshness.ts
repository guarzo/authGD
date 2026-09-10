export type FleetFreshnessInput = {
  date: string | null;
  age: string | null;
  expires: string | null;
  cacheControl: string | null;
  requestStartedAt: Date;
  responseCompletedAt: Date;
};

/** Strict IMF-fixdate only: Date.parse alone accepts ambiguous/normalized dates. */
export function fleetHttpDate(value: string | null): number | null {
  if (value === null || value.length !== 29) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toUTCString() === value ? ms : null;
}
export function fleetHeaderSeconds(value: string | null): number | null {
  return value !== null && /^\d{1,8}$/.test(value) ? Number(value) : null;
}

/** Unknown constraints are NOT a zero-second cache. Discovery uses this same
 * strict metadata parser, but does not adopt the roster's ten-second lease. */
export function deriveFleetCacheWindow(input: FleetFreshnessInput): {
  observedAt: Date;
  nextFetchAt: Date;
} | null {
  const start = input.requestStartedAt.getTime();
  const end = input.responseCompletedAt.getTime();
  const date = fleetHttpDate(input.date);
  const age = input.age === null ? 0 : fleetHeaderSeconds(input.age);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    date === null ||
    date > end ||
    age === null
  )
    return null;
  const expires = fleetHttpDate(input.expires);
  if (input.expires !== null && (expires === null || expires < date)) return null;
  let lifetime: number | null = null;
  if (input.cacheControl !== null) {
    if (input.cacheControl.length > 1024) return null;
    const seen = new Set<string>();
    for (const raw of input.cacheControl.split(",")) {
      const directive = raw.trim().toLowerCase();
      const name = directive.split("=")[0];
      if (
        seen.has(name) ||
        (name === "public" && seen.has("private")) ||
        (name === "private" && seen.has("public"))
      )
        return null;
      seen.add(name);
      if (["public", "private", "must-revalidate"].includes(directive)) continue;
      const match = /^max-age=(\d{1,8})$/.exec(directive);
      if (!match) return null;
      lifetime = Number(match[1]) * 1000;
    }
  }
  if (expires !== null && lifetime !== null && expires - date !== lifetime) return null;
  lifetime ??= expires === null ? null : expires - date;
  if (lifetime === null || lifetime > 86_400_000) return null;
  const observed = end - Math.max(end - date, age * 1000 + end - start, 0);
  return {
    observedAt: new Date(observed),
    // Date/Expires is a further upstream bound even when transit makes our
    // application observation more conservative than the origin timestamp.
    nextFetchAt: new Date(Math.max(end, date + lifetime, observed + 5000)),
  };
}

/** Unknown metadata invalidates evidence, not consent. A source may probe after
 * one minute, but never before any independently valid retained pacing bound. */
export const FLEET_CONSERVATIVE_PROBE_MS = 60_000;

/** Pacing only — never use this receipt fallback to create evidence. Even an
 * unsupported directive or absent Date cannot erase a valid long cache wait.
 * Keep all usable lower bounds, including contradictory/duplicate larger values. */
export function deriveFleetPacingBoundary(input: FleetFreshnessInput): Date {
  const cache = deriveFleetCacheWindow(input);
  if (cache) return cache.nextFetchAt;
  const end = input.responseCompletedAt.getTime();
  const date = fleetHttpDate(input.date);
  let boundary = Math.max(end, fleetHttpDate(input.expires) ?? 0);
  for (const raw of input.cacheControl?.split(",") ?? []) {
    const match = /^(?:max-age|s-maxage)=(?:"(\d{1,8})"|(\d{1,8}))$/.exec(
      raw.trim().toLowerCase(),
    );
    if (match)
      boundary = Math.max(boundary, (date ?? end) + Number(match[1] ?? match[2]) * 1000);
  }
  return new Date(boundary);
}

/** Replaying one representation never re-stamps its application evidence. */
export function deriveFleetEvidenceWindow(input: FleetFreshnessInput): {
  observedAt: Date;
  expiresAt: Date;
  nextFetchAt: Date;
} | null {
  const cache = deriveFleetCacheWindow(input);
  if (!cache) return null;
  const expiresAt = new Date(cache.observedAt.getTime() + 10_000);
  if (expiresAt.getTime() <= input.responseCompletedAt.getTime()) return null;
  return { ...cache, expiresAt };
}
