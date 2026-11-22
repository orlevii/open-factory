import { type AgentCommandsResponse, type Command, commandSchema } from "@open-factory/shared";

/**
 * U3 §13.3, Q36: the built-ins a human may run from the composer. Every other built-in is refused (the template owns
 * it, it is terminal-only, or it starts costly work outside the factory's view), and so is any `builtin: true` bundled
 * workflow or skill. The server enforces this set; the menu shows the same one.
 *
 * `clear` (and its aliases `new`, `reset`) is left out for now (Task 55 review I1): the server's only reset flow,
 * Start a new session, works only after a failed resume, so `/clear` would always be refused on a healthy agent.
 * A healthy-session reset path is future work; until it exists `clear` is refused like any other built-in.
 */
export const BUILTIN_ALLOWLIST: ReadonlySet<string> = new Set([
  "compact",
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
 * Known built-in names (lowercase) outside the allowlist: the spec's refused list, every other `builtin` name and alias
 * in Claude Code 2.1.327's `initialize` list (spike), and the terminal's session commands. They guard the names a list
 * doesn't mark: template skills before the first start (a template skill named `login` or `exit` is refused until a
 * session list exists), and a skill or alias sharing a built-in's name. A built-in added by a later Claude Code is
 * caught by the session list's own `builtin` marks after the first start.
 */
const REFUSED_BUILTINS: ReadonlySet<string> = new Set([
  // Out until a healthy session can be reset (see BUILTIN_ALLOWLIST), with its aliases.
  "clear",
  "new",
  "reset",
  // The spec's list (U3 §13.3) and their aliases.
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
  // The rest of the spike's built-ins, bundled workflows and skills included.
  "__remote-workflow",
  "advisor",
  "auto-mode-setup",
  "autocompact",
  "checkup",
  "claude-api",
  "dataviz",
  "debug",
  "deep-research",
  "design",
  "design-consent",
  "design-revoke",
  "design-sync",
  "extra-usage",
  "fewer-permission-prompts",
  "focus",
  "goal",
  "import",
  "insights",
  "list-agents",
  "loop",
  "output-style",
  "peers",
  "plugin-authoring",
  "proactive",
  "recap",
  "run",
  "run-skill-generator",
  "simplify",
  "skill-doctor",
  "team-onboarding",
  "update-config",
  "usage-credits",
  "verify",
  "workflow-authoring",
  "workflow-launch-exec",
  // Terminal session commands.
  "login",
  "logout",
  "exit",
  "quit",
  "help",
  "resume",
  "status",
  "permissions",
  "memory",
  "hooks",
  "ide",
  "add-dir",
  "export",
  "vim",
  "theme",
  "terminal-setup",
  "upgrade",
  "bug",
  "feedback",
  "release-notes",
  "privacy-settings",
  "plugin",
  "plugins",
]);

/** Case-insensitive: whether Claude resolves `/Model` as `/model` is unverified, so both are refused. */
const isRefusedName = (name: string) => {
  const n = name.toLowerCase();
  return REFUSED_BUILTINS.has(n) || n.startsWith("reload-");
};

export function canonicalCommand(name: string): string {
  return Object.hasOwn(ALIASES, name) ? (ALIASES[name] as string) : name;
}

/**
 * The commands an agent may run: the non-builtin entries (project, plugin and personal skills) and the built-in
 * allowlist, plus template skills the list doesn't have yet.
 * - A non-builtin entry or template skill whose name is a built-in's (one the list marks, or a known one), compared
 *   case-insensitively, is dropped unless it is exactly an allowed built-in's name.
 * - A kept skill's aliases never name a built-in, allowed or not: such aliases are dropped.
 * - Entries outside the schema's bounds (name format, sizes) are dropped.
 */
export function allowedCommands(stored: Command[], templateSkills: string[]): Command[] {
  const builtinNames = new Set<string>();
  for (const c of stored)
    if (c.builtin)
      for (const n of [c.name, ...(c.aliases ?? [])]) builtinNames.add(n.toLowerCase());
  const namesBuiltin = (name: string) => {
    const n = name.toLowerCase();
    return builtinNames.has(n) || isRefusedName(n) || BUILTIN_ALLOWLIST.has(canonicalCommand(n));
  };
  const shadowsBuiltin = (name: string) =>
    !BUILTIN_ALLOWLIST.has(canonicalCommand(name)) && namesBuiltin(name);
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    const c = parsed.data;
    if (c.builtin) {
      if (!BUILTIN_ALLOWLIST.has(c.name)) continue;
    } else {
      if (shadowsBuiltin(c.name)) continue;
      if (c.aliases) {
        const aliases = c.aliases.filter((a) => !namesBuiltin(a));
        if (aliases.length) c.aliases = aliases;
        else delete c.aliases;
      }
    }
    seen.add(c.name);
    out.push(c);
  }
  for (const name of templateSkills) {
    const entry = { name, description: "", argumentHint: "" };
    if (seen.has(name) || shadowsBuiltin(name) || !commandSchema.safeParse(entry).success) continue;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

/**
 * The allowed entry `name` names (after canonicalizing built-in aliases, or by a skill's own alias). Dispatch
 * (Task 55) must send `"/" + entry.name`, never the token the human typed: an alias only finds an entry.
 */
export function findCommand(allowed: Command[], name: string): Command | undefined {
  const n = canonicalCommand(name);
  const exact = allowed.find((c) => c.name === n);
  if (exact) return exact;
  // An alias that names a built-in never resolves, even if an unchecked list carried one.
  if (isRefusedName(n) || BUILTIN_ALLOWLIST.has(canonicalCommand(n.toLowerCase())))
    return undefined;
  return allowed.find((c) => !c.builtin && c.aliases?.includes(n));
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
