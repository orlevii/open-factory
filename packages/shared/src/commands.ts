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
  /** Why the factory won't run it (the denylist's reason); the menu shows it instead of offering the command. */
  denied: z.string().max(MAX_COMMAND_DESCRIPTION).optional(),
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

/** Commands the factory never forwards to Claude, by the group their reason belongs to. Keys are lowercase. */
export const DENIED_COMMANDS: Readonly<
  Record<string, "session" | "model" | "credentials" | "process">
> = {
  clear: "session",
  new: "session",
  reset: "session",
  model: "model",
  effort: "model",
  login: "credentials",
  logout: "credentials",
  exit: "process",
  quit: "process",
  resume: "process",
  continue: "process",
};

const DENIED_WHY = {
  session: "each agent keeps one session.",
  model: "the model and effort come from the agent's template.",
  credentials: "credentials are managed in Settings \u2192 Credentials.",
  process: "the factory runs this agent's process.",
} as const;

/** Why `/typed` is refused, naming it as typed, or undefined when it isn't on the denylist. */
export function deniedReason(typed: string): string | undefined {
  const key = typed.toLowerCase();
  if (!Object.hasOwn(DENIED_COMMANDS, key)) return undefined;
  return `/${typed} isn't available: ${DENIED_WHY[DENIED_COMMANDS[key] as keyof typeof DENIED_WHY]}`;
}

export type InputClass =
  | { kind: "text" }
  | { kind: "command"; name: string; args: string; denied?: string; multiline: boolean };

/** Any line break: LF, CR, NEL, U+2028, U+2029. One command is one line. */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;
export const hasLineBreak = (s: string): boolean => LINE_BREAK.test(s);

/** `/name rest`: the typed name (as typed, maybe empty) and the rest of the line. */
const SLASH_INPUT = /^\/([^\s\u0085]*)[\s\u0085]*([\s\S]*)$/;
/** The name typed after the leading `/` of a line, as typed; empty when there is none. */
export const typedCommandName = (text: string): string =>
  SLASH_INPUT.exec(text.trimStart())?.[1] ?? "";

/**
 * What a line of session input is. A command when its first token (after `/`, lowercased) is a known name or alias or
 * is on the denylist; anything else, a path included, is text. `text` is already trimEnd'ed; `known` holds lowercase
 * names and aliases (the list, the snapshot and the template's skills).
 */
export function classifyInput(text: string, known: ReadonlySet<string>): InputClass {
  const t = text.trimStart();
  if (!t.startsWith("/")) return { kind: "text" };
  const m = SLASH_INPUT.exec(t);
  const typed = m?.[1] ?? "";
  const name = typed.toLowerCase();
  if (!name || !(known.has(name) || Object.hasOwn(DENIED_COMMANDS, name))) return { kind: "text" };
  return {
    kind: "command",
    name,
    args: m?.[2] ?? "",
    denied: deniedReason(typed),
    multiline: LINE_BREAK.test(t),
  };
}

/** `POST /api/agents/:slug/input`: the raw text a human types into the session, and the sender's optimistic-row id. */
export const inputBodySchema = z.object({
  text: z.string().min(1),
  clientMessageId: z.string().uuid(),
});
