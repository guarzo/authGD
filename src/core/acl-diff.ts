export type AclMember = { characterId: number; role: string };

/**
 * Spec job 3: admin-role entries are NEVER removed; manager-role entries are
 * removed like anyone else when they leave the desired set. A desired
 * character whose role is "blocked" has no effective access — presence alone
 * is not convergence — so it is unblocked (reset to viewer); all other roles
 * (admin/manager/member/viewer) are preserved as-is. Blocked entries are also
 * NEVER removed even when undesired: removing a blocked member is equivalent
 * to un-banning them, which could restore access via an inert corp/alliance
 * ACL entry — blocked access must only ever be lifted deliberately.
 */
export function diffAcl(input: { desiredIds: number[]; members: AclMember[] }): {
  add: number[];
  remove: number[];
  unblock: number[];
} {
  const desired = new Set(input.desiredIds);
  const byId = new Map(input.members.map((m) => [m.characterId, m]));
  return {
    add: input.desiredIds.filter((id) => !byId.has(id)),
    unblock: input.desiredIds.filter((id) => byId.get(id)?.role === "blocked"),
    remove: input.members
      .filter(
        (m) => !desired.has(m.characterId) && m.role !== "admin" && m.role !== "blocked",
      )
      .map((m) => m.characterId),
  };
}
