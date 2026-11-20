import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";
import { users } from "./auth.ts";

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
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id").references(() => users.id),
    bodyAuthorAgentId: text("body_author_agent_id").references(() => agents.id),
    bodyAuthorUserId: text("body_author_user_id").references(() => users.id),
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
    check(
      "schedules_creator_check",
      sql`num_nonnulls(${t.createdByAgentId}, ${t.createdByUserId}) = 1`,
    ),
    check(
      "schedules_author_check",
      sql`num_nonnulls(${t.bodyAuthorAgentId}, ${t.bodyAuthorUserId}) = 1`,
    ),
    index("schedules_due_idx")
      .on(t.nextRunAt)
      .where(sql`${t.deletedAt} is null and ${t.pausedAt} is null and ${t.nextRunAt} is not null`),
    index("schedules_target_idx").on(t.targetAgentId).where(sql`${t.deletedAt} is null`),
    index("schedules_creator_idx")
      .on(t.createdByAgentId)
      .where(sql`${t.deletedAt} is null and ${t.createdByAgentId} is not null`),
  ],
);
export type ScheduleRow = typeof schedules.$inferSelect;
