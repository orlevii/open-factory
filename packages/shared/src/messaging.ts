import { z } from "zod";

export const MESSAGE_KINDS = [
  "message",
  "system",
  "member_update",
  "peer_joined",
  "peer_left",
  "task_assigned",
  "task_comment",
  "task_update",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const HELD_KINDS: readonly MessageKind[] = ["member_update", "peer_joined", "peer_left"];
export const FACT_CODES = [
  "turn_failed",
  "denied",
  "crashed",
  "errored",
  "recovered",
  "work_lost",
] as const;
export type FactCode = (typeof FACT_CODES)[number];

export const subjectSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  relation: z.enum(["peer", "report"]),
  left: z
    .union([
      z.object({ reason: z.literal("archived") }),
      z.object({ reason: z.literal("moved"), to: z.string().nullable() }),
      z.object({ reason: z.literal("terminated"), by: z.string() }),
    ])
    .optional(),
});

/** One item of `message_in.messages[]`. */
export const envelopeSchema = z.object({
  id: z.string(),
  from: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  urgent: z.boolean(),
  body: z.string(),
  taskKey: z.string().optional(),
  taskTitle: z.string().optional(),
  commentId: z.string().optional(),
  ids: z.array(z.string()).optional(),
  about: z.string().optional(),
  parts: z.array(z.object({ id: z.string(), body: z.string(), createdAt: z.string() })).optional(),
  fact: z.string().optional(),
  subject: subjectSchema.optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

export const INBOX_KINDS = ["message", "mention", "task_event"] as const;
export const inboxItemSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  kind: z.enum(INBOX_KINDS),
  read: z.boolean(),
  from: z.object({ kind: z.enum(["agent", "human", "factory"]), name: z.string() }),
  about: z.string().optional(),
  to: z.string(),
  preview: z.string(),
  urgent: z.boolean(),
  createdAt: z.string(),
  /** The task a mention or task event is about, with its current title. */
  task: z.object({ key: z.string(), title: z.string() }).optional(),
  /** A task event's notice, so the UI never parses the preview. */
  fact: z.enum(["done", "cancelled"]).optional(),
  link: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("session"),
      agentSlug: z.string(),
      seq: z.number().int().optional(),
    }),
    z.object({ kind: z.literal("task"), key: z.string(), commentId: z.string().optional() }),
  ]),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxPageSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
});
export const readAllBodySchema = z.object({ upTo: z.string().min(1) });
export const undoReadAllBodySchema = z.object({ readAt: z.string().min(1) });
export const readAllResponseSchema = z.object({ readAt: z.string(), count: z.number().int() });
export const undoReadAllResponseSchema = z.object({ count: z.number().int() });
export const unreadCountSchema = z.object({ count: z.number().int().nonnegative() });
export const eventRefSchema = z.object({ agentSlug: z.string(), seq: z.number().int() });
export const messageLookupSchema = z.object({
  id: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  from: z.string(),
  to: z.string(),
  state: z.enum(["pending", "delivered", "rejected"]),
  recipientEvent: eventRefSchema.optional(),
  senderEvent: eventRefSchema.optional(),
});
