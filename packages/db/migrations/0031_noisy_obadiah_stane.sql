-- principals: one sender/recipient/author column. The hand-written checks go first (they name the old columns) and are re-issued last.
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_kind_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_recipient_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_recipients";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_from_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_from_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_to_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_to_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_author_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_author_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "messages_to_agent_state_idx";--> statement-breakpoint
DROP INDEX "messages_from_agent_idx";--> statement-breakpoint
DROP INDEX "messages_chat_out_idx";--> statement-breakpoint
DROP INDEX "messages_schedule_pending_idx";--> statement-breakpoint
DROP INDEX "messages_client_id_unique";--> statement-breakpoint
DROP INDEX "messages_chat_in_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "from_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "recipient_ids" text[];--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_id_principals_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_id_principals_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_principals_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_to_state_idx" ON "messages" USING btree ("to_id","state","created_at");--> statement-breakpoint
CREATE INDEX "messages_from_idx" ON "messages" USING btree ("from_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_schedule_pending_idx" ON "messages" USING btree ("schedule_id","to_id") WHERE "messages"."state" IN ('pending','loop_held') AND "messages"."schedule_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_unique" ON "messages" USING btree ("from_id","client_message_id","to_id") WHERE "messages"."client_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_chat_in_idx" ON "messages" USING btree ("to_id","from_id","created_at") WHERE "messages"."kind" = 'message';--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "from_user_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "from_agent_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "to_agent_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "to_user_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "recipients";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "author_agent_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "author_user_id";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipients" CHECK ("messages"."kind" <> 'message' OR "messages"."recipient_ids" IS NOT NULL);
--> statement-breakpoint
-- principals: one sender/recipient/author column (translated clause by clause from 0026 / 0004).
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_kind_check" CHECK (
       (kind = 'message' AND from_id IS NOT NULL AND notice IS NULL AND subject_agent_id IS NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'system' AND from_id IS NULL AND notice IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'member_update' AND to_id IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL
        AND ((from_id IS NOT NULL AND subject_agent_id IS NULL AND notice IS NULL)
          OR (from_id IS NULL AND subject_agent_id IS NOT NULL AND notice IS NOT NULL)))
    OR (kind IN ('peer_joined','peer_left') AND from_id IS NULL
        AND subject_agent_id IS NOT NULL AND notice IS NOT NULL AND to_id IS NOT NULL
        AND task_id IS NULL AND comment_id IS NULL
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'task_assigned' AND from_id IS NULL AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_id IS NOT NULL
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'task_comment' AND from_id IS NOT NULL AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NOT NULL
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'task_update' AND from_id IS NULL
        AND notice IN ('done','cancelled','unblocked','unassigned','status_changed','edited')
        AND subject_agent_id IS NULL AND task_id IS NOT NULL AND comment_id IS NULL AND to_all_humans = false
        AND schedule_id IS NULL AND author_id IS NULL
        AND due_at IS NULL AND firings IS NULL AND late IS NULL)
    OR (kind = 'scheduled' AND from_id IS NULL AND notice IS NULL
        AND subject_agent_id IS NULL AND task_id IS NULL AND comment_id IS NULL AND to_id IS NOT NULL
        AND to_all_humans = false AND schedule_id IS NOT NULL AND author_id IS NOT NULL
        AND due_at IS NOT NULL AND firings IS NOT NULL AND firings >= 1 AND late IS NOT NULL));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_check" CHECK (num_nonnulls(to_id, nullif(to_all_humans, false)) = 1);
