ALTER TABLE "messages" ALTER COLUMN "from_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "attempting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_journal" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "rate_limit_notice_owed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "notice" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rate_limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rate_limit_exact" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- S5: tie sender and kind. S6 rewrites this when agent senders (from_agent) arrive.
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_kind_check" CHECK (
  ("kind" = 'system' AND "from_user_id" IS NULL AND "notice" IS NOT NULL)
  OR ("kind" <> 'system' AND "from_user_id" IS NOT NULL AND "notice" IS NULL)
);
