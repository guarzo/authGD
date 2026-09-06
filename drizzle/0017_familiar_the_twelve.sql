CREATE TABLE "fleet_access_check_gate" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_access_check_gate" ADD CONSTRAINT "fleet_access_check_gate_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;