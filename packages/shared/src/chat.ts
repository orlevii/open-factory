import { z } from "zod";
import { messageAttachmentSchema } from "./messaging.ts";

/** I1 §6.3: the entries of one human's chat thread with one agent. */
export const CHAT_OUTCOMES = ["no_reply", "stopped", "error"] as const;
export const chatEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: z.string(),
    /** `@handle` of the sender. */
    from: z.string(),
    fromKind: z.enum(["human", "agent"]),
    body: z.string(),
    /** The full recipient list as `@handle`s. */
    recipients: z.array(z.string()),
    urgent: z.boolean(),
    createdAt: z.string(),
    state: z.enum(["pending", "delivered", "rejected"]),
    rejectReason: z.string().optional(),
    attachments: z.array(messageAttachmentSchema).optional(),
    clientMessageId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("turn_outcome"),
    /** The id of the first of your messages in the batch the turn consumed (the working line's key). */
    key: z.string(),
    turnId: z.string(),
    endedAt: z.string(),
    /** The turn's last event in the session, null when it has none. */
    eventSeq: z.number().int().nullable(),
    outcome: z.enum(CHAT_OUTCOMES),
  }),
]);
export type ChatEntry = z.infer<typeof chatEntrySchema>;

export const chatPageSchema = z.object({
  /** Oldest first. */
  entries: z.array(chatEntrySchema),
  /** Pass as `before` for the page of older entries; null at the start of the thread. */
  nextCursor: z.string().nullable(),
  /** Set when the page ends before the thread's newest entry (an `around` page). */
  newerCursor: z.string().nullable(),
  working: z.object({ key: z.string(), since: z.string() }).nullable(),
});
export type ChatPage = z.infer<typeof chatPageSchema>;

export const chatQuerySchema = z.object({
  before: z.string().min(1).optional(),
  around: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
