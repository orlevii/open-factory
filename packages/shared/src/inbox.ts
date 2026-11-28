import { z } from "zod";
import { agentStatusSchema } from "./agents.ts";
import { avatarColorSchema } from "./avatar.ts";
import { inboxItemSchema } from "./messaging.ts";

/**
 * I1 §6.7: one agent's unread messages to you, for the Inbox's chat rows. `latest.preview` is plain text, at most 280
 * characters.
 */
export const chatRowSchema = z.object({
  agent: z.object({
    ref: z.string(),
    handle: z.string(),
    displayName: z.string(),
    template: z.string(),
    avatarVersion: z.string().nullable(),
    color: avatarColorSchema.nullable(),
    kind: z.enum(["persistent", "ephemeral"]),
    status: agentStatusSchema,
    archivedAt: z.string().nullable(),
  }),
  unread: z.number().int().positive(),
  /** The oldest unread message from this agent: where the chat opens, and a notification burst's tag. */
  firstUnreadId: z.string(),
  latest: z.object({
    messageId: z.string(),
    preview: z.string().max(280),
    createdAt: z.string(),
    urgent: z.boolean(),
  }),
});
export type ChatRow = z.infer<typeof chatRowSchema>;
export const inboxPageSchema = z.object({
  /** The unread chats: only on the first page (no `before`), unpaginated. */
  chats: z.array(chatRowSchema).optional(),
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
});
