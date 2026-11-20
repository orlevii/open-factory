import { z } from "zod";
import { sessionEventSchema } from "./events.ts";
import { nameSchema, slugSchema } from "./names.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_FOCUS_CHARS = 2000;
const utf8 = new TextEncoder();

export const agentStatusSchema = z.enum([
  "hibernated",
  "queued",
  "working",
  "idle",
  "rate_limited",
  "errored",
  "terminated",
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const errorKindSchema = z.enum([
  "start",
  "resume",
  "resume_unrecoverable",
  "crash",
  "stop_failed",
  "internal",
]);
export type ErrorKind = z.infer<typeof errorKindSchema>;

export const waitingOnSchema = z.object({
  tasks: z.array(z.object({ taskId: z.string(), description: z.string(), startedAt: z.string() })),
  crons: z.number().int().nonnegative(),
});
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/** Live fields shared by the agent summary and the `agent_status` frame. */
export const agentLiveShape = {
  rateLimitedUntil: z.string().optional(),
  rateLimitExact: z.boolean().optional(),
  runtimeDisabled: z.string().optional(),
  errorKind: errorKindSchema.optional(),
  image: z.string().optional(),
  pulling: z.boolean().optional(),
};

export const agentSummarySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  status: agentStatusSchema,
  turnOpen: z.boolean(),
  runtime: z.enum(["local", "docker"]),
  lastError: z.string().optional(),
  kind: z.enum(["persistent", "ephemeral"]),
  template: z.string(),
  reportsTo: z.string().nullable(),
  reports: z.number().int().nonnegative().default(0),
  credential: z.string().nullable(),
  projects: z.array(z.string()),
  grantsOverridden: z.boolean(),
  depth: z.number().int().nonnegative(),
  archivedAt: z.string().nullable(),
  terminatedAt: z.string().optional(),
  terminatedBy: z.string().optional(),
  workspacePinned: z.boolean().optional(),
  workspaceGraceEndsAt: z.string().optional(),
  workspaceDeletedAt: z.string().optional(),
  stuck: z.literal(true).optional(),
  restartPending: z.boolean(),
  restartWaitingOn: z.number().int().nonnegative(),
  waitingOn: waitingOnSchema.default({ tasks: [], crons: 0 }),
  ...agentLiveShape,
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const queueItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["message", "compact", "notice", "held"]),
  body: z.string().optional(),
  count: z.number().int().positive().optional(),
  about: z.string().optional(),
  dueAt: z.string().optional(),
  waitReason: z
    .enum(["turn", "window", "starting", "errored", "rate_limited", "ride_along"])
    .optional(),
  focus: z.string().optional(),
  urgent: z.boolean().optional(),
  from: z.string(),
  taskKey: z.string().optional(),
  taskTitle: z.string().optional(),
  commentId: z.string().optional(),
  createdAt: z.string(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const agentListSchema = z.object({
  agents: z.array(agentSummarySchema),
  /** `ended=only` (S7 §14): older ended agents exist beyond the newest 200 shown. */
  more: z.boolean().default(false),
  running: z.object({ count: z.number().int().nonnegative(), max: z.number().int().positive() }),
});
export const agentDetailSchema = z.object({
  agent: agentSummarySchema,
  queue: z.array(queueItemSchema),
  lastSeq: z.number().int().nonnegative(),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

export const eventsQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  around: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const eventsPageSchema = z.object({
  events: z.array(sessionEventSchema),
  hasMore: z.object({ before: z.boolean(), after: z.boolean() }),
});
export type EventsPage = z.infer<typeof eventsPageSchema>;

export const sendMessageBodySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Message is empty")
    .refine((s) => utf8.encode(s).length <= MAX_BODY_BYTES, "Message is larger than 64 KB"),
  urgent: z.boolean().default(false),
});
export const sendMessageToolSchema = z.object({
  to: z.string().min(1).max(64),
  body: sendMessageBodySchema.shape.body,
  urgent: z.boolean().default(false),
});
export const listPeersToolSchema = z.object({
  scope: z.enum(["neighborhood", "all"]).optional(),
});
export const compactBodySchema = z.object({
  focus: z.string().trim().max(MAX_FOCUS_CHARS).optional(),
});
export const queueItemResponseSchema = z.object({ item: queueItemSchema });

// Strict: `?archived=` was renamed to `?ended=` in S7, and an old caller must get a 400, not a silently changed list.
export const agentListQuerySchema = z.strictObject({
  ended: z.enum(["exclude", "only"]).default("exclude"),
});
export const SPAWN_SUFFIX_PATTERN = /^[a-z0-9-]+$/;
export const spawnAgentToolSchema = (templates: [string, ...string[]]) =>
  z.strictObject({
    template: z.enum(templates),
    suffix: z.string().regex(SPAWN_SUFFIX_PATTERN).optional(),
    description: z.string().describe("What this agent is for (one or two sentences)"),
    prompt: z.string().describe("The brief; it becomes the agent's first message"),
  });
export const terminateAgentToolSchema = z.strictObject({ slug: z.string().min(1).max(64) });
export const createAgentBodySchema = z.object({
  template: nameSchema,
  slug: slugSchema,
  displayName: z.string().trim().min(1, "Enter a display name.").max(80),
  description: z.string().trim().max(500),
  reportsTo: slugSchema.nullable(),
  credential: nameSchema,
  projects: z.array(nameSchema).optional(),
});
export type CreateAgentBody = z.infer<typeof createAgentBodySchema>;
export const patchAgentBodySchema = z
  .strictObject({
    displayName: z.string().trim().min(1, "Enter a display name.").max(80),
    description: z.string().trim().max(500),
    reportsTo: slugSchema.nullable(),
    credential: nameSchema,
    projects: z.array(nameSchema).nullable(),
  })
  .partial();
export type PatchAgentBody = z.infer<typeof patchAgentBodySchema>;
export const agentResponseSchema = z.object({ agent: agentSummarySchema });
export const resyncResponseSchema = z.object({
  agent: agentSummarySchema,
  backupDir: z.string().optional(),
  applied: z.enum(["now", "on_restart"]),
});
