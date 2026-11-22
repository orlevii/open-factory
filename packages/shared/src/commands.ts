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
