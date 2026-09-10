CREATE TABLE "fleet_sharing_gate" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"transitioned_at" timestamp with time zone,
	CONSTRAINT "fleet_sharing_gate_singleton_ck" CHECK ("fleet_sharing_gate"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "fleet_device" ADD COLUMN "approved_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_device" ADD COLUMN "participation_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_device" ADD COLUMN "participation_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_device_session" ADD COLUMN "approved_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_device_session" ADD COLUMN "acknowledged_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_pairing_request" ADD COLUMN "requested_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;