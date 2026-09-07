CREATE TABLE "fleet_source_authority" (
	"fleet_id" bigint PRIMARY KEY NOT NULL,
	"source_id" uuid,
	"source_generation" integer,
	"authority_generation" integer DEFAULT 0 NOT NULL,
	"linked_characters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "fleet_source_authority_generation_ck" CHECK ("fleet_source_authority"."authority_generation" >= 0 and ("fleet_source_authority"."source_generation" is null or "fleet_source_authority"."source_generation" > 0)),
	CONSTRAINT "fleet_source_authority_binding_ck" CHECK (("fleet_source_authority"."source_id" is null) = ("fleet_source_authority"."source_generation" is null)),
	CONSTRAINT "fleet_source_authority_evidence_ck" CHECK (jsonb_typeof("fleet_source_authority"."linked_characters") = 'array' and jsonb_array_length("fleet_source_authority"."linked_characters") <= 256 and octet_length("fleet_source_authority"."linked_characters"::text) <= 32768 and ("fleet_source_authority"."source_id" is not null or ("fleet_source_authority"."linked_characters" = '[]'::jsonb and "fleet_source_authority"."verified_at" is null and "fleet_source_authority"."expires_at" is null)))
);
--> statement-breakpoint
CREATE TABLE "fleet_source_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"device_id" uuid,
	"boss_character_id" bigint,
	"boss_owner_hash" text,
	"boss_link_epoch" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"intent_created_at" timestamp with time zone NOT NULL,
	"intent_expires_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"fleet_id" bigint,
	"fetch_generation" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_fetch_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"terminal_reason" text,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_source_intent_state_ck" CHECK ("fleet_source_intent"."state" in ('pending', 'active', 'ended')),
	CONSTRAINT "fleet_source_intent_generation_ck" CHECK ("fleet_source_intent"."generation" > 0 and "fleet_source_intent"."fetch_generation" >= 0),
	CONSTRAINT "fleet_source_intent_identity_ck" CHECK ("fleet_source_intent"."state" = 'ended' or ("fleet_source_intent"."account_id" is not null and "fleet_source_intent"."device_id" is not null and "fleet_source_intent"."boss_character_id" > 0 and "fleet_source_intent"."boss_character_id" is not null and "fleet_source_intent"."boss_owner_hash" is not null and "fleet_source_intent"."boss_link_epoch" is not null)),
	CONSTRAINT "fleet_source_intent_terminal_ck" CHECK (("fleet_source_intent"."state" = 'ended') = ("fleet_source_intent"."ended_at" is not null and "fleet_source_intent"."terminal_reason" is not null)),
	CONSTRAINT "fleet_source_intent_time_ck" CHECK ("fleet_source_intent"."intent_expires_at" > "fleet_source_intent"."intent_created_at" and "fleet_source_intent"."retain_until" > "fleet_source_intent"."intent_expires_at")
);
--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "fleet_link_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD COLUMN "source_generation" integer;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD COLUMN "authority_generation" integer;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD COLUMN "link_epoch" uuid;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD COLUMN "participation_generation" integer;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD COLUMN "source_generation" integer;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD COLUMN "authority_generation" integer;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD COLUMN "link_epoch" uuid;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD COLUMN "participation_generation" integer;--> statement-breakpoint
CREATE INDEX "fleet_source_authority_source_idx" ON "fleet_source_authority" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "fleet_source_intent_account_idx" ON "fleet_source_intent" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "fleet_source_intent_boss_idx" ON "fleet_source_intent" USING btree ("boss_character_id");--> statement-breakpoint
CREATE INDEX "fleet_source_intent_device_idx" ON "fleet_source_intent" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "fleet_source_intent_retention_idx" ON "fleet_source_intent" USING btree ("retain_until");