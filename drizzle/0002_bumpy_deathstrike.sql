DROP INDEX "outbox_undispatched_idx";--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_undispatched_idx" ON "outbox" USING btree ("id") WHERE "outbox"."dispatched_at" IS NULL;