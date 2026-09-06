ALTER TYPE "public"."oauth_intent" ADD VALUE 'grant-fleet-read';--> statement-breakpoint
ALTER TABLE "oauth_transaction" ADD COLUMN "fleet_read_character_id" bigint;