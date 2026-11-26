import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";
import { principals } from "./principals.ts";

/** S8 spec §5. `number` comes from `task_number_seq` (created by hand in the migration); the key is `T-<number>`. */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull().unique().default(sql`nextval('task_number_seq')`),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status")
      .notNull()
      .default("open")
      .$type<"open" | "in_progress" | "done" | "cancelled">(),
    assigneeAgentId: text("assignee_agent_id").references(() => agents.id),
    createdById: text("created_by_id")
      .notNull()
      .references(() => principals.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("tasks_status_check", sql`${t.status} IN ('open','in_progress','done','cancelled')`),
    index("tasks_status_updated_idx").on(t.status, t.updatedAt.desc(), t.id),
    index("tasks_assignee_status_idx").on(t.assigneeAgentId, t.status),
    index("tasks_created_by_idx").on(t.createdById),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    check("task_dependencies_self_check", sql`${t.taskId} <> ${t.dependsOnTaskId}`),
    index("task_dependencies_depends_on_idx").on(t.dependsOnTaskId),
  ],
);

export const taskLinks = pgTable(
  "task_links",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    position: integer("position").notNull(),
    kind: text("kind").notNull().$type<"url" | "pr" | "file" | "agent">(),
    target: text("target"),
    agentId: text("agent_id").references(() => agents.id),
    title: text("title"),
  },
  (t) => [
    check("task_links_kind_check", sql`${t.kind} IN ('url','pr','file','agent')`),
    check(
      "task_links_agent_check",
      sql`(${t.kind} = 'agent') = (${t.agentId} IS NOT NULL AND ${t.target} IS NULL)`,
    ),
    check("task_links_target_check", sql`${t.kind} = 'agent' OR ${t.target} IS NOT NULL`),
    index("task_links_task_position_idx").on(t.taskId, t.position),
  ],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    authorId: text("author_id")
      .notNull()
      .references(() => principals.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The target of messages' composite (task_id, comment_id) foreign key.
    uniqueIndex("task_comments_task_id_id_unique").on(t.taskId, t.id),
    index("task_comments_task_created_idx").on(t.taskId, t.createdAt, t.id),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    actorId: text("actor_id")
      .notNull()
      .references(() => principals.id),
    type: text("type")
      .notNull()
      .$type<"created" | "status" | "assignee" | "title" | "body" | "depends_on" | "links">(),
    fromValue: jsonb("from_value"),
    toValue: jsonb("to_value"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "task_events_type_check",
      sql`${t.type} IN ('created','status','assignee','title','body','depends_on','links')`,
    ),
    index("task_events_task_at_idx").on(t.taskId, t.at, t.id),
  ],
);

export type TaskRow = typeof tasks.$inferSelect;
export type TaskLinkRow = typeof taskLinks.$inferSelect;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
