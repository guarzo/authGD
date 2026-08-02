CREATE TYPE "public"."account_status" AS ENUM('active', 'cryo');--> statement-breakpoint
CREATE TYPE "public"."oauth_intent" AS ENUM('login', 'link-character', 'link-discord');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('ok', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tier" AS ENUM('flygd', 'blue', 'green');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('valid', 'invalid', 'needs_reauth', 'missing');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"tier" "tier" DEFAULT 'green' NOT NULL,
	"tier_changed_at" timestamp with time zone,
	"tier_changed_by" text,
	"tier_locked" boolean DEFAULT false NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"status_note" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"main_character_id" bigint
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "bootstrap_admin_grant" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"owner_hash" text NOT NULL,
	"account_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character" (
	"id" bigint PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"corporation_id" bigint,
	"alliance_id" bigint,
	"affiliation_checked_at" timestamp with time zone,
	"affiliation_invalid" boolean DEFAULT false NOT NULL,
	"owner_hash" text NOT NULL,
	"refresh_token_enc" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_status" "token_status" DEFAULT 'missing' NOT NULL,
	CONSTRAINT "character_id_account_uq" UNIQUE("id","account_id")
);
--> statement-breakpoint
CREATE TABLE "contact_sync_state" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_result" text
);
--> statement-breakpoint
CREATE TABLE "discord_link" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"discord_user_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_link_discord_user_id_unique" UNIQUE("discord_user_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"intent" "oauth_intent" NOT NULL,
	"session_id" text,
	"account_id" uuid,
	"pkce_verifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_transaction_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_run_status",
	"error_summary" text,
	"counts" jsonb
);
--> statement-breakpoint
CREATE TABLE "wanderer_acl_observation" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bootstrap_admin_grant" ADD CONSTRAINT "bootstrap_admin_grant_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character" ADD CONSTRAINT "character_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sync_state" ADD CONSTRAINT "contact_sync_state_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_link" ADD CONSTRAINT "discord_link_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" USING btree ("dispatched_at");