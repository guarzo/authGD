CREATE TYPE "public"."loot_price_source" AS ENUM('triff', 'manual', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."loot_valuation_source" AS ENUM('appraised', 'flat');--> statement-breakpoint
CREATE TYPE "public"."payout_operation_status" AS ENUM('draft', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."payout_payment_kind" AS ENUM('paid', 'reverted');--> statement-breakpoint
CREATE TABLE "loot_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"type_id" bigint,
	"name" text NOT NULL,
	"qty" bigint NOT NULL,
	"unit_price" numeric(20, 2) DEFAULT '0' NOT NULL,
	"total_value" numeric(20, 2) DEFAULT '0' NOT NULL,
	"price_source" "loot_price_source" NOT NULL,
	CONSTRAINT "loot_item_qty_ck" CHECK ("loot_item"."qty" > 0),
	CONSTRAINT "loot_item_price_ck" CHECK ("loot_item"."unit_price" >= 0 AND "loot_item"."total_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loot_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"raw_paste" text,
	"valuation_source" "loot_valuation_source" NOT NULL,
	"pricing_mode" text,
	"station_id" bigint,
	"region_id" bigint,
	"total_value" numeric(20, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"appraised_at" timestamp with time zone,
	CONSTRAINT "loot_pool_total_ck" CHECK ("loot_pool"."total_value" >= 0),
	CONSTRAINT "loot_pool_flat_note_ck" CHECK ("loot_pool"."valuation_source" <> 'flat' OR ("loot_pool"."notes" IS NOT NULL AND "loot_pool"."notes" <> '')),
	CONSTRAINT "loot_pool_appraised_fields_ck" CHECK ("loot_pool"."valuation_source" <> 'appraised' OR ("loot_pool"."pricing_mode" IS NOT NULL AND ("loot_pool"."station_id" IS NOT NULL) <> ("loot_pool"."region_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "payout_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"battle_report_url" text,
	"created_by" uuid,
	"corp_share_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"status" "payout_operation_status" DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_operation_corp_pct_ck" CHECK ("payout_operation"."corp_share_pct" >= 0 AND "payout_operation"."corp_share_pct" <= 100)
);
--> statement-breakpoint
CREATE TABLE "payout_participant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"account_id" uuid,
	"recipient_character_id" bigint,
	"display_name" text NOT NULL,
	"source_characters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shares" numeric(6, 2) DEFAULT '1' NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"amount" numeric(20, 2) DEFAULT '0' NOT NULL,
	"paid_amount" numeric(20, 2),
	CONSTRAINT "payout_participant_shares_ck" CHECK ("payout_participant"."shares" > 0),
	CONSTRAINT "payout_participant_amount_ck" CHECK ("payout_participant"."amount" >= 0),
	CONSTRAINT "payout_participant_paid_amount_ck" CHECK ("payout_participant"."paid_amount" IS NULL OR "payout_participant"."paid_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payout_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"participant_id" uuid NOT NULL,
	"kind" "payout_payment_kind" NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" uuid,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "loot_item" ADD CONSTRAINT "loot_item_pool_id_loot_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."loot_pool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loot_pool" ADD CONSTRAINT "loot_pool_operation_id_payout_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payout_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_operation" ADD CONSTRAINT "payout_operation_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_participant" ADD CONSTRAINT "payout_participant_operation_id_payout_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payout_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_participant" ADD CONSTRAINT "payout_participant_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_participant" ADD CONSTRAINT "payout_participant_recipient_character_id_character_id_fk" FOREIGN KEY ("recipient_character_id") REFERENCES "public"."character"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_payment" ADD CONSTRAINT "payout_payment_participant_id_payout_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."payout_participant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_payment" ADD CONSTRAINT "payout_payment_actor_account_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;