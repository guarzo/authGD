import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ContactSyncResult } from "@/core/contact-result";

export const tierEnum = pgEnum("tier", ["member", "associate", "alumni", "pending"]);
export const accountStatusEnum = pgEnum("account_status", ["active", "cryo"]);
export const tokenStatusEnum = pgEnum("token_status", [
  "valid",
  "invalid",
  "needs_reauth",
  "missing",
]);
export const oauthIntentEnum = pgEnum("oauth_intent", [
  "login",
  "link-character",
  "link-discord",
  "grant-fleet-read",
]);
export const syncRunStatusEnum = pgEnum("sync_run_status", ["ok", "partial", "failed"]);
export const accessListReadStatusEnum = pgEnum("access_list_read_status", [
  "ok",
  "not_visible",
  "failed",
]);
export const esiEntityKindEnum = pgEnum("esi_entity_kind", [
  "character",
  "corporation",
  "alliance",
]);
export const accessListEntryKindEnum = pgEnum("access_list_entry_kind", [
  "character",
  "corporation",
  "alliance",
]);

export const structureReadStatusEnum = pgEnum("structure_read_status", [
  "ok",
  "forbidden",
  "failed",
]);
export type StructureReadStatus = (typeof structureReadStatusEnum.enumValues)[number];

/**
 * Four distinct states, not shades of one.
 *
 * `seeded`    — recorded without alerting: this holder had never polled, or no
 *               webhook is configured so there is no recipient.
 * `pending`   — recorded and owed an alert.
 * `sent`      — posted successfully.
 * `abandoned` — was pending when the holder was replaced, and will never be
 *               posted.
 *
 * `abandoned` is not a reuse of `seeded` because the two answer different
 * questions: "deliberately not alerted" versus "owed an alert with no valid
 * recipient". Collapsing them makes it impossible to tell from the table
 * whether a holder swap swallowed a live attack.
 */
export const structureAlertStatusEnum = pgEnum("structure_alert_status", [
  "seeded",
  "pending",
  "sent",
  "abandoned",
]);
export type StructureAlertStatus = (typeof structureAlertStatusEnum.enumValues)[number];
export type AccessListReadStatus = (typeof accessListReadStatusEnum.enumValues)[number];

/**
 * The recorded outcome of one sync run. Exported here rather than re-derived at
 * each use site: two private copies of `(typeof syncRunStatusEnum.enumValues)[number]`
 * are two places to forget when the enum grows.
 */
export type SyncRunStatus = (typeof syncRunStatusEnum.enumValues)[number];

export const account = pgTable("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  tier: tierEnum("tier").notNull().default("alumni"),
  tierChangedAt: timestamp("tier_changed_at", { withTimezone: true }),
  tierChangedBy: text("tier_changed_by"), // account uuid or "system"
  tierLocked: boolean("tier_locked").notNull().default(false),
  status: accountStatusEnum("status").notNull().default("active"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  statusNote: text("status_note"),
  isAdmin: boolean("is_admin").notNull().default(false),
  mainCharacterId: bigint("main_character_id", { mode: "number" }),
});

export const character = pgTable(
  "character",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // EVE character id
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    name: text("name").notNull(),
    corporationId: bigint("corporation_id", { mode: "number" }),
    allianceId: bigint("alliance_id", { mode: "number" }),
    affiliationCheckedAt: timestamp("affiliation_checked_at", { withTimezone: true }),
    affiliationInvalid: boolean("affiliation_invalid").notNull().default(false),
    ownerHash: text("owner_hash").notNull(),
    // New link/incarnation, including unlink/relink ABA and same-account transfers.
    fleetLinkEpoch: uuid("fleet_link_epoch").notNull().defaultRandom(),
    refreshTokenEnc: text("refresh_token_enc"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    tokenStatus: tokenStatusEnum("token_status").notNull().default("missing"),
    // Current location, overwritten in place by the location job every fifteen
    // minutes. All five are nullable, and null means "never read": a character
    // who has not granted `esi-location.read_location.v1` keeps them forever.
    //
    // Fork operators: this is location data about your members that the schema
    // did not hold before — which system each of them is sitting in, and what
    // they are docked in. It is deliberately current-value-only: there is no
    // history table, no audit row on change, and nothing to purge, so a leak
    // or a compromised admin session exposes one snapshot rather than a
    // movement trail. `locationCheckedAt` is never advanced by a failed read,
    // which is what lets the UI state how stale a row is instead of silently
    // blanking it. Dropping these columns degrades both pages to a character
    // name with no second line, and nothing else.
    locationSystemId: bigint("location_system_id", { mode: "number" }),
    locationStationId: bigint("location_station_id", { mode: "number" }),
    locationStructureId: bigint("location_structure_id", { mode: "number" }),
    locationOnline: boolean("location_online"),
    locationCheckedAt: timestamp("location_checked_at", { withTimezone: true }),
  },
  // target for the composite main-character FK on account
  (t) => [unique("character_id_account_uq").on(t.id, t.accountId)],
);

export const discordLink = pgTable("discord_link", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id),
  discordUserId: text("discord_user_id").notNull().unique(),
  // Both nullable and both purely cosmetic: the link is identified by
  // `discordUserId`, and every code path here works with neither set. They
  // exist so a member's Discord row can say who it is in the words the member
  // would use, rather than a snowflake nobody recognises.
  //
  // Fork operators: this is personal data about your members that the schema
  // did not hold before. `username` is the stable @handle, globally unique
  // and how a person is @-mentioned; `displayName` is the guild nickname
  // falling back to the global display name, so it is whatever they chose to
  // be called in your server. Neither is a secret — both are visible to
  // anyone in the same guild — but both land in your database and on the
  // admin members screen, all of them on one page. Dropping the columns
  // degrades the UI to a button with no name beside it and nothing else.
  username: text("username"),
  displayName: text("display_name"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(), // sha256 digest of the opaque cookie value
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // supports the expired-session sweep
  (t) => [index("session_expires_at_idx").on(t.expiresAt)],
);

// Historical snapshot: account reference is nullable and detaches on account
// deletion so the consumed grant row survives forever (it must never be reusable).
export const bootstrapAdminGrant = pgTable("bootstrap_admin_grant", {
  characterId: bigint("character_id", { mode: "number" }).primaryKey(),
  ownerHash: text("owner_hash").notNull(),
  accountId: uuid("account_id").references(() => account.id, {
    onDelete: "set null",
  }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outbox = pgTable(
  "outbox",
  {
    id: serial("id").primaryKey(),
    payload: jsonb("payload")
      .$type<
        | { kind: "account"; accountId: string }
        | { kind: "discord-user"; discordUserId: string }
        | { kind: "membership-recheck" }
        | { kind: "all" }
        | { kind: "fleet-source"; sourceId: string; generation: number }
        // one scheduled/admin-rerunnable job; jobType is validated at dispatch
        // time, so an unknown value drops rather than enqueueing
        // to an arbitrary queue name
        | { kind: "job"; jobType: string }
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  // partial index: only undispatched rows, ordered by id — matches the
  // dispatcher's polling query exactly and stays tiny as history grows
  (t) => [
    index("outbox_undispatched_idx")
      .on(t.id)
      .where(sql`${t.dispatchedAt} IS NULL`),
  ],
);

export const oauthTransaction = pgTable("oauth_transaction", {
  id: uuid("id").primaryKey().defaultRandom(),
  stateHash: text("state_hash").notNull().unique(),
  intent: oauthIntentEnum("intent").notNull(),
  sessionId: text("session_id"),
  accountId: uuid("account_id"),
  // Required by grant-fleet-read handlers, nullable for legacy intents. No FK:
  // deleting/unlinking a character must not erase the grant's intended identity.
  fleetReadCharacterId: bigint("fleet_read_character_id", { mode: "number" }),
  pkceVerifier: text("pkce_verifier").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const contactSyncState = pgTable("contact_sync_state", {
  characterId: bigint("character_id", { mode: "number" })
    .primaryKey()
    .references(() => character.id),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastResult: text("last_result").$type<ContactSyncResult>(),
  /**
   * Free-text context for `lastResult`. Two shapes: the JSON-encoded list of
   * fold-equal candidate names when `last_result = 'label_mismatch'`, and the
   * bare name of the label authGD matched loosely when `last_result = 'ok'`
   * and the member's label differed only in case or surrounding whitespace.
   * Nullable and ALWAYS written (null when inapplicable): `recordResult` does a
   * partial upsert, so a column left out of the set keeps its old value, and a
   * member who fixed their label would keep a stale name in the UI forever.
   */
  lastDetail: text("last_detail"),
});

export const syncRun = pgTable(
  "sync_run",
  {
    id: serial("id").primaryKey(),
    jobType: text("job_type").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: syncRunStatusEnum("status"),
    errorSummary: text("error_summary"),
    counts: jsonb("counts").$type<Record<string, number>>(),
  },
  (t) => [index("sync_run_job_type_id_idx").on(t.jobType, t.id.desc())],
);

export const wandererAclObservation = pgTable("wanderer_acl_observation", {
  characterId: bigint("character_id", { mode: "number" }).primaryKey(),
  role: text("role").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export const universeNameKindEnum = pgEnum("universe_name_kind", [
  "system",
  "station",
  "structure",
]);

/**
 * Name cache for the ids the `character` location columns hold. Fork
 * operators: no personal data lands here — systems, NPC stations and player
 * structures are places, not people — but the `structure` rows do record which
 * citadels your members have docking access to, which is corp-sensitive even
 * though it names nobody. Safe to truncate at any time; it refills on the next
 * job run at the cost of some ESI calls.
 *
 * EVE id ranges do not collide across the three kinds, so `id` alone is a safe
 * primary key and `kind` exists to drive the refresh policy instead: systems
 * and stations are effectively immutable and fetched once, structures are
 * re-fetched after seven days because they can be renamed or destroyed.
 */
export const universeName = pgTable("universe_name", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  kind: universeNameKindEnum("kind").notNull(),
  name: text("name").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The designated ACL holder: the one character whose token reads every watched
 * access list. Singleton by construction — `id` is pinned to 1 by a check
 * constraint, so "replace the holder" is an UPDATE and there is no way to end
 * up with two.
 *
 * The FK CASCADES deliberately. The default (NO ACTION) would make
 * `delete(character)` fail with a constraint violation for whoever happens to
 * be the holder, breaking both existing deletion paths — unlink
 * (src/services/accounts.ts:198-205) and transfer reclaim (:482-505, :583-609).
 * `set null` is not available because the column is NOT NULL, so cascade it is:
 * unlinking the holder's character silently drops the designation and the page
 * falls back to its "no holder designated" state, which it already renders as a
 * first-class case rather than an error.
 */
export const accessListHolder = pgTable(
  "access_list_holder",
  {
    id: integer("id").primaryKey(),
    characterId: bigint("character_id", { mode: "number" })
      .notNull()
      .references(() => character.id, { onDelete: "cascade" }),
    designatedAt: timestamp("designated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    designatedBy: text("designated_by").notNull(), // account uuid or "system"
  },
  (t) => [check("access_list_holder_singleton_ck", sql`${t.id} = 1`)],
);

/**
 * Every list the holder can currently see, and the cache of their names —
 * `/access-lists` returns ids only, so a name costs its own detail call.
 * Discovery reconciles this against what the holder sees rather than rebuilding
 * it, so it stays one holder's world and never a merge of several;
 * `observedByCharacterId` records whose.
 */
export const accessListCatalog = pgTable("access_list_catalog", {
  accessListId: bigint("access_list_id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  observedByCharacterId: bigint("observed_by_character_id", { mode: "number" }).notNull(),
});

/** The shared watchlist. Curated by admins; not per-admin by design. */
export const accessListWatch = pgTable("access_list_watch", {
  accessListId: bigint("access_list_id", { mode: "number" }).primaryKey(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  addedBy: text("added_by").notNull(), // account uuid
});

/**
 * One row per watched list, split from its entries so three states stay
 * distinguishable: read succeeded and the list is empty (row, zero entries),
 * never read (no row), and read failed (row with readStatus ≠ ok and the last
 * good observedAt still in place).
 *
 * Two timestamps, not one. `observedAt` is the last SUCCESSFUL read and is null
 * until there is one; `lastAttemptAt` + `readStatus` + `detail` describe the
 * most recent attempt whether it worked or not. Collapsing them forces a choice
 * between lying about freshness and discarding the failure.
 */
export const accessListSnapshot = pgTable("access_list_snapshot", {
  accessListId: bigint("access_list_id", { mode: "number" }).primaryKey(),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
  readStatus: accessListReadStatusEnum("read_status").notNull(),
  observedByCharacterId: bigint("observed_by_character_id", { mode: "number" }).notNull(),
  name: text("name"),
  description: text("description"),
  allowEveryone: boolean("allow_everyone"),
  detail: text("detail"),
});

/**
 * Membership rows, replaced per list inside the same transaction as its
 * snapshot. `access` is stored verbatim as text: CCP adding a value must not
 * be able to fail a read of a field nothing branches on.
 */
export const accessListEntry = pgTable(
  "access_list_entry",
  {
    id: serial("id").primaryKey(),
    accessListId: bigint("access_list_id", { mode: "number" }).notNull(),
    kind: accessListEntryKindEnum("kind").notNull(),
    entityId: bigint("entity_id", { mode: "number" }).notNull(),
    access: text("access").notNull(),
  },
  (t) => [unique("access_list_entry_uq").on(t.accessListId, t.kind, t.entityId)],
);

/**
 * Name cache for the ids access-list entries carry.
 *
 * Fork operators: unlike `universe_name` above, personal data DOES land here.
 * `character` rows are EVE character names — people, not places — including
 * people who are not your members, since an access list can grant anyone. Corp
 * and alliance names are public. Nothing here is a secret (every one of these
 * names is visible in-game to anyone who looks the id up), but they are stored
 * in your database and rendered on the admin monitor page. Safe to truncate at
 * any time; it refills on the next job run at the cost of some ESI calls, and
 * the page renders unresolved ids bare in the meantime rather than failing.
 *
 * Kept separate from `universe_name` precisely so that table's promise — "no
 * personal data lands here" — stays true.
 */
export const esiEntityName = pgTable("esi_entity_name", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  kind: esiEntityKindEnum("kind").notNull(),
  name: text("name").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(), // account uuid or "system"
    action: text("action").notNull(),
    target: text("target").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("audit_log_at_idx").on(t.at),
    // Serves logAuditIfChanged's "most recent row for this action+target"
    // lookup, and the two equality lookups in src/services/audit.ts that
    // resolve identities — resolveAuditIdentities' `payout.deleted` read and
    // resolveFilterIdentity's.
    //
    // It does NOT serve /admin/audit's action filter: queryAuditLog matches
    // `action` with a LIKE prefix, not equality, and under this deployment's
    // en_US.utf8 collation a plain btree cannot answer `LIKE 'x%'` without
    // text_pattern_ops. EXPLAIN puts it in Filter, not Index Cond. See
    // audit_log_action_pattern_idx below for that case.
    index("audit_log_action_target_id_idx").on(t.action, t.target, t.id.desc()),
    // Serves /admin/audit's action-prefix filter (LIKE 'x%') for the tail
    // case. Measured at the page's real shape — ORDER BY id DESC LIMIT 100,
    // AUDIT_PAGE_SIZE, since the page passes no limit. A recent-heavy prefix
    // is already answered in under 0.2ms by a backward scan of audit_log_pkey
    // and never touches this index, but a prefix with few or no recent rows
    // (including a typo in the free-text filter box) otherwise degrades to a
    // full seq scan — 2.3ms at 40k rows, 26ms at 500k, 52ms at 1M, 80ms at
    // 2M, against a flat 0.08-0.09ms with this index.
    // Action-only (not composite with id) because btree deduplication keeps
    // it small — 304kB at 40k rows, 14MB at 2M — and a composite
    // (action, id DESC) was measured and rejected: no gain, 82MB at 2M since
    // adding id defeats the dedup.
    index("audit_log_action_pattern_idx").on(t.action.op("text_pattern_ops")),
  ],
);

export const payoutOperationStatusEnum = pgEnum("payout_operation_status", [
  "draft",
  "finalized",
]);
export const lootValuationSourceEnum = pgEnum("loot_valuation_source", [
  "appraised",
  "flat",
]);
export const lootPriceSourceEnum = pgEnum("loot_price_source", [
  "triff",
  "manual",
  "unresolved",
]);
export const payoutPaymentKindEnum = pgEnum("payout_payment_kind", ["paid", "reverted"]);

export const payoutOperation = pgTable(
  "payout_operation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    battleReportUrl: text("battle_report_url"),
    createdBy: uuid("created_by").references(() => account.id, { onDelete: "set null" }),
    corpSharePct: numeric("corp_share_pct", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    status: payoutOperationStatusEnum("status").notNull().default("draft"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "payout_operation_corp_pct_ck",
      sql`${t.corpSharePct} >= 0 AND ${t.corpSharePct} <= 100`,
    ),
  ],
);

export const lootPool = pgTable(
  "loot_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => payoutOperation.id, { onDelete: "cascade" }),
    rawPaste: text("raw_paste"),
    valuationSource: lootValuationSourceEnum("valuation_source").notNull(),
    pricingMode: text("pricing_mode"),
    stationId: bigint("station_id", { mode: "number" }),
    regionId: bigint("region_id", { mode: "number" }),
    totalValue: numeric("total_value", { precision: 20, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    appraisedAt: timestamp("appraised_at", { withTimezone: true }),
  },
  (t) => [
    check("loot_pool_total_ck", sql`${t.totalValue} >= 0`),
    check(
      "loot_pool_flat_note_ck",
      sql`${t.valuationSource} <> 'flat' OR (${t.notes} IS NOT NULL AND ${t.notes} <> '')`,
    ),
    check(
      "loot_pool_appraised_fields_ck",
      sql`${t.valuationSource} <> 'appraised' OR (${t.pricingMode} IS NOT NULL AND (${t.stationId} IS NOT NULL) <> (${t.regionId} IS NOT NULL))`,
    ),
  ],
);

export const lootItem = pgTable(
  "loot_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => lootPool.id, { onDelete: "cascade" }),
    typeId: bigint("type_id", { mode: "number" }),
    name: text("name").notNull(),
    qty: bigint("qty", { mode: "number" }).notNull(),
    unitPrice: numeric("unit_price", { precision: 20, scale: 2 }).notNull().default("0"),
    totalValue: numeric("total_value", { precision: 20, scale: 2 })
      .notNull()
      .default("0"),
    priceSource: lootPriceSourceEnum("price_source").notNull(),
  },
  (t) => [
    check("loot_item_qty_ck", sql`${t.qty} > 0`),
    check("loot_item_price_ck", sql`${t.unitPrice} >= 0 AND ${t.totalValue} >= 0`),
  ],
);

export const payoutParticipant = pgTable(
  "payout_participant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => payoutOperation.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => account.id, { onDelete: "set null" }),
    recipientCharacterId: bigint("recipient_character_id", { mode: "number" }).references(
      () => character.id,
      { onDelete: "set null" },
    ),
    displayName: text("display_name").notNull(),
    sourceCharacters: jsonb("source_characters").$type<string[]>().notNull().default([]),
    shares: numeric("shares", { precision: 6, scale: 2 }).notNull().default("1"),
    excluded: boolean("excluded").notNull().default(false),
    amount: numeric("amount", { precision: 20, scale: 2 }).notNull().default("0"),
    paidAmount: numeric("paid_amount", { precision: 20, scale: 2 }),
  },
  (t) => [
    check("payout_participant_shares_ck", sql`${t.shares} > 0`),
    check("payout_participant_amount_ck", sql`${t.amount} >= 0`),
    check(
      "payout_participant_paid_amount_ck",
      sql`${t.paidAmount} IS NULL OR ${t.paidAmount} >= 0`,
    ),
  ],
);

export const payoutPayment = pgTable("payout_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  participantId: uuid("participant_id")
    .notNull()
    .references(() => payoutParticipant.id, { onDelete: "cascade" }),
  kind: payoutPaymentKindEnum("kind").notNull(),
  amount: numeric("amount", { precision: 20, scale: 2 }).notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: uuid("actor").references(() => account.id, { onDelete: "set null" }),
  note: text("note"),
});

/**
 * The designated structure holder. Singleton, like `access_list_holder`.
 *
 * `corporationId` is PINNED at designation rather than read live off
 * `character.corporationId`, which the membership job overwrites every thirty
 * minutes (src/jobs/membership.ts:125). Following it live means a holder who
 * changes corp silently re-rosters against the new corp and stamps
 * `missingSince` on every previous structure — indistinguishable from a mass
 * destruction event, arriving during the exact incident this tool exists for.
 *
 * `seededAt` null means this holder has never completed a poll: the events job
 * records without alerting until it is stamped. `designateHolder` writes it
 * null, so replacing the holder re-seeds.
 */
export const structureHolder = pgTable(
  "structure_holder",
  {
    id: integer("id").primaryKey(),
    characterId: bigint("character_id", { mode: "number" })
      .notNull()
      .references(() => character.id, { onDelete: "cascade" }),
    corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
    designatedAt: timestamp("designated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    designatedBy: text("designated_by").notNull(), // account uuid or "system"
    seededAt: timestamp("seeded_at", { withTimezone: true }),
  },
  (t) => [check("structure_holder_singleton_ck", sql`${t.id} = 1`)],
);

/**
 * Read health, one row per (kind, corporation). Two timestamps for the reason
 * `access_list_snapshot` gives: `observedAt` is the last SUCCESSFUL read and is
 * null until there is one; `lastAttemptAt` + `readStatus` + `detail` describe
 * the most recent attempt either way.
 *
 * Keyed by corporation because the row describes a read against one specific
 * corp. Without it, replacing the holder leaves the previous corp's freshness
 * and 403 state in place and the page calls the new monitor healthy on the
 * strength of a read against a corp it no longer watches.
 */
export const structureReadState = pgTable(
  "structure_read_state",
  {
    kind: text("kind").notNull(), // 'roster' | 'events'
    corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
    readStatus: structureReadStatusEnum("read_status").notNull(),
    detail: text("detail"),
  },
  (t) => [primaryKey({ columns: [t.kind, t.corporationId] })],
);

/**
 * The roster. `state` is stored verbatim as text, not a pgEnum: a state string
 * CCP adds next patch must not be able to fail a read of a field nothing
 * branches on for correctness.
 *
 * `typeName` is denormalized because there is no type-id name cache to use —
 * `universe_name`'s kind enum has no `type` value and `resolveEntityNames`
 * deliberately drops inventory types (src/services/entity-names.ts:76-80).
 *
 * A structure that stops appearing gets `missingSince` stamped, never deleted:
 * never remove on unknown state. From the roster's side a destroyed Astrahus
 * and a 403 are identical; only the event stream tells them apart.
 */
export const structure = pgTable("structure", {
  structureId: bigint("structure_id", { mode: "number" }).primaryKey(),
  corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
  typeId: bigint("type_id", { mode: "number" }).notNull(),
  typeName: text("type_name"),
  systemId: bigint("system_id", { mode: "number" }).notNull(),
  name: text("name"),
  state: text("state").notNull(),
  stateTimerStart: timestamp("state_timer_start", { withTimezone: true }),
  stateTimerEnd: timestamp("state_timer_end", { withTimezone: true }),
  fuelExpires: timestamp("fuel_expires", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  missingSince: timestamp("missing_since", { withTimezone: true }),
});

/**
 * One row per structure notification ever seen. ESI's own `notification_id` is
 * the primary key, which is what makes "seen" idempotent across runs.
 *
 * `corporationId` is stamped at insert from the holder's PINNED corp, not
 * parsed from the body. It is what the sender filters on, so a row recorded
 * under a previous holder can never be posted under a new one.
 *
 * `details` holds ONLY the parsed subset actually rendered. The notifications
 * endpoint returns every notification type for the character — war decs, mail,
 * kill rights, corp applications — and this job persists none of them.
 */
export const structureEvent = pgTable(
  "structure_event",
  {
    notificationId: bigint("notification_id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    structureId: bigint("structure_id", { mode: "number" }),
    corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
    alertStatus: structureAlertStatusEnum("alert_status").notNull(),
    details: jsonb("details").$type<Record<string, string | number | null>>(),
  },
  // Serves the sender's hot path: pending rows for the pinned corp, oldest
  // first. Without it that is a full scan of a table that only grows.
  (t) => [
    index("structure_event_pending_idx").on(t.corporationId, t.alertStatus, t.sentAt),
  ],
);

/**
 * Fleet telemetry relay: durable device consent plus short-lived pairing,
 * session material and a few seconds of DPS/EWAR backing the signed device
 * protocol in `src/lib/fleet-signature.ts` — never a telemetry history. None of these tables store raw combat log content,
 * attacker/target text, EVE tokens, or browser session cookies.
 *
 * Public key material is stored as base64 text (SPKI DER), matching this
 * codebase's existing convention of encoding binary blobs as text rather than
 * native `bytea` — drizzle-orm's pg-core has no bytea column helper, and every
 * other binary value here (`crypto.ts`, `pkceVerifier`, hashed session ids)
 * already does the same.
 */

/** Empty means disabled. Only the explicit operator transition writes this row. */
export const fleetSharingGate = pgTable(
  "fleet_sharing_gate",
  {
    id: integer("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }),
    keyIdentityPhase: text("key_identity_phase")
      .$type<"pending" | "reconciling" | "ready">()
      .notNull()
      .default("pending"),
    keyIdentityCursor: uuid("key_identity_cursor"),
  },
  (t) => [
    check("fleet_sharing_gate_singleton_ck", sql`${t.id} = 1`),
    check(
      "fleet_sharing_gate_identity_phase_ck",
      sql`${t.keyIdentityPhase} in ('pending', 'reconciling', 'ready')`,
    ),
  ],
);

/**
 * A paired device: one Ed25519 public key, tied to the account that approved
 * it. `revokedAt` is a soft revoke — the row survives so `fleet_pairing_
 * request.approvedDeviceId` keeps meaning — while `revokeFleetDevice`
 * deletes its sessions/leases/rows explicitly. The CASCADE from
 * `accountId` is the schema-level backstop: deleting an account tears down
 * every device (and, transitively, every session/lease/row) it ever paired,
 * even if a future code path forgets to call that service first.
 *
 * `publicKeySpkiB64` MUST be `canonicalDevicePublicKeyB64`'s output
 * (`src/lib/fleet-signature.ts`) — padded, standard base64 of the raw SPKI
 * DER bytes — never a caller-supplied encoding. The UNIQUE constraint
 * compares this column as literal text, so two encodings of the identical
 * key (base64url vs. base64, padded vs. unpadded) would otherwise both
 * insert successfully and defeat it. The constraint is also NOT scoped by
 * `revokedAt`: a key that was ever inserted here, revoked or not, can never
 * be inserted again. Re-pairing after revocation is by design a new local
 * key pair, not the old one. This raw-DER text uniqueness is the legacy
 * constraint, not DER identity: after explicit reconciliation, registration
 * additionally uses fleetDeviceKeyIdentity and stores re-exported canonical DER.
 * Original raw legacy records are never rewritten or merged.
 */
export const fleetDevice = pgTable("fleet_device", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id, { onDelete: "cascade" }),
  publicKeySpkiB64: text("public_key_spki_b64").notNull().unique(),
  approvedCapabilities: jsonb("approved_capabilities")
    .$type<string[]>()
    .notNull()
    .default([]),
  participationEnabled: boolean("participation_enabled").notNull().default(false),
  participationGeneration: integer("participation_generation").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * A device's request to pair, before a browser-approved account exists for it.
 * The device submits its candidate Ed25519 public key and must later prove
 * possession of the matching private key by signing `challengeDigest`'s
 * pre-image to complete pairing — approval alone is not enough.
 *
 * `approvedAccountId`/`approvedDeviceId` are set once, at approval and at
 * completion respectively, and both CASCADE: this row has no independent
 * value once its account or device is gone, unlike the audit-quality
 * `bootstrap_admin_grant` pattern elsewhere in this schema.
 *
 * `publicKeySpkiB64` here follows the same canonicalization contract as
 * `fleet_device.publicKeySpkiB64` above — see that column's comment.
 */
export const fleetPairingRequest = pgTable(
  "fleet_pairing_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicKeySpkiB64: text("public_key_spki_b64").notNull(),
    challengeDigest: text("challenge_digest").notNull(),
    // Immutable request scope: the browser approves this, not completion input.
    requestedCapabilities: jsonb("requested_capabilities")
      .$type<string[]>()
      .notNull()
      .default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    approvedAccountId: uuid("approved_account_id").references(() => account.id, {
      onDelete: "cascade",
    }),
    approvedDeviceId: uuid("approved_device_id").references(() => fleetDevice.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [index("fleet_pairing_request_expires_at_idx").on(t.expiresAt)],
);

/** Derived, collision-aware key identity. Null/nonconflicted is a deleted-binding
 * tombstone, never a free key. No original device, grants or revocations are merged. */
export const fleetDeviceKeyIdentity = pgTable(
  "fleet_device_key_identity",
  {
    canonicalSpkiB64: text("canonical_spki_b64").primaryKey(),
    deviceId: uuid("device_id")
      .unique()
      .references(() => fleetDevice.id, { onDelete: "set null" }),
    conflicted: boolean("conflicted").notNull().default(false),
  },
  (t) => [
    check(
      "fleet_device_key_identity_conflict_ck",
      sql`not ${t.conflicted} or ${t.deviceId} is null`,
    ),
  ],
);

/** Signer-authorized challenges have no device/account FK so conflicts/revocations
 * remain completion-only outcomes. Consumed rows remain until expiry for replay
 * protection and admission bounds. Legacy null request fields never authorize. */
export const fleetRecoveryChallenge = pgTable(
  "fleet_recovery_challenge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicKeySpkiB64: text("public_key_spki_b64").notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    requestId: text("request_id"),
    requestIssuedAt: timestamp("request_issued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    unique("fleet_recovery_challenge_key_request_uq").on(t.publicKeySpkiB64, t.requestId),
    index("fleet_recovery_challenge_expires_at_idx").on(t.expiresAt),
    index("fleet_recovery_challenge_key_expires_idx").on(t.publicKeySpkiB64, t.expiresAt),
    check(
      "fleet_recovery_challenge_attempts_ck",
      sql`${t.attempts} >= 0 AND ${t.attempts} <= 5`,
    ),
  ],
);

/**
 * A short-lived signed-in device session. `id` is the SHA-256 digest of the
 * opaque session value the device holds — the same "store the hash, not the
 * secret" shape as the browser `session` table above — so a leaked database
 * row cannot be replayed as a session. `lastRevision` is the server's high-
 * water mark for `X-Fleet-Revision`: a publish must submit a strictly greater
 * value, which is what makes a captured-and-replayed signed request inert.
 */
export const fleetDeviceSession = pgTable(
  "fleet_device_session",
  {
    id: text("id").primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => fleetDevice.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Write once at issuance. A later pairing may upgrade the device, never this ceiling.
    approvedCapabilities: jsonb("approved_capabilities")
      .$type<string[]>()
      .notNull()
      .default([]),
    acknowledgedCapabilities: jsonb("acknowledged_capabilities")
      .$type<string[]>()
      .notNull()
      .default([]),
    lastRevision: integer("last_revision").notNull().default(0),
    lastPublishAt: timestamp("last_publish_at", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [index("fleet_device_session_expires_at_idx").on(t.expiresAt)],
);

/** Immutable consent bindings intentionally have NO cascading FKs. Ended intents
 * are retry fences, including after character/account/device deletion. A later
 * Start must still bound intentCreatedAt after retention cleanup (Task 4).
 * These rows do not, by themselves, authorize any shared read or publication. */
export const fleetSourceIntent = pgTable(
  "fleet_source_intent",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id"),
    deviceId: uuid("device_id"),
    bossCharacterId: bigint("boss_character_id", { mode: "number" }),
    bossOwnerHash: text("boss_owner_hash"),
    bossLinkEpoch: uuid("boss_link_epoch"),
    generation: integer("generation").notNull().default(1),
    state: text("state").$type<"pending" | "active" | "paused" | "ended">().notNull(),
    intentCreatedAt: timestamp("intent_created_at", { withTimezone: true }).notNull(),
    intentExpiresAt: timestamp("intent_expires_at", { withTimezone: true }).notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    fleetId: bigint("fleet_id", { mode: "number" }),
    fetchGeneration: integer("fetch_generation").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }),
    fetchClaimExpiresAt: timestamp("fetch_claim_expires_at", { withTimezone: true }),
    enqueueUntil: timestamp("enqueue_until", { withTimezone: true }),
    latestOutcome: text("latest_outcome").$type<
      "verified" | "service_unavailable" | "untrustworthy_evidence" | "timed_out"
    >(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("fleet_source_intent_account_idx").on(t.accountId),
    index("fleet_source_intent_boss_idx").on(t.bossCharacterId),
    index("fleet_source_intent_device_idx").on(t.deviceId),
    index("fleet_source_intent_retention_idx").on(t.retainUntil),
    index("fleet_source_intent_due_idx")
      .on(t.nextFetchAt)
      .where(sql`${t.state} <> 'ended'`),
    index("fleet_source_intent_pending_expiry_idx")
      .on(t.intentExpiresAt)
      .where(sql`${t.activatedAt} is null and ${t.state} <> 'ended'`),
    check(
      "fleet_source_intent_outcome_ck",
      sql`${t.latestOutcome} is null or ${t.latestOutcome} in ('verified', 'service_unavailable', 'untrustworthy_evidence', 'timed_out')`,
    ),
    check(
      "fleet_source_intent_state_ck",
      sql`${t.state} in ('pending', 'active', 'paused', 'ended')`,
    ),
    check(
      "fleet_source_intent_generation_ck",
      sql`${t.generation} > 0 and ${t.fetchGeneration} >= 0`,
    ),
    check(
      "fleet_source_intent_identity_ck",
      sql`${t.state} = 'ended' or (${t.accountId} is not null and ${t.deviceId} is not null and ${t.bossCharacterId} > 0 and ${t.bossCharacterId} is not null and ${t.bossOwnerHash} is not null and ${t.bossLinkEpoch} is not null)`,
    ),
    check(
      "fleet_source_intent_terminal_ck",
      sql`(${t.state} = 'ended') = (${t.endedAt} is not null and ${t.terminalReason} is not null)`,
    ),
    check(
      "fleet_source_intent_time_ck",
      sql`${t.intentExpiresAt} > ${t.intentCreatedAt} and ${t.retainUntil} > ${t.intentExpiresAt}`,
    ),
  ],
);

/** One durable slot per fleet, including empty slots. Authority generations never
 * reset on withdrawal. Evidence contains linked IDs/epochs only, no ESI roster
 * payload or unlinked character identities. Task 4 owns proof publication. */
export const fleetSourceAuthority = pgTable(
  "fleet_source_authority",
  {
    fleetId: bigint("fleet_id", { mode: "number" }).primaryKey(),
    sourceId: uuid("source_id"),
    sourceGeneration: integer("source_generation"),
    authorityGeneration: integer("authority_generation").notNull().default(0),
    linkedCharacters: jsonb("linked_characters")
      .$type<{ characterId: number; linkEpoch: string }[]>()
      .notNull()
      .default([]),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("fleet_source_authority_source_idx").on(t.sourceId),
    index("fleet_source_authority_expiry_idx").on(t.expiresAt),
    check(
      "fleet_source_authority_generation_ck",
      sql`${t.authorityGeneration} >= 0 and (${t.sourceGeneration} is null or ${t.sourceGeneration} > 0)`,
    ),
    check(
      "fleet_source_authority_binding_ck",
      sql`(${t.sourceId} is null) = (${t.sourceGeneration} is null)`,
    ),
    check(
      "fleet_source_authority_evidence_ck",
      sql`jsonb_typeof(${t.linkedCharacters}) = 'array' and jsonb_array_length(${t.linkedCharacters}) <= 256 and octet_length(${t.linkedCharacters}::text) <= 32768 and (${t.sourceId} is not null or (${t.linkedCharacters} = '[]'::jsonb and ${t.verifiedAt} is null and ${t.expiresAt} is null))`,
    ),
  ],
);

/** One operational cooldown per account; the manual check retains no roster evidence. */
export const fleetAccessCheckGate = pgTable("fleet_access_check_gate", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id, { onDelete: "cascade" }),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }).notNull(),
});

/**
 * Legacy materialized fleet eligibility. No supported production writer or
 * compatibility mirror may populate it; the cutover deletes it and shared
 * admission never uses it. Retained for additive-schema/old-reader compatibility.
 * Legacy relay routes only read it; they never call ESI (Global Constraints).
 * `rosterCharacterIds` holds ONLY character ids: no name, ship, or system, so
 * a leaked row exposes fleet composition by id and nothing else about it.
 * `outcomeCode` is stored verbatim as text, not an enum — like `structure.
 * state` above, a new outcome this schema doesn't yet branch on must not be
 * able to fail a read.
 */
export const fleetEligibility = pgTable(
  "fleet_eligibility",
  {
    characterId: bigint("character_id", { mode: "number" })
      .primaryKey()
      .references(() => character.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    fleetId: bigint("fleet_id", { mode: "number" }).notNull(),
    rosterCharacterIds: jsonb("roster_character_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    outcomeCode: text("outcome_code").notNull(),
  },
  (t) => [
    index("fleet_eligibility_account_id_idx").on(t.accountId),
    index("fleet_eligibility_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * One EVE character publishes through at most one device/session at a time,
 * globally — this is what a global `characterId` primary key enforces. A
 * second device claiming the same character must fail closed rather than
 * silently taking over, which is why the relay core checks this
 * row's device/session before accepting a publish.
 */
export const fleetPublisherLease = pgTable(
  "fleet_publisher_lease",
  {
    characterId: bigint("character_id", { mode: "number" })
      .primaryKey()
      .references(() => character.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => fleetDevice.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => fleetDeviceSession.id, { onDelete: "cascade" }),
    fleetId: bigint("fleet_id", { mode: "number" }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    sourceId: uuid("source_id"),
    sourceGeneration: integer("source_generation"),
    authorityGeneration: integer("authority_generation"),
    linkEpoch: uuid("link_epoch"),
    participationGeneration: integer("participation_generation"),
  },
  (t) => [index("fleet_publisher_lease_expires_at_idx").on(t.leaseExpiresAt)],
);

/**
 * The current sparse remote row for one character — the only thing a reader
 * ever sees. Deliberately narrow: character id, fleet id, DPS, EWAR, and
 * three timestamps. No log content, no target/source, no event time, no
 * fleet name, no system, no ship, no EVE token — an accepted empty publish
 * batch deletes this row immediately, so its mere presence already
 * means "live as of `receivedAt`".
 *
 * `staleAt`/`hardExpiresAt` are stored, not recomputed at read time, so the
 * per-fleet expiry sweep and the filtered read can use a plain index
 * instead of an expression on `receivedAt` — this table's `(fleet_id,
 * hard_expires_at)` index below is exactly that sweep's shape.
 */
export const fleetTelemetryRow = pgTable(
  "fleet_telemetry_row",
  {
    characterId: bigint("character_id", { mode: "number" })
      .primaryKey()
      .references(() => character.id, { onDelete: "cascade" }),
    fleetId: bigint("fleet_id", { mode: "number" }).notNull(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => fleetDevice.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => fleetDeviceSession.id, { onDelete: "cascade" }),
    // Nullable provenance is only a targeted-cleanup seam, never admission proof.
    sourceId: uuid("source_id"),
    sourceGeneration: integer("source_generation"),
    authorityGeneration: integer("authority_generation"),
    linkEpoch: uuid("link_epoch"),
    participationGeneration: integer("participation_generation"),
    // Only accepted publications stamp this. Existing rows remain unobserved;
    // no default/backfill can invent a publication at migration or read time.
    publicationId: uuid("publication_id"),
    dps: integer("dps").notNull(),
    // Only `[]` or `["SCRAM/POINT"]` are meaningful values (`PublishedRow.
    // ewar`'s union, `src/services/fleet-relay.ts`) — the CHECK constraint below is the only
    // thing stopping an arbitrary JSON array from being persisted here, since
    // jsonb has no way to express "array of this one literal, 0 or 1 times"
    // in its column type.
    ewar: jsonb("ewar").$type<string[]>().notNull().default([]),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
    hardExpiresAt: timestamp("hard_expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("fleet_telemetry_row_hard_expires_at_idx").on(t.hardExpiresAt),
    index("fleet_telemetry_row_fleet_hard_expires_idx").on(t.fleetId, t.hardExpiresAt),
    check(
      "fleet_telemetry_row_ewar_ck",
      sql`${t.ewar} = '[]'::jsonb OR ${t.ewar} = '["SCRAM/POINT"]'::jsonb`,
    ),
  ],
);
