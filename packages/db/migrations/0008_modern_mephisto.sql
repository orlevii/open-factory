CREATE SEQUENCE "task_number_seq";--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"author_agent_id" text,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comments_author_check" CHECK (num_nonnulls("task_comments"."author_agent_id", "task_comments"."author_user_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" text NOT NULL,
	"depends_on_task_id" text NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_self_check" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"actor_agent_id" text,
	"actor_user_id" text,
	"type" text NOT NULL,
	"from_value" jsonb,
	"to_value" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_events_actor_check" CHECK (num_nonnulls("task_events"."actor_agent_id", "task_events"."actor_user_id") = 1),
	CONSTRAINT "task_events_type_check" CHECK ("task_events"."type" IN ('created','status','assignee','title','body','depends_on','links'))
);
--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"target" text,
	"agent_id" text,
	"title" text,
	CONSTRAINT "task_links_kind_check" CHECK ("task_links"."kind" IN ('url','pr','file','agent')),
	CONSTRAINT "task_links_agent_check" CHECK (("task_links"."kind" = 'agent') = ("task_links"."agent_id" IS NOT NULL AND "task_links"."target" IS NULL)),
	CONSTRAINT "task_links_target_check" CHECK ("task_links"."kind" = 'agent' OR "task_links"."target" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"number" integer DEFAULT nextval('task_number_seq') NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_agent_id" text,
	"created_by_agent_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_number_unique" UNIQUE("number"),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('open','in_progress','done','cancelled')),
	CONSTRAINT "tasks_creator_check" CHECK (num_nonnulls("tasks"."created_by_agent_id", "tasks"."created_by_user_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "comment_id" text;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_comments_task_id_id_unique" ON "task_comments" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "task_comments_task_created_idx" ON "task_comments" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_idx" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "task_events_task_at_idx" ON "task_events" USING btree ("task_id","at","id");--> statement-breakpoint
CREATE INDEX "task_links_task_position_idx" ON "task_links" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX "tasks_status_updated_idx" ON "tasks" USING btree ("status","updated_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_status_idx" ON "tasks" USING btree ("assignee_agent_id","status");--> statement-breakpoint
CREATE INDEX "tasks_created_by_agent_idx" ON "tasks" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_user_idx" ON "tasks" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_items_unread_idx" ON "inbox_items" USING btree ("user_id") WHERE "inbox_items"."read_at" is null;
-- S8: a message's comment must belong to its task (MATCH SIMPLE: checked only when both are set).
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_comment_fk" FOREIGN KEY ("task_id","comment_id") REFERENCES "task_comments"("task_id","id");--> statement-breakpoint
-- S8: the three task kinds; every earlier kind gains `task_id IS NULL AND comment_id IS NULL`.
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_kind_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_kind_check" CHECK (
  num_nonnulls(from_user_id, from_agent_id) <= 1 AND (
       (kind = 'message' AND num_nonnulls(from_user_id, from_agent_id) = 1 AND notice IS NULL AND subject_agent_id IS NULL
        AND task_id IS NULL AND comment_id IS NULL)
    OR (kind = 'system' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL)
    OR (kind = 'member_update' AND from_user_id IS NULL AND to_agent_id IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND ((from_agent_id IS NOT NULL AND subject_agent_id IS NULL AND notice IS NULL)
          OR (from_agent_id IS NULL AND subject_agent_id IS NOT NULL AND notice IS NOT NULL)))
    OR (kind IN ('peer_joined','peer_left') AND from_user_id IS NULL AND from_agent_id IS NULL
        AND subject_agent_id IS NOT NULL AND notice IS NOT NULL AND to_agent_id IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL)
    OR (kind = 'task_assigned' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_agent_id IS NOT NULL)
    OR (kind = 'task_comment' AND num_nonnulls(from_user_id, from_agent_id) = 1 AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NOT NULL)
    OR (kind = 'task_update' AND from_user_id IS NULL AND from_agent_id IS NULL
        AND notice IN ('done','cancelled','unblocked','unassigned','status_changed','edited')
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_all_humans = false)));--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_kind_check" CHECK (kind IN ('message','mention','task_event'));--> statement-breakpoint
CREATE INDEX "messages_task_idx" ON "messages" ("task_id") WHERE task_id IS NOT NULL;
