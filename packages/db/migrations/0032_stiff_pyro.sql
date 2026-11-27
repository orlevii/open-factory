ALTER TABLE "schedules" DROP CONSTRAINT "schedules_creator_check";--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_author_check";--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT "task_comments_author_check";--> statement-breakpoint
ALTER TABLE "task_events" DROP CONSTRAINT "task_events_actor_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_creator_check";--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_created_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_body_author_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_body_author_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT "task_comments_author_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT "task_comments_author_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "task_events" DROP CONSTRAINT "task_events_actor_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "task_events" DROP CONSTRAINT "task_events_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "tasks_created_by_agent_idx";--> statement-breakpoint
DROP INDEX "tasks_created_by_user_idx";--> statement-breakpoint
DROP INDEX "schedules_creator_idx";--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "created_by_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "body_author_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "task_comments" ADD COLUMN "author_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "task_events" ADD COLUMN "actor_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_id_principals_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_body_author_id_principals_id_fk" FOREIGN KEY ("body_author_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_principals_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_id_principals_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_principals_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "schedules_creator_idx" ON "schedules" USING btree ("created_by_id") WHERE "schedules"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "created_by_agent_id";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "created_by_user_id";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "body_author_agent_id";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "body_author_user_id";--> statement-breakpoint
ALTER TABLE "task_comments" DROP COLUMN "author_agent_id";--> statement-breakpoint
ALTER TABLE "task_comments" DROP COLUMN "author_user_id";--> statement-breakpoint
ALTER TABLE "task_events" DROP COLUMN "actor_agent_id";--> statement-breakpoint
ALTER TABLE "task_events" DROP COLUMN "actor_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "created_by_agent_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "created_by_user_id";