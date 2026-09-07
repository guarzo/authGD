CREATE TABLE "fleet_recovery_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_key_spki_b64" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fleet_recovery_challenge_attempts_ck" CHECK ("fleet_recovery_challenge"."attempts" >= 0 AND "fleet_recovery_challenge"."attempts" <= 5)
);
--> statement-breakpoint
CREATE INDEX "fleet_recovery_challenge_expires_at_idx" ON "fleet_recovery_challenge" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fleet_recovery_challenge_key_expires_idx" ON "fleet_recovery_challenge" USING btree ("public_key_spki_b64","expires_at");