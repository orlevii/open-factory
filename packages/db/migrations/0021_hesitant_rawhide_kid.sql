CREATE TABLE "skill_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"path" text,
	"repo" text,
	"subpath" text,
	"branch" text,
	"commit" text,
	"committed_at" timestamp with time zone,
	"subject" text,
	"trees" jsonb,
	"update_commit" text,
	"update_at" timestamp with time zone,
	"update_subject" text,
	"checked_at" timestamp with time zone,
	"check_error" text,
	"skills" jsonb NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "skill_sources_kind_check" CHECK ("skill_sources"."kind" IN ('folder','github')),
	CONSTRAINT "skill_sources_state_check" CHECK ("skill_sources"."state" IN ('adding','ready')),
	CONSTRAINT "skill_sources_kind_fields_check" CHECK (("skill_sources"."kind" = 'folder' AND "skill_sources"."path" IS NOT NULL)
        OR ("skill_sources"."kind" = 'github' AND "skill_sources"."repo" IS NOT NULL AND "skill_sources"."subpath" IS NOT NULL
          AND "skill_sources"."branch" IS NOT NULL AND "skill_sources"."commit" IS NOT NULL)),
	CONSTRAINT "skill_sources_skills_check" CHECK (jsonb_array_length("skill_sources"."skills") >= 1)
);
