CREATE TYPE "public"."access_list_entry_kind" AS ENUM('character', 'corporation', 'alliance');--> statement-breakpoint
CREATE TYPE "public"."access_list_read_status" AS ENUM('ok', 'not_visible', 'failed');--> statement-breakpoint
CREATE TYPE "public"."esi_entity_kind" AS ENUM('character', 'corporation', 'alliance');--> statement-breakpoint
CREATE TABLE "access_list_catalog" (
	"access_list_id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_by_character_id" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_list_entry" (
	"id" serial PRIMARY KEY NOT NULL,
	"access_list_id" bigint NOT NULL,
	"kind" "access_list_entry_kind" NOT NULL,
	"entity_id" bigint NOT NULL,
	"access" text NOT NULL,
	CONSTRAINT "access_list_entry_uq" UNIQUE("access_list_id","kind","entity_id")
);
--> statement-breakpoint
CREATE TABLE "access_list_holder" (
	"id" integer PRIMARY KEY NOT NULL,
	"character_id" bigint NOT NULL,
	"designated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"designated_by" text NOT NULL,
	CONSTRAINT "access_list_holder_singleton_ck" CHECK ("access_list_holder"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "access_list_snapshot" (
	"access_list_id" bigint PRIMARY KEY NOT NULL,
	"observed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"read_status" "access_list_read_status" NOT NULL,
	"observed_by_character_id" bigint NOT NULL,
	"name" text,
	"description" text,
	"allow_everyone" boolean,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "access_list_watch" (
	"access_list_id" bigint PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "esi_entity_name" (
	"id" bigint PRIMARY KEY NOT NULL,
	"kind" "esi_entity_kind" NOT NULL,
	"name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_list_holder" ADD CONSTRAINT "access_list_holder_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE cascade ON UPDATE no action;