import { z } from "zod";

/**
 * A command name or alias: no space, newline or leading `/`, so `"/" + name` is always one token. Project skills are
 * agent-writable, so every bound here is a security bound, not just hygiene.
 */
export const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
export const MAX_COMMAND_NAME = 100;
export const MAX_COMMAND_DESCRIPTION = 2048;
export const MAX_COMMANDS = 500;
export const MAX_CLAUDE_CODE_VERSION = 64;
const commandName = z.string().max(MAX_COMMAND_NAME).regex(COMMAND_NAME_PATTERN);

/** One entry of Claude Code's `initialize` command list (U3 §13.3). Descriptions of skills end in a source tag. */
export const commandSchema = z.object({
  name: commandName,
  description: z.string().max(MAX_COMMAND_DESCRIPTION),
  argumentHint: z.string().max(500),
  builtin: z.boolean().optional(),
  aliases: z.array(commandName).max(20).optional(),
});
export type Command = z.infer<typeof commandSchema>;

/**
 * The well-formed entries of a raw list, at most MAX_COMMANDS. Applied where the list is parsed (the harness) and
 * again where it is stored (the server). `onDrop` hears each malformed entry, so a dropped `builtin` mark is visible.
 */
export function parseCommands(raw: unknown[], onDrop?: (entry: unknown) => void): Command[] {
  const out: Command[] = [];
  for (const c of raw) {
    if (out.length >= MAX_COMMANDS) break;
    const r = commandSchema.safeParse(c);
    if (r.success) out.push(r.data);
    else onDrop?.(c);
  }
  return out;
}

/** The Claude Code version as reported, or undefined when it isn't a short plain string. */
export function boundVersion(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= MAX_CLAUDE_CODE_VERSION && /^[\w.+-]+$/.test(v)
    ? v
    : undefined;
}

/** `GET /api/agents/:slug/commands`: the allowed set (U3 §13.3). `template` before the first start (`at` null). */
export const agentCommandsResponseSchema = z.object({
  commands: z.array(commandSchema),
  source: z.enum(["session", "template"]),
  at: z.string().nullable(),
  /** The template's skills changed after `at`: the list updates when the agent next starts. */
  stale: z.boolean(),
});
export type AgentCommandsResponse = z.infer<typeof agentCommandsResponseSchema>;
