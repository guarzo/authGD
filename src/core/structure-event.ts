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
      // Object.hasOwn, not `in` or a bare index: `anchors` is a plain object
      // literal, so `*constructor` (or `*toString`, `*__proto__`) resolves
      // through the prototype chain to a function rather than `undefined`,
      // and that function would then be typed as a string all the way to
      // jsonb. `in` walks the same chain and would not fix it.
      const resolved = Object.hasOwn(anchors, alias[1]) ? anchors[alias[1]] : undefined;
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

/** The subject + location fields common to both alert renders. */
type StructureAlertSubject = {
  type: string;
  structureName: string | null;
  typeName: string | null;
  systemName: string | null;
};

export type StructureAlertInput = StructureAlertSubject & {
  details: Record<string, string | number | null>;
};

/**
 * The subject + location + verb, shared by `formatStructureAlert`'s plain-text
 * line and `buildStructureAlertEmbed`'s title. One helper so the two renders
 * of "what happened" cannot drift apart — only the attacker suffix and the
 * truncation mechanism differ between them (a plain `.slice` clamp for the
 * plain-text line, `truncateCodePoints` plus a separate `description` field
 * for the embed).
 */
function structureAlertSentence(input: StructureAlertSubject): string {
  const subject = input.structureName ?? input.typeName ?? "A structure";
  const verb = VERB[input.type] ?? input.type;
  // Real structure names are typically `"<systemName> - <structureName>"`
  // (e.g. "J214811 - Derelicte" in system "J214811"), so appending the system
  // name again would read as "J214811 - Derelicte in J214811 is under
  // attack". Omit the location clause whenever the structure name already
  // contains it.
  const where =
    input.systemName && !input.structureName?.includes(input.systemName)
      ? ` in ${input.systemName}`
      : "";
  return `${subject}${where} ${verb}`;
}

/**
 * One plain-text line per alert, rendered into the admin structures page's
 * notification table (src/app/admin/structures/page.tsx). Clamped to 1900
 * characters here as well as in the webhook poster's own clamp, so a `<td>`
 * never has to render an unbounded string built from attacker-controlled
 * text.
 */
export function formatStructureAlert(input: StructureAlertInput): string {
  const attacker = input.details.allianceName ?? input.details.corpName ?? null;
  const by = attacker ? ` — ${attacker}` : "";
  return `${structureAlertSentence(input)}${by}`.slice(0, 1900);
}

/** Truncates by CODE POINT, not UTF-16 unit, so a surrogate pair is never split. */
function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** Severity ramp — most alarming last, matching how bad the outcome is. */
const EMBED_COLOR: Record<StructureEventType, number> = {
  StructureUnderAttack: 0xf1c40f,
  StructureLostShields: 0xe67e22,
  StructureLostArmor: 0xe74c3c,
  StructureDestroyed: 0x992d22,
};

/**
 * Falls back to Discord's "greyple" for an unknown type. This is NOT what an
 * embed with no `color` renders as — that has no colored sidebar at all —
 * it's just a neutral, still-visible color for a `type` this module does not
 * recognize (the DB column is `text`, not the union, so an unmapped value
 * must degrade rather than crash).
 */
const DEFAULT_EMBED_COLOR = 0x99aab5;

const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;

/** A reinforcement timer beyond this is not trustworthy data, not a real window. */
const MAX_REINFORCE_SECONDS = 14 * 24 * 60 * 60;

/** EVE's `timeLeft` unit: 100-nanosecond ticks. */
const TICKS_PER_SECOND = 1e7;

export type DiscordEmbedField = { name: string; value: string };

export type DiscordEmbed = {
  title: string;
  color: number;
  description?: string;
  fields?: DiscordEmbedField[];
  thumbnail?: { url: string };
  url?: string;
  timestamp: string;
  footer: { text: string };
};

export type StructureAlertEmbedInput = StructureAlertSubject & {
  systemId: number | null;
  sentAt: Date;
  notificationId: number;
  details: Record<string, string | number | null>;
};

function roundPercent(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * A plain Discord embed object for one structure alert. Kept pure — no I/O —
 * like the rest of this module; the poster is the only thing that sends it.
 *
 * Every absent datum SHORTENS the embed rather than rendering a placeholder:
 * there is no "Unknown" or "????" anywhere below. `timestamp` is the event's
 * own `sentAt`, never `new Date()` — delivery is at-least-once, so a re-post
 * must report when the notification actually fired, not when it happened to
 * be retried.
 */
export function buildStructureAlertEmbed(input: StructureAlertEmbedInput): DiscordEmbed {
  const title = truncateCodePoints(structureAlertSentence(input), TITLE_MAX);
  const color = isStructureEventType(input.type)
    ? EMBED_COLOR[input.type]
    : DEFAULT_EMBED_COLOR;

  const attacker = input.details.allianceName ?? input.details.corpName ?? null;
  const description = attacker
    ? truncateCodePoints(`Attacker: ${attacker}`, DESCRIPTION_MAX)
    : undefined;

  const shield = roundPercent(input.details.shieldPercentage);
  const armor = roundPercent(input.details.armorPercentage);
  const hull = roundPercent(input.details.hullPercentage);
  const damageParts: string[] = [];
  if (shield !== undefined) damageParts.push(`Shield ${shield}%`);
  if (armor !== undefined) damageParts.push(`Armor ${armor}%`);
  if (hull !== undefined) damageParts.push(`Hull ${hull}%`);

  const fields: DiscordEmbedField[] = [];
  if (damageParts.length > 0) {
    fields.push({ name: "Damage", value: damageParts.join(" · ") });
  }

  const rawTimeLeft = input.details.timeLeft;
  const timeLeftTicks =
    rawTimeLeft === null || rawTimeLeft === undefined || rawTimeLeft === ""
      ? undefined
      : Number(rawTimeLeft);
  if (timeLeftTicks !== undefined && Number.isFinite(timeLeftTicks)) {
    const durationSeconds = timeLeftTicks / TICKS_PER_SECOND;
    // Sanity-gated: a negative, zero, or absurdly long duration is bad data,
    // not a real window worth telling anyone to watch for.
    if (durationSeconds > 0 && durationSeconds <= MAX_REINFORCE_SECONDS) {
      const unix = Math.floor(input.sentAt.getTime() / 1000 + durationSeconds);
      fields.push({
        name: "Reinforcement ends",
        value: `<t:${unix}:F> (<t:${unix}:R>)`,
      });
    }
  }

  // `structureTypeID` is the ONE url input here that is not type-guaranteed
  // numeric: `systemId` arrives from a bigint column, but this comes through
  // `asNumberIfNumeric`, which leaves a value that will not coerce as a raw
  // STRING. Interpolating that straight into a url would build a malformed —
  // or path-traversing — image request out of a notification body. Gate on a
  // positive safe integer so a junk body drops the thumbnail instead.
  const typeIdNumber = Number(input.details.structureTypeID);
  const thumbnail =
    input.details.structureTypeID !== null &&
    input.details.structureTypeID !== undefined &&
    input.details.structureTypeID !== "" &&
    Number.isSafeInteger(typeIdNumber) &&
    typeIdNumber > 0
      ? { url: `https://images.evetech.net/types/${typeIdNumber}/render?size=1024` }
      : undefined;

  const url =
    input.systemId !== null
      ? `https://zkillboard.com/system/${input.systemId}/`
      : undefined;

  return {
    title,
    color,
    ...(description !== undefined ? { description } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(thumbnail !== undefined ? { thumbnail } : {}),
    ...(url !== undefined ? { url } : {}),
    timestamp: input.sentAt.toISOString(),
    footer: { text: `Notification ${input.notificationId}` },
  };
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
