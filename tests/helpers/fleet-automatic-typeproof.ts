import type { Db } from "@/db";
import type {
  AutomaticToken,
  AutomaticRejectedToken,
  AutomaticAuthLossProof,
  AutomaticBound,
  AutomaticVerified,
  AutomaticCommit,
} from "@/core/fleet-automatic";
import { bindFleetAutomaticDiscovery as bind } from "@/services/fleet-automatic";

/** Compile only; rejected evidence must fail against the ACTUAL runtime bind.
 * Positive commit remains a future port, never a fabricated runtime owner. */
export function automaticAdmissionTypeproof(
  db: Db,
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
