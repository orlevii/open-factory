CREATE TABLE "agent_commands" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"commands" jsonb NOT NULL,
	"claude_code_version" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_commands" ADD CONSTRAINT "agent_commands_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;