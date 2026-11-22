import { z } from "zod";

/** One entry of Claude Code's `initialize` command list (U3 §13.3). Descriptions of skills end in a source tag. */
export const commandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string(),
  builtin: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
});
export type Command = z.infer<typeof commandSchema>;

/** `GET /api/agents/:slug/commands`: the allowed set (U3 §13.3). `template` before the first start (`at` null). */
export const agentCommandsResponseSchema = z.object({
  commands: z.array(commandSchema),
  source: z.enum(["session", "template"]),
  at: z.string().nullable(),
  /** The template's skills changed after `at`: the list updates when the agent next starts. */
  stale: z.boolean(),
});
export type AgentCommandsResponse = z.infer<typeof agentCommandsResponseSchema>;
