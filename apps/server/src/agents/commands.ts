import type { AgentCommandsResponse, Command } from "@open-factory/shared";

/**
 * U3 §13.3, Q36: the built-ins a human may run from the composer. Every other built-in is refused (the template owns
 * it, it is terminal-only, or it starts costly work outside the factory's view), and so is any `builtin: true` bundled
 * workflow or skill. The server enforces this set; the menu shows the same one.
 */
export const BUILTIN_ALLOWLIST: ReadonlySet<string> = new Set([
  "compact",
  "clear",
  "context",
  "usage",
  "code-review",
  "security-review",
  "init",
]);

const ALIASES: Readonly<Record<string, string>> = {
  cost: "usage",
  stats: "usage",
  review: "code-review",
  new: "clear",
  reset: "clear",
};

/**
 * Built-ins the spec names as refused. They guard the names a list doesn't mark (template skills before the first
 * start, a skill that shares a built-in's name), so no stored or template entry can ever reach one of them.
 */
const REFUSED_BUILTINS: ReadonlySet<string> = new Set([
  "model",
  "effort",
  "config",
  "settings",
  "color",
  "fast",
  "rename",
  "name",
  "mcp",
  "agents",
  "doctor",
  "heapdump",
  "ultrareview",
  "schedule",
  "routines",
  "batch",
]);
const isRefusedName = (name: string) => REFUSED_BUILTINS.has(name) || name.startsWith("reload-");

export function canonicalCommand(name: string): string {
  return Object.hasOwn(ALIASES, name) ? (ALIASES[name] as string) : name;
}

/**
 * The commands an agent may run: the non-builtin entries (project, plugin and personal skills) and the built-in
 * allowlist, plus template skills the list doesn't have yet. A non-builtin entry or template skill whose name is a
 * built-in's (one the list marks, or one the spec refuses) is dropped unless that built-in is allowed.
 */
export function allowedCommands(stored: Command[], templateSkills: string[]): Command[] {
  const builtinNames = new Set<string>();
  for (const c of stored)
    if (c.builtin) for (const n of [c.name, ...(c.aliases ?? [])]) builtinNames.add(n);
  const shadowsBuiltin = (name: string) =>
    !BUILTIN_ALLOWLIST.has(canonicalCommand(name)) &&
    (builtinNames.has(name) || isRefusedName(name));
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const c of stored) {
    if (seen.has(c.name)) continue;
    const ok = c.builtin ? BUILTIN_ALLOWLIST.has(c.name) : !shadowsBuiltin(c.name);
    if (!ok) continue;
    seen.add(c.name);
    out.push(c);
  }
  for (const name of templateSkills) {
    if (seen.has(name) || shadowsBuiltin(name)) continue;
    seen.add(name);
    out.push({ name, description: "", argumentHint: "" });
  }
  return out;
}

/** The allowed entry `name` names (after canonicalizing built-in aliases, or by a skill's own alias). */
export function findCommand(allowed: Command[], name: string): Command | undefined {
  const n = canonicalCommand(name);
  return (
    allowed.find((c) => c.name === n) ?? allowed.find((c) => !c.builtin && c.aliases?.includes(n))
  );
}

/**
 * The GET body (U3 §13.3). Before the first start, the template's skills (`source: "template"`). After it, the
 * session's list; `stale` when the template now has a skill that list lacks, which the next start picks up.
 */
export function commandsResponse(
  stored: { commands: Command[]; at: Date } | undefined,
  templateSkills: string[],
): AgentCommandsResponse {
  if (!stored)
    return {
      commands: allowedCommands([], templateSkills),
      source: "template",
      at: null,
      stale: false,
    };
  const have = new Set(stored.commands.map((c) => c.name));
  return {
    commands: allowedCommands(stored.commands, []),
    source: "session",
    at: stored.at.toISOString(),
    stale: templateSkills.some((s) => !have.has(s)),
  };
}
