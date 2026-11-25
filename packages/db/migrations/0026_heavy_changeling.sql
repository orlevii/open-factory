ALTER TABLE "agents" DROP CONSTRAINT "agents_ephemeral_manager";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reports_to_user" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_user_users_id_fk" FOREIGN KEY ("reports_to_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager" CHECK (("agents"."kind" = 'ephemeral' AND "agents"."reports_to" IS NOT NULL AND "agents"."reports_to_user" IS NULL)
        OR ("agents"."kind" = 'persistent' AND num_nonnulls("agents"."reports_to", "agents"."reports_to_user") = 1));
--> statement-breakpoint
-- I9 §4.5: a member update may go to a human manager (to_user_id) as well as to a manager agent.
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
    OR (kind = 'member_update' AND from_user_id IS NULL AND (to_agent_id IS NOT NULL OR to_user_id IS NOT NULL)
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
--> statement-breakpoint
ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_kind_check" CHECK (kind IN ('message','mention','task_event','credential','member_update'));
