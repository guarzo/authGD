/**
 * Pure parsing, formatting and ordering for structure damage notifications.
 * No I/O, no imports from services or db — this module is unit-tested on
 * literal notification bodies.
 */

/**
 * The four damage types. Fuel, low-power, anchoring and ownership-transfer
 * notifications exist and are deliberately not here: this feature alerts on
 * damage. Adding one later is a one-line change to this array.
 */
export const STRUCTURE_EVENT_TYPES = [
  "StructureUnderAttack",
  "StructureLostShields",
  "StructureLostArmor",
  "StructureDestroyed",
] as const;

export type StructureEventType = (typeof STRUCTURE_EVENT_TYPES)[number];

export function isStructureEventType(type: string): type is StructureEventType {
  return (STRUCTURE_EVENT_TYPES as readonly string[]).includes(type);
}

const SCALAR_LINE = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
const ANCHOR = /^&(\S+)[ \t]+(.*)$/;
const ALIAS = /^\*(\S+)$/;

/**
 * A tolerant reader for EVE notification bodies.
 *
 * The bodies are YAML, but a narrow dialect: top-level scalars plus block
 * sequences, with anchors used to avoid repeating a structure id. Rather than
 * take a YAML dependency for that, this reads the scalars and ignores
 * everything else.
 *
 * Three behaviours are load-bearing:
 *   - block sequence items (`- showinfo`) are skipped, not parsed as keys
 *   - `structureID: &id001 102920` yields "102920", not "&id001 102920"
 *   - `b: *id001` resolves to whatever `&id001` was bound to
 *
 * Never throws. An unparseable body yields `{}`, and the caller records the
 * event without a structure name rather than dropping the alert.
 */
export function parseNotificationBody(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const anchors: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // Block sequence item, or a continuation of one. Not a key.
    if (/^[ \t]*-/.test(line)) continue;
    const m = SCALAR_LINE.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    // A key with an empty value opens a nested block (e.g. structureShowInfoData).
    // Nothing this feature reads is nested, so drop it rather than record "".
    if (value === "") continue;
    const anchored = ANCHOR.exec(value);
    if (anchored) {
      const [, name, actual] = anchored;
      anchors[name] = actual.trim();
      out[key] = actual.trim();
      continue;
    }
    const alias = ALIAS.exec(value);
    if (alias) {
      const resolved = anchors[alias[1]];
      if (resolved !== undefined) out[key] = resolved;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The body keys worth persisting. Everything else is dropped on the floor. */
const KEPT_KEYS = [
  "corpName",
  "allianceName",
  "charID",
  "shieldPercentage",
  "armorPercentage",
  "hullPercentage",
  "timeLeft",
  "solarsystemID",
  "structureTypeID",
  "ownerCorpName",
  "isAbandoned",
] as const;

export type ParsedStructureEvent = {
  structureId: number | null;
  details: Record<string, string | number | null>;
};

function asNumberIfNumeric(value: string): string | number {
  if (value === "") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/**
 * The parsed subset this feature persists and renders. Anything not in
 * KEPT_KEYS never reaches Postgres — the notifications endpoint returns every
 * notification type for the character, including personal ones.
 */
export function extractStructureEvent(text: string): ParsedStructureEvent {
  const body = parseNotificationBody(text);
  const rawId = body.structureID;
  const parsedId = rawId === undefined ? Number.NaN : Number(rawId);
  const details: Record<string, string | number | null> = {};
  for (const key of KEPT_KEYS) {
    const value = body[key];
    if (value !== undefined) details[key] = asNumberIfNumeric(value);
  }
  return {
    structureId: Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : null,
    details,
  };
}

const VERB: Record<string, string> = {
  StructureUnderAttack: "is under attack",
  StructureLostShields: "lost shields",
  StructureLostArmor: "lost armor",
  StructureDestroyed: "was destroyed",
};

export type StructureAlertInput = {
  type: string;
  structureName: string | null;
  typeName: string | null;
  systemName: string | null;
  details: Record<string, string | number | null>;
};

/**
 * One plain-text line per alert.
 *
 * Clamped to 1900 characters here as well as in the webhook poster. The poster
 * clamps to protect Discord; this clamps so the string a test asserts on is the
 * string that gets sent, rather than one silently truncated a layer later.
 */
export function formatStructureAlert(input: StructureAlertInput): string {
  const subject = input.structureName ?? input.typeName ?? "A structure";
  const verb = VERB[input.type] ?? input.type;
  const where = input.systemName ? ` in ${input.systemName}` : "";
  const attacker = input.details.allianceName ?? input.details.corpName ?? null;
  const by = attacker ? ` — ${attacker}` : "";
  return `${subject}${where} ${verb}${by}`.slice(0, 1900);
}

/**
 * Most alarming first. Hull reinforce is the last timer before the structure
 * dies, so it outranks armor; both outrank a vulnerability window that nobody
 * has shot yet.
 */
const STATE_RANK: Record<string, number> = {
  hull_reinforce: 0,
  armor_reinforce: 1,
  hull_vulnerable: 2,
  armor_vulnerable: 3,
  shield_vulnerable: 4,
};

export type RosterSortable = { state: string; name: string | null };

export function compareRosterRows(a: RosterSortable, b: RosterSortable): number {
  const ra = STATE_RANK[a.state] ?? 90;
  const rb = STATE_RANK[b.state] ?? 90;
  if (ra !== rb) return ra - rb;
  // Ties break by name so the table does not reshuffle between renders on
  // rows the state cannot distinguish.
  return (a.name ?? "").localeCompare(b.name ?? "");
}
