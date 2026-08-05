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

type Render = (
  d: Record<string, unknown>,
  roleNames: ReadonlyMap<string, string>,
) => string;

/**
 * A renderer that knows which payload keys it reads. The tag is what lets
 * summarizeDetails tell "declared and deliberately silent" apart from "nobody
 * looked at this key", so only the second earns a `+N more`. Tagging at the
 * combinator keeps the key names in one place: they are already arguments.
 */
type Part = Render & { readonly keys: readonly string[] };

const part = (keys: readonly string[], render: Render): Part =>
  Object.assign(render, { keys });

/** `flygd → green`, or `→ green` when the payload has no prior value. One
 * renderer shared by every transition action, so the two can't drift apart
 * the way tier.changed and status.changed did. */
function transition(fromKey: string, toKey: string): Part {
  return part([fromKey, toKey], (d) =>
    d[fromKey] !== undefined
      ? `${fmt(d[fromKey])} → ${fmt(d[toKey])}`
      : `→ ${fmt(d[toKey])}`,
  );
}

/** `+green −flygd`. Ids the app manages resolve to their tier name; anything
 * else collapses to a count, or to a truncated id when it stands alone. An
 * operator asking which roles changed gets an answer, and an id that changed
 * since the row was written degrades instead of lying. */
function roles(addedKey: string, removedKey: string): Part {
  return part([addedKey, removedKey], (d, roleNames) => {
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
  });
}

/** A single payload value, rendered bare. */
function scalar(key: string): Part {
  return part([key], (d) => (d[key] === undefined ? "" : fmt(d[key])));
}

/** A payload value behind a fixed word, e.g. `character 90000001`. */
function labelled(word: string, key: string): Part {
  return part([key], (d) => (d[key] === undefined ? "" : `${word} ${fmt(d[key])}`));
}

/** A boolean that is only worth words when it is true: `locked`, `was main`.
 * A false flag renders nothing but still counts as read, so it never shows up
 * as an unexplained `+1 more`. */
function flag(key: string, word: string): Part {
  return part([key], (d) => (d[key] ? word : ""));
}

/** A uuid the audit page cannot resolve to a name, shortened the way an
 * unnameable role id is. `account.merged` is the case: the source account row
 * is deleted by the merge that writes the row, so there is nothing left to
 * resolve against and the full value only crowds the column. It rides along in
 * the `title` the details cell already sets. */
function shortRef(word: string, key: string): Part {
  return part([key], (d) =>
    typeof d[key] === "string" ? `${word} ${shortId(d[key])}` : "",
  );
}

/** Keys the line deliberately does not show. Declaring them is the whole
 * point: `summarizeDetails` counts undeclared keys as `+N more`, so a payload
 * id that identifies a sub-object rather than describing the change would
 * otherwise be reported to an admin as something withheld. */
function silent(...keys: string[]): Part {
  return part(keys, () => "");
}

/** `missing esi-a.v1, esi-b.v1` up to two values, `missing 4 scopes` beyond
 * that: a full EVE scope string is long and this column is narrow.
 *
 * Guards with Array.isArray because the DB does not enforce payload shape, so
 * a legacy row, a hand-inserted row, or a future writer bug can put a bare
 * string or null here. A malformed value renders nothing rather than mapping
 * into per-character garbage or throwing into the (unreadable) catch, and the
 * key still counts as read so the line does not claim a hidden key it is
 * actually refusing to guess at. The payload stays one disclosure click away. */
function list(key: string, word: string, noun: string): Part {
  return part([key], (d) => {
    const raw = d[key];
    if (!Array.isArray(raw) || raw.length === 0) return "";
    if (raw.length > 2) return `${word} ${raw.length} ${noun}`;
    return `${word} ${raw.map(fmt).join(", ")}`;
  });
}

/** Whether a note was added, replaced, or cleared. Deliberately not the note
 * text: the audit log records that a note changed, and the note itself lives
 * on the account where it is current rather than frozen at write time. */
function noteChange(hadKey: string, hasKey: string): Part {
  return part([hadKey, hasKey], (d) => {
    const had = Boolean(d[hadKey]);
    const has = Boolean(d[hasKey]);
    if (had && has) return "note replaced";
    if (has) return "note added";
    if (had) return "note cleared";
    return "";
  });
}

/**
 * Which payload keys matter, per action, and how they read. Adding an action
 * means adding a row here; adding a key to an existing action without adding
 * it here means the summary says `+1 more` rather than dropping it in silence.
 *
 * `admin.promoted` is deliberately absent. It was declared here with a scope
 * and a note that no writer produces: the app has no admin-scope concept, and
 * the declaration described seeded test data.
 */
const PARTS: Record<string, readonly Part[]> = {
  "tier.changed": [transition("from", "to"), scalar("cause"), flag("locked", "locked")],
  // Same shape as tier.changed on purpose: an approval IS a tier transition,
  // and the payload has no `from` because a pending account has no prior tier
  // an admin would recognise. `transition` already renders `→ green` for that.
  "tier.approved": [transition("from", "to"), flag("locked", "locked")],
  "account.merged": [
    shortRef("absorbed", "sourceAccountId"),
    labelled("character", "characterId"),
  ],
  // The only action in the repo whose payload exceeds FALLBACK_KEYS, and the
  // key the fallback dropped was the price — the reason the row exists.
  // transition() reused rather than scalar()+labelled(): those are two
  // declared parts, joined by the ", " every other multi-part line uses, which
  // renders "Tritanium, → 5.50" — the arrow needs to live inside one part.
  "payout.item_repriced": [transition("name", "unitPrice"), silent("itemId", "poolId")],
  "status.changed": [transition("from", "to"), flag("self", "self-service")],
  "admin.bootstrap_granted": [labelled("character", "characterId")],
  "account.created": [labelled("main", "mainCharacterId")],
  "account.main_changed": [labelled("main →", "mainCharacterId")],
  "character.reclaimed": [labelled("from", "fromAccount")],
  "character.unlinked": [scalar("name"), flag("wasMain", "was main")],
  "token.invalidated": [scalar("reason")],
  "token.verify_failed": [scalar("error")],
  "token.subject_mismatch": [labelled("subject", "subjectCharacterId")],
  "token.needs_reauth": [list("missingScopes", "missing", "scopes")],
  "tier.unlocked": [labelled("was", "tier")],
  "status.note_changed": [noteChange("had", "has")],
  "character.owner_mismatch": [labelled("detected by", "detectedBy")],
  "discord.unlinked": [scalar("reason")],
  "discord.role_changed": [
    roles("added", "removed"),
    labelled("tier", "tier"),
    scalar("cause"),
  ],
  "wanderer.removed": [labelled("role", "role")],
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
      const declared = new Set(parts.flatMap((p) => p.keys));
      const hidden = Object.keys(d).filter((k) => !declared.has(k)).length;
      const line = rendered.join(", ");
      // Declared parts are never truncated: the cap below is for the
      // machine-generated fallback, and truncating a hand-curated declaration
      // would be second-guessing whoever wrote it.
      if (hidden > 0) return line ? `${line}, +${hidden} more` : `+${hidden} more`;
      return line || "—";
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
