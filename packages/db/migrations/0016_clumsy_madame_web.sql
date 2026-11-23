DROP INDEX "messages_client_id_unique";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "recipients" text[];--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_unique" ON "messages" USING btree ("from_user_id","client_message_id","to_agent_id") WHERE "messages"."client_message_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipients" CHECK ("messages"."kind" <> 'message' OR "messages"."recipients" IS NOT NULL);