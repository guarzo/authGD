import {
  bigint,
  boolean,
  check,
  index,
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

export const tierEnum = pgEnum("tier", ["flygd", "blue", "green"]);
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

export const account = pgTable("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  tier: tierEnum("tier").notNull().default("green"),
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
  },
  // target for the composite main-character FK on account
  (t) => [unique("character_id_account_uq").on(t.id, t.accountId)],
);

export const discordLink = pgTable("discord_link", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id),
  discordUserId: text("discord_user_id").notNull().unique(),
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
  // supports the Plan 2 expired-session sweep
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
  lastResult: text("last_result"),
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
  (t) => [index("audit_log_at_idx").on(t.at)],
);

export const payoutOperationStatusEnum = pgEnum("payout_operation_status", [
  "draft",
  "finalized",
]);
export const lootValuationSourceEnum = pgEnum("loot_valuation_source", ["appraised", "flat"]);
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
    corpSharePct: numeric("corp_share_pct", { precision: 5, scale: 2 }).notNull().default("0"),
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
    totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull().default("0"),
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
    totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull().default("0"),
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
