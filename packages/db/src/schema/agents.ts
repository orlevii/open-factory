import type { AgentOverlay, Command, MessageAttachment, RequestRef } from "@open-factory/shared";
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { credentials } from "./factory.ts";
import { principals } from "./principals.ts";
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

export const agents = pgTable(
  "agents",
  {
    id: text("id")
      .primaryKey()
      .references(() => principals.id),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    sessionId: text("session_id"),
    /** Only 'hibernated' | 'errored' are stored; working/idle are derived in memory. */
    status: text("status").notNull().default("hibernated"),
    kind: text("kind").notNull().default("persistent"),
    template: text("template").notNull(),
    config: jsonb("config").$type<AgentOverlay>().notNull().default({}),
    runtime: text("runtime").notNull().$type<"local" | "docker">(),
    /** The manager: a human or an agent principal. An ephemeral agent's is its spawner (an agent, app-enforced). */
    reportsTo: text("reports_to")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    credentialId: text("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    /** I2 §11: identity colour 1..12 (`AVATAR_HUES`), null = Auto (seeded from the ref). Identity, not overlay. */
    color: smallint("color"),
    lastError: text("last_error"),
    errorKind: text("error_kind"),
    attempting: boolean("attempting").notNull().default(false),
    /**
     * S6 §9.1 (R4): the current errored episode's `errored` fact was forwarded (to its manager). Set once
     * per episode; cleared with the error. Read at boot so a restart never reports one episode twice.
     */
    erroredReported: boolean("errored_reported").notNull().default(false),
    runtimeJournal: jsonb("runtime_journal").$type<RuntimeJournal>(),
    rateLimitNoticeOwed: boolean("rate_limit_notice_owed").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    /** Who ended it: the spawner or a human; null when the factory did (the idle TTL). */
    terminatedBy: text("terminated_by").references(() => principals.id),
    /** §5.1: the org manager (persistent only): sees and manages the whole org. */
    manageOrg: boolean("manage_org").notNull().default(false),
    /** §10: the agent that last wrote `description` (the manager who set it); null when nobody did. */
    descriptionBy: text("description_by").references((): AnyPgColumn => agents.id, {
      onDelete: "set null",
    }),
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
    // The literal 1..12 mirrors AVATAR_COUNT (packages/shared/src/avatar.ts); a SQL CHECK can't import it.
    check("agents_color", sql`${t.color} IS NULL OR ${t.color} BETWEEN 1 AND 12`),
    check("agents_kind", sql`${t.kind} IN ('persistent','ephemeral')`),
    check(
      "agents_terminated_ephemeral",
      sql`${t.kind} = 'ephemeral' OR (${t.terminatedAt} IS NULL AND ${t.terminatedBy} IS NULL)`,
    ),
    check("agents_manage_org_persistent", sql`NOT ${t.manageOrg} OR ${t.kind} = 'persistent'`),
    index("agents_spawned_idx").on(t.reportsTo, t.createdAt).where(sql`${t.kind} = 'ephemeral'`),
    // The Ended list (Task 16): newest end first, limit 200.
    index("agents_ended_idx")
      .on(sql`coalesce(${t.terminatedAt}, ${t.archivedAt}) desc`)
      .where(sql`${t.terminatedAt} is not null or ${t.archivedAt} is not null`),
  ],
);

/**
 * U3 §13.3: the command list of the agent's last process start (`initialize`). A side table, never a column on
 * `agents`: agent rows are read wholesale (`select().from(agents)`), and a ~60 KB list must not ride along.
 */
export const agentCommands = pgTable("agent_commands", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  commands: jsonb("commands").$type<Command[]>().notNull(),
  claudeCodeVersion: text("claude_code_version"),
  at: timestamp("at", { withTimezone: true }).notNull(),
});

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
    // I1 §6.3: the seq of the turn's last event (its `turn_end` for a normal close); null when it has none.
    endEventSeq: integer("end_event_seq"),
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
    // Loop guard: an agent's operator input, read by the window count without scanning its whole log.
    index("session_events_operator_input_idx")
      .on(t.agentId, t.at)
      .where(sql`${t.type} = 'operator_input'`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("message"),
    // The sender principal (an agent or a human); null = the factory, a notice or a scheduled firing.
    fromId: text("from_id").references(() => principals.id),
    notice: text("notice"),
    subjectAgentId: text("subject_agent_id").references((): AnyPgColumn => agents.id),
    // I3: the credential a `system` notice is about; deleting the credential deletes its notices.
    subjectCredentialId: text("subject_credential_id").references(
      (): AnyPgColumn => credentials.id,
      {
        onDelete: "cascade",
      },
    ),
    // The recipient principal; an agent for the agent-only kinds, a human or an agent for messages.
    toId: text("to_id").references(() => principals.id, { onDelete: "cascade" }),
    toAllHumans: boolean("to_all_humans").notNull().default(false),
    fromToolUseId: text("from_tool_use_id"),
    deliveredEventSeq: integer("delivered_event_seq"),
    // I1: the full recipient list of a `kind='message'` row, as principal ids (a fan-out writes one row per recipient).
    recipientIds: text("recipient_ids").array(),
    body: text("body").notNull(),
    urgent: boolean("urgent").notNull().default(false),
    state: text("state").notNull().default("pending"),
    // Loop guard: the open loop hold this message is parked under (state 'loop_held').
    loopHoldId: text("loop_hold_id").references((): AnyPgColumn => loopHolds.id),
    deliveredTurnId: text("delivered_turn_id").references(() => turns.id, { onDelete: "set null" }),
    // S8: task messages. (task_id, comment_id) is a composite foreign key to task_comments, added in SQL.
    taskId: text("task_id").references((): AnyPgColumn => tasks.id),
    commentId: text("comment_id"),
    // S9: scheduled rows. They carry their author (the schedule's body author can change after the firing).
    scheduleId: text("schedule_id").references((): AnyPgColumn => schedules.id),
    authorId: text("author_id").references(() => principals.id),
    dueAt: timestamp("due_at", { withTimezone: true }),
    firings: integer("firings"),
    late: boolean("late"),
    // U3: the sender's optimistic-row id; idempotent per sender forever.
    clientMessageId: text("client_message_id"),
    // U3 §13.5: the confirmed uploads, for the envelope's UI field (the body carries the `[attached: …]` lines).
    attachments: jsonb("attachments").$type<MessageAttachment[]>(),
    // A `member_update` of a report's text: the requests of the report's turn when it wrote it (the envelope's `re`).
    re: jsonb("re").$type<RequestRef[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    index("messages_to_state_idx").on(t.toId, t.state, t.createdAt),
    // Loop guard: a schedule holds at most one undelivered row per agent, whether it is pending or loop_held.
    uniqueIndex("messages_schedule_pending_idx")
      .on(t.scheduleId, t.toId)
      .where(sql`${t.state} IN ('pending','loop_held') AND ${t.scheduleId} IS NOT NULL`),
    index("messages_from_idx").on(t.fromId, t.createdAt),
    // S10: turn attribution reads a closing turn's delivered messages.
    index("messages_delivered_turn_idx")
      .on(t.deliveredTurnId)
      .where(sql`${t.deliveredTurnId} is not null`),
    uniqueIndex("messages_client_id_unique")
      .on(t.fromId, t.clientMessageId, t.toId)
      .where(sql`${t.clientMessageId} is not null`),
    // I1 §6.3: the chat thread, one direction per scan (to, from), newest first by (created_at, id).
    index("messages_chat_in_idx")
      .on(t.toId, t.fromId, t.createdAt)
      .where(sql`${t.kind} = 'message'`),
    // I8: Resume's flip and the inbox's hold counts look rows up by hold.
    index("messages_loop_hold_idx").on(t.loopHoldId).where(sql`${t.loopHoldId} is not null`),
    check("messages_recipients", sql`${t.kind} <> 'message' OR ${t.recipientIds} IS NOT NULL`),
  ],
);

/** Loop guard: a held agent pair. At most one open hold per pair; resuming sets resumedAt. */
export const loopHolds = pgTable(
  "loop_holds",
  {
    id: text("id").primaryKey(),
    agentA: text("agent_a")
      .notNull()
      .references(() => agents.id),
    agentB: text("agent_b")
      .notNull()
      .references(() => agents.id),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    resumedBy: text("resumed_by").references(() => users.id),
  },
  (t) => [
    check("loop_holds_order", sql`${t.agentA} < ${t.agentB}`),
    uniqueIndex("loop_holds_open_unique").on(t.agentA, t.agentB).where(sql`${t.resumedAt} is null`),
  ],
);

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind")
      .notNull()
      .$type<"message" | "mention" | "task_event" | "credential" | "member_update">(),
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

/**
 * U3 §13.5: a file a human uploaded into an agent's workspace (`.factory/uploads/<stored>`). `message_id` is null until
 * the message carrying it is sent; an unsent row older than 24 hours is swept with its file.
 */
export const uploads = pgTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id")
      .notNull()
      .references(() => users.id),
    /** Relative to the agent's workdir: `.factory/uploads/<yyyymmdd>-<id>-<safe>`. */
    storedPath: text("stored_path").notNull(),
    originalName: text("original_name").notNull(),
    kind: text("kind").notNull().$type<"image" | "text">(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("uploads_message_idx").on(t.messageId),
    // The 24h sweep reads unsent rows by age.
    index("uploads_unsent_idx").on(t.createdAt).where(sql`${t.messageId} is null`),
  ],
);
export type UploadRow = typeof uploads.$inferSelect;

export type AgentRow = typeof agents.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
