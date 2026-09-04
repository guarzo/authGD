CREATE TABLE "fleet_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"public_key_spki_b64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "fleet_device_public_key_spki_b64_unique" UNIQUE("public_key_spki_b64")
);
--> statement-breakpoint
CREATE TABLE "fleet_device_session" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_revision" integer DEFAULT 0 NOT NULL,
	"last_publish_at" timestamp with time zone,
	"last_read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fleet_eligibility" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"fleet_id" bigint NOT NULL,
	"roster_character_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"outcome_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_pairing_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_key_spki_b64" text NOT NULL,
	"challenge_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"approved_account_id" uuid,
	"approved_device_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fleet_publisher_lease" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"fleet_id" bigint NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_telemetry_row" (
	"character_id" bigint PRIMARY KEY NOT NULL,
	"fleet_id" bigint NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"dps" integer NOT NULL,
	"ewar" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"stale_at" timestamp with time zone NOT NULL,
	"hard_expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_device" ADD CONSTRAINT "fleet_device_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_device_session" ADD CONSTRAINT "fleet_device_session_device_id_fleet_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."fleet_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_eligibility" ADD CONSTRAINT "fleet_eligibility_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_eligibility" ADD CONSTRAINT "fleet_eligibility_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_pairing_request" ADD CONSTRAINT "fleet_pairing_request_approved_account_id_account_id_fk" FOREIGN KEY ("approved_account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_pairing_request" ADD CONSTRAINT "fleet_pairing_request_approved_device_id_fleet_device_id_fk" FOREIGN KEY ("approved_device_id") REFERENCES "public"."fleet_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD CONSTRAINT "fleet_publisher_lease_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD CONSTRAINT "fleet_publisher_lease_device_id_fleet_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."fleet_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_publisher_lease" ADD CONSTRAINT "fleet_publisher_lease_session_id_fleet_device_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."fleet_device_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD CONSTRAINT "fleet_telemetry_row_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD CONSTRAINT "fleet_telemetry_row_device_id_fleet_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."fleet_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_telemetry_row" ADD CONSTRAINT "fleet_telemetry_row_session_id_fleet_device_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."fleet_device_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fleet_device_session_expires_at_idx" ON "fleet_device_session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fleet_eligibility_account_id_idx" ON "fleet_eligibility" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "fleet_eligibility_expires_at_idx" ON "fleet_eligibility" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fleet_pairing_request_expires_at_idx" ON "fleet_pairing_request" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fleet_publisher_lease_expires_at_idx" ON "fleet_publisher_lease" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "fleet_telemetry_row_hard_expires_at_idx" ON "fleet_telemetry_row" USING btree ("hard_expires_at");--> statement-breakpoint
CREATE INDEX "fleet_telemetry_row_fleet_hard_expires_idx" ON "fleet_telemetry_row" USING btree ("fleet_id","hard_expires_at");