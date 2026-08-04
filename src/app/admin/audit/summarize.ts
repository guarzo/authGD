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

/** A Discord role id we can't name: first six characters, then an ellipsis.
 * The full value rides along in the `title` the details cell already sets. */
function shortId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
}

type Part = (d: Record<string, unknown>, roleNames: ReadonlyMap<string, string>) => string;

/** `flygd → green`, or `→ green` when the payload has no prior value. One
 * renderer shared by every transition action, so the two can't drift apart
 * the way tier.changed and status.changed did. */
function transition(fromKey: string, toKey: string): Part {
  return (d) =>
    d[fromKey] !== undefined
      ? `${fmt(d[fromKey])} → ${fmt(d[toKey])}`
      : `→ ${fmt(d[toKey])}`;
}

/** `+green −flygd`. Ids the app manages resolve to their tier name; anything
 * else collapses to a count, or to a truncated id when it stands alone. An
 * operator asking which roles changed gets an answer, and an id that changed
 * since the row was written degrades instead of lying. */
function roles(addedKey: string, removedKey: string): Part {
  return (d, roleNames) => {
    const side = (key: string, sign: string): string => {
      const raw = d[key];
      if (!Array.isArray(raw) || raw.length === 0) return "";
      const ids = raw.map(String);
      const known = ids.filter((id) => roleNames.has(id));
      const unknown = ids.filter((id) => !roleNames.has(id));
      const parts = known.map((id) => `${sign}${roleNames.get(id)}`);
      if (unknown.length === 1 && known.length === 0) {
        parts.push(`${sign}${shortId(unknown[0])}`);
      } else if (unknown.length > 0) {
        parts.push(`${sign}${unknown.length} other`);
      }
      return parts.join(", ");
    };
    return [side(addedKey, "+"), side(removedKey, "−")].filter(Boolean).join(" ");
  };
}

/** A single payload value, rendered bare. */
function scalar(key: string): Part {
  return (d) => (d[key] === undefined ? "" : fmt(d[key]));
}

/** A payload value behind a fixed word, e.g. `character 90000001`. */
function labelled(word: string, key: string): Part {
  return (d) => (d[key] === undefined ? "" : `${word} ${fmt(d[key])}`);
}

/**
 * Which payload keys matter, per action, and how they read. Adding an action
 * means adding a row here. A key nobody declared shows up as a visible blank
 * rather than being silently dropped, which is the failure mode the old
 * hand-written templates had.
 */
const PARTS: Record<string, readonly Part[]> = {
  "tier.changed": [transition("from", "to")],
  "status.changed": [transition("from", "to")],
  "admin.promoted": [scalar("scope"), scalar("note")],
  "admin.bootstrap_granted": [labelled("character", "characterId")],
  "account.created": [labelled("main", "mainCharacterId")],
  "account.main_changed": [labelled("main →", "mainCharacterId")],
  "character.reclaimed": [labelled("from", "fromAccount")],
  "token.invalidated": [scalar("reason")],
  "token.verify_failed": [scalar("error")],
  "token.subject_mismatch": [labelled("subject", "subjectCharacterId")],
  "character.owner_mismatch": [labelled("detected by", "detectedBy")],
  "discord.unlinked": [scalar("reason")],
  "discord.role_changed": [roles("added", "removed")],
};

/** How many key=value pairs the fallback shows before it says so. */
const FALLBACK_KEYS = 3;

/**
 * One factual line per action, e.g. `tier.changed` -> `flygd → green`. This is
 * what a scanning admin actually reads; the full payload stays behind the `+`
 * disclosure, so the line's job is not to be complete, it is to not lie about
 * being complete.
 *
 * Total and defensive: an unknown action or a malformed payload falls through
 * to a generic key=value rendering rather than throwing, since new action names
 * appear over time and the DB does not enforce a shape.
 *
 * `roleNames` maps a Discord role id to its tier name. Passed in rather than
 * imported so this module stays a pure function of its arguments and needs no
 * env to test.
 */
export function summarizeDetails(
  action: string,
  details: unknown,
  roleNames: ReadonlyMap<string, string> = new Map(),
): string {
  const d = (details && typeof details === "object" ? details : {}) as Record<
    string,
    unknown
  >;
  try {
    const parts = PARTS[action];
    if (parts) {
      const rendered = parts.map((p) => p(d, roleNames)).filter(Boolean);
      if (rendered.length) return rendered.join(", ");
      return "—";
    }
    const entries = Object.entries(d);
    const shown = entries.slice(0, FALLBACK_KEYS).map(([k, v]) => `${k}=${fmt(v)}`);
    if (!shown.length) return "—";
    const hidden = entries.length - shown.length;
    return hidden > 0 ? `${shown.join(", ")}, +${hidden} more` : shown.join(", ");
  } catch {
    return "(unreadable)";
  }
}
