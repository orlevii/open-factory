import { z } from "zod";
import { avatarColorSchema } from "./avatar.ts";
import { configDocSchema } from "./config.ts";
import { sessionEventSchema } from "./events.ts";
import { nameSchema, slugSchema } from "./names.ts";
import { liveCronSchema } from "./schedules.ts";
import { templateIssueSchema } from "./templates.ts";

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
  /** Docker agents: the image of the live process (null when none runs) and the one the config resolves to now. */
  image: z.object({ running: z.string().nullable(), next: z.string() }).optional(),
  pulling: z.boolean().optional(),
  /** U3: when the open turn started (ISO), so the UI can time it. */
  turnStartedAt: z.string().optional(),
  /** U3: a compaction is running. */
  compacting: z.boolean().optional(),
  /** I2 §7.3: the config change lines a pending restart applies (empty when none is pending). */
  restartChanges: z.array(z.string()),
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
  /** S8: open and in-progress tasks assigned to it (the session strip's link). */
  openTasks: z.number().int().nonnegative().default(0),
  /** U2: the avatar's cache-busting version, null when the agent has no avatar. */
  avatarVersion: z.string().nullable().default(null),
  /** I2 §11: identity colour 1..12 (`AVATAR_HUES`), null = Auto. */
  color: avatarColorSchema.nullable().default(null),
  /** §5.1: the org manager flag; only persistent agents can hold it. */
  manageOrg: z.boolean(),
  credential: z.string().nullable(),
  projects: z.array(z.string()),
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
  /** S9: the live in-session crons, the zone their text is written in, and a pending Stop crons. */
  crons: z.array(liveCronSchema).default([]),
  cronZone: z.string().default("UTC"),
  stopCronsPending: z.boolean().default(false),
  /** S9: schedules targeting it that are neither deleted nor done. */
  scheduleCount: z.number().int().nonnegative().default(0),
  ...agentLiveShape,
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const queueItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["message", "compact", "notice", "raw"]),
  body: z.string().optional(),
  /** S9: a scheduled row's due time. */
  dueAt: z.string().optional(),
  waitReason: z.enum(["turn", "stopping"]).optional(),
  clientMessageId: z.string().uuid().optional(),
  focus: z.string().optional(),
  urgent: z.boolean().optional(),
  from: z.string(),
  /** What `from` is; the UI never guesses it from the handle. */
  fromKind: z.enum(["human", "agent", "factory"]),
  taskKey: z.string().optional(),
  taskTitle: z.string().optional(),
  commentId: z.string().optional(),
  scheduleKey: z.string().optional(),
  firings: z.number().int().positive().optional(),
  late: z.boolean().optional(),
  createdAt: z.string(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const agentListSchema = z.object({
  agents: z.array(agentSummarySchema),
  /** `ended=only` (S7 §14): older ended agents exist beyond the newest 200 shown. */
  more: z.boolean().default(false),
  running: z.object({ count: z.number().int().nonnegative() }),
});
/** The model an agent runs with and where it comes from (I2 §12.3): its own overlay, its template, or Claude's default. */
export const agentModelSchema = z.object({
  value: z.string().nullable(),
  source: z.enum(["agent", "template", "default"]),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentDetailSchema = z.object({
  agent: agentSummarySchema,
  model: agentModelSchema,
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

/** I1 §6.6: one human message to one to ten agents; attachments only with a single recipient. */
export const sendMessagesBodySchema = z.object({
  to: z.array(z.string().min(1).max(65)).min(1).max(10),
  body: z
    .string()
    .trim()
    .min(1, "Message is empty")
    .refine((s) => utf8.encode(s).length <= MAX_BODY_BYTES, "Message is larger than 64 KB"),
  urgent: z.boolean().default(false),
  clientMessageId: z.string().uuid().optional(),
  /** U3 §13.5: upload ids from `POST /api/agents/:slug/uploads`, at most 10. */
  attachments: z.array(z.string().min(1).max(64)).max(10).optional(),
});
/** Why a recipient was refused: the router's codes, so a client never parses `reason`. */
export const REFUSAL_CODES = [
  "not_found",
  "reserved",
  "channel",
  "self",
  "archived",
  "terminated",
  "disabled",
  "human",
  "invalid_attachment",
  "too_large",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
/** One recipient's outcome: `start_failed` keeps its row pending; `refused` wrote nothing. */
export const sendMessagesResultSchema = z.object({
  to: z.string(),
  status: z.enum(["queued", "start_failed", "refused"]),
  id: z.string().optional(),
  item: queueItemSchema.optional(),
  reason: z.string().optional(),
  /** Set when `status` is `refused`. */
  code: z.enum(REFUSAL_CODES).optional(),
});
export const sendMessagesResponseSchema = z.object({ results: z.array(sendMessagesResultSchema) });
export type SendMessagesResponse = z.infer<typeof sendMessagesResponseSchema>;
export const sendMessageToolSchema = z.object({
  to: z
    .array(
      z
        .string()
        .max(65)
        .refine((s) => s.trim().length > 0, "Name a recipient"),
    )
    .min(1)
    .max(10, "Send to at most 10 recipients at once."),
  body: sendMessagesBodySchema.shape.body,
  urgent: z.boolean().default(false),
});
export const sendCommandToolSchema = z.object({
  target: z.string().max(65), // a handle (64) with its @
  command: z.string(),
});
export const listPeersToolSchema = z.object({
  scope: z.enum(["neighborhood", "all"]).optional(),
});
export const compactBodySchema = z.object({
  focus: z.string().trim().max(MAX_FOCUS_CHARS).optional(),
});
export const queueItemResponseSchema = z.object({ item: queueItemSchema });
/** I7 §9.4: a human's Restart now. `force` restarts even when background work would be stopped. */
export const restartAgentBodySchema = z.object({ force: z.boolean().optional() });
/** I7 §9.2: what `restartNow` did; it never waits for the start. */
export const restartStatusSchema = z.enum([
  "restarting",
  "restart_pending",
  "not_running",
  "restarted_idle",
]);
export const restartAgentResponseSchema = z.object({ status: restartStatusSchema });
export type RestartStatus = z.infer<typeof restartStatusSchema>;

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
  manageOrg: z.boolean().optional(),
});
export type CreateAgentBody = z.infer<typeof createAgentBodySchema>;
export const patchAgentBodySchema = z
  .strictObject({
    displayName: z.string().trim().min(1, "Enter a display name.").max(80),
    description: z.string().trim().max(500),
    reportsTo: slugSchema.nullable(),
    credential: nameSchema,
    projects: z.array(nameSchema),
    color: avatarColorSchema.nullable(),
    manageOrg: z.boolean(),
  })
  .partial();
export type PatchAgentBody = z.infer<typeof patchAgentBodySchema>;
export const agentResponseSchema = z.object({ agent: agentSummarySchema });
/** `backupDir` is relative to the factory home, and absent when nothing differed or the reset is staged. */
export const resetPersonaResponseSchema = z.object({
  applied: z.enum(["now", "on_restart"]),
  backupDir: z.string().optional(),
});
export type ResetPersonaResponse = z.infer<typeof resetPersonaResponseSchema>;

/** `GET /api/agents/:slug/config` (I2 §12.1). `doc` and `merged` are null while the template is invalid or missing. */
export const agentConfigResponseSchema = z.object({
  overlay: z.record(z.string(), z.unknown()),
  version: z.string(),
  template: z.object({
    name: z.string(),
    doc: configDocSchema.nullable(),
    valid: z.boolean(),
  }),
  merged: configDocSchema.nullable(),
  issues: z.array(templateIssueSchema),
});
export type AgentConfigResponse = z.infer<typeof agentConfigResponseSchema>;

/**
 * `PUT /api/agents/:slug/config`. `overlay` is checked by `agentOverlaySchema` in the service, so a bad one answers
 * with `issues` (paths and constant messages) instead of a generic body error.
 */
export const putAgentConfigBodySchema = z.object({
  overlay: z.record(z.string(), z.unknown()),
  baseVersion: z.string().min(1).max(100),
});
export type PutAgentConfigBody = z.infer<typeof putAgentConfigBodySchema>;

/**
 * The saved config, plus the change lines and whether a restart check was scheduled. `restartChecked` is not "will
 * restart": a running process restarts when idle only if what it started with differs.
 */
export const putAgentConfigResponseSchema = agentConfigResponseSchema.extend({
  changes: z.array(z.string()),
  restartChecked: z.boolean(),
  checked: z.enum(["full", "schema"]),
});
export type PutAgentConfigResponse = z.infer<typeof putAgentConfigResponseSchema>;
