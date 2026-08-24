CREATE TYPE "public"."structure_alert_status" AS ENUM('seeded', 'pending', 'sent', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."structure_read_status" AS ENUM('ok', 'forbidden', 'failed');--> statement-breakpoint
CREATE TABLE "structure" (
	"structure_id" bigint PRIMARY KEY NOT NULL,
	"corporation_id" bigint NOT NULL,
	"type_id" bigint NOT NULL,
	"type_name" text,
	"system_id" bigint NOT NULL,
	"name" text,
	"state" text NOT NULL,
	"state_timer_start" timestamp with time zone,
	"state_timer_end" timestamp with time zone,
	"fuel_expires" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "structure_event" (
	"notification_id" bigint PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"structure_id" bigint,
	"corporation_id" bigint NOT NULL,
	"alert_status" "structure_alert_status" NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "structure_holder" (
	"id" integer PRIMARY KEY NOT NULL,
	"character_id" bigint NOT NULL,
	"corporation_id" bigint NOT NULL,
	"designated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"designated_by" text NOT NULL,
	"seeded_at" timestamp with time zone,
	CONSTRAINT "structure_holder_singleton_ck" CHECK ("structure_holder"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "structure_read_state" (
	"kind" text NOT NULL,
	"corporation_id" bigint NOT NULL,
	"observed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"read_status" "structure_read_status" NOT NULL,
	"detail" text,
	CONSTRAINT "structure_read_state_kind_corporation_id_pk" PRIMARY KEY("kind","corporation_id")
);
--> statement-breakpoint
ALTER TABLE "structure_holder" ADD CONSTRAINT "structure_holder_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "structure_event_pending_idx" ON "structure_event" USING btree ("corporation_id","alert_status","sent_at");