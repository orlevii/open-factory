ALTER TABLE "agents" DROP CONSTRAINT "agents_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "credential_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "terminated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "terminated_by" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace_pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_spawned_idx" ON "agents" USING btree ("reports_to","created_at") WHERE "agents"."kind" = 'ephemeral';--> statement-breakpoint
CREATE INDEX "agents_ended_idx" ON "agents" USING btree (coalesce("terminated_at", "archived_at") desc) WHERE "agents"."terminated_at" is not null or "agents"."archived_at" is not null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_live_credential" CHECK ("agents"."credential_id" IS NOT NULL OR "agents"."terminated_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_kind" CHECK ("agents"."kind" IN ('persistent','ephemeral'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_terminated_ephemeral" CHECK ("agents"."kind" = 'ephemeral' OR ("agents"."terminated_at" IS NULL AND "agents"."terminated_by" IS NULL));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_ephemeral_manager" CHECK ("agents"."kind" = 'persistent' OR "agents"."reports_to" IS NOT NULL);