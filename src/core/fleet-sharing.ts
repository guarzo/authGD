// Shared model consent is independent of pairing identity and participation.
export const SHARED_CAPABILITY = "shared-source-v1" as const;
export type SignedFleetCall = {
  sessionId: string;
  revision: number;
  /** Deterministic test seam only; production samples after locks. */
  now?: Date;
};
export type FleetCode =
  | "unauthorized"
  | "forbidden"
  | "feature_disabled"
  | "capability_required"
  | "rate_limited"
  | "revision_replayed"
  | "conflict"
  | "invalid_intent"
  | "fleet_read_required"
  | "not_verified"
  | "service_unavailable";
export type FleetReply<T> = { ok: true; value: T } | { ok: false; code: FleetCode };
export type Participation = { enabled: boolean; generation: number };
export type RecoveryResult =
  | {
      result: "reconnected";
      deviceId: string;
      sessionId: string;
      sessionExpiresAt: Date;
      approvedCapabilities: string[];
      participation: Participation;
    }
  | { result: "device_revoked" }
  | { result: "device_key_conflict" }
  | { result: "account_ineligible" | "retry_later"; retryAfterMs: number };
export type DeviceView = {
  deviceId: string;
  sessionExpiresAt: Date;
  featureEnabled: boolean;
  approvedCapabilities: string[];
  sessionApprovedCapabilities: string[];
  acknowledgedCapabilities: string[];
  participation: Participation;
};

/** Closed, bounded capability vocabulary. Unknown or duplicate rights fail closed. */
export function validFleetCapabilities(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1 &&
    value.every((c) => c === SHARED_CAPABILITY)
  );
}
