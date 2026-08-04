/** Renders a JSON value inline where it can't throw: a string/number/boolean
 * as itself, anything else as compact JSON. Never lets a malformed payload
 * take the whole row down. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "?";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return "?";
  }
}

/**
 * One factual line per action, e.g. `tier.changed` -> `green → flygd`. This is
 * what a scanning admin actually reads; the full payload stays behind the `+`
 * disclosure. Total and defensive: an unknown action or a malformed payload
 * falls through to a generic key=value rendering rather than throwing, since
 * new action names appear over time and the DB does not enforce a shape.
 */
export function summarizeDetails(action: string, details: unknown): string {
  const d = (details && typeof details === "object" ? details : {}) as Record<
    string,
    unknown
  >;
  try {
    switch (action) {
      case "tier.changed":
        return d.from !== undefined ? `${fmt(d.from)} → ${fmt(d.to)}` : `→ ${fmt(d.to)}`;
      case "status.changed":
        return `→ ${fmt(d.to)}`;
      case "admin.bootstrap_granted":
        return `character ${fmt(d.characterId)}`;
      case "account.created":
        return `main ${fmt(d.mainCharacterId)}`;
      case "account.main_changed":
        return `main → ${fmt(d.mainCharacterId)}`;
      case "character.reclaimed":
        return `from ${fmt(d.fromAccount)}`;
      case "token.invalidated":
        return fmt(d.reason);
      case "token.verify_failed":
        return fmt(d.error);
      case "token.subject_mismatch":
        return `subject ${fmt(d.subjectCharacterId)}`;
      case "character.owner_mismatch":
        return `detected by ${fmt(d.detectedBy)}`;
      case "discord.unlinked":
        return fmt(d.reason);
      case "discord.role_changed":
        return d.added !== undefined
          ? `+${fmt(d.added)} -${fmt(d.removed)} (${fmt(d.tier)})`
          : `-${fmt(d.removed)} (${fmt(d.cause)})`;
      default: {
        const entries = Object.entries(d)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${fmt(v)}`);
        return entries.length ? entries.join(", ") : "—";
      }
    }
  } catch {
    return "(unreadable)";
  }
}
