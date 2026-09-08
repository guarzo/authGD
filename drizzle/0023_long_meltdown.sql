ALTER TABLE "fleet_source_intent" ADD COLUMN "fetch_claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_source_intent" ADD COLUMN "enqueue_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_source_intent" ADD COLUMN "latest_outcome" text;--> statement-breakpoint
CREATE INDEX "fleet_source_authority_expiry_idx" ON "fleet_source_authority" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fleet_source_intent_due_idx" ON "fleet_source_intent" USING btree ("next_fetch_at") WHERE "fleet_source_intent"."state" <> 'ended';--> statement-breakpoint
CREATE INDEX "fleet_source_intent_pending_expiry_idx" ON "fleet_source_intent" USING btree ("intent_expires_at") WHERE "fleet_source_intent"."activated_at" is null and "fleet_source_intent"."state" <> 'ended';--> statement-breakpoint
ALTER TABLE "fleet_source_intent" ADD CONSTRAINT "fleet_source_intent_outcome_ck" CHECK ("fleet_source_intent"."latest_outcome" is null or "fleet_source_intent"."latest_outcome" in ('verified', 'service_unavailable', 'untrustworthy_evidence', 'timed_out'));