import {
  bigserial,
  boolean,
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

/** S3 subset of data-model.md's agents table; later specs add their columns. */
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  sessionId: text("session_id"),
  /** Only 'hibernated' | 'errored' are stored in S3; working/idle are derived in memory. */
  status: text("status").notNull().default("hibernated"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
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
  },
  (t) => [index("turns_agent_started_idx").on(t.agentId, t.startedAt)],
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
  (t) => [uniqueIndex("session_events_agent_seq_unique").on(t.agentId, t.seq)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("message"),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => users.id),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    urgent: boolean("urgent").notNull().default(false),
    state: text("state").notNull().default("pending"),
    deliveredTurnId: text("delivered_turn_id").references(() => turns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("messages_to_agent_state_idx").on(t.toAgentId, t.state, t.createdAt)],
);

export type AgentRow = typeof agents.$inferSelect;
export type TurnRow = typeof turns.$inferSelect;
export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
