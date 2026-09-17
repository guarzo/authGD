import type { Db } from "@/db";
import type {
  AutomaticToken,
  AutomaticRejectedToken,
  AutomaticAuthLossProof,
  AutomaticBound,
  AutomaticVerified,
  AutomaticCommit,
} from "@/core/fleet-automatic";
import type { BindFleetAutomaticDiscovery } from "@/services/fleet-automatic";

/** Compile only; no fake bind implementation or runtime positive authority.
 * The actual future bind port's parameter, not a parallel lookalike, is checked. */
export function automaticAdmissionTypeproof(
  db: Db,
  bind: BindFleetAutomaticDiscovery,
  admitted: AutomaticToken,
  rejected: AutomaticRejectedToken,
  verified: AutomaticVerified,
  commit: (
    db: Db,
    bound: AutomaticBound,
    verified: AutomaticVerified,
  ) => Promise<AutomaticCommit>,
) {
  const membership: AutomaticAuthLossProof = {
    cause: "esi_membership_unauthorized",
    token: admitted,
  };
  const refused: AutomaticAuthLossProof = { cause: "verified_scope_missing", rejected };
  const positive = bind(db, admitted, 123, new Date()).then(
    (bound) => bound && commit(db, bound, verified),
  );
  // @ts-expect-error Rejected evidence must not be assignable to positive tokens.
  const wrongToken: AutomaticToken = rejected;
  // @ts-expect-error The actual bind function parameter must refuse rejected evidence.
  const wrongBind = bind(db, rejected, 123, new Date());
  const wrongMembership: AutomaticAuthLossProof = {
    cause: "esi_membership_unauthorized",
    // @ts-expect-error A membership401 requires admitted, not rejected, token evidence.
    token: rejected,
  };
  return { membership, refused, positive, wrongToken, wrongBind, wrongMembership };
}
