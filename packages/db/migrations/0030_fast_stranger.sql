ALTER TABLE "agents" DROP CONSTRAINT "agents_manager";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_reports_to_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_reports_to_user_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "reports_to" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_sources" ADD COLUMN "added_by_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_principals_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_terminated_by_principals_id_fk" FOREIGN KEY ("terminated_by") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_sources" ADD CONSTRAINT "skill_sources_added_by_id_principals_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "reports_to_user";--> statement-breakpoint
ALTER TABLE "skill_sources" DROP COLUMN "added_by";