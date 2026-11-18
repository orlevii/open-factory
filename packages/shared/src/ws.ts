import { z } from "zod";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), userId: z.string() }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
