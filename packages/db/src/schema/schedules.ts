import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";
import { principals } from "./principals.ts";

/**
 * S9 spec §5. `number` comes from `schedule_number_seq` (created by hand in the migration); the key is
 * `S-<number>`. There is no status column: deleted, paused and done are derived from the timestamps.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull().unique().default(sql`nextval('schedule_number_seq')`),
    targetAgentId: text("target_agent_id")
      .notNull()
      .references(() => agents.id),
    cron: text("cron"),
    runAt: timestamp("run_at", { withTimezone: true }),
    timezone: text("timezone").notNull(),
    body: text("body").notNull(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => principals.id),
    bodyAuthorId: text("body_author_id")
      .notNull()
      .references(() => principals.id),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    failCount: integer("fail_count").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("schedules_when_check", sql`num_nonnulls(${t.cron}, ${t.runAt}) = 1`),
    index("schedules_due_idx")
      .on(t.nextRunAt)
      .where(sql`${t.deletedAt} is null and ${t.pausedAt} is null and ${t.nextRunAt} is not null`),
    index("schedules_target_idx").on(t.targetAgentId).where(sql`${t.deletedAt} is null`),
    index("schedules_creator_idx").on(t.createdById).where(sql`${t.deletedAt} is null`),
  ],
);
export type ScheduleRow = typeof schedules.$inferSelect;
