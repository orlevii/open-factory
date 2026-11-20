CREATE TABLE "factory_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"max_running_agents" integer DEFAULT 8 NOT NULL,
	"default_warm_window_minutes" integer DEFAULT 70 NOT NULL,
	"member_update_debounce_seconds" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_used_by_unique" UNIQUE("used_by")
);
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "credential_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_by" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rl_status" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rl_type" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rl_utilization" real;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rl_resets_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rl_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "factory_settings" ADD CONSTRAINT "factory_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turns_task_idx" ON "turns" USING btree ("task_id") WHERE "turns"."task_id" is not null;--> statement-breakpoint
CREATE INDEX "turns_credential_started_idx" ON "turns" USING btree ("credential_id","started_at");--> statement-breakpoint
CREATE INDEX "turns_started_idx" ON "turns" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "factory_settings" ADD CONSTRAINT "factory_settings_singleton" CHECK ("id" = 1);--> statement-breakpoint
INSERT INTO "factory_settings" ("id") VALUES (1);
