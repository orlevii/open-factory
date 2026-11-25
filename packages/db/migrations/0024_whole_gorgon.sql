CREATE TABLE "loop_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_a" text NOT NULL,
	"agent_b" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resumed_at" timestamp with time zone,
	"resumed_by" text,
	CONSTRAINT "loop_holds_order" CHECK ("loop_holds"."agent_a" < "loop_holds"."agent_b")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "loop_hold_id" text;--> statement-breakpoint
ALTER TABLE "factory_settings" ADD COLUMN "loop_guard_messages" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_settings" ADD COLUMN "loop_guard_window_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "loop_holds" ADD CONSTRAINT "loop_holds_agent_a_agents_id_fk" FOREIGN KEY ("agent_a") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_holds" ADD CONSTRAINT "loop_holds_agent_b_agents_id_fk" FOREIGN KEY ("agent_b") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_holds" ADD CONSTRAINT "loop_holds_resumed_by_users_id_fk" FOREIGN KEY ("resumed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loop_holds_open_unique" ON "loop_holds" USING btree ("agent_a","agent_b") WHERE "loop_holds"."resumed_at" is null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_loop_hold_id_loop_holds_id_fk" FOREIGN KEY ("loop_hold_id") REFERENCES "public"."loop_holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_state_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_state_check"
  CHECK (state IN ('pending','delivered','rejected','cancelled','loop_held'));--> statement-breakpoint
DROP INDEX "messages_schedule_pending_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_schedule_pending_idx" ON "messages" ("schedule_id","to_agent_id")
  WHERE state IN ('pending','loop_held') AND schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "session_events_operator_input_idx" ON "session_events" USING btree ("agent_id","at") WHERE "session_events"."type" = 'operator_input';