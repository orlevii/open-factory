import path from "node:path";
import { PLUGIN_SETTINGS_KEYS } from "@open-factory/shared";
import type { DenyRules } from "../spawning/inherit.ts";

const LISTS = ["environment", "allow", "soft_deny", "hard_deny"] as const;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export interface SettingsInput {
  tpl: Record<string, unknown>;
  slug: string;
  workdir: string;
  permissionMode: "auto" | "bypass";
  grantedPaths: string[];
  /** The exact agent MCP URL this agent reaches (spec §10.4). */
  mcpUrl: string;
  /** Deny rules inherited from the spawner (spec §6); appended after the template's own. */
  inherited?: DenyRules;
}

/** Claude Code's built-in agent-team tools would bypass the factory's messaging (spec §10.4). */
const BUILT_IN_TEAM_TOOLS = ["SendMessage", "ListAgents"];

export function factoryEnvironment(
  slug: string,
  workdir: string,
  grantedPaths: string[],
  mcpUrl: string,
): string[] {
  return [
    `This is an Open Factory agent named @${slug}, run headless for the humans who operate this factory.`,
    `Its working directory ${workdir} and the granted project repositories (${grantedPaths.length ? grantedPaths.join(", ") : "none"}) are trusted local workspaces.`,
    "The git remotes configured in the granted project repositories are trusted source control for this agent's branches and pull requests.",
    `The Open Factory MCP server at ${mcpUrl} is trusted local infrastructure this agent uses to message other agents and humans.`,
  ];
}

export function claudeMdExcludes(workdir: string): string[] {
  const out: string[] = [];
  let dir = path.dirname(workdir);
  for (;;) {
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"])
      out.push(path.join(dir, f));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  out.push(path.join(workdir, "CLAUDE.md"), path.join(workdir, "CLAUDE.local.md"));
  return out;
}

export function buildSettings(i: SettingsInput): Record<string, unknown> {
  const tpl = structuredClone(i.tpl);
  // The plugin keys never reach the workdir: the factory passes its own with `--settings` (spec §7.3 step 5).
  for (const key of PLUGIN_SETTINGS_KEYS) delete tpl[key];
  const perms = obj(tpl.permissions);
  const permissions = {
    ...perms,
    deny: [
      ...new Set([
        ...strs(perms.deny),
        ...(i.inherited?.permissionsDeny ?? []),
        ...BUILT_IN_TEAM_TOOLS,
      ]),
    ],
    defaultMode: i.permissionMode === "bypass" ? "bypassPermissions" : "auto",
    additionalDirectories: [...new Set([...strs(perms.additionalDirectories), ...i.grantedPaths])],
  };
  const tplAuto = obj(tpl.autoMode);
  const autoMode: Record<string, unknown> = { ...tplAuto };
  for (const k of LISTS) {
    const own = [
      ...new Set([
        ...strs(tplAuto[k]).filter((x) => x !== "$defaults"),
        ...(k === "soft_deny"
          ? (i.inherited?.softDeny ?? [])
          : k === "hard_deny"
            ? (i.inherited?.hardDeny ?? [])
            : []),
      ]),
    ];
    const extra =
      k === "environment" ? factoryEnvironment(i.slug, i.workdir, i.grantedPaths, i.mcpUrl) : [];
    if (own.length || extra.length) autoMode[k] = ["$defaults", ...own, ...extra];
    else delete autoMode[k];
  }
  return {
    ...tpl,
    permissions,
    autoMode,
    claudeMdExcludes: [...strs(tpl.claudeMdExcludes), ...claudeMdExcludes(i.workdir)],
  };
}
