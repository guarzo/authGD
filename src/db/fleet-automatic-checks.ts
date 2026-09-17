import { sql, type SQL } from "drizzle-orm";

// SQL backstops for the two bounded JSON receipt slots. TypeScript $type is not
// validation. Missing JSON keys must fail (CHECK alone admits SQL NULL), and
// casts are guarded by JSON type so malformed external SQL cannot bypass them.
const literal = (value: string) => sql.raw(`'${value.replaceAll("'", "''")}'`);
const text = (value: SQL) => sql`(${value} #>> '{}')`;
const field = (value: SQL, key: string) => sql`(${value}->${literal(key)})`;
function object(value: SQL, keys: readonly string[]): SQL {
  const list = sql`ARRAY[${sql.join(keys.map(literal), sql`, `)}]::text[]`;
  return sql`(jsonb_typeof(${value}) = 'object' AND ${value} ?& ${list} AND ${value} - ${list} = '{}'::jsonb)`;
}
function integer(value: SQL, minimum: number, maximum: number): SQL {
  const n = sql`${text(value)}::numeric`;
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'number' THEN ${n} = trunc(${n}) AND ${n} BETWEEN ${sql.raw(String(minimum))} AND ${sql.raw(String(maximum))} ELSE false END)`;
}
function uuid(value: SQL, v4 = false): SQL {
  const pattern = v4
    ? "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    : "^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
  return sql`(jsonb_typeof(${value}) = 'string' AND ${v4 ? text(value) : sql`lower(${text(value)})`} ~ ${literal(pattern)})`;
}
function nullable(value: SQL, check: SQL): SQL {
  return sql`(${value} = 'null'::jsonb OR ${check})`;
}
function oneOf(value: SQL, values: readonly string[]): SQL {
  return sql`(jsonb_typeof(${value}) = 'string' AND ${text(value)} IN (${sql.join(values.map(literal), sql`, `)}))`;
}
export function fleetFiniteDate(value: SQL): SQL {
  return sql`(${value} >= '0001-01-01T00:00:00Z'::timestamptz AND ${value} < '10000-01-01T00:00:00Z'::timestamptz AND date_trunc('milliseconds', ${value}) = ${value})`;
}
function date(value: SQL): SQL {
  const t = text(value);
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'string' AND ${t} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND left(${t}, 4) <> '0000'
    THEN to_char(${t}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = ${t} ELSE false END)`;
}
function binding(value: SQL): SQL {
  return nullable(
    value,
    sql`${object(value, ["consent_generation"])} AND ${integer(field(value, "consent_generation"), 1, Number.MAX_SAFE_INTEGER)}`,
  );
}
function consent(value: SQL): SQL {
  const g = field(value, "generation"),
    r = field(value, "revision"),
    enabled = field(value, "enabled");
  const device = field(value, "approving_device_id"),
    approved = field(value, "approved_at");
  const disabled = field(value, "disabled_at"),
    reason = field(value, "closed_reason");
  return sql`(${object(value, ["generation", "revision", "enabled", "approving_device_id", "approved_at", "disabled_at", "closed_reason"])} AND
    ${integer(g, 0, Number.MAX_SAFE_INTEGER)} AND ${integer(r, 0, Number.MAX_SAFE_INTEGER)} AND jsonb_typeof(${enabled}) = 'boolean' AND
    (CASE WHEN ${g} = '0'::jsonb THEN ${r} = '0'::jsonb AND ${enabled} = 'false'::jsonb AND ${device} = 'null'::jsonb AND ${approved} = 'null'::jsonb AND ${disabled} = 'null'::jsonb AND ${reason} = 'null'::jsonb
    ELSE ${r} >= ${g} AND ${uuid(device)} AND ${date(approved)} AND
      (CASE WHEN ${enabled} = 'true'::jsonb THEN ${r} < '9007199254740991'::jsonb AND ${disabled} = 'null'::jsonb AND ${reason} = 'null'::jsonb
       ELSE ${date(disabled)} AND ${text(disabled)} >= ${text(approved)} AND ${oneOf(reason, ["explicit_off", "source_stop", "approver_revoked"])} END) END))`;
}
function command(value: SQL, automatic: boolean): SQL {
  const keys = automatic
    ? [
        "protocol",
        "request_id",
        "intent_created_at",
        "enabled",
        "expected_generation",
        "expected_revision",
      ]
    : [
        "protocol",
        "operation",
        "request_id",
        "intent_created_at",
        "source_id",
        "expected_generation",
        "expected_automatic",
      ];
  return sql`(${object(value, keys)} AND ${field(value, "protocol")} = '2'::jsonb AND ${uuid(field(value, "request_id"), true)} AND ${date(field(value, "intent_created_at"))} AND
    ${integer(field(value, "expected_generation"), 0, automatic ? Number.MAX_SAFE_INTEGER : 2147483646)} AND
    ${
      automatic
        ? sql`jsonb_typeof(${field(value, "enabled")}) = 'boolean' AND ${integer(field(value, "expected_revision"), 0, Number.MAX_SAFE_INTEGER)}`
        : sql`${field(value, "operation")} = '"stop"'::jsonb AND ${uuid(field(value, "source_id"))} AND ${binding(field(value, "expected_automatic"))}`
    })`;
}
function source(value: SQL): SQL {
  const reason = field(value, "reason");
  return sql`(${object(value, ["source_id", "generation", "character_id", "state", "reason", "pending_expires_at", "automatic"])} AND
    ${uuid(field(value, "source_id"))} AND ${integer(field(value, "generation"), 1, 2147483647)} AND
    ${nullable(field(value, "character_id"), integer(field(value, "character_id"), 1, Number.MAX_SAFE_INTEGER))} AND
    ${field(value, "state")} = '"ended"'::jsonb AND ${field(value, "pending_expires_at")} = 'null'::jsonb AND
    ${oneOf(reason, ["stopped", "expired", "superseded", "not_in_fleet", "boss_lost", "identity_changed", "fleet_read_invalid", "member_lost", "device_revoked", "token_invalid", "mode_transition", "service_unavailable", "untrustworthy_evidence", "timed_out", "ended"])} AND
    ${binding(field(value, "automatic"))})`;
}
function times(value: SQL, automatic: boolean): SQL {
  const accepted = field(value, "accepted_at"),
    expires = field(value, "expires_at");
  const c = field(value, "command"),
    result = field(value, automatic ? "result" : "consent");
  const intent = field(c, "intent_created_at"),
    approved = field(result, "approved_at"),
    disabled = field(result, "disabled_at");
  return sql`(${date(accepted)} AND ${date(expires)} AND
    ${text(expires)}::timestamptz = ${text(accepted)}::timestamptz + interval '24 hours' AND
    ${text(intent)} <= ${text(accepted)} AND
    (${automatic ? sql`${field(c, "enabled")} = 'false'::jsonb OR` : sql``} ${text(accepted)}::timestamptz < ${text(intent)}::timestamptz + interval '60 seconds') AND
    (${approved} = 'null'::jsonb OR ${text(approved)} <= ${text(accepted)}) AND (${disabled} = 'null'::jsonb OR ${text(disabled)} <= ${text(accepted)}))`;
}
export function fleetAutomaticReceiptCheck(
  value: SQL,
  requestId: SQL,
  expiresAt: SQL,
): SQL {
  const c = field(value, "command"),
    r = field(value, "result");
  return sql`(CASE WHEN octet_length(${value}::text) <= 2048 AND
    ${object(value, ["kind", "command", "accepted_at", "expires_at", "result"])} AND ${field(value, "kind")} = '"automatic"'::jsonb AND
    (${command(c, true)}) IS TRUE AND (${consent(r)}) IS TRUE THEN
    ${times(value, true)} AND ${text(field(c, "request_id"))} = ${requestId}::text AND ${text(field(value, "expires_at"))}::timestamptz = ${expiresAt} AND
    ${field(r, "enabled")} = ${field(c, "enabled")} AND
    ${text(field(r, "generation"))}::numeric = ${text(field(c, "expected_generation"))}::numeric + CASE WHEN ${field(c, "enabled")} = 'true'::jsonb THEN 1 ELSE 0 END AND
    ${text(field(r, "revision"))}::numeric = ${text(field(c, "expected_revision"))}::numeric + 1 AND
    (${field(c, "enabled")} = 'false'::jsonb OR ${text(field(r, "revision"))}::numeric <= 9007199254740990)
    ELSE false END) IS TRUE`;
}
export function fleetStopReceiptCheck(
  value: SQL,
  sourceId: SQL,
  sourceGeneration: SQL,
  consentGeneration: SQL,
  retainUntil: SQL,
): SQL {
  const c = field(value, "command"),
    s = field(value, "source"),
    r = field(value, "consent");
  const b = field(s, "automatic"),
    effect = field(value, "automatic_effect");
  const expected = sql`${text(field(c, "expected_generation"))}::numeric`;
  const actual = sql`${text(field(s, "generation"))}::numeric`;
  const bound = sql`${text(field(b, "consent_generation"))}::numeric`;
  return sql`(CASE WHEN octet_length(${value}::text) <= 2048 AND
    ${object(value, ["kind", "command", "accepted_at", "expires_at", "source", "automatic_effect", "consent"])} AND ${field(value, "kind")} = '"source_stop"'::jsonb AND
    (${command(c, false)}) IS TRUE AND (${source(s)}) IS TRUE AND (${consent(r)}) IS TRUE THEN
    ${times(value, false)} AND lower(${text(field(c, "source_id"))}) = ${sourceId}::text AND lower(${text(field(s, "source_id"))}) = ${sourceId}::text AND
    ${actual} = ${sourceGeneration} AND ${field(c, "expected_automatic")} = ${b} AND
    ((${consentGeneration} IS NULL AND ${b} = 'null'::jsonb) OR (${consentGeneration} IS NOT NULL AND ${bound} = ${consentGeneration})) AND
    ${retainUntil} >= ${text(field(value, "expires_at"))}::timestamptz AND
    (CASE WHEN ${effect} = '"unknown_cancelled"'::jsonb THEN ${expected} = 0 AND ${b} = 'null'::jsonb AND ${actual} = 1
    ELSE ${expected} > 0 AND ${actual} BETWEEN ${expected} AND ${expected} + 1 AND
      (CASE WHEN ${effect} = '"manual_only"'::jsonb THEN ${b} = 'null'::jsonb
       WHEN ${effect} IN ('"disabled_current"'::jsonb, '"current_already_off"'::jsonb) THEN ${bound} = ${text(field(r, "generation"))}::numeric AND ${field(r, "enabled")} = 'false'::jsonb
       WHEN ${effect} = '"older_generation_only"'::jsonb THEN ${bound} < ${text(field(r, "generation"))}::numeric ELSE false END) END)
    ELSE false END) IS TRUE`;
}
