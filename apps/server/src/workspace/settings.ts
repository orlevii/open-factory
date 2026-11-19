import path from "node:path";

const LISTS = ["environment", "allow", "soft_deny", "hard_deny"] as const;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export interface SettingsInput {
  tpl: Record<string, unknown>;
  /** `enabledPlugins`/`extraKnownMarketplaces` from the factory-owned `plugins-config/settings.json`
   *  (spec §11.7), never from the agent's config-dir settings, which the agent can write. */
  pluginKeys: Record<string, unknown>;
  slug: string;
  workdir: string;
  permissionMode: "auto" | "bypass";
  plugins: string[];
  grantedPaths: string[];
}

export function factoryEnvironment(
  slug: string,
  workdir: string,
  grantedPaths: string[],
): string[] {
  return [
    `This is an Open Factory agent named @${slug}, run headless for the humans who operate this factory.`,
    `Its working directory ${workdir} and the granted project repositories (${grantedPaths.length ? grantedPaths.join(", ") : "none"}) are trusted local workspaces.`,
    "The git remotes configured in the granted project repositories are trusted source control for this agent's branches and pull requests.",
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
  delete tpl.enabledPlugins;
  const installed = obj(i.pluginKeys.enabledPlugins);
  const enabledPlugins = Object.fromEntries(
    Object.entries(installed).filter(([k]) => i.plugins.includes(k)),
  );
  const extraKnownMarketplaces = {
    ...obj(i.pluginKeys.extraKnownMarketplaces),
    ...obj(i.tpl.extraKnownMarketplaces),
  };
  const perms = obj(tpl.permissions);
  const permissions = {
    ...perms,
    defaultMode: i.permissionMode === "bypass" ? "bypassPermissions" : "auto",
    additionalDirectories: [...new Set([...strs(perms.additionalDirectories), ...i.grantedPaths])],
  };
  const tplAuto = obj(tpl.autoMode);
  const autoMode: Record<string, unknown> = { ...tplAuto };
  for (const k of LISTS) {
    const own = strs(tplAuto[k]).filter((x) => x !== "$defaults");
    const extra = k === "environment" ? factoryEnvironment(i.slug, i.workdir, i.grantedPaths) : [];
    if (own.length || extra.length) autoMode[k] = ["$defaults", ...own, ...extra];
    else delete autoMode[k];
  }
  return {
    ...tpl,
    extraKnownMarketplaces,
    enabledPlugins,
    permissions,
    autoMode,
    claudeMdExcludes: [...strs(tpl.claudeMdExcludes), ...claudeMdExcludes(i.workdir)],
  };
}
