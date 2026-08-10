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
        // one named job, re-run on demand; jobType is validated against QUEUES
        // at dispatch time, so an unknown value drops rather than enqueueing
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
