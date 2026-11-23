ALTER TABLE "turns" ADD COLUMN "end_event_seq" integer;--> statement-breakpoint
CREATE INDEX "messages_chat_in_idx" ON "messages" USING btree ("to_agent_id","from_user_id","created_at") WHERE "messages"."kind" = 'message';--> statement-breakpoint
CREATE INDEX "messages_chat_out_idx" ON "messages" USING btree ("to_user_id","from_agent_id","created_at") WHERE "messages"."kind" = 'message';