import type { TemplateConfig } from "@open-factory/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { credentials } from "./factory.ts";
import { schedules } from "./schedules.ts";
import { tasks } from "./tasks.ts";

/** Snapshot of live runtime state, taken every 10 s, used to reap leftovers and report lost work. */
export type RuntimeJournal = {
  claude?: { pid: number; start: string };
  descendants?: { pid: number; start: string }[];
  tasks: { taskId: string; description: string }[];
  crons: { cronId: string; humanSchedule: string }[];
  takenAt: string;
};

/** S3 subset of data-model.md's agents table; later specs add their columns. */
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    sessionId: text("session_id"),
    /** Only 'hibernated' | 'errored' are stored in S3; working/idle are derived in memory. */
    status: text("status").notNull().default("hibernated"),
    kind: text("kind").notNull().default("persistent"),
    template: text("template").notNull(),
    config: jsonb("config").$type<TemplateConfig>().notNull(),
    runtime: text("runtime").notNull().$type<"local" | "docker">(),
    reportsTo: text("reports_to").references((): AnyPgColumn => agents.id, {
      onDelete: "restrict",
    }),
    credentialId: text("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    grantsOverridden: boolean("grants_overridden").notNull().default(false),
    lastError: text("last_error"),
    errorKind: text("error_kind"),
    attempting: boolean("attempting").notNull().default(false),
    /**
     * S6 §9.1 (R4): the current errored episode's `errored` fact was forwarded (to the manager or the humans). Set once
     * per episode; cleared with the error. Read at boot so a restart never reports one episode twice.
     */
    erroredReported: boolean("errored_reported").notNull().default(false),
    runtimeJournal: jsonb("runtime_journal").$type<RuntimeJournal>(),
    rateLimitNoticeOwed: boolean("rate_limit_notice_owed").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    /** '@handle' (a human), the spawner's bare slug, or '@factory' (the TTL). */
    terminatedBy: text("terminated_by"),
    workspacePinned: boolean("workspace_pinned").notNull().default(false),
    workspaceDeletedAt: timestamp("workspace_deleted_at", { withTimezone: true }),
    /** S7 §10.2: the last process start, turn end or delivered batch; read by the TTL sweep. */
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      "agents_live_credential",
      sql`${t.credentialId} IS NOT NULL OR ${t.terminatedAt} IS NOT NULL`,
    ),
    check("agents_kind", sql`${t.kind} IN ('persistent','ephemeral')`),
    check(
      "agents_terminated_ephemeral",
      sql`${t.kind} = 'ephemeral' OR (${t.terminatedAt} IS NULL AND ${t.terminatedBy} IS NULL)`,
    ),
    check("agents_ephemeral_manager", sql`${t.kind} = 'persistent' OR ${t.reportsTo} IS NOT NULL`),
    index("agents_spawned_idx").on(t.reportsTo, t.createdAt).where(sql`${t.kind} = 'ephemeral'`),
    // The Ended list (Task 16): newest end first, limit 200.
    index("agents_ended_idx")
      .on(sql`coalesce(${t.terminatedAt}, ${t.archivedAt}) desc`)
      .where(sql`${t.terminatedAt} is not null or ${t.archivedAt} is not null`),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    originKind: text("origin_kind"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
    isError: boolean("is_error"),
    terminalReason: text("terminal_reason"),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    credentialId: text("credential_id").references(() => credentials.id, { onDelete: "set null" }),
  },
  (t) => [
    index("turns_agent_started_idx").on(t.agentId, t.startedAt),
    index("turns_task_idx").on(t.taskId).where(sql`${t.taskId} is not null`),
    index("turns_credential_started_idx").on(t.credentialId, t.startedAt),
    index("turns_started_idx").on(t.startedAt),
  ],
);

export const sessionEvents = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    turnId: text("turn_id").references(() => turns.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("session_events_agent_seq_unique").on(t.agentId, t.seq),
    // S7 §8: an agent's `terminated` event, found without reading its whole log (boot's crash-window query and
    // `ensureTerminatedEvent`). At most one row per terminated agent.
    index("session_events_terminated_idx").on(t.agentId).where(sql`${t.type} = 'terminated'`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("message"),
    fromUserId: text("from_user_id").references(() => users.id),
    notice: text("notice"),
    fromAgentId: text("from_agent_id").references((): AnyPgColumn => agents.id),
    subjectAgentId: text("subject_agent_id").references((): AnyPgColumn => agents.id),
    toAgentId: text("to_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    toUserId: text("to_user_id").references(() => users.id),
    toAllHumans: boolean("to_all_humans").notNull().default(false),
    fromToolUseId: text("from_tool_use_id"),
    deliveredEventSeq: integer("delivered_event_seq"),
    body: text("body").notNull(),
    urgent: boolean("urgent").notNull().default(false),
    state: text("state").notNull().default("pending"),
    deliveredTurnId: text("delivered_turn_id").references(() => turns.id, { onDelete: "set null" }),
    // S8: task messages. (task_id, comment_id) is a composite foreign key to task_comments, added in SQL.
    taskId: text("task_id").references((): AnyPgColumn => tasks.id),
    commentId: text("comment_id"),
    // S9: scheduled rows. They carry their author (the schedule's body author can change after the firing).
    scheduleId: text("schedule_id").references((): AnyPgColumn => schedules.id),
    authorAgentId: text("author_agent_id").references((): AnyPgColumn => agents.id),
    authorUserId: text("author_user_id").references(() => users.id),
    dueAt: timestamp("due_at", { withTimezone: true }),
    firings: integer("firings"),
    late: boolean("late"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    index("messages_to_agent_state_idx").on(t.toAgentId, t.state, t.createdAt),
    index("messages_from_agent_idx").on(t.fromAgentId, t.createdAt),
    // S10: turn attribution reads a closing turn's delivered messages.
    index("messages_delivered_turn_idx")
      .on(t.deliveredTurnId)
      .where(sql`${t.deliveredTurnId} is not null`),
  ],
);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<"message" | "mention" | "task_event">(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("inbox_items_user_message_unique").on(t.userId, t.messageId),
    index("inbox_items_user_created_idx").on(t.userId, t.createdAt.desc()),
    // S8: the unread count.
    index("inbox_items_unread_idx").on(t.userId).where(sql`${t.readAt} is null`),
  ],
);
export type InboxItemRow = typeof inboxItems.$inferSelect;

export type AgentRow = typeof agents.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
