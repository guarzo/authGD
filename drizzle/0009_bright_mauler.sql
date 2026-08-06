CREATE TYPE "public"."universe_name_kind" AS ENUM('system', 'station', 'structure');--> statement-breakpoint
CREATE TABLE "universe_name" (
	"id" bigint PRIMARY KEY NOT NULL,
	"kind" "universe_name_kind" NOT NULL,
	"name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "location_system_id" bigint;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "location_station_id" bigint;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "location_structure_id" bigint;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "location_online" boolean;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "location_checked_at" timestamp with time zone;