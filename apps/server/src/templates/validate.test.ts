// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP files reference secrets as ${NAME}.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MarketplaceRow } from "@open-factory/db";
import { emptyDoc, FACTORY_ENV_NAMES } from "@open-factory/shared";
import { expect, test } from "vitest";
import { hostOnlyLibrary, writeHostSkill } from "../test/library.ts";
import {
  overlayIssues,
  overlaySchemaIssues,
  type ValidationContext,
  validateEffective,
  validateTemplate,
} from "./validate.ts";

const claude = mkdtempSync(path.join(tmpdir(), "claude-"));
writeHostSkill(claude, "grilling");
// A host skill whose SKILL.md names another skill, so the Library calls it unusable.
mkdirSync(path.join(claude, "skills", "renamed"));
writeFileSync(path.join(claude, "skills", "renamed", "SKILL.md"), "---\nname: other\n---\n");

// The Library's registered marketplaces, as checkouts of one catalog: `acme` at a commit and a tag, `local` as a folder.
const COMMIT = "a".repeat(40);
const TAG_COMMIT = "b".repeat(40);
const OTHER_COMMIT = "c".repeat(40);
const CATALOG = {
  name: "acme",
  plugins: [
    { name: "rel", source: "./plugins/rel" },
    { name: "held", source: { source: "github", repo: "o/held", sha: COMMIT } },
    { name: "free", source: { source: "github", repo: "o/free" } },
    { name: "cmd", source: { source: "command", command: "x" } },
  ],
};
const writeCatalog = (dir: string, catalog = CATALOG) => {
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify(catalog));
};
const registryHome = mkdtempSync(path.join(tmpdir(), "of-reg-"));
const checkout = (name: string, sha: string) =>
  path.join(registryHome, "state", "library", "marketplaces", name, sha);
for (const [name, sha] of [
  ["acme", COMMIT],
  ["acme", TAG_COMMIT],
  ["claude-plugins-official", COMMIT],
] as const)
  writeCatalog(checkout(name, sha));
const localDir = mkdtempSync(path.join(tmpdir(), "of-local-mk-"));
writeCatalog(localDir);
const row = (
  name: string,
  source: MarketplaceRow["source"],
  over: Partial<MarketplaceRow> = {},
): MarketplaceRow => ({
  name,
  source,
  branch: "main",
  commit: COMMIT,
  committedAt: null,
  subject: null,
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  tags: {},
  state: "ready",
  startedAt: new Date(0),
  addedBy: "@or",
  addedAt: new Date(0),
  deletedAt: null,
  ...over,
});
const ACME = { source: "github", repo: "o/acme" } as const;
const registry = [
  row("acme", ACME, { tags: { v1: TAG_COMMIT } }),
  row("claude-plugins-official", { source: "github", repo: "anthropics/claude-plugins-official" }),
  row("local", { source: "directory", path: localDir }, { commit: null }),
];
const ctx: ValidationContext = {
  projects: new Set(["app"]),
  secrets: new Set(["GH_TOKEN"]),
  templates: new Set(["tech-lead", "dev"]),
  userImages: new Set(["smoke"]),
  library: hostOnlyLibrary(claude, registryHome, [], registry),
  localRuntimeAllowed: true,
};

function tpl(files: Record<string, string>, name = "tech-lead") {
  const root = mkdtempSync(path.join(tmpdir(), "tpl-"));
  const dir = path.join(root, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
const base = {
  "template.yaml": "name: tech-lead\ndisplay_name: Tech Lead\nruntime: local\n",
  "AGENTS.md": "# TL\n",
};

test("a clean template", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", ctx);
  expect(r.issues).toEqual([]);
  expect(r.config?.runtime).toBe("local");
  expect(r.tplSettings).toEqual({});
  expect(r.tplMcp).toEqual({ mcpServers: {} });
});

test.each([
  ["missing AGENTS.md", { "AGENTS.md": null }, /AGENTS\.md is missing/],
  ["yaml syntax", { "template.yaml": "name: [" }, /YAML/],
  ["schema", { "template.yaml": "name: tech-lead\ndisplay_name: X\nmodle: opus\n" }, /modle/],
  [
    "model that looks like a flag",
    {
      "template.yaml": "name: tech-lead\ndisplay_name: X\nmodel: --dangerously-skip-permissions\n",
    },
    /Can't start with a dash\./,
  ],
  [
    "name != folder",
    { "template.yaml": "name: other\ndisplay_name: X\n" },
    /doesn't match the folder/,
  ],
  [
    "a skill that hasn't been added",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [nope]\n" },
    /^Skill nope hasn't been added in Skills\.$/,
  ],
  [
    "an unusable skill",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [renamed]\n" },
    /^Skill renamed is unusable: SKILL\.md names it other\.$/,
  ],
  [
    "a Library skill vs a template skill",
    {
      "template.yaml": "name: tech-lead\ndisplay_name: X\nskills: [grilling]\n",
      "skills/grilling/SKILL.md": "x",
    },
    /same name/,
  ],
  [
    "unknown project",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nprojects: [web]\n" },
    /Project web isn't registered/,
  ],
  [
    "bypass + local",
    {
      "template.yaml":
        "name: tech-lead\ndisplay_name: X\nruntime: local\npermission_mode: bypass\n",
    },
    /bypass/,
  ],
  [
    "factory env in settings",
    { "settings.json": '{"env":{"ANTHROPIC_API_KEY":"x"}}' },
    /^ANTHROPIC_API_KEY is set by the factory\.$/,
  ],
  [
    "factory env in secrets",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [OPEN_FACTORY_X]\n" },
    /reserved/,
  ],
  ["mcp without mcpServers", { "mcp.json": "{}" }, /mcpServers/],
  ["reserved mcp server", { "mcp.json": '{"mcpServers":{"factory":{}}}' }, /factory/],
  ["reserved files entry", { "files/CLAUDE.md": "x" }, /files\/CLAUDE\.md/],
  [
    "bad marketplace source",
    {
      "settings.json": '{"extraKnownMarketplaces":{"m":{"source":{"source":"npm","package":"x"}}}}',
    },
    /source/,
  ],
  [
    "plugins in template.yaml",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nplugins: [p@m]\n" },
    /^Unknown field plugins\.$/,
  ],
])("error: %s", async (_n, files, re) => {
  const dir = tpl(
    Object.fromEntries(
      Object.entries({ ...base, ...files }).filter(([, v]) => v !== null),
    ) as Record<string, string>,
  );
  const issues = (await validateTemplate(dir, "tech-lead", ctx)).issues;
  expect(issues.filter((i) => i.severity === "error").map((i) => i.message)).toContainEqual(
    expect.stringMatching(re),
  );
});

test.each([
  [
    "undefined secret",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [NPM_TOKEN]\n" },
    /Secret NPM_TOKEN isn't set/,
  ],
  [
    "unknown can_spawn",
    { "template.yaml": "name: tech-lead\ndisplay_name: X\ncan_spawn: [ghost]\n" },
    /ghost/,
  ],
  [
    "unresolved MCP reference",
    { "mcp.json": '{"mcpServers":{"gh":{"url":"u","headers":{"A":"Bearer ${NOPE}"}}}}' },
    /^NOPE isn't a secret or env var here\.$/,
  ],
])("warning: %s", async (_n, files, re) => {
  const issues = (await validateTemplate(tpl({ ...base, ...files }), "tech-lead", ctx)).issues;
  expect(issues.filter((i) => i.severity === "warning").map((i) => i.message)).toContainEqual(
    expect.stringMatching(re),
  );
  expect(issues.filter((i) => i.severity === "error")).toEqual([]);
});

test("schema issue carries the yaml line; json issue carries line and column", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "template.yaml": "name: tech-lead\ndisplay_name: X\nskills:\n  - ..\n" }),
    "tech-lead",
    ctx,
  );
  expect(r.issues[0]).toMatchObject({ file: "template.yaml", line: 4 });
  const j = await validateTemplate(
    tpl({ ...base, "settings.json": '{\n "a": 1,\n}' }),
    "tech-lead",
    ctx,
  );
  expect(j.issues[0]).toMatchObject({ file: "settings.json", line: 3 });
});

test("override substitutes unsaved content for one file", async () => {
  const dir = tpl(base);
  const r = await validateTemplate(dir, "tech-lead", ctx, {
    "template.yaml": "name: tech-lead\ndisplay_name: X\nprojects: [web]\n",
  });
  expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/web/));
});

// Plugin declarations and pins (spec §7.4).
const declare = (name: string, source: Record<string, unknown>, plugins: string[] = []) => ({
  "settings.json": JSON.stringify({
    extraKnownMarketplaces: { [name]: { source } },
    ...(plugins.length
      ? { enabledPlugins: Object.fromEntries(plugins.map((k) => [k, true])) }
      : {}),
  }),
});
const issuesOf = async (files: Record<string, string>) =>
  (await validateTemplate(tpl({ ...base, ...files }), "tech-lead", ctx)).issues;
const messages = (issues: { message: string }[]) => issues.map((i) => i.message);

test("a pinned declaration of a registered marketplace is clean", async () => {
  expect(
    await issuesOf(declare("acme", { ...ACME, ref: TAG_COMMIT }, ["rel@acme", "held@acme"])),
  ).toEqual([]);
  expect(await issuesOf(declare("acme", { ...ACME, ref: "v1" }, ["rel@acme"]))).toEqual([]);
});

test("a directory marketplace is live: no pin and no Latest warning", async () => {
  expect(
    await issuesOf(declare("local", { source: "directory", path: localDir }, ["free@local"])),
  ).toEqual([]);
});

test.each([
  ["a branch ref", "refs/heads/main"],
  ["a range of dots", "a..b"],
  ["a ref with a space", "v 1"],
])("%s is refused as a pin", async (_n, ref) => {
  expect(messages(await issuesOf(declare("acme", { ...ACME, ref })))).toContain(
    "Pin acme to a commit or a tag.",
  );
});

test("a ref that isn't a string is refused as a pin", async () => {
  expect(messages(await issuesOf(declare("acme", { ...ACME, ref: 7 })))).toContain(
    "Pin acme to a commit or a tag.",
  );
});

test("a commit pin on the official marketplace is refused by Claude Code", async () => {
  const official = { source: "github", repo: "anthropics/claude-plugins-official" };
  expect(
    messages(await issuesOf(declare("claude-plugins-official", { ...official, ref: COMMIT }))),
  ).toContain("Claude Code can't pin claude-plugins-official to a commit; use a tag or Latest.");
  expect(
    await issuesOf(declare("claude-plugins-official", official, ["rel@claude-plugins-official"])),
  ).toEqual([
    expect.objectContaining({
      severity: "warning",
      message:
        "Plugin rel@claude-plugins-official follows the latest claude-plugins-official: new code runs at each restart without review.",
    }),
  ]);
});

test("a tag Skills hasn't read is a warning, and so is a commit it hasn't", async () => {
  const unread = await issuesOf(declare("acme", { ...ACME, ref: "v2" }));
  expect(unread).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: "Skills hasn't read acme at v2; fetch it in Skills.",
    }),
  ]);
  expect(messages(await issuesOf(declare("acme", { ...ACME, ref: OTHER_COMMIT })))).toContain(
    "Skills hasn't read acme at ccccccc; fetch it in Skills.",
  );
});

test("an unregistered marketplace names the fix: Add from this template", async () => {
  const issues = await issuesOf(declare("elsewhere", { source: "github", repo: "o/else" }));
  expect(issues).toEqual([
    expect.objectContaining({
      severity: "error",
      message: "Marketplace elsewhere hasn't been added. Add it in Skills.",
      action: "add_from_template",
    }),
  ]);
});

test("a source that differs from the one in Skills is an error, whatever the ref", async () => {
  const issues = await issuesOf(declare("acme", { source: "github", repo: "o/other", ref: "v1" }));
  expect(messages(issues)).toEqual(["Marketplace acme's source differs from the one in Skills."]);
});

test("a path on a git marketplace and a ref on a folder are refused", async () => {
  expect(messages(await issuesOf(declare("acme", { ...ACME, path: "p" })))).toContain(
    "Marketplace acme: path isn't supported.",
  );
  expect(
    messages(await issuesOf(declare("local", { source: "directory", path: localDir, ref: "v1" }))),
  ).toContain("Marketplace local: a folder is read live; remove ref.");
});

test.each([
  ["false", false, "Remove the plugin instead of turning it off."],
  ["a string", "yes", "Use true, or remove the plugin."],
])("an enabledPlugins value of %s is an error", async (_n, value, message) => {
  const files = declare("acme", { ...ACME, ref: "v1" });
  files["settings.json"] = JSON.stringify({
    extraKnownMarketplaces: { acme: { source: { ...ACME, ref: "v1" } } },
    enabledPlugins: { "rel@acme": value },
  });
  expect(messages(await issuesOf(files))).toEqual([message]);
});

test("a plugin from an undeclared marketplace is an error", async () => {
  const issues = await issuesOf({ "settings.json": '{"enabledPlugins":{"p@m":true}}' });
  expect(issues).toEqual([
    expect.objectContaining({
      severity: "error",
      message: "Marketplace m isn't declared in settings.json.",
      path: "settings.enabledPlugins.p@m",
    }),
  ]);
});

test.each(["constructor", "toString"])(
  "plugin from inherited name %s has no marketplace",
  async (m) => {
    const issues = await issuesOf({ "settings.json": `{"enabledPlugins":{"x@${m}":true}}` });
    expect(messages(issues)).toEqual([`Marketplace ${m} isn't declared in settings.json.`]);
  },
);

test("a key that isn't name@marketplace is refused without echoing it", async () => {
  const secret = "sk-ant-SECRET0123456789";
  const issues = await issuesOf({
    "settings.json": JSON.stringify({ enabledPlugins: { [secret]: true } }),
  });
  expect(messages(issues)).toEqual(["Use name@marketplace."]);
  expect(JSON.stringify(issues)).not.toContain(secret);
});

test("syncClaudeAiPlugins in a template is an error", async () => {
  expect(messages(await issuesOf({ "settings.json": '{"syncClaudeAiPlugins":true}' }))).toEqual([
    "The factory sets syncClaudeAiPlugins.",
  ]);
});

test("a plugin whose catalog entry uses a refused source is an error", async () => {
  const issues = await issuesOf(declare("acme", { ...ACME, ref: "v1" }, ["cmd@acme"]));
  expect(messages(issues)).toEqual([
    "Plugin cmd@acme uses a command source, which Open Factory doesn't install.",
  ]);
});

test("an unpinnable plugin under a pinned declaration says to switch to Latest", async () => {
  const issues = await issuesOf(declare("acme", { ...ACME, ref: "v1" }, ["free@acme"]));
  expect(messages(issues)).toEqual(["free@acme can't be pinned. Switch acme to Latest to add it."]);
});

test("Latest is a warning for each plugin that follows it, and lets an unpinnable plugin in", async () => {
  const issues = await issuesOf(declare("acme", ACME, ["free@acme", "rel@acme"]));
  expect(issues.map((i) => [i.severity, i.message])).toEqual([
    [
      "warning",
      "Plugin free@acme follows the latest acme: new code runs at each restart without review.",
    ],
    [
      "warning",
      "Plugin rel@acme follows the latest acme: new code runs at each restart without review.",
    ],
  ]);
});

test("reserved files entries match case-insensitively", async () => {
  const r = await validateTemplate(tpl({ ...base, "files/claude.md": "x" }), "tech-lead", ctx);
  expect(r.issues.map((i) => i.message)).toContainEqual(expect.stringMatching(/files\/claude\.md/));
});

test("gate off: validator warns on runtime: local", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", { ...ctx, localRuntimeAllowed: false });
  expect(r.issues).toEqual([
    {
      severity: "warning",
      file: "template.yaml",
      message: "The local runtime is disabled on this factory.",
      line: 3,
      path: "template.runtime",
    },
  ]);
  const docker = tpl({
    ...base,
    "template.yaml": "name: tech-lead\ndisplay_name: Tech Lead\nruntime: docker\n",
  });
  expect(
    (await validateTemplate(docker, "tech-lead", { ...ctx, localRuntimeAllowed: false })).issues,
  ).toEqual([]);
});

test("a bare image name without images/<name>/Dockerfile is an error naming the escape", async () => {
  const yaml = "name: tech-lead\ndisplay_name: Tech Lead\nruntime: docker\nimage: ubuntu\n";
  const r = await validateTemplate(tpl({ ...base, "template.yaml": yaml }), "tech-lead", ctx);
  expect(r.issues).toEqual([
    {
      severity: "error",
      file: "template.yaml",
      message:
        "No user image \u2018ubuntu\u2019 (images/ubuntu/Dockerfile). For a Docker Hub image, write docker.io/library/ubuntu.",
      line: 4,
      path: "template.image",
    },
  ]);
});

test("a bare image name with its Dockerfile, and a registry reference, are fine", async () => {
  for (const image of ["smoke", "docker.io/library/ubuntu"]) {
    const yaml = `name: tech-lead\ndisplay_name: Tech Lead\nruntime: docker\nimage: ${image}\n`;
    const r = await validateTemplate(tpl({ ...base, "template.yaml": yaml }), "tech-lead", ctx);
    expect(r.issues).toEqual([]);
  }
});

test("a settings.json defaultMode is an error", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "settings.json": '{"permissions":{"defaultMode":"dontAsk"}}' }),
    "tech-lead",
    ctx,
  );
  expect(r.issues).toEqual([
    expect.objectContaining({ severity: "error", path: "settings.permissions.defaultMode" }),
  ]);
});

test("an MCP reference to a secret or env var raises nothing", async () => {
  const files = {
    ...base,
    "template.yaml": "name: tech-lead\ndisplay_name: X\nsecrets: [GH_TOKEN]\n",
    "settings.json": '{"env":{"REGION":"eu"}}',
    "mcp.json":
      '{"mcpServers":{"gh":{"url":"u","headers":{"A":"Bearer ${GH_TOKEN}"},"env":{"R":"${REGION}"}}}}',
  };
  expect((await validateTemplate(tpl(files), "tech-lead", ctx)).issues).toEqual([]);
});

test("validateTemplate returns the parsed template.yaml object", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", ctx);
  expect(r.tplYaml).toEqual({ name: "tech-lead", display_name: "Tech Lead", runtime: "local" });
});

test("a symlinked skill folder is an error", async () => {
  const dir = tpl(base);
  const target = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
  mkdirSync(path.join(dir, "skills"));
  symlinkSync(target, path.join(dir, "skills", "x"));
  const r = await validateTemplate(dir, "tech-lead", ctx);
  expect(r.issues).toEqual([
    expect.objectContaining({
      severity: "error",
      file: "skills",
      message: "skills/x must be a folder, not a link.",
    }),
  ]);
});

test("a symlinked skills folder is an error", async () => {
  const dir = tpl(base);
  symlinkSync(mkdtempSync(path.join(tmpdir(), "elsewhere-")), path.join(dir, "skills"));
  const r = await validateTemplate(dir, "tech-lead", ctx);
  expect(r.issues).toEqual([
    expect.objectContaining({
      severity: "error",
      file: "skills",
      message: "skills/ must be a folder, not a link.",
    }),
  ]);
});

test("real skill folders and dotfiles in skills/ are fine", async () => {
  const dir = tpl({ ...base, "skills/a/SKILL.md": "x", "skills/.DS_Store": "x" });
  expect((await validateTemplate(dir, "tech-lead", ctx)).issues).toEqual([]);
});

test("I2 §7.2: the real skill folders come back sorted, as the doc's local_skill_names", async () => {
  const dir = tpl({ ...base, "skills/zeta/SKILL.md": "x", "skills/alpha/SKILL.md": "x" });
  expect((await validateTemplate(dir, "tech-lead", ctx)).localSkillNames).toEqual([
    "alpha",
    "zeta",
  ]);
  expect((await validateTemplate(tpl(base), "tech-lead", ctx)).localSkillNames).toEqual([]);
});

test("local_skill_names is derived only: template.yaml can't set it, validateEffective accepts it in a doc", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "template.yaml": `${base["template.yaml"]}local_skill_names: [x]\n` }),
    "tech-lead",
    ctx,
  );
  expect(r.issues.some((i) => i.severity === "error")).toBe(true);
  const ok = await validateTemplate(tpl(base), "tech-lead", ctx);
  // The semantic rules still run on a doc carrying the key (a strict parse failure would skip them silently).
  const doc = {
    template: { ...ok.tplYaml, skills: ["nope"], local_skill_names: ["x"] },
    settings: ok.tplSettings,
    mcp: ok.tplMcp,
  };
  expect(await validateEffective(doc, ctx, "human")).toEqual([
    expect.objectContaining({ severity: "error", path: "template.skills.0" }),
  ]);
});

test("a runtime that differs from an existing agent's warns", async () => {
  const r = await validateTemplate(tpl(base), "tech-lead", { ...ctx, agentRuntimes: ["docker"] });
  expect(r.issues).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: "Existing agents keep their runtime.",
      path: "template.runtime",
    }),
  ]);
  expect(
    (await validateTemplate(tpl(base), "tech-lead", { ...ctx, agentRuntimes: ["local"] })).issues,
  ).toEqual([]);
});

const baseDoc = () => ({
  ...emptyDoc(),
  template: { name: "dev", display_name: "Dev", runtime: "local" },
});

test("validateEffective roots paths at template., settings. and mcp.", () => {
  const doc = {
    template: { name: "dev", display_name: "Dev", projects: ["nope"] },
    settings: { permissions: { defaultMode: "x" } },
    mcp: { mcpServers: { factory: {} } },
  };
  return validateEffective(doc, ctx, "human").then((issues) => {
    expect(issues.map((i) => i.path).sort()).toEqual([
      "mcp.mcpServers.factory",
      "settings.permissions.defaultMode",
      "template.projects.0",
    ]);
  });
});

test("an overlay plugin whose marketplace the template doesn't declare", async () => {
  const issues = await overlayIssues(
    baseDoc(),
    { settings: { enabledPlugins: { "p@acme": true } } },
    ctx,
  );
  expect(issues).toEqual([
    expect.objectContaining({
      severity: "error",
      message: "Marketplace acme isn't declared by template dev.",
      path: "settings.enabledPlugins.p@acme",
    }),
  ]);
});

test("an overlay plugin from a marketplace the template declares runs at the template's pin", async () => {
  const doc = {
    ...baseDoc(),
    settings: { extraKnownMarketplaces: { acme: { source: { ...ACME, ref: "v1" } } } },
  };
  expect(
    await overlayIssues(doc, { settings: { enabledPlugins: { "rel@acme": true } } }, ctx),
  ).toEqual([]);
  expect(
    messages(
      await overlayIssues(doc, { settings: { enabledPlugins: { "free@acme": true } } }, ctx),
    ),
  ).toEqual(["free@acme can't be pinned. Switch acme to Latest to add it."]);
  expect(
    messages(
      await overlayIssues(doc, { settings: { enabledPlugins: { "rel@acme": false } } }, ctx),
    ),
  ).toEqual(["Remove the plugin instead of turning it off."]);
  expect(
    messages(await overlayIssues(doc, { settings: { syncClaudeAiPlugins: true } }, ctx)),
  ).toEqual(["The factory sets syncClaudeAiPlugins."]);
});

test("overlayIssues rebases a list index to the overlay", async () => {
  const base = {
    ...baseDoc(),
    template: { name: "dev", display_name: "Dev", skills: [] },
  };
  const issues = await overlayIssues(base, { template: { skills: ["nope"] } }, ctx);
  expect(issues.map((i) => i.path)).toEqual(["template.skills.0"]);
});

test("a skill the Library lists but can't find in its folder is missing, whatever the reason", async () => {
  const library = {
    marketplaces: () => ctx.library.marketplaces(),
    marketplaceDir: ctx.library.marketplaceDir.bind(ctx.library),
    catalogAt: ctx.library.catalogAt.bind(ctx.library),
    resolveSkill: async (name: string) =>
      name === "gone"
        ? { ok: false as const, reason: "missing" as const, detail: "Fetch again" }
        : { ok: false as const, reason: "not_added" as const },
  };
  const doc = { ...baseDoc(), template: { name: "dev", display_name: "Dev", skills: ["gone"] } };
  const issues = await validateEffective(doc, { ...ctx, library }, "human");
  expect(issues.map((i) => [i.path, i.message])).toEqual([
    ["template.skills.0", "Skill gone is missing from its folder."],
  ]);
});

test("a template skill with a Library skill's name is a collision in an overlay, and only that", async () => {
  const dir = tpl({ ...base, "skills/grilling/SKILL.md": "x", "skills/mine/SKILL.md": "x" });
  const issues = await overlayIssues(
    { ...baseDoc(), template: { name: "dev", display_name: "Dev", skills: [] } },
    { template: { skills: ["grilling", "mine", "nope"] } },
    { ...ctx, templateDir: dir },
  );
  expect(issues.map((i) => [i.path, i.message])).toEqual([
    ["template.skills.0", "Skill grilling has the same name as a template skill in skills/."],
    ["template.skills.1", "Skill mine has the same name as a template skill in skills/."],
    ["template.skills.2", "Skill nope hasn't been added in Skills."],
  ]);
});

test("overlayIssues reports nothing that already fails on the base", async () => {
  const base = { ...baseDoc(), template: { ...baseDoc().template, projects: ["nope"] } };
  expect(await overlayIssues(base, { template: { model: "opus" } }, ctx)).toEqual([]);
});

test("overlayIssues includes the overlay schema's issues", async () => {
  const issues = await overlayIssues(baseDoc(), { settings: { extraKnownMarketplaces: {} } }, ctx);
  expect(issues).toContainEqual(
    expect.objectContaining({ severity: "error", path: "settings.extraKnownMarketplaces" }),
  );
});

test("overlayIssues never echoes secret-shaped values", async () => {
  const secret = "sk-ant-SECRET0123456789";
  const overlay = {
    template: { [secret]: 1 },
    settings: { env: { [secret]: secret, ANTHROPIC_API_KEY: secret } },
    mcp: {
      mcpServers: {
        gh: {
          command: secret,
          args: [secret],
          url: `https://${secret}.example`,
          env: { T: `${secret}-${"${MISSING}"}` },
          headers: { Authorization: `Bearer ${secret}`, B: "${NOPE}" },
        },
      },
    },
  } as never;
  const issues = await overlayIssues(baseDoc(), overlay, ctx);
  expect(issues.length).toBeGreaterThan(0);
  expect(JSON.stringify(issues)).not.toContain(secret);
});

test("overlaySchemaIssues carries paths and constant messages, never a value or an unknown key", () => {
  const secret = "sk-ant-SECRET0123456789";
  const overlays: Record<string, unknown> = {
    "unknown top key": { [secret]: 1 },
    "unknown template key": { template: { [secret]: 1 } },
    "bad model": { template: { model: `${secret}!` } },
    "bad effort": { template: { effort: secret } },
    "bad secrets": { template: { secrets: [secret, "OPEN_FACTORY_X"] } },
    "long item": { template: { skills: [`${secret}${"a".repeat(1001)}`] } },
    "bad env name": { settings: { env: { [secret]: secret, ANTHROPIC_API_KEY: secret } } },
    "default mode": { settings: { permissions: { defaultMode: secret } } },
    marketplaces: { settings: { extraKnownMarketplaces: { [secret]: secret } } },
    "reserved server": { mcp: { mcpServers: { factory: { command: secret, args: [secret] } } } },
    "unknown mcp key": { mcp: { [secret]: 1 } },
  };
  for (const [name, overlay] of Object.entries(overlays)) {
    const issues = overlaySchemaIssues(overlay);
    expect(issues.length, name).toBeGreaterThan(0);
    expect(JSON.stringify(issues), name).not.toContain(secret);
    expect(
      issues.every((i) => i.severity === "error"),
      name,
    ).toBe(true);
  }
});

test("overlaySchemaIssues is empty for a good overlay", () => {
  expect(overlaySchemaIssues({ template: { model: "opus" } })).toEqual([]);
  expect(overlaySchemaIssues({})).toEqual([]);
});

test("validateEffective never echoes an env name that fails the name rule", async () => {
  const bad = "OPEN_FACTORY_sk-ant-SECRET0123";
  const issues = await validateEffective(
    { ...baseDoc(), settings: { env: { [bad]: "v" } } },
    ctx,
    "human",
  );
  expect(issues).toEqual([expect.objectContaining({ severity: "error", path: "settings.env" })]);
  expect(JSON.stringify(issues)).not.toContain("sk-ant");
});

const PLUGIN_ENV = [
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_SYNC_PLUGIN_INSTALL",
  "DISABLE_AUTOUPDATER",
  "DISABLE_UPDATES",
  "FORCE_AUTOUPDATE_PLUGINS",
];

// Spec §7.3 step 4: the plugin env is the factory's. No template, overlay or secret can set it (a project's own
// settings `env` is refused at the start: workspace/agent-folders.test.ts runs every name in FACTORY_ENV_NAMES).
test.each(PLUGIN_ENV)(
  "%s is a factory env name no template, overlay or secret can set",
  async (name) => {
    expect(FACTORY_ENV_NAMES).toContain(name);
    const template = await validateEffective(
      { ...baseDoc(), settings: { env: { [name]: "1" } } },
      ctx,
      "human",
    );
    expect(template).toEqual([
      expect.objectContaining({ severity: "error", message: `${name} is set by the factory.` }),
    ]);
    const overlayEnv = overlaySchemaIssues({ settings: { env: { [name]: "1" } } });
    expect(overlayEnv).toEqual([
      expect.objectContaining({ severity: "error", path: `settings.env.${name}` }),
    ]);
    const secret = overlaySchemaIssues({ template: { secrets: [name] } });
    expect(secret).toEqual([
      expect.objectContaining({ severity: "error", path: "template.secrets.0" }),
    ]);
  },
);

test("an overlay secret the factory owns gives one issue", async () => {
  const issues = await overlayIssues(baseDoc(), { template: { secrets: ["OPEN_FACTORY_X"] } }, ctx);
  expect(issues.filter((i) => i.path === "template.secrets.0")).toHaveLength(1);
});

test("schema and name issues are rooted like the semantic ones", async () => {
  const r = await validateTemplate(
    tpl({ ...base, "template.yaml": "name: other\ndisplay_name: X\n" }),
    "tech-lead",
    ctx,
  );
  expect(r.issues.map((i) => i.path)).toEqual(["template.name"]);
  const z = await validateTemplate(
    tpl({ ...base, "template.yaml": "name: tech-lead\ndisplay_name: X\nmodle: o\n" }),
    "tech-lead",
    ctx,
  );
  expect(z.issues[0]?.path).toBe("template.modle");
});
