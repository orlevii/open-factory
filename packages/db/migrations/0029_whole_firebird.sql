CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"handle" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_kind" CHECK ("principals"."kind" IN ('agent','human'))
);
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_slug_handles_handle_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_handle_handles_handle_fk";
--> statement-breakpoint
-- principals replace handles
ALTER TABLE "handles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "handles";--> statement-breakpoint
DROP INDEX "users_handle_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "principals_handle_unique" ON "principals" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_ref_unique" ON "principals" USING btree ("ref");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_id_principals_id_fk" FOREIGN KEY ("id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_principals_id_fk" FOREIGN KEY ("id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "handle";