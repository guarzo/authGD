import {
  bigint,
  boolean,
  index,
  jsonb,
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
