ALTER TABLE "factory_settings" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_settings" DROP COLUMN "max_running_agents";--> statement-breakpoint
ALTER TABLE "factory_settings" DROP COLUMN "default_warm_window_minutes";--> statement-breakpoint
ALTER TABLE "factory_settings" DROP COLUMN "member_update_debounce_seconds";