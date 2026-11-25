import { z } from "zod";
import { agentLiveShape, agentStatusSchema, queueItemSchema, waitingOnSchema } from "./agents.ts";
import { sessionEventSchema } from "./events.ts";
import { liveCronSchema } from "./schedules.ts";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    agent: z.string(),
    afterSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("unsubscribe"), agent: z.string() }),
  /** U3 §11.3: asks for a `reset` live frame holding the full live state (sent on an offset gap). */
  z.object({ type: z.literal("live_snapshot"), agent: z.string() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const agentStatusFrameSchema = z.object({
  type: z.literal("agent_status"),
  agent: z.string(),
  status: agentStatusSchema,
  turnOpen: z.boolean(),
  lastError: z.string().optional(),
  restartPending: z.boolean(),
  restartWaitingOn: z.number().int().nonnegative(),
  waitingOn: waitingOnSchema.optional(),
  crons: z.array(liveCronSchema).optional(),
  stopCronsPending: z.boolean().optional(),
  ...agentLiveShape,
});
export type AgentStatusFrame = z.infer<typeof agentStatusFrameSchema>;

/** A live block's retire key (U3 §11.2, §11.3): the server's `retire` list and the client's `retired` set. */
export const liveKey = (messageId: string, index: number): string => `${messageId}:${index}`;

/** One live text block's growth: `offset` is the block length before `append`, in UTF-16 code units. */
const liveTextSchema = z.object({
  messageId: z.string(),
  index: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  append: z.string(),
  capped: z.boolean().optional(),
});

/** A running subagent's counters, from `task_progress` (U3 §12). */
const progressSchema = z.object({
  toolUseId: z.string(),
  description: z.string(),
  subagentType: z.string(),
  toolUses: z.number(),
  tokens: z.number(),
  durationMs: z.number(),
  lastTool: z.string().optional(),
});
export type SubagentProgress = z.infer<typeof progressSchema>;

/**
 * Token streaming (U3 §11.3), never stored. An absent field means unchanged, `null` means cleared;
 * `retire` lists `messageId:index` keys removed without a persisted row; `reset` replaces the whole
 * live state with this frame's contents.
 */
export const liveFrameSchema = z.object({
  type: z.literal("live"),
  agent: z.string(),
  texts: z.array(liveTextSchema).optional(),
  retire: z.array(z.string()).optional(),
  toolInput: z
    .object({
      toolUseId: z.string(),
      name: z.string(),
      bytes: z.number(),
      target: z.string().optional(),
    })
    .nullable()
    .optional(),
  thinking: z.object({ tokens: z.number() }).nullable().optional(),
  subagents: z.array(progressSchema).optional(),
  reset: z.literal(true).optional(),
});
export type LiveFrame = z.infer<typeof liveFrameSchema>;

/** A typed union: S3 adds frames here; a later `assistant_delta` frame fits without other changes. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), userId: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("session_event"), agent: z.string(), event: sessionEventSchema }),
  z.object({ type: z.literal("queue"), agent: z.string(), items: z.array(queueItemSchema) }),
  agentStatusFrameSchema,
  liveFrameSchema,
  z.object({ type: z.literal("resync"), agent: z.string() }),
  /** I1 §5.3: the agent's stored command list changed (named apart from Claude's own `system/commands_changed`). */
  z.object({ type: z.literal("agent_commands_changed"), agent: z.string() }),
  z.object({ type: z.literal("supervisor"), running: z.number().int(), max: z.number().int() }),
  z.object({ type: z.literal("inbox_changed") }),
  /** I1 §6.5: per user; their chat with this agent (a message created or changed state, a batch written, a turn started or closed). */
  z.object({ type: z.literal("chat_changed"), agent: z.string() }),
  /** S8: after any task commit (create, change, comment); the list and an open detail page refetch when their key is listed. */
  z.object({ type: z.literal("tasks_changed"), keys: z.array(z.string()) }),
  /** S9: after any schedule commit; the Schedules page, an open edit page and the strip's count refetch. */
  z.object({ type: z.literal("schedules_changed") }),
  /** S10: factory settings, users and invites, and the images list changed. */
  z.object({ type: z.literal("settings_changed") }),
  z.object({ type: z.literal("users_changed") }),
  /**
   * I5 §9.5: the Library (skill sources) changed; the Library pages refetch. `addFailed` is
   * the repo of a background GitHub add that failed and whose row was removed: the spec (§10.4) asks for a toast
   * but has no frame for it, so this one optional field carries it.
   */
  z.object({ type: z.literal("library_changed"), addFailed: z.string().optional() }),
  /**
   * I2 §7.2: an agent's effective config changed (one frame per affected agent), or a template's (one per template
   * change). Names only: the change lines are in the agent's `config_changed` event.
   */
  z.object({
    type: z.literal("config_changed"),
    agent: z.string().optional(),
    template: z.string().optional(),
  }),
  /**
   * I7 §8.3: an agent created, archived or unarchived an agent, or created a template. Published only for agent
   * actors (a human's own action already toasts in their browser); `by` is the actor's `@slug`.
   */
  z.object({
    type: z.literal("org_action"),
    action: z.enum(["agent_created", "agent_archived", "agent_unarchived", "template_created"]),
    by: z.string(),
    subject: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
