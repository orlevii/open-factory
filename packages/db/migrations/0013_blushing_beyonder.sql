CREATE TABLE "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"uploader_id" text NOT NULL,
	"stored_path" text NOT NULL,
	"original_name" text NOT NULL,
	"kind" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploads_message_idx" ON "uploads" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "uploads_unsent_idx" ON "uploads" USING btree ("created_at") WHERE "uploads"."message_id" is null;