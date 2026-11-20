-- S4 clean cutover: pre-S4 agents (the S3 dev seed) have no template or credential, and v0.1 is unreleased.
-- Their session_events, turns and messages cascade. FACTORY_HOME/agents/<slug>/ folders stay on disk.
DELETE FROM "agents";--> statement-breakpoint
CREATE TABLE "agent_project_grants" (
	"agent_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "agent_project_grants_agent_id_project_id_pk" PRIMARY KEY("agent_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name"),
	CONSTRAINT "projects_host_path_unique" UNIQUE("host_path")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"name" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"config" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "kind" text DEFAULT 'persistent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "config" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reports_to" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "credential_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "grants_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_project_grants" ADD CONSTRAINT "agent_project_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_project_grants" ADD CONSTRAINT "agent_project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;