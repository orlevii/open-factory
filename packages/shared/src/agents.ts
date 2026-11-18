import { z } from "zod";
import { sessionEventSchema } from "./events.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_FOCUS_CHARS = 2000;
const utf8 = new TextEncoder();

export const agentStatusSchema = z.enum(["hibernated", "working", "idle", "errored"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentSummarySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  status: agentStatusSchema,
  turnOpen: z.boolean(),
  runtime: z.literal("local"),
  lastError: z.string().optional(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const queueItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["message", "compact"]),
  body: z.string().optional(),
  focus: z.string().optional(),
  urgent: z.boolean().optional(),
  from: z.string(),
  createdAt: z.string(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const agentListSchema = z.object({ agents: z.array(agentSummarySchema) });
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
export const compactBodySchema = z.object({
  focus: z.string().trim().max(MAX_FOCUS_CHARS).optional(),
});
export const queueItemResponseSchema = z.object({ item: queueItemSchema });
