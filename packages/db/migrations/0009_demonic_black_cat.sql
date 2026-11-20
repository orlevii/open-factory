CREATE SEQUENCE "schedule_number_seq";--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer DEFAULT nextval('schedule_number_seq') NOT NULL,
	"target_agent_id" text NOT NULL,
	"cron" text,
	"run_at" timestamp with time zone,
	"timezone" text NOT NULL,
	"body" text NOT NULL,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"body_author_agent_id" text,
	"body_author_user_id" text,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_number_unique" UNIQUE("number"),
	CONSTRAINT "schedules_when_check" CHECK (num_nonnulls("schedules"."cron", "schedules"."run_at") = 1),
	CONSTRAINT "schedules_creator_check" CHECK (num_nonnulls("schedules"."created_by_agent_id", "schedules"."created_by_user_id") = 1),
	CONSTRAINT "schedules_author_check" CHECK (num_nonnulls("schedules"."body_author_agent_id", "schedules"."body_author_user_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_agent_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_user_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "firings" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "late" boolean;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_body_author_agent_id_agents_id_fk" FOREIGN KEY ("body_author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_body_author_user_id_users_id_fk" FOREIGN KEY ("body_author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."deleted_at" is null and "schedules"."paused_at" is null and "schedules"."next_run_at" is not null;--> statement-breakpoint
CREATE INDEX "schedules_target_idx" ON "schedules" USING btree ("target_agent_id") WHERE "schedules"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "schedules_creator_idx" ON "schedules" USING btree ("created_by_agent_id") WHERE "schedules"."deleted_at" is null and "schedules"."created_by_agent_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
-- S9: at most one pending firing per schedule and target (the replace path updates that row; a concurrent insert fails).
CREATE UNIQUE INDEX "messages_schedule_pending_idx" ON "messages" ("schedule_id","to_agent_id") WHERE state = 'pending' AND schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_schedule_idx" ON "messages" ("schedule_id") WHERE schedule_id IS NOT NULL;--> statement-breakpoint
-- S9: the `scheduled` kind; every earlier kind gains "no schedule columns".
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_kind_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_kind_check" CHECK (
  num_nonnulls(from_user_id, from_agent_id) <= 1 AND (
       (kind = 'message' AND num_nonnulls(from_user_id, from_agent_id) = 1 AND notice IS NULL AND subject_agent_id IS NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'system' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'member_update' AND from_user_id IS NULL AND to_agent_id IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL
        AND ((from_agent_id IS NOT NULL AND subject_agent_id IS NULL AND notice IS NULL)
          OR (from_agent_id IS NULL AND subject_agent_id IS NOT NULL AND notice IS NOT NULL)))
    OR (kind IN ('peer_joined','peer_left') AND from_user_id IS NULL AND from_agent_id IS NULL
        AND subject_agent_id IS NOT NULL AND notice IS NOT NULL AND to_agent_id IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'task_assigned' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_agent_id IS NOT NULL
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'task_comment' AND num_nonnulls(from_user_id, from_agent_id) = 1 AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NOT NULL
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'task_update' AND from_user_id IS NULL AND from_agent_id IS NULL
        AND notice IN ('done','cancelled','unblocked','unassigned','status_changed','edited')
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_all_humans = false
        AND schedule_id IS NULL AND author_agent_id IS NULL AND author_user_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'scheduled' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NULL AND comment_id IS NULL AND to_agent_id IS NOT NULL
        AND to_user_id IS NULL AND to_all_humans = false AND schedule_id IS NOT NULL AND num_nonnulls(author_agent_id, author_user_id) = 1
        AND due_at IS NOT NULL AND firings IS NOT NULL AND firings >= 1 AND late IS NOT NULL)));
