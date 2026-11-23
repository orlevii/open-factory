ALTER TABLE "messages" ADD COLUMN "subject_credential_id" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "expiry_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_subject_credential_id_credentials_id_fk" FOREIGN KEY ("subject_credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" DROP CONSTRAINT "inbox_items_kind_check";--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_kind_check" CHECK (kind IN ('message','mention','task_event','credential'));
