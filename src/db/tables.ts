/**
 * Every table this app owns, in one place.
 *
 * Two callers TRUNCATE the whole set — the test helper between tests
 * (tests/helpers/db.ts) and the dev seed's --reset (scripts/seed-dev.ts).
 * They used to keep separate copies of this list, which drifts silently: a new
 * table missing from one copy leaves stale rows behind and fails no test.
 * tests/seed-dev.ts asserts this list matches the database, so adding a table
 * without adding it here breaks a test instead of leaking rows.
 *
 * `character` is quoted because it is a reserved word in SQL.
 */
export const MANAGED_TABLES = [
  "account",
  '"character"',
  "discord_link",
  "session",
  "bootstrap_admin_grant",
  "outbox",
  "oauth_transaction",
  "contact_sync_state",
  "sync_run",
  "wanderer_acl_observation",
  "audit_log",
  "universe_name",
  "payout_operation",
  "loot_pool",
  "loot_item",
  "payout_participant",
  "payout_payment",
  "access_list_holder",
  "access_list_catalog",
  "access_list_watch",
  "access_list_snapshot",
  "access_list_entry",
  "esi_entity_name",
] as const;

/** Bare table names, unquoted — for comparing against information_schema. */
export const MANAGED_TABLE_NAMES: string[] = MANAGED_TABLES.map((t) =>
  t.replace(/"/g, ""),
);

/**
 * Static SQL built from a hardcoded constant — no user input reaches this, so
 * it is safe to pass through sql.raw().
 */
export const TRUNCATE_ALL_SQL = `TRUNCATE ${MANAGED_TABLES.join(", ")} RESTART IDENTITY CASCADE`;
