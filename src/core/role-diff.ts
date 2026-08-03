export type ManagedRoleIds = { flygd: string; blue: string; green: string };

/** Ensure exactly the tier's role among the three managed roles; all other roles untouched. */
export function diffRoles(input: {
  tier: "flygd" | "blue" | "green";
  managed: ManagedRoleIds;
  memberRoleIds: string[];
}): { add: string[]; remove: string[] } {
  const want = input.managed[input.tier];
  const managedAll = [input.managed.flygd, input.managed.blue, input.managed.green];
  const have = new Set(input.memberRoleIds);
  return {
    add: have.has(want) ? [] : [want],
    remove: managedAll.filter((r) => r !== want && have.has(r)),
  };
}

/** The managed roles a member currently carries (unlinked-user deprovision). */
export function stripManagedRoles(
  managed: ManagedRoleIds,
  memberRoleIds: string[],
): string[] {
  const managedAll = new Set([managed.flygd, managed.blue, managed.green]);
  return memberRoleIds.filter((r) => managedAll.has(r));
}

const MANAGE_ROLES = 1n << 28n;
const ADMINISTRATOR = 1n << 3n;

/**
 * Config validation: three distinct managed role ids that exist in the guild;
 * bot has Manage Roles (or Administrator); bot's highest role sits ABOVE
 * every managed role. Failure is permanent-config — no retry loop.
 */
/** Malformed permissions strings must never grant access — treat as zero.
 * Digits-only: BigInt would also accept hex ("0x...") and padded input, which
 * Discord never sends and which must not sneak permissions in. */
function parsePermissions(permissions: string): bigint {
  if (!/^\d+$/.test(permissions)) return 0n;
  return BigInt(permissions);
}

export function validateRoleConfig(input: {
  managed: ManagedRoleIds;
  guildRoles: Array<{ id: string; position: number; permissions: string }>;
  botRoleIds: string[];
  /** Discord omits @everyone (id === guild id) from member role arrays; when
   * provided, its guild role is folded into the bot's permission union. */
  everyoneRoleId?: string;
}): { ok: true } | { ok: false; error: string } {
  const ids = [input.managed.flygd, input.managed.blue, input.managed.green];
  if (new Set(ids).size !== 3) {
    return { ok: false, error: "managed role ids are not distinct" };
  }
  const byId = new Map(input.guildRoles.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `managed roles missing from guild: ${missing.join(", ")}`,
    };
  }
  const botRoleIds = input.everyoneRoleId
    ? [...new Set([...input.botRoleIds, input.everyoneRoleId])]
    : input.botRoleIds;
  const botRoles = botRoleIds.flatMap((id) => {
    const role = byId.get(id);
    return role ? [role] : [];
  });
  const canManage = botRoles.some(
    (r) => (parsePermissions(r.permissions) & (MANAGE_ROLES | ADMINISTRATOR)) !== 0n,
  );
  if (!canManage) return { ok: false, error: "bot lacks Manage Roles" };
  const botTop = botRoles.reduce((max, r) => Math.max(max, r.position), -1);
  const tooHigh = ids.filter((id) => {
    const role = byId.get(id);
    return role !== undefined && role.position >= botTop;
  });
  if (tooHigh.length > 0) {
    return {
      ok: false,
      error: `bot's highest role is not above managed roles: ${tooHigh.join(", ")}`,
    };
  }
  return { ok: true };
}
