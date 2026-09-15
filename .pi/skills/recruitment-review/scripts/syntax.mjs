export const SAFE_ID_PATTERN = String.raw`[A-Za-z0-9_-]{1,128}`;

const SAFE_ID = new RegExp(`^${SAFE_ID_PATTERN}$`);
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

export function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function isUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}
