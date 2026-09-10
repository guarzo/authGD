CREATE TABLE "fleet_device_key_identity" (
	"canonical_spki_b64" text PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"conflicted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "fleet_device_key_identity_device_id_unique" UNIQUE("device_id"),
	CONSTRAINT "fleet_device_key_identity_conflict_ck" CHECK (not "fleet_device_key_identity"."conflicted" or "fleet_device_key_identity"."device_id" is null)
);
--> statement-breakpoint
ALTER TABLE "fleet_recovery_challenge" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "fleet_recovery_challenge" ADD COLUMN "request_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_sharing_gate" ADD COLUMN "key_identity_phase" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_sharing_gate" ADD COLUMN "key_identity_cursor" uuid;--> statement-breakpoint
ALTER TABLE "fleet_device_key_identity" ADD CONSTRAINT "fleet_device_key_identity_device_id_fleet_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."fleet_device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_recovery_challenge" ADD CONSTRAINT "fleet_recovery_challenge_key_request_uq" UNIQUE("public_key_spki_b64","request_id");--> statement-breakpoint
ALTER TABLE "fleet_sharing_gate" ADD CONSTRAINT "fleet_sharing_gate_identity_phase_ck" CHECK ("fleet_sharing_gate"."key_identity_phase" in ('pending', 'reconciling', 'ready'));