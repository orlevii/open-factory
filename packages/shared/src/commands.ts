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

/**
 * A character that could end the line or hide in it: C0 controls but tab, DEL, NEL and the Unicode line and paragraph
 * separators. Args stay one line of data, so `"/" + name + " " + args` is always one command and never reads as a
 * second message or a second command.
 */
const breaksLine = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029)
      return true;
  }
  return false;
};

/**
 * `POST /api/agents/:slug/commands` (U3 §13.3). `name` is the typed token: the server resolves it against the allowed
 * set and sends the allowed entry's own name, never this string. The 64 KB bound on `/name args` is checked by the
 * route (413), after the name resolves.
 */
export const runCommandBodySchema = z.object({
  name: z.string().min(1).max(MAX_COMMAND_NAME),
  args: z
    .string()
    .trim()
    .refine((s) => !breaksLine(s), "Command arguments must be one line")
    .default(""),
  clientMessageId: z.string().uuid().optional(),
});
export type RunCommandBody = z.infer<typeof runCommandBodySchema>;

/** The raw line a command is written as (U3 §13.3): `/name`, then one space and the args when there are any. */
export const commandText = (name: string, args: string): string =>
  args ? `/${name} ${args}` : `/${name}`;
