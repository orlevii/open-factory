CREATE TABLE "handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handles_kind" CHECK ("handles"."kind" IN ('agent','user'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_slug_handles_handle_fk" FOREIGN KEY ("slug") REFERENCES "public"."handles"("handle") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_handles_handle_fk" FOREIGN KEY ("handle") REFERENCES "public"."handles"("handle") ON DELETE no action ON UPDATE no action;