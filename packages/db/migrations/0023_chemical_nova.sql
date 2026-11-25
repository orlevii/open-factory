ALTER TABLE "agents" ADD COLUMN "manage_org" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "description_by" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_description_by_agents_id_fk" FOREIGN KEY ("description_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manage_org_persistent" CHECK (NOT "agents"."manage_org" OR "agents"."kind" = 'persistent');