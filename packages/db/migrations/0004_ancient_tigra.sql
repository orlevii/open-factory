CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "to_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "from_agent_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "subject_agent_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_user_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_all_humans" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "from_tool_use_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivered_event_seq" integer;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_user_message_unique" ON "inbox_items" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "inbox_items_user_created_idx" ON "inbox_items" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_subject_agent_id_agents_id_fk" FOREIGN KEY ("subject_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_from_agent_idx" ON "messages" USING btree ("from_agent_id","created_at");--> statement-breakpoint
-- S6: agent senders, subject agents and non-agent recipients; rewrites the S5 sender/kind check.
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender_kind_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_kind_check" CHECK (
  num_nonnulls(from_user_id, from_agent_id) <= 1 AND (
       (kind = 'message' AND num_nonnulls(from_user_id, from_agent_id) = 1 AND notice IS NULL AND subject_agent_id IS NULL)
    OR (kind = 'system' AND from_user_id IS NULL AND from_agent_id IS NULL AND notice IS NOT NULL)
    OR (kind = 'member_update' AND from_user_id IS NULL AND to_agent_id IS NOT NULL
        AND ((from_agent_id IS NOT NULL AND subject_agent_id IS NULL AND notice IS NULL)
          OR (from_agent_id IS NULL AND subject_agent_id IS NOT NULL AND notice IS NOT NULL)))
    OR (kind IN ('peer_joined','peer_left') AND from_user_id IS NULL AND from_agent_id IS NULL
        AND subject_agent_id IS NOT NULL AND notice IS NOT NULL AND to_agent_id IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_check"
  CHECK (num_nonnulls(to_agent_id, to_user_id, nullif(to_all_humans, false)) = 1);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_state_check" CHECK (state IN ('pending','delivered','rejected'));--> statement-breakpoint
CREATE INDEX "session_events_tool_use_idx" ON "session_events" ("agent_id", (payload->>'toolUseId')) WHERE type = 'tool_call';
