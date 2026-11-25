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
    slug: z.string(),
    displayName: z.string(),
    template: z.string(),
    avatarVersion: z.string().nullable(),
    color: avatarColorSchema.nullable(),
    kind: z.enum(["persistent", "ephemeral"]),
    status: agentStatusSchema,
    archivedAt: z.string().nullable(),
  }),
  unread: z.number().int().positive(),
  latest: z.object({
    messageId: z.string(),
    preview: z.string().max(280),
    createdAt: z.string(),
    urgent: z.boolean(),
  }),
});
export type ChatRow = z.infer<typeof chatRowSchema>;
/**
 * I9 §4.5: one report's unread member updates to you (a human manager), grouped into one row ("3 updates from @ada"):
 * the report's summary, how many, and the newest. The same shape as a chat row. They never notify.
 */
export const updateRowSchema = chatRowSchema;
export type UpdateRow = ChatRow;
export const inboxPageSchema = z.object({
  /** The unread chats: only on the first page (no `before`), unpaginated. */
  chats: z.array(chatRowSchema).optional(),
  /** The unread member updates of your reports, one row per report: only on the first page, unpaginated. */
  updates: z.array(updateRowSchema).optional(),
  items: z.array(inboxItemSchema),
  nextCursor: z.string().nullable(),
});
