import { z } from "zod";
import { cleanupSchema } from "./workspace-cleanup.ts";

export const MESSAGE_KINDS = [
  "message",
  "system",
  "member_update",
  "peer_joined",
  "peer_left",
  "task_assigned",
  "task_comment",
  "task_update",
  "scheduled",
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
/** U3 §13.5: a confirmed upload on a message, for the UI's chips (the model reads only the `[attached: …]` line). */
export const messageAttachmentSchema = z.object({
  uploadId: z.string(),
  name: z.string(),
  kind: z.enum(["image", "text"]),
  /** The file's size: the UI previews an image automatically only when it is small. */
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const envelopeSchema = z.object({
  id: z.string(),
  from: z.string(),
  fromKind: z.enum(["human", "agent", "factory"]),
  kind: z.enum(MESSAGE_KINDS),
  to: z.array(z.string()).optional(),
  urgent: z.boolean(),
  body: z.string(),
  taskKey: z.string().optional(),
  taskTitle: z.string().optional(),
  commentId: z.string().optional(),
  /** S9 `scheduled` rows: the schedule's key, its author, when it was due (zone offset), runs covered, delayed. */
  scheduleKey: z.string().optional(),
  by: z.string().optional(),
  /** UI-only: what `by` is (a human or an agent). Never rendered into the model's text. */
  byKind: z.enum(["human", "agent"]).optional(),
  due: z.string().optional(),
  firings: z.number().int().positive().optional(),
  late: z.boolean().optional(),
  ids: z.array(z.string()).optional(),
  about: z.string().optional(),
  parts: z.array(z.object({ id: z.string(), body: z.string(), createdAt: z.string() })),
  fact: z.string().optional(),
  subject: subjectSchema.optional(),
  /** UI-only: the sender's optimistic-row id. Never rendered into the model's text. */
  clientMessageId: z.string().optional(),
  /** UI-only (U3 §13.5): the message's confirmed uploads. Never rendered into the model's text. */
  attachments: z.array(messageAttachmentSchema).optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** `notice` is a factory notice (an agent errored, ...); `credential` is a factory fact about a credential; a chat message is the Chat's, never an item (I1 §6.7). */
export const INBOX_KINDS = ["notice", "mention", "task_event", "credential"] as const;
export const loopHoldSchema = z.object({
  id: z.string(),
  agents: z.tuple([
    z.object({ slug: z.string(), status: z.enum(["live", "terminated", "archived"]) }),
    z.object({ slug: z.string(), status: z.enum(["live", "terminated", "archived"]) }),
  ]),
  /** Rows still `loop_held` on this hold. */
  waiting: z.number().int(),
  /** Rows whose state is neither `loop_held` nor `rejected`. */
  sentOn: z.number().int(),
  resumedAt: z.string().nullable(),
  /** The resuming human's handle with `@`. */
  resumedBy: z.string().nullable(),
});
export const resumeLoopHoldResponseSchema = z.object({ sentOn: z.number().int() });

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
  /** An @factory notice's type (`agent_errored`, `loop_held`, ...), so the UI never parses the preview. */
  notice: z.string().optional(),
  /** A task event's notice, so the UI never parses the preview. */
  fact: z.enum(["done", "cancelled"]).optional(),
  /** The credential a `credential` item is about. */
  credential: z
    .object({ name: z.string(), expiresAt: z.string().nullable(), current: z.boolean() })
    .optional(),
  /** A `loop_held` notice's hold (I8 §6.4); `status` is live, so the pane can say who ended. */
  loopHold: loopHoldSchema.optional(),
  /** A `worktrees_kept` notice's cleanup result, so the pane never parses the body (I8 §7.6). */
  cleanup: cleanupSchema.optional(),
  link: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("session"),
      agentSlug: z.string(),
      seq: z.number().int().optional(),
    }),
    z.object({ kind: z.literal("task"), key: z.string(), commentId: z.string().optional() }),
    z.object({ kind: z.literal("credential"), name: z.string() }),
  ]),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const inboxItemResponseSchema = z.object({ item: inboxItemSchema });
export const readAllBodySchema = z.object({ upTo: z.string().min(1) });
export const undoReadAllBodySchema = z.object({ readAt: z.string().min(1) });
export const readAllResponseSchema = z.object({ readAt: z.string(), count: z.number().int() });
export const undoReadAllResponseSchema = z.object({ count: z.number().int() });
export const unreadCountSchema = z.object({
  count: z.number().int().nonnegative(),
  byAgent: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export const readFromBodySchema = z.object({ upTo: z.string().min(1) });
export const readFromResponseSchema = z.object({ marked: z.number().int(), readAt: z.string() });
export const eventRefSchema = z.object({ agentSlug: z.string(), seq: z.number().int() });
export const messageLookupSchema = z.object({
  id: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  from: z.string(),
  fromKind: z.enum(["human", "agent", "factory"]),
  to: z.string(),
  state: z.enum(["pending", "loop_held", "delivered", "rejected", "cancelled"]),
  recipientEvent: eventRefSchema.optional(),
  senderEvent: eventRefSchema.optional(),
  scheduleKey: z.string().optional(),
  firings: z.number().int().positive().optional(),
  late: z.boolean().optional(),
  dueAt: z.string().optional(),
});
