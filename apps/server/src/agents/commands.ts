import {
  type AgentCommandsResponse,
  CLAUDE_BUILTINS,
  type Command,
  commandSchema,
  deniedReason,
} from "@open-factory/shared";

/** The reason a command's name is on the denylist. A skill is flagged by its name only, never by an alias. */
const denial = (c: Command): string | undefined => deniedReason(c.name);

/**
 * Every command the menu may show: the stored session list, or before the first start Claude Code's built-in
 * snapshot, then the template's skills the list doesn't have yet. Nothing is dropped; a name on the denylist carries
 * its reason in `denied`, so the menu can say why it can't run. Entries outside the schema's bounds are dropped.
 */
export function commandList(stored: Command[] | undefined, templateSkills: string[]): Command[] {
  const base: Command[] =
    stored ?? CLAUDE_BUILTINS.map((b) => ({ ...b, builtin: true, aliases: [...b.aliases] }));
  const out: Command[] = [];
  const seen = new Set<string>();
  const add = ({ denied: _ignored, ...c }: Command) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    const denied = denial(c);
    out.push(denied ? { ...c, denied } : c);
  };
  for (const raw of base) {
    const parsed = commandSchema.safeParse(raw);
    if (parsed.success) add(parsed.data);
  }
  if (!stored) {
    for (const name of templateSkills) {
      const parsed = commandSchema.safeParse({ name, description: "", argumentHint: "" });
      if (parsed.success) add(parsed.data);
    }
  }
  return out;
}

/**
 * The GET body (U3 §13.3). Before the first start, the built-ins and the template's skills (`source: "template"`).
 * After it, the session's list; `stale` when the template now has a skill that list lacks, which the next start
 * picks up.
 */
export function commandsResponse(
  stored: { commands: Command[]; at: Date } | undefined,
  templateSkills: string[],
): AgentCommandsResponse {
  if (!stored)
    return {
      commands: commandList(undefined, templateSkills),
      source: "template",
      at: null,
      stale: false,
    };
  const have = new Set(stored.commands.map((c) => c.name));
  return {
    commands: commandList(stored.commands, []),
    source: "session",
    at: stored.at.toISOString(),
    stale: templateSkills.some((s) => !have.has(s)),
  };
}
