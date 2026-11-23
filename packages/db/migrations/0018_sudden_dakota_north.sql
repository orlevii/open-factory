ALTER TABLE "agents" ALTER COLUMN "config" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "last_valid" jsonb;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "last_valid_hash" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "valid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "grants_overridden";