import { z } from "zod";
import { agentStatusSchema, queueItemSchema } from "./agents.ts";
import { sessionEventSchema } from "./events.ts";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    agent: z.string(),
    afterSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("unsubscribe"), agent: z.string() }),
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
});
export type AgentStatusFrame = z.infer<typeof agentStatusFrameSchema>;

/** A typed union: S3 adds frames here; a later `assistant_delta` frame fits without other changes. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), userId: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("session_event"), agent: z.string(), event: sessionEventSchema }),
  z.object({ type: z.literal("queue"), agent: z.string(), items: z.array(queueItemSchema) }),
  agentStatusFrameSchema,
  z.object({ type: z.literal("resync"), agent: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
