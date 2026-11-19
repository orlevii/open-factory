import { expect, test } from "vitest";
import { buildSettings, claudeMdExcludes, factoryEnvironment } from "./settings.ts";

const base = {
  slug: "lead",
  workdir: "/h/of/agents/lead",
  permissionMode: "auto" as const,
  plugins: ["p@m"],
  grantedPaths: ["/code/app"],
};

test("rebuild: template base, plugin keys from plugins-config carried and filtered, agent keys dropped", () => {
  const s = buildSettings({
    ...base,
    tpl: {
      hooks: { Stop: [] },
      permissions: { deny: ["Bash(curl:*)"], additionalDirectories: ["/data"] },
      extraKnownMarketplaces: { m: { source: { source: "directory", path: "/new" } } },
      enabledPlugins: { "x@y": true },
    },
    pluginKeys: {
      enabledPlugins: { "p@m": true, "old@m": true },
      extraKnownMarketplaces: {
        m: { source: { source: "directory", path: "/old" } },
        other: { source: { source: "git", url: "u" } },
      },
      agentAdded: true,
    },
  });
  expect(s.hooks).toEqual({ Stop: [] });
  expect(s.enabledPlugins).toEqual({ "p@m": true });
  expect(s.extraKnownMarketplaces).toEqual({
    m: { source: { source: "directory", path: "/new" } },
    other: { source: { source: "git", url: "u" } },
  });
  expect(s).not.toHaveProperty("agentAdded");
  expect(s.permissions).toEqual({
    deny: ["Bash(curl:*)"],
    defaultMode: "auto",
    additionalDirectories: ["/data", "/code/app"],
  });
});

test("autoMode: $defaults first in every list, deduped; factory environment appended", () => {
  const s = buildSettings({
    ...base,
    pluginKeys: {},
    tpl: {
      autoMode: {
        hard_deny: ["$defaults", "Never X."],
        soft_deny: ["Y"],
        environment: ["Team env."],
      },
    },
  });
  const am = s.autoMode as Record<string, string[]>;
  expect(am.hard_deny).toEqual(["$defaults", "Never X."]);
  expect(am.soft_deny).toEqual(["$defaults", "Y"]);
  expect(am.environment).toEqual([
    "$defaults",
    "Team env.",
    ...factoryEnvironment("lead", base.workdir, ["/code/app"]),
  ]);
  expect(am).not.toHaveProperty("allow");
});

test("bypass sets bypassPermissions; no grants → 'none' in the environment entry", () => {
  const s = buildSettings({
    ...base,
    permissionMode: "bypass",
    grantedPaths: [],
    pluginKeys: {},
    tpl: {},
  });
  expect((s.permissions as { defaultMode: string }).defaultMode).toBe("bypassPermissions");
  expect(factoryEnvironment("lead", "/w", [])[1]).toContain("(none)");
});

test("claudeMdExcludes: every ancestor's four files plus the workdir's own CLAUDE.md files", () => {
  const ex = claudeMdExcludes("/h/of/agents/lead");
  for (const dir of ["/", "/h", "/h/of", "/h/of/agents"])
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md"])
      expect(ex).toContain(`${dir === "/" ? "" : dir}/${f}`);
  expect(ex).toContain("/h/of/agents/lead/CLAUDE.md");
  expect(ex).toContain("/h/of/agents/lead/CLAUDE.local.md");
  expect(ex).not.toContain("/h/of/agents/lead/AGENTS.md");
  const s = buildSettings({ ...base, pluginKeys: {}, tpl: { claudeMdExcludes: ["/x/CLAUDE.md"] } });
  expect((s.claudeMdExcludes as string[])[0]).toBe("/x/CLAUDE.md");
});
