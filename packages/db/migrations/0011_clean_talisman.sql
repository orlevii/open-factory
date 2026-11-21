ALTER TABLE "messages" ADD COLUMN "client_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_unique" ON "messages" USING btree ("from_user_id","client_message_id") WHERE "messages"."client_message_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_state_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_state_check" CHECK (state IN ('pending','delivered','rejected','cancelled'));
