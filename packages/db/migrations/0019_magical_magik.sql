ALTER TABLE "agents" ADD COLUMN "color" smallint;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_color" CHECK ("agents"."color" IS NULL OR "agents"."color" BETWEEN 1 AND 12);