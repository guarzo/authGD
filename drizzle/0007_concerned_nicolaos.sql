ALTER TYPE "public"."tier" RENAME VALUE 'flygd' TO 'member';--> statement-breakpoint
ALTER TYPE "public"."tier" RENAME VALUE 'blue' TO 'associate';--> statement-breakpoint
ALTER TYPE "public"."tier" RENAME VALUE 'green' TO 'alumni';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "tier" SET DEFAULT 'alumni';
